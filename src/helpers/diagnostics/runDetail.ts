// Backs GET /diagnostics/runs/:runId (Phase 7c) — the first place `DocumentRun.manifest` is
// ever read back, not just written. Also the shared run-fetch this repo's compare and report
// endpoints reuse, so "what is a run" has exactly one definition.
import { DocumentRun, IDocumentRun, IDocumentRunManifestStep } from '../../models/DocumentRun';

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

export interface RunDetail {
  run: IDocumentRun;
  timeline: TimelineEntry[];
}

export async function getRunDetail(runId: string): Promise<RunDetail | undefined> {
  const run = await DocumentRun.findOne({ runId });
  if (!run) return undefined;
  return { run, timeline: buildTimeline(run.manifest?.steps) };
}
