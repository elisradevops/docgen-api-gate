// The LogSink installed in this process, consumed by DiagnosticsTransport (util/logger.ts) —
// api-gate's own warn/error records flow straight here — and the one persist path for
// docgen-content-control's (and its in-process packages') records too: POST /diagnostics/logs
// validates a batch and enqueues it here (enqueueDocs), since only this service holds Mongo
// credentials.
//
// Buffers in memory and flushes on a timer or a size threshold, whichever comes first — a
// concrete, testable pair of numbers rather than "periodically" — one flush in flight at a time,
// with a bounded buffer that drops the oldest events under backpressure. Pruning to the document
// cap runs on its own timer, independent of whether anything is being flushed. Never lets a Mongo
// problem propagate into whatever code path called logger.warn/error: losing the dashboard must
// never take down generation.
import { LogSink, DiagnosticEvent, installLogSink } from '../../util/logSink';
import { LogEvent, LOG_EVENT_RETENTION_MS, LOG_EVENT_MAX_DOCUMENTS } from '../../models/LogEvent';
import { isMongoConnected } from '../../util/mongodb';
import { runContextStore } from '../../util/runContext';
import { computeSignature } from '../../helpers/diagnostics/signature';
import { upsertIssuesForEvents } from '../../helpers/diagnostics/issueUpsert';
import { sanitizeEvent } from '../../helpers/diagnostics/sanitizeEvent';

// Half a second, not two: this is half of what a live-tail viewer waits for an event (the other
// halves are the relaying service's own flush and the UI's poll). Size-triggered flushes are unchanged.
const FLUSH_INTERVAL_MS = Number(process.env.DIAGNOSTICS_FLUSH_INTERVAL_MS) || 500;
const FLUSH_BATCH_SIZE = Number(process.env.DIAGNOSTICS_FLUSH_BATCH_SIZE) || 500;
const BUFFER_MAX = Number(process.env.DIAGNOSTICS_BUFFER_MAX) || 10_000;
// Dropping one event at a time with shift() is O(n) per push once the buffer is full; dropping
// a slice makes it O(1) amortized.
const DROP_CHUNK = Math.max(1, Math.floor(BUFFER_MAX / 10));
const MAX_BATCHES_PER_FLUSH = 20;
// Prune is a separate, much less frequent check than flush — estimatedDocumentCount() and a
// potential delete are more expensive than an insertMany, and the cap only needs to hold
// roughly, not exactly, at any given instant. It runs on its own timer (below), not from
// flush(): relayed ingest used to bypass flush entirely, so a quiet api-gate never pruned.
const PRUNE_INTERVAL_MS = 60_000;
const PRUNE_CHUNK = 5000;
const PRUNE_MAX_CHUNKS_PER_TICK = 20;
// Phase 6b — only debug/info volume is subject to this cap (warn/error, the 'normal'-mode
// baseline, never is): a run only emits debug/info at all once it has opted into
// verbose/retain-on-failure, so normal-mode runs never pay the extra count-query cost either.
const PER_RUN_CAP = Number(process.env.DIAGNOSTICS_PER_RUN_MAX_EVENTS) || 20_000;
const TRUNCATION_MESSAGE = `Diagnostics capture truncated at ${PER_RUN_CAP} events for this run`;
// computeSignature normalizes the embedded number to <n>, so this stays stable across
// different PER_RUN_CAP values — it's what lets a later batch recognize "already marked".
const TRUNCATION_SIGNATURE = computeSignature(TRUNCATION_MESSAGE);
// Runs already known to carry a truncation marker, so a long-truncated run's later batches skip
// the marker-existence query. Bounded, evicting the oldest entry first.
const MARKED_RUNS_MAX = 1000;

type LogDoc = Record<string, unknown>;

export class MongoLogSink implements LogSink {
  private buffer: LogDoc[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private droppedSinceLastWarning = 0;
  private inFlight: Promise<void> | null = null;
  private markedRuns = new Set<string>();

  push(event: DiagnosticEvent): void {
    const doc = sanitizeEvent(event);
    if (doc) this.enqueueDocs([doc]);
  }

  // Already-sanitized LogEvent-shaped documents (the ingest controller's path).
  enqueueDocs(docs: LogDoc[]): void {
    for (const doc of docs) {
      if (this.buffer.length >= BUFFER_MAX) {
        // Drop oldest under backpressure — a store that silently stops growing (rather than
        // OOMing the process) is the correct failure mode for a monitoring side-channel.
        this.droppedSinceLastWarning += this.buffer.splice(0, DROP_CHUNK).length;
      }
      this.buffer.push(doc);
    }
    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      void this.flush();
    }
  }

  start(): void {
    if (this.timer) return;
    // A background timer inherits whatever ALS context was active when it was scheduled —
    // the same reasoning util/mongodb.ts's scheduleReconnect already documents. Without
    // exit(), a flush triggered while some unrelated request happened to be in flight would
    // stamp this sink's own failure logs with that request's runId.
    this.timer = setInterval(() => {
      runContextStore.exit(() => {
        void this.flush();
      });
    }, FLUSH_INTERVAL_MS);
    this.timer.unref();
    this.pruneTimer = setInterval(() => {
      runContextStore.exit(() => {
        void this.pruneIfNeeded().catch((e) => {
          console.error('MongoLogSink failed to prune', e);
        });
      });
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  // One flush in flight at a time; a caller arriving mid-flush shares it, and the drain loop
  // picks up whatever was enqueued meanwhile, so awaiting flush() at shutdown covers it all.
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.buffer.length === 0) return Promise.resolve();
    if (!isMongoConnected()) return Promise.resolve(); // no-op cleanly when Mongo is down
    this.inFlight = this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    for (let i = 0; i < MAX_BATCHES_PER_FLUSH && this.buffer.length > 0; i++) {
      const batch = this.buffer.splice(0, FLUSH_BATCH_SIZE);
      try {
        await this.persist(batch);
      } catch (e) {
        // Never through `logger` — that would recurse back into DiagnosticsTransport, which
        // pushes into this same sink.
        // eslint-disable-next-line no-console
        console.error('MongoLogSink failed to flush', e);
      }
    }
    if (this.droppedSinceLastWarning > 0) {
      // eslint-disable-next-line no-console
      console.warn(`MongoLogSink dropped ${this.droppedSinceLastWarning} events under backpressure`);
      this.droppedSinceLastWarning = 0;
    }
  }

  private async persist(docs: LogDoc[]): Promise<void> {
    const toInsert = await this.applyPerRunCap(docs);
    if (toInsert.length === 0) return;
    await LogEvent.insertMany(toInsert, { ordered: false });
    await upsertIssuesForEvents(
      toInsert
        .filter((d) => d.level === 'error')
        .map((d) => ({
          signature: d.signature as string,
          message: d.message as string,
          service: d.service as string,
          level: d.level as string,
          version: d.version as string,
          project: d.project as string | undefined,
          runId: d.runId as string | undefined,
          docType: d.docType as string | undefined,
        }))
    );
  }

  private markRun(runId: string): void {
    if (this.markedRuns.size >= MARKED_RUNS_MAX) {
      const oldest = this.markedRuns.values().next().value;
      if (oldest !== undefined) this.markedRuns.delete(oldest);
    }
    this.markedRuns.add(runId);
  }

  // Applies the per-run cap to debug/info documents only, grouped by runId — one count query
  // per distinct capped runId in the batch, not per event. Truncated events are dropped with
  // one marker inserted in their place, rather than a silent drop — and exactly one per run,
  // not one per batch: a long-truncated run flushes in many small batches, and each one
  // re-checking "am I over the cap" independently would otherwise re-insert the marker every
  // time (caught live during Phase 6b verification with a deliberately low cap).
  private async applyPerRunCap(docs: LogDoc[]): Promise<LogDoc[]> {
    const cappable = docs.filter((d) => (d.level === 'debug' || d.level === 'info') && typeof d.runId === 'string');
    const runIds = [...new Set(cappable.map((d) => d.runId as string))];
    if (runIds.length === 0) return docs;

    const byRunId = new Map<string, number>();
    await Promise.all(
      runIds.map(async (runId) => {
        byRunId.set(runId, await LogEvent.countDocuments({ runId }));
      })
    );

    const result: LogDoc[] = [];
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
    // The marker-existence check only matters for a run that actually got truncated, and is
    // skipped outright for one already known to be marked.
    await Promise.all(
      [...truncatedRunIds].map(async (runId) => {
        if (this.markedRuns.has(runId)) return;
        const exists = (await LogEvent.countDocuments({ runId, signature: TRUNCATION_SIGNATURE })) > 0;
        this.markRun(runId);
        if (exists) return;
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
      })
    );
    return result;
  }

  // Deletes the oldest overflow in bounded chunks: one `$in` over the whole overflow could be a
  // six-figure id list. At most PRUNE_MAX_CHUNKS_PER_TICK per tick — the next tick continues.
  async pruneIfNeeded(): Promise<void> {
    if (!isMongoConnected()) return;
    const count = await LogEvent.estimatedDocumentCount();
    let overflow = count - LOG_EVENT_MAX_DOCUMENTS;
    for (let i = 0; i < PRUNE_MAX_CHUNKS_PER_TICK && overflow > 0; i++) {
      const take = Math.min(overflow, PRUNE_CHUNK);
      const oldest = await LogEvent.find({}, { _id: 1 }).sort({ ts: 1 }).limit(take).lean();
      if (oldest.length === 0) return;
      await LogEvent.deleteMany({ _id: { $in: oldest.map((d: any) => d._id) } });
      overflow -= oldest.length;
    }
  }
}

let installed: MongoLogSink | null = null;
let ingestFallback: MongoLogSink | null = null;

export function installMongoLogSink(): MongoLogSink {
  if (installed) return installed;
  installed = new MongoLogSink();
  installLogSink(installed);
  installed.start();
  return installed;
}

// The sink POST /diagnostics/logs enqueues into: the installed one in a running server, or a
// private started instance when none is installed (an embedding/test context) — never installed
// as the process's LogSink, so it can't capture this process's own logs by surprise.
export function getIngestSink(): MongoLogSink {
  if (installed) return installed;
  if (!ingestFallback) {
    ingestFallback = new MongoLogSink();
    ingestFallback.start();
  }
  return ingestFallback;
}
