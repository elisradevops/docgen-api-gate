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

export type FindingKey = 'runs' | 'outcome' | 'range' | 'funnel' | 'credential' | 'access' | 'inputs' | 'unexplained';

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

const describeRange = (range: any, withSource = true): string => {
  if (!isObject(range)) return 'not recorded';
  const side = (s: any) => {
    if (!isObject(s)) return 'not recorded';
    if (s.id === undefined || s.id === null) {
      if (s.source === 'none') return 'none found (baseline)';
      return s.source === 'auto' ? 'not resolved (auto-discovery found nothing)' : 'not recorded';
    }
    return `#${s.id}${withSource && s.source ? ` (${s.source})` : ''}`;
  };
  const name = range.definition?.name ? ` "${range.definition.name}"` : range.definition?.id ? ` #${range.definition.id}` : '';
  return `${range.rangeType || 'range'}${name}: from ${side(range.from)} to ${side(range.to)}`;
};

const ACCESS_LABEL: Record<string, string> = {
  project: 'project visibility',
  repositories: 'repositories',
  workItems: 'work items',
  builds: 'build definitions',
  releases: 'release definitions',
  testPlans: 'test plans',
};
const ACCESS_ORDER = Object.keys(ACCESS_LABEL);

const describeAccessArea = (area: any, name?: string): string => {
  if (!isObject(area)) return 'not recorded';
  if (area.status === 'ok') {
    if (name === 'project') return 'visible';
    // The work-item read asks for one item (WIQL top 1), so its count only says whether any are visible.
    if (name === 'workItems') return area.count ? 'some visible' : 'none visible';
    return `${area.count ?? '?'} visible`;
  }
  if (area.status === 'denied') return `denied${area.httpStatus ? ` (${area.httpStatus})` : ''}`;
  // 404 on the project means the project is not in the credential's list; elsewhere it can also be an API the server lacks.
  if (area.status === 'notFound') return name === 'project' ? 'not visible' : 'not available';
  return 'could not be read';
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
  const base = identity ? `${kind}, ${identity}` : kind;
  return credential.name ? `${base} "${credential.name}"` : base;
};

// emptyResult: true = nothing was produced, false = output, undefined = the run did not record it.
const emptyWord = (emptyResult: unknown): string =>
  emptyResult === undefined ? 'an unrecorded result' : emptyResult ? 'nothing' : 'output';

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
      text: `Step "${step}" produced ${emptyWord(row.a)} in run A but ${emptyWord(row.b)} in run B.`,
      a: row.a,
      b: row.b,
    });
  }
  const outcomeDiffers = findings.some((f) => f.key === 'outcome');

  // 2) Was it the same range? (an omitted from/to is auto-discovered, so the same request can resolve differently)
  const rangeA: any = runA.manifest?.inputs?.resolvedRange;
  const rangeB: any = runB.manifest?.inputs?.resolvedRange;
  if (rangeA && rangeB) {
    // The versions are what matters; HOW each run got them (discovered or given) and the names are not a
    // difference in range.
    const same =
      rangeA.rangeType === rangeB.rangeType &&
      rangeA.definition?.id === rangeB.definition?.id &&
      rangeA.from?.id === rangeB.from?.id &&
      rangeA.to?.id === rangeB.to?.id;
    const route = (['from', 'to'] as const)
      .filter((side) => rangeA[side]?.source && rangeB[side]?.source && rangeA[side].source !== rangeB[side].source)
      .map((side) => `${side}: ${rangeA[side].source === 'auto' ? 'discovered' : 'given'} in run A, ${rangeB[side].source === 'auto' ? 'discovered' : 'given'} in run B`);
    findings.push({
      key: 'range',
      severity: same ? 'info' : 'severe',
      text: same
        ? `Both runs used the same versions (${describeRange(rangeA, false)}), so the range is not the cause${route.length ? ` (${route.join('; ')})` : ''}.`
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
  const stageRank = (row: DiffRow) => {
    const index = FUNNEL_STAGES.indexOf(stageOf(row));
    return index === -1 ? Number.POSITIVE_INFINITY : index; // a stage this code does not know sorts last
  };
  const firstDiverging = [...funnelChanged].sort((x, y) => stageRank(x) - stageRank(y))[0];
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

  // 4) Who ran it: a build service and a person do not see the same repositories and work items. A field
  // only one run recorded (the probe was off or timed out, or capture was not authorized) is not a difference.
  const credA = runA.manifest?.environment?.credential;
  const credB = runB.manifest?.environment?.credential;
  const credentialFields = ['kind', 'identity', 'name'] as const;
  const differingCredential = credentialFields.filter(
    (f) => credA?.[f] !== undefined && credB?.[f] !== undefined && credA[f] !== credB[f]
  );
  if (differingCredential.length > 0) {
    findings.push({
      key: 'credential',
      severity: 'severe',
      text: `The runs used different credentials. Run A: ${describeCredential(credA)}. Run B: ${describeCredential(credB)}. Different identities can see different repositories and work items.`,
      a: credA,
      b: credB,
    });
  } else if (credentialFields.some((f) => (credA?.[f] === undefined) !== (credB?.[f] === undefined))) {
    findings.push({
      key: 'credential',
      severity: 'info',
      text: `Not every detail of who ran each run was recorded. Run A: ${describeCredential(credA)}. Run B: ${describeCredential(credB)}.`,
      a: credA,
      b: credB,
    });
  }

  // 4b) What each credential could actually see in the project: Azure DevOps often answers a reader without
  // access with a shorter list rather than an error, so the counts are the evidence.
  const accessA = runA.manifest?.environment?.credential?.access;
  const accessB = runB.manifest?.environment?.credential?.access;
  if (isObject(accessA) && isObject(accessB)) {
    const differing = ACCESS_ORDER.filter(
      (area) => describeAccessArea(accessA[area], area) !== describeAccessArea(accessB[area], area)
    );
    // A difference in access matters when a status differs, or the project/repository/work-item visibility does;
    // build, release and test-plan definition counts changing between runs made days apart do not explain much.
    const meaningful = differing.some(
      (area) =>
        (accessA[area] as any)?.status !== (accessB[area] as any)?.status ||
        area === 'project' ||
        area === 'repositories' ||
        area === 'workItems'
    );
    const notOk = ACCESS_ORDER.filter((area) => {
      const outcomes = [accessA[area], accessB[area]].filter(isObject);
      return outcomes.length > 0 && outcomes.some((o) => o.status !== 'ok');
    });
    findings.push(
      differing.length > 0
        ? {
            key: 'access',
            severity: meaningful ? 'severe' : 'info',
            text: `What the credentials could see in the project differs: ${differing
              .map((area) => `${ACCESS_LABEL[area]} — ${describeAccessArea(accessA[area], area)} in run A, ${describeAccessArea(accessB[area], area)} in run B`)
              .join('; ')}.`,
            a: accessA,
            b: accessB,
          }
        : {
            key: 'access',
            severity: 'info',
            text:
              notOk.length === 0
                ? 'Both credentials could see the same in the project, so missing permissions are not the cause.'
                : `Both credentials had the same access in the project, including areas neither could read (${notOk
                    .map((area) => `${ACCESS_LABEL[area]}: ${describeAccessArea(accessA[area], area)}`)
                    .join('; ')}): a difference in permissions between them is not the cause, but both were missing access.`,
            a: accessA,
            b: accessB,
          }
    );
  } else if (isObject(accessA) || isObject(accessB)) {
    const only = isObject(accessA) ? accessA : (accessB as Record<string, any>);
    findings.push({
      key: 'access',
      severity: 'info',
      text: `Only run ${isObject(accessA) ? 'A' : 'B'} recorded what its credential could see: ${ACCESS_ORDER.filter((area) => only[area])
        .map((area) => `${ACCESS_LABEL[area]} ${describeAccessArea(only[area], area)}`)
        .join(', ')}.`,
    });
  }

  // 5) Other differences in what was asked for. A content control that exists in only one run would
  // otherwise list every one of its fields; say it once.
  // The from/to of an SVD control are what the range finding is about: with both ranges recorded, the raw
  // request ('' for a version to be discovered, the number for one that was given) is not a difference.
  const rangeCovered = !!rangeA && !!rangeB;
  let inputRows = inputs.filter(
    (r) =>
      !r.field.startsWith('resolvedRange') &&
      !r.field.startsWith('resolvedContextName') &&
      !(rangeCovered && /\.data\.(from|to|fromText|toText)$/.test(r.field))
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

  // Nothing recorded explains it: say so, and only claim what was actually checked.
  const explains = findings.some(
    (f) => f.severity !== 'info' && (f.key === 'range' || f.key === 'funnel' || f.key === 'credential' || f.key === 'access')
  );
  if (outcomeDiffers && !explains) {
    const ruledOut = [
      findings.some((f) => f.key === 'range' && f.severity === 'info' && f.text.startsWith('Both runs used the same versions')) ? 'the range' : '',
      findings.some((f) => f.key === 'funnel' && f.severity === 'info') ? 'the counts at every recorded stage' : '',
      findings.some((f) => f.key === 'access' && f.severity === 'info' && f.text.startsWith('Both credentials')) ? 'what the credentials could see' : '',
      credA?.kind !== undefined && credA?.kind === credB?.kind ? 'the kind of credential' : '',
    ].filter(Boolean);
    findings.push({
      key: 'unexplained',
      severity: 'moderate',
      text: `Nothing recorded for these runs explains the difference in outcome${
        ruledOut.length > 0 ? ` (the same: ${ruledOut.join(', ')})` : ' (the runs recorded little to compare)'
      }. Look at each run's logs (run the manual one with Detailed diagnostics on).`,
    });
  } else if (findings.length === 0) {
    findings.push({ key: 'unexplained', severity: 'info', text: 'Nothing recorded differs between these two runs.' });
  }

  return findings;
}
