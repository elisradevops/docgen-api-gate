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

const FLUSH_INTERVAL_MS = Number(process.env.DIAGNOSTICS_FLUSH_INTERVAL_MS) || 2000;
const FLUSH_BATCH_SIZE = Number(process.env.DIAGNOSTICS_FLUSH_BATCH_SIZE) || 500;
const BUFFER_MAX = Number(process.env.DIAGNOSTICS_BUFFER_MAX) || 10_000;
// Prune is a separate, much less frequent check than flush — estimatedDocumentCount() and a
// potential delete are more expensive than an insertMany, and the cap only needs to hold
// roughly, not exactly, at any given instant.
const PRUNE_INTERVAL_MS = 60_000;

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
        step: event.step,
        contentControlType: event.contentControlType,
        contentControlTitle: event.contentControlTitle,
        project: event.project,
        userId: event.userId,
        message: event.message,
        err: event.err,
        signature: computeSignature(event.message),
        expiresAt: new Date(Date.now() + LOG_EVENT_RETENTION_MS),
      }));
      await LogEvent.insertMany(docs, { ordered: false });
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
