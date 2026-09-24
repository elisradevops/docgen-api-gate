import { Request, Response } from 'express';
import { LogEvent, LOG_EVENT_RETENTION_MS } from '../models/LogEvent';
import { computeSignature } from '../helpers/diagnostics/signature';
import { upsertIssueForEvent } from '../helpers/diagnostics/issueUpsert';
import { isMongoConnected } from '../util/mongodb';

const MAX_BATCH_SIZE = 500;
const MAX_MESSAGE_LEN = 2000;
const MAX_STACK_LEN = 4000;

function clampString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

// Whitelists and clamps one ingested event into a LogEvent-shaped plain object, or returns
// undefined for a malformed one (dropped, not a batch-failing error). Every field is coerced
// to a string (or dropped) here — that IS the backstop for an event arriving over HTTP from
// another process: an unlisted field (a stray minioSecretKey, say) is never even read, let
// alone persisted. redactValue (util/logger.ts) isn't applicable here the way it is in
// runManifest.ts's buildInputs — it redacts sensitive *keys* inside a nested object, and
// every field surviving this allowlist is already a flat string; redacting a secret
// interpolated inline inside message/err.message/err.stack text is the same known limit the
// redact() winston format itself documents (a call-site problem, not a format one) — the
// call-site fixes upstream (Phase 1/4) are what keep sensitive values out of message text at
// the source.
const CAPTURED_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
// Phase 6b — only debug/info volume is subject to this cap (warn/error, the 'normal'-mode
// baseline, never is): a run only emits debug/info at all once it has opted into
// verbose/retain-on-failure, so normal-mode runs never pay the extra count-query cost either.
const PER_RUN_CAP = Number(process.env.DIAGNOSTICS_PER_RUN_MAX_EVENTS) || 20_000;

function sanitizeEvent(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const event = raw as Record<string, unknown>;
  if (typeof event.level !== 'string' || !CAPTURED_LEVELS.has(event.level)) return undefined;
  if (typeof event.service !== 'string' || typeof event.message !== 'string') return undefined;

  const message = clampString(event.message, MAX_MESSAGE_LEN) ?? '';
  const err =
    event.err && typeof event.err === 'object'
      ? {
          message: clampString((event.err as Record<string, unknown>).message, MAX_MESSAGE_LEN) ?? '',
          code: clampString((event.err as Record<string, unknown>).code, 100),
          stack: clampString((event.err as Record<string, unknown>).stack, MAX_STACK_LEN),
        }
      : undefined;

  return {
    ts: typeof event.ts === 'string' ? new Date(event.ts) : new Date(),
    level: event.level,
    service: clampString(event.service, 200),
    version: clampString(event.version, 100) ?? 'unknown',
    runId: clampString(event.runId, 100),
    step: clampString(event.step, 200),
    contentControlType: clampString(event.contentControlType, 200),
    contentControlTitle: clampString(event.contentControlTitle, 200),
    project: clampString(event.project, 200),
    userId: clampString(event.userId, 200),
    message,
    err,
    signature: computeSignature(message),
    expiresAt: new Date(Date.now() + LOG_EVENT_RETENTION_MS),
    retainPending: event.retainPending === true ? true : undefined,
  };
}

const TRUNCATION_MESSAGE = `Diagnostics capture truncated at ${PER_RUN_CAP} events for this run`;
// computeSignature normalizes the embedded number to <n>, so this stays stable across
// different PER_RUN_CAP values — it's what lets a later batch recognize "already marked".
const TRUNCATION_SIGNATURE = computeSignature(TRUNCATION_MESSAGE);

function truncationMarker(runId: string): Record<string, unknown> {
  return {
    ts: new Date(),
    level: 'warn',
    service: 'dg-api-gate',
    version: 'unknown',
    runId,
    message: TRUNCATION_MESSAGE,
    signature: TRUNCATION_SIGNATURE,
    expiresAt: new Date(Date.now() + LOG_EVENT_RETENTION_MS),
  };
}

// Applies the per-run cap to debug/info events only, grouped by runId — one count query per
// distinct capped runId in the batch, not per event. Truncated events are dropped with one
// marker inserted in their place, rather than a silent drop — and exactly one per run, not
// one per batch: a long-truncated run flushes/ingests in many small batches, and each one
// re-checking "am I over the cap" independently would otherwise re-insert the marker every
// time (caught live during Phase 6b verification with a deliberately low cap).
async function applyPerRunCap(docs: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const cappable = docs.filter((d) => (d.level === 'debug' || d.level === 'info') && typeof d.runId === 'string');
  const runIds = [...new Set(cappable.map((d) => d.runId as string))];
  if (runIds.length === 0) return docs;

  const byRunId = new Map<string, number>();
  const alreadyMarked = new Set<string>();
  await Promise.all(
    runIds.map(async (runId) => {
      const [count, markerCount] = await Promise.all([
        LogEvent.countDocuments({ runId }),
        LogEvent.countDocuments({ runId, signature: TRUNCATION_SIGNATURE }),
      ]);
      byRunId.set(runId, count);
      if (markerCount > 0) alreadyMarked.add(runId);
    })
  );

  const result: Record<string, unknown>[] = [];
  const truncatedRunIds = new Set<string>();
  for (const doc of docs) {
    const isCappable = (doc.level === 'debug' || doc.level === 'info') && typeof doc.runId === 'string';
    if (!isCappable) {
      result.push(doc);
      continue;
    }
    const runId = doc.runId as string;
    const count = byRunId.get(runId) ?? 0;
    if (count >= PER_RUN_CAP) {
      truncatedRunIds.add(runId);
      continue;
    }
    byRunId.set(runId, count + 1);
    result.push(doc);
  }
  for (const runId of truncatedRunIds) {
    if (alreadyMarked.has(runId)) continue;
    result.push(truncationMarker(runId));
  }
  return result;
}

export class DiagnosticsController {
  // POST /diagnostics/logs — the relay path for services with no Mongo credentials of their
  // own (docgen-content-control, forwarding its own logger's events plus
  // docgen-data-provider-package's and docgen-dg-skins-package's, which run in-process
  // inside it). api-gate's own events go straight through MongoLogSink instead.
  public async ingestLogs(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    const events = Array.isArray(req.body?.events) ? req.body.events : undefined;
    if (!events) {
      res.status(400).json({ message: 'Expected { events: [...] }', error: 'invalid_payload' });
      return;
    }
    const batch = events.slice(0, MAX_BATCH_SIZE);
    const sanitized = batch.map(sanitizeEvent).filter((e: unknown): e is Record<string, unknown> => !!e);
    const rejected = batch.length - sanitized.length;
    try {
      const toInsert = await applyPerRunCap(sanitized);
      if (toInsert.length > 0) {
        await LogEvent.insertMany(toInsert, { ordered: false });
        await Promise.all(
          toInsert
            .filter((d) => d.level === 'warn' || d.level === 'error')
            .map((d) =>
              upsertIssueForEvent({
                signature: d.signature as string,
                service: d.service as string,
                level: d.level as string,
                version: d.version as string,
                project: d.project as string | undefined,
                runId: d.runId as string | undefined,
              })
            )
        );
      }
      res.status(200).json({ accepted: sanitized.length, rejected });
    } catch (err) {
      res.status(500).json({ message: 'Failed to persist diagnostics batch', error: String(err) });
    }
  }
}
