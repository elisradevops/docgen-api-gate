// The LogSink installed in this process, consumed by DiagnosticsTransport (util/logger.ts) —
// api-gate's own warn/error records flow straight here; docgen-content-control's (and its
// in-process packages') flow in via POST /diagnostics/logs instead, since only this service
// holds Mongo credentials.
//
// Buffers in memory and flushes on a timer or a size threshold, whichever comes first — a
// concrete, testable pair of numbers rather than "periodically" — and never lets a Mongo
// problem propagate into whatever code path called logger.warn/error. Losing the dashboard
// must never take down generation.
import { LogSink, DiagnosticEvent, installLogSink } from '../../util/logSink';
import { LogEvent, LOG_EVENT_RETENTION_MS, LOG_EVENT_MAX_DOCUMENTS } from '../../models/LogEvent';
import { isMongoConnected } from '../../util/mongodb';
import { runContextStore } from '../../util/runContext';
import { computeSignature } from '../../helpers/diagnostics/signature';
import { upsertIssueForEvent } from '../../helpers/diagnostics/issueUpsert';

const FLUSH_INTERVAL_MS = Number(process.env.DIAGNOSTICS_FLUSH_INTERVAL_MS) || 2000;
const FLUSH_BATCH_SIZE = Number(process.env.DIAGNOSTICS_FLUSH_BATCH_SIZE) || 500;
const BUFFER_MAX = Number(process.env.DIAGNOSTICS_BUFFER_MAX) || 10_000;
// Prune is a separate, much less frequent check than flush — estimatedDocumentCount() and a
// potential delete are more expensive than an insertMany, and the cap only needs to hold
// roughly, not exactly, at any given instant.
const PRUNE_INTERVAL_MS = 60_000;
// Phase 6b — only debug/info volume is subject to this cap (warn/error, the 'normal'-mode
// baseline, never is): a run only emits debug/info at all once it has opted into
// verbose/retain-on-failure, so normal-mode runs never pay the extra count-query cost either.
const PER_RUN_CAP = Number(process.env.DIAGNOSTICS_PER_RUN_MAX_EVENTS) || 20_000;
const TRUNCATION_MESSAGE = `Diagnostics capture truncated at ${PER_RUN_CAP} events for this run`;
// computeSignature normalizes the embedded number to <n>, so this stays stable across
// different PER_RUN_CAP values — it's what lets a later batch recognize "already marked".
const TRUNCATION_SIGNATURE = computeSignature(TRUNCATION_MESSAGE);

export class MongoLogSink implements LogSink {
  private buffer: DiagnosticEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPruneAt = 0;
  private droppedSinceLastWarning = 0;

  push(event: DiagnosticEvent): void {
    if (this.buffer.length >= BUFFER_MAX) {
      // Drop oldest under backpressure — a store that silently stops growing (rather than
      // OOMing the process) is the correct failure mode for a monitoring side-channel.
      this.buffer.shift();
      this.droppedSinceLastWarning++;
    }
    this.buffer.push(event);
    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      void this.flush();
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // A background timer inherits whatever ALS context was active when it was scheduled —
      // the same reasoning util/mongodb.ts's scheduleReconnect already documents. Without
      // exit(), a flush triggered while some unrelated request happened to be in flight would
      // stamp this sink's own failure logs with that request's runId.
      runContextStore.exit(() => {
        void this.flush();
      });
    }, FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (!isMongoConnected()) return; // no-op cleanly when Mongo is down
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const docs = batch.map((event) => ({
        ts: new Date(event.ts),
        level: event.level,
        service: event.service,
        version: event.version,
        runId: event.runId,
        docType: event.docType,
        step: event.step,
        contentControlType: event.contentControlType,
        contentControlTitle: event.contentControlTitle,
        project: event.project,
        userId: event.userId,
        message: event.message,
        err: event.err,
        signature: computeSignature(event.message),
        expiresAt: new Date(Date.now() + LOG_EVENT_RETENTION_MS),
        retainPending: event.retainPending,
      }));
      const toInsert = await this.applyPerRunCap(docs);
      await LogEvent.insertMany(toInsert, { ordered: false });
      await Promise.all(
        toInsert
          .filter((d) => d.level === 'error')
          .map((d) =>
            upsertIssueForEvent({
              signature: d.signature as string,
              message: d.message as string,
              service: d.service as string,
              level: d.level as string,
              version: d.version as string,
              project: d.project as string | undefined,
              runId: d.runId as string | undefined,
              docType: d.docType as string | undefined,
            })
          )
      );
      await this.pruneIfDue();
      if (this.droppedSinceLastWarning > 0) {
        // eslint-disable-next-line no-console
        console.warn(`MongoLogSink dropped ${this.droppedSinceLastWarning} events under backpressure`);
        this.droppedSinceLastWarning = 0;
      }
    } catch (e) {
      // Never through `logger` — that would recurse back into DiagnosticsTransport, which
      // pushes into this same sink.
      // eslint-disable-next-line no-console
      console.error('MongoLogSink failed to flush', e);
    }
  }

  // Applies the per-run cap to debug/info documents only, grouped by runId — one count query
  // per distinct capped runId in the batch, not per event. Truncated events are dropped with
  // one marker inserted in their place, rather than a silent drop — and exactly one per run,
  // not one per batch: a long-truncated run flushes in many small batches, and each one
  // re-checking "am I over the cap" independently would otherwise re-insert the marker every
  // time (caught live during Phase 6b verification with a deliberately low cap). Mirrors
  // DiagnosticsController's applyPerRunCap (api-gate's own ingest path) — the two repos don't
  // share code, same discipline as logger.ts/runContext.ts.
  private async applyPerRunCap(docs: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
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
      result.push({
        ts: new Date(),
        level: 'warn',
        service: 'dg-api-gate',
        version: 'unknown',
        runId,
        message: TRUNCATION_MESSAGE,
        signature: TRUNCATION_SIGNATURE,
        expiresAt: new Date(Date.now() + LOG_EVENT_RETENTION_MS),
      });
    }
    return result;
  }

  private async pruneIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    const count = await LogEvent.estimatedDocumentCount();
    if (count <= LOG_EVENT_MAX_DOCUMENTS) return;
    const overflow = count - LOG_EVENT_MAX_DOCUMENTS;
    const oldest = await LogEvent.find({}, { _id: 1 }).sort({ ts: 1 }).limit(overflow).lean();
    if (oldest.length === 0) return;
    await LogEvent.deleteMany({ _id: { $in: oldest.map((d: any) => d._id) } });
  }
}

let installed: MongoLogSink | null = null;

export function installMongoLogSink(): MongoLogSink {
  if (installed) return installed;
  installed = new MongoLogSink();
  installLogSink(installed);
  installed.start();
  return installed;
}
