jest.mock('../../../models/DocumentRun', () => ({
  __esModule: true,
  DocumentRun: { findOne: () => ({ sort: () => undefined }) },
}));

import { diffManifests } from '../../../helpers/diagnostics/manifestDiff';
import { buildCompareFindings, Finding } from '../../../helpers/diagnostics/compareFindings';

const STEP = 'required-states-and-modes';
const range = (over: any = {}) => ({
  rangeType: 'release',
  definition: { id: 12, name: 'MyRelease' },
  to: { id: 418, name: 'Release-418', source: 'auto' },
  from: { id: 409, source: 'auto' },
  ...over,
});

// An Auto SVD run (pipeline) and a manual run (UI): by default the "came back empty" shape.
function run(over: any = {}): any {
  const { manifest: m = {}, ...rest } = over;
  return {
    runId: 'run-x',
    status: 'succeeded',
    trigger: 'pipeline',
    docType: 'SVD',
    project: 'MEWP',
    templateName: 'SVD.dotx',
    manifest: {
      steps: [
        {
          name: STEP,
          type: 'generate-content-control',
          status: 'succeeded',
          durationMs: 1,
          errorCount: 0,
          outputSummary: m.outputSummary ?? { rowCount: 0, emptyResult: true, funnel: { artifacts: 2, linkedChanges: 0, unlinkedCommits: 0, knownBugs: 0 } },
        },
      ],
      environment: m.environment ?? { credential: { kind: 'bearer', identity: 'build-service' } },
      inputs: m.inputs ?? { resolvedRange: range() },
    },
    ...rest,
  };
}

const manual = (over: any = {}) =>
  run({
    trigger: 'ui',
    ...over,
    manifest: {
      outputSummary: { rowCount: 37, emptyResult: false, funnel: { artifacts: 2, linkedChanges: 37, unlinkedCommits: 4, knownBugs: 0 } },
      environment: { credential: { kind: 'pat', identity: 'user' } },
      inputs: { resolvedRange: range() },
      ...(over.manifest || {}),
    },
  });

const findingsFor = (a: any, b: any): Finding[] => buildCompareFindings(a, b, diffManifests(a, b));
const byKey = (findings: Finding[], key: string) => findings.filter((f) => f.key === key);

describe('buildCompareFindings — an empty Auto SVD run versus the manual run', () => {
  test('names the outcome difference, the credential difference and the first diverging stage, and rules the range out', () => {
    const findings = findingsFor(run(), manual());

    expect(byKey(findings, 'runs')[0].text).toBe('Run A was started by a pipeline, run B by the UI.');
    expect(byKey(findings, 'outcome').map((f) => f.text)).toContain(`Step "${STEP}" produced nothing in run A but output in run B.`);
    expect(byKey(findings, 'range')[0]).toMatchObject({ severity: 'info' });
    expect(byKey(findings, 'range')[0].text).toContain('the range is not the cause');
    expect(byKey(findings, 'funnel')[0].text).toBe('The counts first diverge at "linkedChanges": 0 in run A, 37 in run B.');
    expect(byKey(findings, 'credential')[0].text).toContain('Run A: a bearer token, a build service identity. Run B: a personal access token, a user.');
    expect(byKey(findings, 'unexplained')).toHaveLength(0);
  });

  test('a different resolved range is a severe finding that shows both ranges', () => {
    const findings = findingsFor(run(), manual({ manifest: { inputs: { resolvedRange: range({ from: { id: 417, source: 'explicit' } }) } } }));

    const finding = byKey(findings, 'range')[0];
    expect(finding.severity).toBe('severe');
    expect(finding.text).toContain('from #409 (auto) to #418 (auto)');
    expect(finding.text).toContain('from #417 (explicit) to #418 (auto)');
  });

  test('"no previous release" is described as a baseline, not as a missing id', () => {
    const findings = findingsFor(run({ manifest: { inputs: { resolvedRange: range({ from: { source: 'none' } }) } } }), manual());

    expect(byKey(findings, 'range')[0].text).toContain('from none found (baseline)');
  });

  test('a side that auto-discovery could not resolve is said so, not shown as an unknown number', () => {
    const findings = findingsFor(
      run({ manifest: { inputs: { resolvedRange: range({ to: { source: 'auto' }, from: { source: 'auto' } }) } } }),
      manual()
    );

    expect(byKey(findings, 'range')[0].text).toContain('from not resolved (auto-discovery found nothing) to not resolved (auto-discovery found nothing)');
    expect(byKey(findings, 'range')[0].text).not.toContain('#?');
  });

  test('reports the first stage that diverges, in funnel order, not the last', () => {
    const a = run({ manifest: { outputSummary: { rowCount: 0, emptyResult: true, funnel: { artifacts: 0, linkedChanges: 0, unlinkedCommits: 0, knownBugs: 0 } } } });
    const findings = findingsFor(a, manual());

    expect(byKey(findings, 'funnel')[0].text).toContain('"artifacts": 0 in run A, 2 in run B');
  });

  test('says the counts match when every recorded stage is the same', () => {
    const same = { rowCount: 3, emptyResult: false, funnel: { artifacts: 1, linkedChanges: 3, unlinkedCommits: 0, knownBugs: 0 } };
    const findings = findingsFor(run({ manifest: { outputSummary: same } }), manual({ manifest: { outputSummary: same } }));

    expect(byKey(findings, 'funnel')[0].text).toBe('Both runs found the same number of items at every recorded stage.');
  });

  test('lists other input differences, bounded', () => {
    const data = (n: number) => ({ contentControls: [{ title: 'cc', data: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`opt${i}`, n])) }] });
    const findings = findingsFor(
      run({ manifest: { inputs: { resolvedRange: range(), ...data(1) } } }),
      manual({ manifest: { inputs: { resolvedRange: range(), ...data(2) } } })
    );

    expect(byKey(findings, 'inputs').filter((f) => f.text.startsWith('Input '))).toHaveLength(6);
    expect(byKey(findings, 'inputs').pop()!.text).toBe('3 more input differences are listed below.');
  });

  test('a content control that exists in only one run is reported once, not field by field', () => {
    const control = { title: 'extra-control', type: 'x', skin: 's', headingLevel: 1, data: { a: 1, b: 2 } };
    const findings = findingsFor(
      run({ manifest: { inputs: { resolvedRange: range(), contentControls: [control] } } }),
      manual({ manifest: { inputs: { resolvedRange: range(), contentControls: [] } } })
    );

    const texts = byKey(findings, 'inputs').map((f) => f.text);
    expect(texts).toEqual(['Content control "extra-control" exists only in run A.']);
  });

  test('says so when the outcome differs and nothing recorded explains it', () => {
    const b = manual({
      manifest: {
        outputSummary: { rowCount: 37, emptyResult: false, funnel: { artifacts: 2, linkedChanges: 0, unlinkedCommits: 0, knownBugs: 0 } },
        environment: { credential: { kind: 'pat', identity: 'user' } },
      },
    });
    // same funnel, same credential, same range, but one output is empty: nothing explains it
    const aSame = run({
      manifest: {
        outputSummary: { rowCount: 0, emptyResult: true, funnel: { artifacts: 2, linkedChanges: 0, unlinkedCommits: 0, knownBugs: 0 } },
        environment: { credential: { kind: 'pat', identity: 'user' } },
      },
    });
    const findings = findingsFor(aSame, b);

    expect(byKey(findings, 'unexplained')[0].text).toContain('Nothing recorded for these runs explains the difference in outcome');
  });

  test('says nothing differs when the two runs are alike', () => {
    const findings = findingsFor(run(), run());

    expect(findings.map((f) => f.key)).toEqual(['range', 'funnel']);
    expect(findings.every((f) => f.severity === 'info')).toBe(true);
  });

  test('tolerates runs that recorded none of the new facts (older runs)', () => {
    const old = (over: any = {}) => ({
      runId: 'old',
      trigger: 'ui',
      docType: 'SVD',
      project: 'P',
      manifest: { steps: [{ name: 's', type: 'generate-content-control', status: 'succeeded', durationMs: 1, errorCount: 0 }], environment: {}, inputs: {}, ...over },
    });
    const findings = findingsFor(old() as any, old() as any);

    expect(findings).toEqual([{ key: 'unexplained', severity: 'info', text: 'Nothing recorded differs between these two runs.' }]);
  });

  test('only one side having a resolved range is stated, not treated as a difference in the range', () => {
    const findings = findingsFor(run(), manual({ manifest: { inputs: {} } }));

    expect(byKey(findings, 'range')[0]).toMatchObject({ severity: 'info' });
    expect(byKey(findings, 'range')[0].text).toContain('Only run A recorded the range it resolved to: release');
    expect(byKey(findings, 'range')[0].text).not.toContain('));');
  });
});
