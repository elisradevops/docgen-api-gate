// Backs GET /diagnostics/issues and GET /diagnostics/issues/:issueId. Issue.docTypes[] is
// still permanently unpopulated (see models/Issue.ts) — 7a doesn't need it: a Needs Attention
// row's doc type comes from one batched DocumentRun lookup over the issues' occurrenceRunIds,
// keyed on the newest run (occurrenceRunIds is chronological, oldest-first — see
// helpers/diagnostics/issueUpsert.ts's $push+$slice), never persisted onto Issue itself.
import { Issue, IIssue } from '../../models/Issue';
import { DocumentRun } from '../../models/DocumentRun';
import { LogEvent } from '../../models/LogEvent';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TREND_HOURS = 24;

export interface ListIssuesParams {
  status?: string;
  service?: string;
  project?: string;
  since?: Date;
  limit?: number;
}

export interface IssueListItem {
  issue: IIssue;
  docType?: string;
}

function clampLimit(raw?: number): number {
  if (!raw || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIST_LIMIT);
}

async function lookupLatestDocTypes(issues: IIssue[]): Promise<Map<string, string>> {
  const latestRunIdByIssueId = new Map<string, string>();
  const allRunIds = new Set<string>();
  for (const issue of issues) {
    const runIds = issue.occurrenceRunIds || [];
    const latest = runIds[runIds.length - 1];
    if (latest) {
      latestRunIdByIssueId.set(String(issue._id), latest);
      allRunIds.add(latest);
    }
  }
  if (allRunIds.size === 0) return new Map();

  const runs = await DocumentRun.find(
    { runId: { $in: [...allRunIds] }, docType: { $ne: null } },
    { runId: 1, docType: 1 }
  ).lean();
  const docTypeByRunId = new Map(runs.map((r: any) => [r.runId, r.docType as string]));

  const result = new Map<string, string>();
  for (const [issueId, runId] of latestRunIdByIssueId) {
    const docType = docTypeByRunId.get(runId);
    if (docType) result.set(issueId, docType);
  }
  return result;
}

export async function listIssues(params: ListIssuesParams): Promise<IssueListItem[]> {
  const status = params.status === 'resolved' ? 'resolved' : 'unresolved';
  const filter: Record<string, unknown> = { status };
  if (params.service) filter.service = params.service;
  if (params.project) filter.projects = params.project;
  if (params.since) filter.lastSeenAt = { $gte: params.since };

  // Served by {status:1, lastSeenAt:-1} — "newest-recurrence-first", the index's own stated
  // purpose (Issue.ts:76).
  const issues = await Issue.find(filter).sort({ lastSeenAt: -1 }).limit(clampLimit(params.limit));
  const docTypeByIssueId = await lookupLatestDocTypes(issues);
  return issues.map((issue) => ({ issue, docType: docTypeByIssueId.get(String(issue._id)) }));
}

export interface IssueDetail {
  issue: IIssue;
  trend: Array<{ hoursAgo: number; count: number }>;
  occurrences: Array<{ runId: string; startedAt?: Date; status?: string; project?: string; docType?: string }>;
}

export async function getIssueDetail(issueId: string): Promise<IssueDetail | undefined> {
  const issue = await Issue.findById(issueId);
  if (!issue) return undefined;

  const since = new Date(Date.now() - TREND_HOURS * 60 * 60 * 1000);
  // Served by {signature:1, ts:-1}.
  const buckets = await LogEvent.aggregate([
    { $match: { signature: issue.signature, service: issue.service, ts: { $gte: since } } },
    {
      $group: {
        _id: { $floor: { $divide: [{ $subtract: [new Date(), '$ts'] }, 60 * 60 * 1000] } },
        count: { $sum: 1 },
      },
    },
  ]);
  const countByHoursAgo = new Map<number, number>(buckets.map((b: any) => [b._id, b.count]));
  const trend = Array.from({ length: TREND_HOURS }, (_, i) => {
    const hoursAgo = TREND_HOURS - 1 - i;
    return { hoursAgo, count: countByHoursAgo.get(hoursAgo) ?? 0 };
  });

  const runIds = issue.occurrenceRunIds || [];
  const runs = runIds.length
    ? await DocumentRun.find(
        { runId: { $in: runIds } },
        { runId: 1, startedAt: 1, status: 1, project: 1, docType: 1 }
      ).lean()
    : [];
  const runByRunId = new Map(runs.map((r: any) => [r.runId, r]));
  const occurrences = runIds
    .slice()
    .reverse() // newest first, matching the list's own default sort
    .map((runId) => {
      const run = runByRunId.get(runId);
      return {
        runId,
        startedAt: run?.startedAt,
        status: run?.status,
        project: run?.project,
        docType: run?.docType,
      };
    });

  return { issue, trend, occurrences };
}
