import mongoose, { Schema, Document } from 'mongoose';

// One record per generation, written by DocumentsGeneratorController.createJSONDoc — the
// monitoring substrate: this is the only place a failed generation leaves a trace at all,
// since MinIO object metadata (the only other trace) is written only on success.
export interface IDocumentRunErrorChainEntry {
  service: string;
  step?: string;
  message: string;
  code?: string;
  stack?: string;
}

export interface IDocumentRun extends Document {
  runId: string;
  status: 'running' | 'succeeded' | 'failed';
  // Best-effort: derived from whether the caller supplied a valid x-docgen-run-id header
  // (the frontend does, per Phase 3's sendDocumentToGenerator; the external SVD pipeline
  // template does not today) rather than from any authenticated identity — /jsonDocument/create
  // carries no session middleware to derive this from more directly.
  trigger: 'ui' | 'pipeline';
  startedAt: Date;
  endedAt?: Date;
  userId?: string;
  project?: string;
  docType?: string;
  templateName?: string;
  documentUrl?: string;
  errorChain: IDocumentRunErrorChainEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const ErrorChainEntrySchema = new Schema<IDocumentRunErrorChainEntry>(
  {
    service: { type: String, required: true },
    step: { type: String },
    message: { type: String, required: true },
    code: { type: String },
    stack: { type: String },
  },
  { _id: false }
);

// Configurable retention, default 90d, matching the plan's default for run history — much
// longer than LogEvent's own 30d default, since a run record is orders of magnitude smaller
// than the log events it correlates.
const RETENTION_DAYS = Number(process.env.DOCUMENT_RUN_RETENTION_DAYS) || 90;
export const DOCUMENT_RUN_RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

const DocumentRunSchema = new Schema(
  {
    runId: { type: String, required: true, unique: true, index: true },
    status: { type: String, required: true, enum: ['running', 'succeeded', 'failed'], default: 'running' },
    trigger: { type: String, required: true, enum: ['ui', 'pipeline'] },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date },
    userId: { type: String },
    project: { type: String },
    docType: { type: String },
    templateName: { type: String },
    documentUrl: { type: String },
    errorChain: { type: [ErrorChainEntrySchema], default: [] },
    // Computed at creation from startedAt + retention, not updated on later writes, so
    // retention counts from when the run began rather than sliding forward on every update.
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

DocumentRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
DocumentRunSchema.index({ status: 1, startedAt: -1 });

export const DocumentRun = mongoose.model<IDocumentRun>('DocumentRun', DocumentRunSchema);
