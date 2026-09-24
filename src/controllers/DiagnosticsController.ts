import { Request, Response } from 'express';
import { LogEvent, LOG_EVENT_RETENTION_MS } from '../models/LogEvent';
import { computeSignature } from '../helpers/diagnostics/signature';
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
function sanitizeEvent(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const event = raw as Record<string, unknown>;
  if (event.level !== 'warn' && event.level !== 'error') return undefined;
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
  };
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
      if (sanitized.length > 0) {
        await LogEvent.insertMany(sanitized, { ordered: false });
      }
      res.status(200).json({ accepted: sanitized.length, rejected });
    } catch (err) {
      res.status(500).json({ message: 'Failed to persist diagnostics batch', error: String(err) });
    }
  }
}
