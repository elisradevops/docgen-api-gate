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

  describe('who ran it and what the credential could see', () => {
    const credential = (over: any = {}) => ({ credential: { kind: 'bearer', identity: 'build-service', ...over } });
    const access = (over: any = {}) => ({
      project: { status: 'ok', count: 4 },
      repositories: { status: 'ok', count: 3 },
      workItems: { status: 'ok', count: 1 },
      releases: { status: 'ok', count: 7 },
      ...over,
    });

    test('names the identity of each credential, display names included', () => {
      const findings = findingsFor(
        run({ manifest: { environment: credential({ name: 'MEWP Build Service (Org)' }) } }),
        manual({ manifest: { environment: { credential: { kind: 'pat', identity: 'user', name: 'Jane Doe' } } } })
      );

      expect(byKey(findings, 'credential')[0].text).toContain('Run A: a bearer token, a build service identity "MEWP Build Service (Org)".');
      expect(byKey(findings, 'credential')[0].text).toContain('Run B: a personal access token, a user "Jane Doe".');
    });

    test('lists exactly what differs in visibility, area by area', () => {
      const findings = findingsFor(
        run({ manifest: { environment: credential({ access: access({ repositories: { status: 'ok', count: 3 }, releases: { status: 'denied', httpStatus: 403 } }) }) } }),
        manual({ manifest: { environment: { credential: { kind: 'pat', identity: 'user', access: access({ repositories: { status: 'ok', count: 12 } }) } } } })
      );

      const finding = byKey(findings, 'access')[0];
      expect(finding.severity).toBe('severe');
      expect(finding.text).toBe(
        'What the credentials could see in the project differs: repositories — 3 visible in run A, 12 visible in run B; release definitions — denied (403) in run A, 7 visible in run B.'
      );
    });

    test('says "not visible" for a project the credential cannot see, not "not available"', () => {
      const findings = findingsFor(
        run({ manifest: { environment: credential({ access: access({ project: { status: 'notFound', count: 1 } }) }) } }),
        manual({ manifest: { environment: { credential: { kind: 'pat', identity: 'user', access: access() } } } })
      );

      expect(byKey(findings, 'access')[0].text).toContain('project visibility — not visible in run A, visible in run B');
    });

    test('says missing permissions are ruled out when both could see the same', () => {
      const findings = findingsFor(
        run({ manifest: { environment: credential({ access: access() }) } }),
        manual({ manifest: { environment: { credential: { kind: 'pat', identity: 'user', access: access() } } } })
      );

      expect(byKey(findings, 'access')[0]).toMatchObject({
        severity: 'info',
        text: 'Both credentials could see the same in the project, so missing permissions are not the cause.',
      });
    });

    test('states it when only one run recorded what its credential could see', () => {
      const findings = findingsFor(run({ manifest: { environment: credential({ access: access() }) } }), manual());

      expect(byKey(findings, 'access')[0].text).toContain('Only run A recorded what its credential could see: project visibility visible, repositories 3 visible');
    });

    test('an access difference alone counts as an explanation (no "nothing explains it")', () => {
      const same = { rowCount: 0, emptyResult: true, funnel: { artifacts: 2, linkedChanges: 0, unlinkedCommits: 0, knownBugs: 0 } };
      const findings = findingsFor(
        run({ manifest: { outputSummary: same, environment: credential({ access: access({ repositories: { status: 'ok', count: 0 } }) }) } }),
        manual({
          manifest: {
            outputSummary: { ...same, rowCount: 5, emptyResult: false },
            environment: credential({ access: access() }),
          },
        })
      );

      expect(byKey(findings, 'access')[0].severity).toBe('severe');
      expect(byKey(findings, 'unexplained')).toHaveLength(0);
    });
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

describe('buildCompareFindings — review fixes', () => {
  const emptyOut = { rowCount: 0, emptyResult: true, funnel: { artifacts: 2, linkedChanges: 0, unlinkedCommits: 0, knownBugs: 0 } };
  const fullOut = { rowCount: 5, emptyResult: false, funnel: { artifacts: 2, linkedChanges: 5, unlinkedCommits: 0, knownBugs: 0 } };

  test('the same versions reached by different routes are the same range (discovered in one run, given in the other)', () => {
    const a = run({ manifest: { inputs: { resolvedRange: range({ from: { id: 409, source: 'auto' }, to: { id: 418, name: 'Release-418', source: 'auto' } }) } } });
    const b = manual({ manifest: { inputs: { resolvedRange: range({ from: { id: 409, source: 'explicit' }, to: { id: 418, source: 'explicit' } }) } } });

    const finding = byKey(findingsFor(a, b), 'range')[0];

    expect(finding.severity).toBe('info');
    expect(finding.text).toContain('Both runs used the same versions');
    expect(finding.text).toContain('from: discovered in run A, given in run B');
    expect(finding.text).toContain('the range is not the cause');
  });

  test('different version ids are still a severe difference', () => {
    const finding = byKey(findingsFor(run(), manual({ manifest: { inputs: { resolvedRange: range({ to: { id: 419, source: 'auto' } }) } } })), 'range')[0];

    expect(finding.severity).toBe('severe');
  });

  test('a credential detail only one run recorded is not "different credentials", and does not suppress the "unexplained" finding', () => {
    // Same kind; run A also recorded the identity class and name (headless, authorized), run B did not (no capture, probe off).
    const a = run({ manifest: { outputSummary: emptyOut, environment: { credential: { kind: 'pat', identity: 'user', name: 'Jane' } } } });
    const b = manual({ manifest: { outputSummary: fullOut, environment: { credential: { kind: 'pat' } } } });

    const findings = findingsFor(a, b);

    expect(byKey(findings, 'credential')[0]).toMatchObject({ severity: 'info' });
    expect(byKey(findings, 'credential')[0].text).toContain('Not every detail of who ran each run was recorded');
    expect(byKey(findings, 'credential').some((f) => f.severity === 'severe')).toBe(false);
  });

  test('a funnel stage this code does not know never wins over a real stage', () => {
    const a = run({ manifest: { outputSummary: { emptyResult: true, funnel: { artifacts: 2, linkedChanges: 0, extra: { count: 1 } } } } });
    const b = manual({ manifest: { outputSummary: { emptyResult: false, funnel: { artifacts: 2, linkedChanges: 9, extra: { count: 7 } } } } });

    expect(byKey(findingsFor(a, b), 'funnel')[0].text).toContain('first diverge at "linkedChanges"');
  });

  test('an emptyResult a run did not record is said to be unrecorded, not "output"', () => {
    const a = run({ manifest: { outputSummary: { rowCount: 0, funnel: undefined } } });
    const b = manual({ manifest: { outputSummary: { rowCount: 3, emptyResult: true, funnel: undefined } } });

    const text = byKey(findingsFor(a, b), 'outcome').map((f) => f.text).join(' ');

    expect(text).toContain('produced an unrecorded result in run A but nothing in run B');
    expect(text).not.toContain('produced output in run A');
  });

  test('"nothing explains it" claims only what was actually compared', () => {
    const bareA = { runId: 'a', trigger: 'ui', docType: 'SVD', project: 'P', manifest: { steps: [{ name: 's', type: 'generate-content-control', status: 'succeeded', durationMs: 1, errorCount: 0, outputSummary: { emptyResult: true } }], environment: {}, inputs: {} } } as any;
    const bareB = JSON.parse(JSON.stringify(bareA));
    bareB.manifest.steps[0].outputSummary.emptyResult = false;

    const bare = byKey(findingsFor(bareA, bareB), 'unexplained')[0].text;
    expect(bare).toContain('the runs recorded little to compare');
    expect(bare).not.toContain('the same: the range');

    const withRange = byKey(
      findingsFor(
        run({ manifest: { outputSummary: { emptyResult: true, funnel: undefined }, environment: { credential: { kind: 'pat' } } } }),
        manual({ manifest: { outputSummary: { emptyResult: false, funnel: undefined }, environment: { credential: { kind: 'pat' } } } })
      ),
      'unexplained'
    )[0].text;
    expect(withRange).toContain('the same: the range, the kind of credential');
  });

  test('when both credentials were denied the same things, it does not say permissions are ruled out', () => {
    const denied = { project: { status: 'ok' }, repositories: { status: 'ok', count: 3 }, releases: { status: 'denied', httpStatus: 403 } };
    const findings = findingsFor(
      run({ manifest: { environment: { credential: { kind: 'bearer', access: denied } } } }),
      manual({ manifest: { environment: { credential: { kind: 'pat', access: denied } } } })
    );

    const finding = byKey(findings, 'access')[0];

    expect(finding.severity).toBe('info');
    expect(finding.text).toContain('including areas neither could read (release definitions: denied (403))');
    expect(finding.text).not.toContain('missing permissions are not the cause.');
  });

  test('work items are "some" or "none" visible (the read asks for one item), never "1 visible"', () => {
    const a = run({ manifest: { environment: { credential: { kind: 'bearer', access: { project: { status: 'ok' }, workItems: { status: 'ok', count: 0 } } } } } });
    const b = manual({ manifest: { environment: { credential: { kind: 'pat', access: { project: { status: 'ok' }, workItems: { status: 'ok', count: 1 } } } } } });

    expect(byKey(findingsFor(a, b), 'access')[0].text).toContain('work items — none visible in run A, some visible in run B');
  });

  test('a change only in build, release or test-plan counts is a note, not an explanation', () => {
    const base = { project: { status: 'ok' }, repositories: { status: 'ok', count: 3 }, workItems: { status: 'ok', count: 1 } };
    const a = run({ manifest: { outputSummary: emptyOut, environment: { credential: { kind: 'pat', access: { ...base, builds: { status: 'ok', count: 5 } } } } } });
    const b = manual({ manifest: { outputSummary: fullOut, environment: { credential: { kind: 'pat', access: { ...base, builds: { status: 'ok', count: 9 } } } } } });

    const findings = findingsFor(a, b);

    expect(byKey(findings, 'access')[0].severity).toBe('info');
    expect(byKey(findings, 'unexplained').length + byKey(findings, 'funnel').length).toBeGreaterThan(0);
  });

  test('the raw from/to of the request are not listed as input differences when both runs recorded their range', () => {
    const control = (from: unknown) => [{ title: 'cc', data: { rangeType: 'release', from, to: '', fromText: from ? 'x' : '(auto)', other: 1 } }];
    const a = run({ manifest: { inputs: { resolvedRange: range(), contentControls: control('') } } });
    const b = manual({ manifest: { inputs: { resolvedRange: range(), contentControls: control(409) } } });

    const inputs = byKey(findingsFor(a, b), 'inputs').map((f) => f.text).join(' ');

    expect(inputs).not.toContain('data.from');
    expect(inputs).not.toContain('data.fromText');
  });
});

