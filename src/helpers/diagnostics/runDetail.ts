// Backs GET /diagnostics/runs/:runId (Phase 7c) — the first place `DocumentRun.manifest` is
// ever read back, not just written. Also the shared run-fetch this repo's compare and report
// endpoints reuse, so "what is a run" has exactly one definition.
import { DocumentRun, IDocumentRun, IDocumentRunManifestStep } from '../../models/DocumentRun';
import { LogEvent } from '../../models/LogEvent';
import logger from '../../util/logger';

// manifest.steps[] has no `service` field and no per-step absolute timestamp (only
// durationMs) — this is the only honest derivation available, not stored fact. A step type
// added later needs an entry here or it falls back to 'unknown'.
const STEP_SERVICE_BY_TYPE: Record<string, string> = {
  'generate-doc-template': 'dg-content-control',
  'generate-content-control': 'dg-content-control',
  'render-document': 'json-to-word',
};

export interface TimelineEntry {
  name: string;
  type: string;
  service: string;
  status: 'succeeded' | 'failed';
  startOffsetMs: number;
  durationMs: number;
  errorCount: number;
  warnCount?: number;
  outputSummary?: Record<string, unknown>;
}

// Cumulative offsets from run.startedAt, summed in manifest.steps[] array order — the only
// ordering signal available, since steps carry no absolute timestamp of their own.
export function buildTimeline(steps: IDocumentRunManifestStep[] | undefined): TimelineEntry[] {
  let cursor = 0;
  return (steps || []).map((step) => {
    const entry: TimelineEntry = {
      name: step.name,
      type: step.type,
      service: STEP_SERVICE_BY_TYPE[step.type] || 'unknown',
      status: step.status,
      startOffsetMs: cursor,
      durationMs: step.durationMs,
      errorCount: step.errorCount,
      warnCount: step.warnCount,
      outputSummary: step.outputSummary,
    };
    cursor += step.durationMs;
    return entry;
  });
}

export interface LoggedCountRow {
  level: 'error' | 'warn';
  // The content control the event was attributed to; absent for events outside any content control.
  title?: string;
  count: number;
}

// A step's stored errorCount only says whether the step threw (runManifest.buildStep), and warnCount is
// never stored. A step that logged errors but carried on (a caught-and-skipped artifact, say) is
// "succeeded" with errorCount 0 there. The log events are the only record of that, so they are merged in
// at read time: never lowering a stored count, and never storing a number the run did not produce.
export function applyLoggedCounts(timeline: TimelineEntry[], rows: LoggedCountRow[]): TimelineEntry[] {
  if (rows.length === 0) return timeline;
  const byTitle = new Map<string, { errors: number; warnings: number }>();
  for (const row of rows) {
    if (!row.title) continue;
    const entry = byTitle.get(row.title) ?? { errors: 0, warnings: 0 };
    if (row.level === 'error') entry.errors += row.count;
    else entry.warnings += row.count;
    byTitle.set(row.title, entry);
  }
  return timeline.map((step) => {
    const logged = byTitle.get(step.name);
    if (!logged) return step;
    return {
      ...step,
      errorCount: Math.max(step.errorCount, logged.errors),
      warnCount: Math.max(step.warnCount ?? 0, logged.warnings),
    };
  });
}

export interface RunDetail {
  run: IDocumentRun;
  timeline: TimelineEntry[];
  // Error / warn events logged under this run (any service), whatever the run's own status says.
  // Undefined when the log store could not be read, which says nothing about the run.
  loggedErrors?: number;
  loggedWarnings?: number;
}

async function getLoggedCounts(runId: string): Promise<LoggedCountRow[] | undefined> {
  try {
    const rows = await LogEvent.aggregate([
      { $match: { runId, level: { $in: ['error', 'warn'] } } },
      { $group: { _id: { level: '$level', title: '$contentControlTitle' }, count: { $sum: 1 } } },
    ]);
    return rows.map((r: any) => ({ level: r._id.level, title: r._id.title || undefined, count: r.count }));
  } catch (err: any) {
    // The run itself is still worth showing without its log counts.
    logger.warn(`Could not count logged errors for run ${runId}: ${err?.message ?? err}`);
    return undefined;
  }
}

// `loggedCounts: false` for callers that only read `run` (compare, baseline) and would otherwise pay
// for the log aggregation and throw its result away.
export async function getRunDetail(
  runId: string,
  options: { loggedCounts?: boolean } = {}
): Promise<RunDetail | undefined> {
  const run = await DocumentRun.findOne({ runId });
  if (!run) return undefined;
  const timeline = buildTimeline(run.manifest?.steps);
  if (options.loggedCounts === false) return { run, timeline };
  const rows = await getLoggedCounts(runId);
  if (!rows) return { run, timeline };
  const total = (level: LoggedCountRow['level']) =>
    rows.filter((r) => r.level === level).reduce((sum, r) => sum + r.count, 0);
  return {
    run,
    timeline: applyLoggedCounts(timeline, rows),
    loggedErrors: total('error'),
    loggedWarnings: total('warn'),
  };
}
