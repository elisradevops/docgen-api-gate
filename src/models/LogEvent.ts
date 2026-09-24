import mongoose, { Schema, Document } from 'mongoose';

// One record per persisted warn/error, written by MongoLogSink (this repo's own
// DiagnosticsTransport output) and by POST /diagnostics/logs (batches relayed from
// docgen-content-control, which forwards its own logger's events plus
// docgen-data-provider-package's and docgen-dg-skins-package's — those two packages run
// in-process inside content-control, not as separate services). err is intentionally
// narrow — {message, code, stack} — a settled Phase 6 schema decision, no generic
// extra-fields bucket: Phase 4-style extra fields (e.g. tfs.ts's url/status/attempt) stay
// stdout-only, visible via `kubectl logs`.
export interface ILogEventErr {
  message: string;
  code?: string;
  stack?: string;
}

export interface ILogEvent extends Document {
  ts: Date;
  // 'debug'/'info' only ever appear under Phase 6b's verbose/retain-on-failure capture modes
  // — 'normal' mode (the only mode before Phase 6b) never persists below warn.
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;
  version: string;
  runId?: string;
  step?: string;
  contentControlType?: string;
  contentControlTitle?: string;
  project?: string;
  userId?: string;
  message: string;
  err?: ILogEventErr;
  signature: string;
  // Computed at creation from ts + retention, not updated on later writes — same rule as
  // DocumentRun.expiresAt, so retention counts from when the event was recorded rather than
  // sliding forward if the document is ever touched again.
  expiresAt: Date;
  // Phase 6b — set on a debug/info event captured under retain-on-failure. Deleted by
  // DocumentsGeneratorController at the run's one success point; left alone if the run fails.
  retainPending?: boolean;
}

const ErrSchema = new Schema<ILogEventErr>(
  {
    message: { type: String, required: true },
    code: { type: String },
    stack: { type: String },
  },
  { _id: false }
);

// Shorter than DocumentRun's own 90d default (DocumentRun.ts) — a run record is orders of
// magnitude smaller than the log events it correlates, and log events are the higher-volume
// side of the two collections.
const RETENTION_DAYS = Number(process.env.LOG_EVENT_RETENTION_DAYS) || 30;
export const LOG_EVENT_RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

// A hard cap, not just TTL: TTL alone can't bound a burst (e.g. an SVD over a very large
// release fanning out across many per-work-item log calls) inside a single 30-day window.
// Enforced as a throttled prune on MongoLogSink's flush path, not a Mongo capped collection —
// capped collections forbid TTL indexes outright.
export const LOG_EVENT_MAX_DOCUMENTS = Number(process.env.LOG_EVENT_MAX_DOCUMENTS) || 500_000;

const LogEventSchema = new Schema(
  {
    ts: { type: Date, required: true },
    level: { type: String, required: true, enum: ['debug', 'info', 'warn', 'error'] },
    service: { type: String, required: true },
    version: { type: String, required: true },
    runId: { type: String },
    step: { type: String },
    contentControlType: { type: String },
    contentControlTitle: { type: String },
    project: { type: String },
    userId: { type: String },
    message: { type: String, required: true },
    err: { type: ErrSchema },
    signature: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    retainPending: { type: Boolean },
  },
  { timestamps: true }
);

LogEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Run-detail timeline: all events for a given run, in order.
LogEventSchema.index({ runId: 1, ts: 1 });
// Top-errors / Issue keying (Phase 6b) and the Logs feed's default newest-first sort.
LogEventSchema.index({ signature: 1, ts: -1 });
LogEventSchema.index({ level: 1, ts: -1 });

export const LogEvent = mongoose.model<ILogEvent>('LogEvent', LogEventSchema);
