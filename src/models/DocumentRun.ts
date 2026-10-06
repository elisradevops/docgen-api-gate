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

export interface IDocumentRunManifestStep {
  name: string;
  type: 'generate-doc-template' | 'generate-content-control' | 'render-document';
  status: 'succeeded' | 'failed';
  durationMs: number;
  errorCount: number;
  // Left undefined until Phase 6's transport exists to count it for real — a fabricated 0
  // would be indistinguishable from a verified one to anything reading this later.
  warnCount?: number;
  outputSummary?: Record<string, unknown>;
}

export interface IDocumentRunManifest {
  environment?: {
    services?: Record<string, string>;
    packages?: Record<string, string>;
    flags?: Record<string, string>;
    // Which kind of credential ran the request, which class of identity it belongs to, that identity's
    // display name, and what it could see in the project (counts and denied/notFound per area). Never the
    // credential itself.
    credential?: { kind?: string; identity?: string; name?: string; access?: Record<string, unknown> };
  };
  inputs?: Record<string, unknown>;
  steps: IDocumentRunManifestStep[];
  artifacts: Array<{
    kind: string;
    name: string;
    url: string;
    contentControlTitle?: string;
  }>;
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
  // Set only when verbose capture was actually active (requested AND authorized) for this run.
  captureMode?: 'verbose' | 'retain-on-failure';
  // What the user asked for (the same summary/details the Documents tab shows), kept on the run so
  // a run that failed — and so has no generated document — still has its input to look at.
  input?: { summary?: string; details?: Record<string, unknown> };
  // The frontend working session (ses-<uuid>) this run was started from. Interactive activity
  // before the run is logged under that id, so run detail can show it.
  sessionId?: string;
  templateName?: string;
  documentUrl?: string;
  errorChain: IDocumentRunErrorChainEntry[];
  manifest?: IDocumentRunManifest;
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

const ManifestStepSchema = new Schema<IDocumentRunManifestStep>(
  {
    name: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['generate-doc-template', 'generate-content-control', 'render-document'],
    },
    status: { type: String, required: true, enum: ['succeeded', 'failed'] },
    durationMs: { type: Number, required: true },
    errorCount: { type: Number, required: true },
    warnCount: { type: Number },
    outputSummary: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const ManifestArtifactSchema = new Schema(
  {
    kind: { type: String, required: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    contentControlTitle: { type: String },
  },
  { _id: false }
);

// environment/inputs are free-form key/value trees (service versions, a normalized request
// tree) rather than a fixed shape — Mixed here, same call as inputs.contentControls[].data below.
const ManifestSchema = new Schema<IDocumentRunManifest>(
  {
    environment: { type: Schema.Types.Mixed },
    inputs: { type: Schema.Types.Mixed },
    steps: { type: [ManifestStepSchema], default: [] },
    artifacts: { type: [ManifestArtifactSchema], default: [] },
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
    captureMode: { type: String, enum: ['verbose', 'retain-on-failure'] },
    sessionId: { type: String },
    input: {
      type: new Schema(
        { summary: { type: String }, details: { type: Schema.Types.Mixed } },
        { _id: false }
      ),
    },
    templateName: { type: String },
    documentUrl: { type: String },
    errorChain: { type: [ErrorChainEntrySchema], default: [] },
    manifest: { type: ManifestSchema },
    // Computed at creation from startedAt + retention, not updated on later writes, so
    // retention counts from when the run began rather than sliding forward on every update.
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

DocumentRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
DocumentRunSchema.index({ status: 1, startedAt: -1 });
// Phase 7a's /diagnostics/overview counts runs in a startedAt window regardless of status —
// {status:1, startedAt:-1} can't lead a startedAt-only range scan.
DocumentRunSchema.index({ startedAt: -1 });
// Phase 7c's baseline auto-selection ("most recent succeeded run of the same project+docType").
DocumentRunSchema.index({ project: 1, docType: 1, status: 1, startedAt: -1 });

export const DocumentRun = mongoose.model<IDocumentRun>('DocumentRun', DocumentRunSchema);
