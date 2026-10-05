// Upserts Issues for the error LogEvents of a persisted batch (MongoLogSink's one persist path,
// shared by api-gate's own events and POST /diagnostics/logs). Regression semantics
// (Phase 6b plan decision 1) need a read-before-write: a single atomic findOneAndUpdate can
// create-or-increment, but "flip resolved back to unresolved, but only if it actually was
// resolved" can't be expressed unconditionally in the same operation without corrupting an
// already-unresolved issue's status. So this is two Mongo round trips only in the regression
// case — one otherwise (the always-run upsert already returns the pre-update document, no
// extra read needed to make that decision).
import { Issue, ISSUE_OCCURRENCE_RUN_IDS_CAP } from '../../models/Issue';
import { isCorrelationOnlyId } from '../../util/runContext';

export interface IssueUpsertEvent {
  signature: string;
  // Original un-normalized message stored on first occurrence for readable display.
  message: string;
  service: string;
  level: string;
  version: string;
  project?: string;
  runId?: string;
  docType?: string;
}

const UPSERT_CONCURRENCY = 10;

interface IssueGroup {
  signature: string;
  service: string;
  message: string;
  version: string;
  count: number;
  projects: Set<string>;
  docTypes: Set<string>;
  runIds: string[];
}

// One upsert per distinct {signature, service} in the batch instead of one per error event: a
// burst of 500 identical errors is one `$inc: {count: 500}` on one Issue document, not 500
// concurrent updates contending for it. Groups are processed a few at a time, so a batch with
// many distinct signatures can't open an unbounded number of simultaneous Mongo operations.
export async function upsertIssuesForEvents(events: IssueUpsertEvent[]): Promise<void> {
  const groups = new Map<string, IssueGroup>();
  for (const event of events) {
    if (event.level !== 'error') continue;
    const key = `${event.service}\u0000${event.signature}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        signature: event.signature,
        service: event.service,
        message: event.message,
        version: event.version,
        count: 0,
        projects: new Set(),
        docTypes: new Set(),
        runIds: [],
      };
      groups.set(key, group);
    }
    group.count++;
    if (event.project) group.projects.add(event.project);
    if (event.docType) group.docTypes.add(event.docType);
    // Only real document runs are occurrences: a request id (req-…) or a session id (ses-…) has no
    // run record to open or compare, so listing it would give "Open run" nothing to open.
    if (event.runId && !isCorrelationOnlyId(event.runId) && !group.runIds.includes(event.runId)) {
      group.runIds.push(event.runId);
    }
  }
  const all = [...groups.values()];
  for (let i = 0; i < all.length; i += UPSERT_CONCURRENCY) {
    await Promise.all(all.slice(i, i + UPSERT_CONCURRENCY).map(upsertGroup));
  }
}

export async function upsertIssueForEvent(event: IssueUpsertEvent): Promise<void> {
  await upsertIssuesForEvents([event]);
}

async function upsertGroup(group: IssueGroup): Promise<void> {
  try {
    const now = new Date();
    // projects[] and docTypes[] are both $addToSet — they must be ONE combined object, not two
    // separate `$addToSet` keys: a second bare `{ $addToSet: {...} }` object spread after the
    // first would silently overwrite it rather than merge, since both target the same top-level
    // update key.
    const addToSet: Record<string, { $each: string[] }> = {};
    if (group.projects.size) addToSet.projects = { $each: [...group.projects] };
    if (group.docTypes.size) addToSet.docTypes = { $each: [...group.docTypes] };
    const before = await Issue.findOneAndUpdate(
      { signature: group.signature, service: group.service },
      {
        $setOnInsert: {
          status: 'unresolved',
          firstSeenAt: now,
          message: group.message,
          environmentAtFirstSeen: { service: group.service, version: group.version },
        },
        $set: { lastSeenAt: now },
        $inc: { count: group.count },
        ...(Object.keys(addToSet).length ? { $addToSet: addToSet } : {}),
        ...(group.runIds.length
          ? { $push: { occurrenceRunIds: { $each: group.runIds, $slice: -ISSUE_OCCURRENCE_RUN_IDS_CAP } } }
          : {}),
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
