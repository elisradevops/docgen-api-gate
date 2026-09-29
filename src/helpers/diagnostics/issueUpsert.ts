// Upserts an Issue for one warn/error LogEvent, called from both places that persist
// LogEvents (MongoLogSink.flush, DiagnosticsController.ingestLogs). Regression semantics
// (Phase 6b plan decision 1) need a read-before-write: a single atomic findOneAndUpdate can
// create-or-increment, but "flip resolved back to unresolved, but only if it actually was
// resolved" can't be expressed unconditionally in the same operation without corrupting an
// already-unresolved issue's status. So this is two Mongo round trips only in the regression
// case — one otherwise (the always-run upsert already returns the pre-update document, no
// extra read needed to make that decision).
import { Issue, ISSUE_OCCURRENCE_RUN_IDS_CAP } from '../../models/Issue';

export interface IssueUpsertEvent {
  signature: string;
  service: string;
  level: string;
  version: string;
  project?: string;
  runId?: string;
  docType?: string;
}

export async function upsertIssueForEvent(event: IssueUpsertEvent): Promise<void> {
  if (event.level !== 'warn' && event.level !== 'error') return;
  try {
    const now = new Date();
    // Both projects[] and docTypes[] are $addToSet — they must be ONE combined spread, not two
    // separate `$addToSet` keys: a second bare `{ $addToSet: {...} }` object spread after the
    // first would silently overwrite it rather than merge, since both target the same top-level
    // update key. Caught during Phase 7b planning before this became a real regression.
    const addToSet: Record<string, string> = {};
    if (event.project) addToSet.projects = event.project;
    if (event.docType) addToSet.docTypes = event.docType;
    const before = await Issue.findOneAndUpdate(
      { signature: event.signature, service: event.service },
      {
        $setOnInsert: {
          status: 'unresolved',
          firstSeenAt: now,
          environmentAtFirstSeen: { service: event.service, version: event.version },
        },
        $set: { lastSeenAt: now },
        $inc: { count: 1 },
        ...(Object.keys(addToSet).length ? { $addToSet: addToSet } : {}),
        ...(event.runId ? { $push: { occurrenceRunIds: { $each: [event.runId], $slice: -ISSUE_OCCURRENCE_RUN_IDS_CAP } } } : {}),
      },
      { upsert: true, new: false }
    );

    // before is null on a genuine insert (status already 'unresolved' via $setOnInsert) — the
    // only remaining case to handle is an existing issue that was resolved.
    if (before && before.status === 'resolved') {
      await Issue.updateOne({ _id: before._id }, { $set: { status: 'unresolved', regressedAt: now } });
    }
  } catch (err) {
    // Never through `logger` — the same recursion-avoidance rule as the transports
    // themselves (this helper is called from inside their own flush paths).
    // eslint-disable-next-line no-console
    console.error('Failed to upsert Issue for event', err);
  }
}
