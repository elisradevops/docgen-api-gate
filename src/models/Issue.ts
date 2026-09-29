import mongoose, { Schema, Document } from 'mongoose';

// One record per recurring error signature, upserted from the same two write paths that
// persist LogEvent (MongoLogSink.flush for this service's own warn/error records,
// DiagnosticsController.ingestLogs for content-control's relayed ones) — see
// helpers/diagnostics/issueUpsert.ts. A read-only error feed forgets itself on every reload;
// this is the one piece of state worth keeping: has this been looked at, and did it come back
// after being marked resolved. Deliberately narrow — two states, no ignore/mute/assign — this
// team's actual volume doesn't justify a full Sentry-style model yet.
export interface IIssueEnvironment {
  service: string;
  version: string;
}

export interface IIssue extends Document {
  signature: string;
  service: string;
  status: 'unresolved' | 'resolved';
  firstSeenAt: Date;
  lastSeenAt: Date;
  count: number;
  projects: string[];
  // Populated via $addToSet in issueUpsert.ts (Phase 7b), same treatment as projects[] below.
  // Sparse on historical data — only events from generations run after Phase 7b shipped have
  // a docType to add.
  docTypes: string[];
  // Capped, most-recent-N, via $push+$slice — duplicates allowed (the same run re-triggering
  // the same signature is itself informative), unlike projects[] below.
  occurrenceRunIds: string[];
  // From the triggering LogEvent's own {service, version} — not a DocumentRun.manifest
  // lookup, since the manifest is only populated at finalizeRunRecord (after the run ends),
  // while an issue's first occurrence typically arrives mid-run.
  environmentAtFirstSeen: IIssueEnvironment;
  resolvedAt?: Date;
  resolvedBy?: string;
  // Set when a resolved issue's signature reappears — flips status back to 'unresolved' at
  // the same time. "This was fixed and is now happening again" is a different fact from
  // "this keeps happening," and it's the one signal this model exists to keep.
  regressedAt?: Date;
  // Original (un-normalized) message from the first occurrence — used for display so the UI
  // shows the real text rather than the signature's normalization placeholders (<url>, <str>…).
  message?: string;
}

const EnvironmentSchema = new Schema<IIssueEnvironment>(
  {
    service: { type: String, required: true },
    version: { type: String, required: true },
  },
  { _id: false }
);

export const ISSUE_OCCURRENCE_RUN_IDS_CAP = Number(process.env.ISSUE_OCCURRENCE_RUN_IDS_CAP) || 50;

const IssueSchema = new Schema(
  {
    signature: { type: String, required: true },
    service: { type: String, required: true },
    status: { type: String, required: true, enum: ['unresolved', 'resolved'], default: 'unresolved' },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    count: { type: Number, required: true, default: 1 },
    projects: { type: [String], default: [] },
    docTypes: { type: [String], default: [] },
    occurrenceRunIds: { type: [String], default: [] },
    environmentAtFirstSeen: { type: EnvironmentSchema },
    resolvedAt: { type: Date },
    resolvedBy: { type: String },
    regressedAt: { type: Date },
    message: { type: String },
  },
  { timestamps: true }
);

// The upsert key — same reasoning as DocumentRun.runId's unique index. Same message text
// from two different services is a different problem, hence the compound key rather than
// signature alone.
IssueSchema.index({ signature: 1, service: 1 }, { unique: true });
// "Needs Attention, newest-recurrence-first" — the eventual dashboard's default view.
IssueSchema.index({ status: 1, lastSeenAt: -1 });

export const Issue = mongoose.model<IIssue>('Issue', IssueSchema);
