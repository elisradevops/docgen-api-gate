// Backs GET /diagnostics/compare (Phase 7c) — one generic tree diff over
// environment/inputs/steps/artifacts, per the master plan's explicit design: no per-doc-type
// comparison code, so a new document type gets comparison for free.
import { DocumentRun, IDocumentRun, IDocumentRunManifestStep } from '../../models/DocumentRun';

export type DiffSeverity = 'severe' | 'moderate' | 'info';

export interface DiffRow {
  field: string;
  a: unknown;
  b: unknown;
  severity: DiffSeverity;
}

export interface ManifestDiff {
  crossType: boolean;
  bands: {
    outcomes: DiffRow[];
    volumes: DiffRow[];
    environment: DiffRow[];
    inputs: DiffRow[];
    unchanged: DiffRow[];
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Structural equality good enough for diffing free-form Mixed data — not a general deep-equal
// library dependency for one call site.
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

// Stable keys tried in order when matching array elements that are plain objects — the first
// key for which every element in the combined array has a string value wins.
const ARRAY_MATCH_KEYS = ['title', 'name', 'id', 'type'];

function findArrayMatchKey(arr: unknown[]): string | null {
  const objs = arr.filter(isPlainObject) as Record<string, unknown>[];
  if (objs.length === 0) return null;
  for (const key of ARRAY_MATCH_KEYS) {
    if (objs.every((o) => typeof o[key] === 'string')) return key;
  }
  return null;
}

// Generic recursive diff over two arbitrary (Mixed) trees — must tolerate missing keys and
// nested objects/arrays without assuming a schema, the same tolerance redactValue/buildInputs
// already need for this same manifest.inputs field elsewhere in this repo.
// Arrays of plain objects are matched by a stable key (title/name/id/type) when one exists,
// falling back to index order. Arrays of primitives are compared atomically — index-by-index
// diffing for e.g. [15,16,30] vs [15,16,30,32] produces too many low-signal rows.
function diffTree(a: unknown, b: unknown, severity: DiffSeverity, prefix = ''): { changed: DiffRow[]; unchanged: DiffRow[] } {
  const changed: DiffRow[] = [];
  const unchanged: DiffRow[] = [];

  if (isPlainObject(a) || isPlainObject(b)) {
    const keys = new Set([...Object.keys(isPlainObject(a) ? a : {}), ...Object.keys(isPlainObject(b) ? b : {})]);
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const av = isPlainObject(a) ? a[key] : undefined;
      const bv = isPlainObject(b) ? b[key] : undefined;
      const nested = diffTree(av, bv, severity, path);
      changed.push(...nested.changed);
      unchanged.push(...nested.unchanged);
    }
    return { changed, unchanged };
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    const arrA = Array.isArray(a) ? a : [];
    const arrB = Array.isArray(b) ? b : [];
    const allElements = [...arrA, ...arrB];
    const matchKey = findArrayMatchKey(allElements);

    if (matchKey) {
      // Objects with a stable key — match by key value and recurse into each pair.
      const mapA = new Map((arrA.filter(isPlainObject) as Record<string, unknown>[]).map((o) => [o[matchKey] as string, o]));
      const mapB = new Map((arrB.filter(isPlainObject) as Record<string, unknown>[]).map((o) => [o[matchKey] as string, o]));
      const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
      for (const key of allKeys) {
        const path = prefix ? `${prefix}[${key}]` : `[${key}]`;
        const nested = diffTree(mapA.get(key), mapB.get(key), severity, path);
        changed.push(...nested.changed);
        unchanged.push(...nested.unchanged);
      }
    } else {
      // Primitive arrays or arrays without a stable key — compare atomically so we get one
      // readable row per field rather than a row-per-index flood.
      if (valuesEqual(a, b)) {
        unchanged.push({ field: prefix, a, b, severity });
      } else {
        changed.push({ field: prefix, a, b, severity });
      }
    }
    return { changed, unchanged };
  }

  if (valuesEqual(a, b)) {
    unchanged.push({ field: prefix, a, b, severity });
  } else {
    changed.push({ field: prefix, a, b, severity });
  }
  return { changed, unchanged };
}

// Steps are matched by name first (stable within one doc type's own template), falling back
// to type when names don't align — the expected case for a genuine cross-type comparison,
// where step names for different content controls won't match at all.
function matchSteps(
  stepsA: IDocumentRunManifestStep[],
  stepsB: IDocumentRunManifestStep[]
): Array<{ a?: IDocumentRunManifestStep; b?: IDocumentRunManifestStep }> {
  const byNameB = new Map(stepsB.map((s) => [s.name, s]));
  const matchedBNames = new Set<string>();
  const pairs: Array<{ a?: IDocumentRunManifestStep; b?: IDocumentRunManifestStep }> = [];

  for (const stepA of stepsA) {
    const byName = byNameB.get(stepA.name);
    if (byName) {
      pairs.push({ a: stepA, b: byName });
      matchedBNames.add(stepA.name);
      continue;
    }
    const byType = stepsB.find((s) => s.type === stepA.type && !matchedBNames.has(s.name));
    if (byType) {
      pairs.push({ a: stepA, b: byType });
      matchedBNames.add(byType.name);
    } else {
      pairs.push({ a: stepA, b: undefined });
    }
  }
  for (const stepB of stepsB) {
    if (!matchedBNames.has(stepB.name)) pairs.push({ a: undefined, b: stepB });
  }
  return pairs;
}

export function diffManifests(runA: IDocumentRun, runB: IDocumentRun): ManifestDiff {
  const crossType = runA.docType !== runB.docType || runA.project !== runB.project;
  const bands: ManifestDiff['bands'] = { outcomes: [], volumes: [], environment: [], inputs: [], unchanged: [] };

  const stepsA = runA.manifest?.steps || [];
  const stepsB = runB.manifest?.steps || [];
  for (const pair of matchSteps(stepsA, stepsB)) {
    const label = pair.a?.name || pair.b?.name || 'unknown step';
    if (!pair.a || !pair.b) {
      bands.outcomes.push({
        field: label,
        a: pair.a ? pair.a.status : undefined,
        b: pair.b ? pair.b.status : undefined,
        severity: 'severe',
      });
      continue;
    }
    if (pair.a.status !== pair.b.status) {
      bands.outcomes.push({ field: label, a: pair.a.status, b: pair.b.status, severity: 'severe' });
    } else {
      bands.unchanged.push({ field: `${label}.status`, a: pair.a.status, b: pair.b.status, severity: 'info' });
    }
    const summaryDiff = diffTree(pair.a.outputSummary, pair.b.outputSummary, 'moderate', label);
    bands.volumes.push(...summaryDiff.changed);
    bands.unchanged.push(...summaryDiff.unchanged);
  }

  const envDiff = diffTree(runA.manifest?.environment, runB.manifest?.environment, 'info');
  bands.environment.push(...envDiff.changed);
  bands.unchanged.push(...envDiff.unchanged);

  const inputsDiff = diffTree(runA.manifest?.inputs, runB.manifest?.inputs, 'info');
  bands.inputs.push(...inputsDiff.changed);
  bands.unchanged.push(...inputsDiff.unchanged);

  const topLevelDiff = diffTree(
    { templateName: runA.templateName, docType: runA.docType, project: runA.project },
    { templateName: runB.templateName, docType: runB.docType, project: runB.project },
    'info'
  );
  // A top-level mismatch here (docType/project) is exactly what `crossType` already flags —
  // surfaced as the banner, not duplicated as an ordinary diff row.
  bands.unchanged.push(...topLevelDiff.unchanged);
  for (const row of topLevelDiff.changed) {
    if (row.field !== 'docType' && row.field !== 'project') bands.inputs.push(row);
  }

  return { crossType, bands };
}

// "Compare to baseline" — most recent successful run of the same project+docType, excluding
// the run itself. Served by DocumentRun's {project,docType,status,startedAt:-1} index.
export async function findBaselineRun(run: IDocumentRun): Promise<IDocumentRun | undefined> {
  const baseline = await DocumentRun.findOne({
    project: run.project,
    docType: run.docType,
    status: 'succeeded',
    runId: { $ne: run.runId },
  }).sort({ startedAt: -1 });
  return baseline || undefined;
}
