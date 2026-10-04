// Backs GET /diagnostics/overview — the Monitoring tab's header counts. No pagination
// precedent exists elsewhere in this repo to follow; this is intentionally the simplest
// query that answers "is anything wrong": one grouped count over DocumentRun, three
// countDocuments over Issue.
import { DocumentRun } from '../../models/DocumentRun';
import { Issue } from '../../models/Issue';

const DEFAULT_WINDOW_HOURS = 24;
const RESOLVED_RECENTLY_DAYS = 7;

export interface RunCounts {
  windowHours: number;
  total: number;
  succeeded: number;
  failed: number;
  running: number;
}

export interface IssueCounts {
  unresolved: number;
  regressed: number;
  resolvedRecently: number;
}

export async function getRunCounts(windowHours: number = DEFAULT_WINDOW_HOURS): Promise<RunCounts> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  // Served by the new {startedAt: -1} index (models/DocumentRun.ts) — the existing
  // {status:1, startedAt:-1} can't lead a startedAt-only range scan.
  const rows = await DocumentRun.aggregate([
    { $match: { startedAt: { $gte: since } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const byStatus = new Map<string, number>(rows.map((r: any) => [r._id, r.count]));
  const succeeded = byStatus.get('succeeded') ?? 0;
  const failed = byStatus.get('failed') ?? 0;
  const running = byStatus.get('running') ?? 0;
  return { windowHours, total: succeeded + failed + running, succeeded, failed, running };
}

export async function getIssueCounts(): Promise<IssueCounts> {
  const resolvedSince = new Date(Date.now() - RESOLVED_RECENTLY_DAYS * 24 * 60 * 60 * 1000);
  const [unresolved, regressed, resolvedRecently] = await Promise.all([
    // Served by {status:1, lastSeenAt:-1}.
    Issue.countDocuments({ status: 'unresolved' }),
    // regressedAt is kept as history and is never cleared on a later re-resolve (Phase 6c) —
    // "currently a regression" means unresolved AND it was set at some point.
    Issue.countDocuments({ status: 'unresolved', regressedAt: { $exists: true } }),
    Issue.countDocuments({ status: 'resolved', resolvedAt: { $gte: resolvedSince } }),
  ]);
  return { unresolved, regressed, resolvedRecently };
}
