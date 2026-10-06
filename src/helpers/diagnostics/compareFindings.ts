// "Why did these two runs differ?" in a few plain sentences, read from the generic manifest diff and
// the two runs. Written for the case this screen exists for: an Auto SVD run (a pipeline, with a build
// service credential and auto-discovered versions) came back empty, while the same input run by hand in
// the UI did not - and the people with access to the evidence are on another network, so what they can
// export has to say where the runs diverge first, and what has been ruled out.
//
// Pure: no I/O, no schema. It looks only at facts the runs record anyway (step statuses, the output
// summary incl. the funnel, environment.credential, inputs.resolvedRange, the input data), so it is
// exactly as good as what was recorded, and says so when nothing explains the difference.
import { IDocumentRun } from '../../models/DocumentRun';
import { DiffRow, DiffSeverity, ManifestDiff } from './manifestDiff';

export type FindingKey = 'runs' | 'outcome' | 'range' | 'funnel' | 'credential' | 'inputs' | 'unexplained';

export interface Finding {
  key: FindingKey;
  severity: DiffSeverity;
  text: string;
  a?: unknown;
  b?: unknown;
}

// The stages an SVD loses items at, in the order they happen.
const FUNNEL_STAGES = ['artifacts', 'linkedChanges', 'unlinkedCommits', 'knownBugs'];
const MAX_INPUT_FINDINGS = 6;

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

const describeRange = (range: any): string => {
  if (!isObject(range)) return 'not recorded';
  const side = (s: any) => {
    if (!isObject(s)) return 'not recorded';
    if (s.id === undefined || s.id === null) {
      if (s.source === 'none') return 'none found (baseline)';
      return s.source === 'auto' ? 'not resolved (auto-discovery found nothing)' : 'not recorded';
    }
    return `#${s.id}${s.source ? ` (${s.source})` : ''}`;
  };
  const name = range.definition?.name ? ` "${range.definition.name}"` : range.definition?.id ? ` #${range.definition.id}` : '';
  return `${range.rangeType || 'range'}${name}: from ${side(range.from)} to ${side(range.to)}`;
};

const describeCredential = (credential: any): string => {
  if (!isObject(credential)) return 'not recorded';
  const kind = credential.kind === 'bearer' ? 'a bearer token' : credential.kind === 'pat' ? 'a personal access token' : 'an unknown credential';
  const identity =
    credential.identity === 'build-service'
      ? 'a build service identity'
      : credential.identity === 'user'
        ? 'a user'
        : credential.identity === 'unknown'
          ? 'an identity of unknown kind'
          : '';
  return identity ? `${kind}, ${identity}` : kind;
};

const rowsEndingWith = (rows: DiffRow[], suffix: string) => rows.filter((r) => r.field.endsWith(suffix));

export function buildCompareFindings(runA: IDocumentRun, runB: IDocumentRun, diff: ManifestDiff): Finding[] {
  const findings: Finding[] = [];
  const { outcomes, volumes, environment, inputs, unchanged } = diff.bands;

  if (runA.trigger && runB.trigger && runA.trigger !== runB.trigger) {
    findings.push({
      key: 'runs',
      severity: 'info',
      text: `Run A was started by ${runA.trigger === 'pipeline' ? 'a pipeline' : 'the UI'}, run B by ${runB.trigger === 'pipeline' ? 'a pipeline' : 'the UI'}.`,
      a: runA.trigger,
      b: runB.trigger,
    });
  }

  // 1) Did the outcome differ, and where?
  for (const row of outcomes) {
    findings.push({
      key: 'outcome',
      severity: 'severe',
      text: `Step "${row.field}" ${row.a === undefined ? 'exists only in run B' : row.b === undefined ? 'exists only in run A' : `finished "${row.a}" in run A but "${row.b}" in run B`}.`,
      a: row.a,
      b: row.b,
    });
  }
  for (const row of rowsEndingWith(volumes, '.emptyResult')) {
    const step = row.field.slice(0, -'.emptyResult'.length);
    findings.push({
      key: 'outcome',
      severity: 'severe',
      text: `Step "${step}" produced ${row.a ? 'nothing' : 'output'} in run A but ${row.b ? 'nothing' : 'output'} in run B.`,
      a: row.a,
      b: row.b,
    });
  }
  const outcomeDiffers = findings.some((f) => f.key === 'outcome');

  // 2) Was it the same range? (an omitted from/to is auto-discovered, so the same request can resolve differently)
  const rangeA = runA.manifest?.inputs?.resolvedRange;
  const rangeB = runB.manifest?.inputs?.resolvedRange;
  if (rangeA && rangeB) {
    const same = JSON.stringify(rangeA) === JSON.stringify(rangeB);
    findings.push({
      key: 'range',
      severity: same ? 'info' : 'severe',
      text: same
        ? `Both runs resolved the same range (${describeRange(rangeA)}), so the range is not the cause.`
        : `The runs resolved different ranges. Run A: ${describeRange(rangeA)}. Run B: ${describeRange(rangeB)}.`,
      a: rangeA,
      b: rangeB,
    });
  } else if (rangeA || rangeB) {
    findings.push({
      key: 'range',
      severity: 'info',
      text: `Only run ${rangeA ? 'A' : 'B'} recorded the range it resolved to: ${describeRange(rangeA || rangeB)}. The other has none to compare.`,
      a: rangeA,
      b: rangeB,
    });
  }

  // 3) The first stage where the counts diverge.
  const funnelChanged = volumes.filter((r) => /\.funnel\./.test(r.field));
  const funnelUnchanged = unchanged.filter((r) => /\.funnel\./.test(r.field));
  const stageOf = (row: DiffRow) => row.field.split('.funnel.')[1] || '';
  const firstDiverging = [...funnelChanged].sort(
    (x, y) => FUNNEL_STAGES.indexOf(stageOf(x)) - FUNNEL_STAGES.indexOf(stageOf(y))
  )[0];
  if (firstDiverging) {
    findings.push({
      key: 'funnel',
      severity: 'severe',
      text: `The counts first diverge at "${stageOf(firstDiverging)}": ${firstDiverging.a ?? 'not recorded'} in run A, ${firstDiverging.b ?? 'not recorded'} in run B.`,
      a: firstDiverging.a,
      b: firstDiverging.b,
    });
  } else if (funnelUnchanged.length > 0) {
    findings.push({
      key: 'funnel',
      severity: 'info',
      text: 'Both runs found the same number of items at every recorded stage.',
    });
  }

  // 4) Who ran it: a build service and a person do not see the same repositories and work items.
  const credentialRows = environment.filter((r) => r.field.startsWith('credential'));
  if (credentialRows.length > 0) {
    const credA = runA.manifest?.environment?.credential;
    const credB = runB.manifest?.environment?.credential;
    findings.push({
      key: 'credential',
      severity: 'severe',
      text: `The runs used different credentials. Run A: ${describeCredential(credA)}. Run B: ${describeCredential(credB)}. Different identities can see different repositories and work items.`,
      a: credA,
      b: credB,
    });
  }

  // 5) Other differences in what was asked for. A content control that exists in only one run would
  // otherwise list every one of its fields; say it once.
  let inputRows = inputs.filter(
    (r) => !r.field.startsWith('resolvedRange') && !r.field.startsWith('resolvedContextName')
  );
  const controlOf = (field: string) => /^contentControls\[([^\]]*)\]/.exec(field)?.[1];
  const controls = new Set(inputRows.map((r) => controlOf(r.field)).filter((c): c is string => c !== undefined));
  for (const control of controls) {
    const rows = inputRows.filter((r) => controlOf(r.field) === control);
    const onlyInA = rows.every((r) => r.b === undefined);
    const onlyInB = rows.every((r) => r.a === undefined);
    if (rows.length > 1 && (onlyInA || onlyInB)) {
      findings.push({
        key: 'inputs',
        severity: 'info',
        text: `Content control "${control}" exists only in run ${onlyInA ? 'A' : 'B'}.`,
      });
      inputRows = inputRows.filter((r) => controlOf(r.field) !== control);
    }
  }
  for (const row of inputRows.slice(0, MAX_INPUT_FINDINGS)) {
    findings.push({
      key: 'inputs',
      severity: 'info',
      text: `Input "${row.field}" differs: ${JSON.stringify(row.a) ?? 'not set'} in run A, ${JSON.stringify(row.b) ?? 'not set'} in run B.`,
      a: row.a,
      b: row.b,
    });
  }
  if (inputRows.length > MAX_INPUT_FINDINGS) {
    findings.push({
      key: 'inputs',
      severity: 'info',
      text: `${inputRows.length - MAX_INPUT_FINDINGS} more input differences are listed below.`,
    });
  }

  // Nothing recorded explains it: say so, which is itself evidence.
  const explains = findings.some(
    (f) => f.severity !== 'info' && (f.key === 'range' || f.key === 'funnel' || f.key === 'credential')
  );
  if (outcomeDiffers && !explains) {
    findings.push({
      key: 'unexplained',
      severity: 'moderate',
      text: 'Nothing recorded for these runs explains the difference in outcome: same range, same credential kind and no diverging count. Look at each run\'s logs (run the manual one with Detailed diagnostics on).',
    });
  } else if (findings.length === 0) {
    findings.push({ key: 'unexplained', severity: 'info', text: 'Nothing recorded differs between these two runs.' });
  }

  return findings;
}
