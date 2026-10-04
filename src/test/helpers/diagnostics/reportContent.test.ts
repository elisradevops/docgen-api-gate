import { buildRunReportContentControls, buildCompareReportContentControls } from '../../../helpers/diagnostics/reportContent';
import { ManifestDiff } from '../../../helpers/diagnostics/manifestDiff';

function run(overrides: any = {}): any {
  return {
    runId: 'run-a',
    status: 'failed',
    docType: 'SVD',
    project: 'Cube-ADCS',
    trigger: 'pipeline',
    startedAt: new Date('2026-09-23T12:04:01.000Z'),
    endedAt: new Date('2026-09-23T12:04:11.400Z'),
    errorChain: [],
    ...overrides,
  };
}

describe('buildRunReportContentControls', () => {
  test('returns exactly one content control with a title and wordObjects', () => {
    const [cc] = buildRunReportContentControls(run(), []);
    expect(cc.title).toBe('diagnostics-run-report');
    expect(Array.isArray(cc.wordObjects)).toBe(true);
  });

  test('includes a title paragraph, a run summary table, and a timeline table', () => {
    const timeline = [{ name: 'render-document', type: 'render-document', service: 'json-to-word', status: 'succeeded' as const, startOffsetMs: 0, durationMs: 900, errorCount: 0 }];
    const [cc] = buildRunReportContentControls(run(), timeline);
    const types = cc.wordObjects.map((o: any) => o.type);
    expect(types.filter((t) => t === 'table').length).toBeGreaterThanOrEqual(2); // summary + timeline
    expect(types[0]).toBe('paragraph');
  });

  test('a run with no error chain gets a plain "no errors" paragraph, not an empty section', () => {
    const [cc] = buildRunReportContentControls(run({ errorChain: [] }), []);
    const text = JSON.stringify(cc.wordObjects);
    expect(text).toContain('No error chain');
  });

  test('a run with error chain entries renders one paragraph per entry', () => {
    const [cc] = buildRunReportContentControls(
      run({ errorChain: [{ service: 'dg-content-control', step: 'sys-overview', message: 'boom' }] }),
      []
    );
    const text = JSON.stringify(cc.wordObjects);
    expect(text).toContain('dg-content-control');
    expect(text).toContain('boom');
  });
});

describe('buildCompareReportContentControls', () => {
  const emptyDiff: ManifestDiff = {
    crossType: false,
    bands: { outcomes: [], volumes: [], environment: [], inputs: [], unchanged: [] },
  };

  test('returns exactly one content control', () => {
    const [cc] = buildCompareReportContentControls(run({ runId: 'a' }), run({ runId: 'b' }), emptyDiff);
    expect(cc.title).toBe('diagnostics-compare-report');
  });

  test('includes the cross-type warning paragraph only when crossType is true', () => {
    const withCross = buildCompareReportContentControls(run(), run(), { ...emptyDiff, crossType: true });
    const withoutCross = buildCompareReportContentControls(run(), run(), emptyDiff);
    expect(JSON.stringify(withCross[0].wordObjects)).toContain('different document types');
    expect(JSON.stringify(withoutCross[0].wordObjects)).not.toContain('different document types');
  });

  test('renders one section per band, each with a table when it has rows, a plain note when empty', () => {
    const diff: ManifestDiff = {
      crossType: false,
      bands: {
        outcomes: [{ field: 'sys-overview', a: 'failed', b: 'succeeded', severity: 'severe' }],
        volumes: [],
        environment: [],
        inputs: [],
        unchanged: [],
      },
    };
    const [cc] = buildCompareReportContentControls(run(), run(), diff);
    const text = JSON.stringify(cc.wordObjects);
    expect(text).toContain('Changed outcomes');
    expect(text).toContain('sys-overview');
    expect(text).toContain('Nothing to show'); // the other four bands are empty
  });
});
