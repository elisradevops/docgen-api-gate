const mockFindOne = jest.fn();

jest.mock('../../../models/DocumentRun', () => ({
  __esModule: true,
  DocumentRun: { findOne: (...args: any[]) => ({ sort: () => mockFindOne(...args) }) },
}));

import { diffManifests, findBaselineRun } from '../../../helpers/diagnostics/manifestDiff';

function run(overrides: any = {}): any {
  return {
    runId: 'run-a',
    docType: 'SVD',
    project: 'Cube-ADCS',
    templateName: 'Software Version Description.dotx',
    manifest: { steps: [], environment: {}, inputs: {} },
    ...overrides,
  };
}

describe('diffManifests — steps band (Changed outcomes)', () => {
  test('a status mismatch on a matched step is a severe outcome row', () => {
    const a = run({ manifest: { steps: [{ name: 'sys-overview', type: 'generate-content-control', status: 'failed', durationMs: 1, errorCount: 1 }] } });
    const b = run({ manifest: { steps: [{ name: 'sys-overview', type: 'generate-content-control', status: 'succeeded', durationMs: 1, errorCount: 0 }] } });
    const diff = diffManifests(a, b);
    expect(diff.bands.outcomes).toContainEqual({ field: 'sys-overview', a: 'failed', b: 'succeeded', severity: 'severe' });
  });

  test('matching statuses on a matched step land in unchanged, not outcomes', () => {
    const step = { name: 'render-document', type: 'render-document', status: 'succeeded', durationMs: 1, errorCount: 0 };
    const a = run({ manifest: { steps: [step] } });
    const b = run({ manifest: { steps: [{ ...step }] } });
    const diff = diffManifests(a, b);
    expect(diff.bands.outcomes).toEqual([]);
    expect(diff.bands.unchanged).toContainEqual({ field: 'render-document.status', a: 'succeeded', b: 'succeeded', severity: 'info' });
  });

  test('a step present in only one run is a severe row ("only ran in A")', () => {
    const a = run({ manifest: { steps: [{ name: 'trace-table', type: 'generate-content-control', status: 'succeeded', durationMs: 1, errorCount: 0 }] } });
    const b = run({ manifest: { steps: [] } });
    const diff = diffManifests(a, b);
    expect(diff.bands.outcomes).toContainEqual({ field: 'trace-table', a: 'succeeded', b: undefined, severity: 'severe' });
  });

  test('falls back to matching by type when names differ (the cross-type case)', () => {
    const a = run({ manifest: { steps: [{ name: 'stp-cover', type: 'generate-content-control', status: 'failed', durationMs: 1, errorCount: 1 }] } });
    const b = run({ manifest: { steps: [{ name: 'svd-overview', type: 'generate-content-control', status: 'succeeded', durationMs: 1, errorCount: 0 }] } });
    const diff = diffManifests(a, b);
    // matched by type despite different names — the row is keyed on A's own step name
    expect(diff.bands.outcomes).toContainEqual({ field: 'stp-cover', a: 'failed', b: 'succeeded', severity: 'severe' });
  });
});

describe('diffManifests — volumes band (Changed volumes)', () => {
  test('a differing outputSummary field on a matched step is a moderate row', () => {
    const step = (rowCount: number) => ({ name: 'changes-table', type: 'generate-content-control', status: 'succeeded', durationMs: 1, errorCount: 0, outputSummary: { rowCount } });
    const a = run({ manifest: { steps: [step(214)] } });
    const b = run({ manifest: { steps: [step(198)] } });
    const diff = diffManifests(a, b);
    expect(diff.bands.volumes).toContainEqual({ field: 'changes-table.rowCount', a: 214, b: 198, severity: 'moderate' });
  });
});

describe('diffManifests — environment and inputs bands', () => {
  test('a package version difference is an info-severity environment row', () => {
    const a = run({ manifest: { steps: [], environment: { packages: { skins: '0.28.0' } } } });
    const b = run({ manifest: { steps: [], environment: { packages: { skins: '0.28.1' } } } });
    const diff = diffManifests(a, b);
    expect(diff.bands.environment).toContainEqual({ field: 'packages.skins', a: '0.28.0', b: '0.28.1', severity: 'info' });
  });

  test('generic inputs diff tolerates missing keys and nested objects', () => {
    const a = run({ manifest: { steps: [], inputs: { range: { from: 1, to: 4 } } } });
    const b = run({ manifest: { steps: [], inputs: {} } });
    const diff = diffManifests(a, b);
    expect(diff.bands.inputs).toContainEqual({ field: 'range.from', a: 1, b: undefined, severity: 'info' });
    expect(diff.bands.inputs).toContainEqual({ field: 'range.to', a: 4, b: undefined, severity: 'info' });
  });

  test('arrays of objects with a stable key are matched by key and recursed field-by-field', () => {
    const cc = (extra: object) => ({ title: 'sys-overview', type: 'test-description', headingLevel: 1, ...extra });
    const a = run({ manifest: { steps: [], inputs: { contentControls: [cc({ data: { isSuiteSpecific: false } })] } } });
    const b = run({ manifest: { steps: [], inputs: { contentControls: [cc({ data: { isSuiteSpecific: true  } })] } } });
    const diff = diffManifests(a, b);
    // Should produce a field-level row, not one row with the full object
    expect(diff.bands.inputs).toContainEqual({
      field: 'contentControls[sys-overview].data.isSuiteSpecific',
      a: false, b: true, severity: 'info',
    });
    // The full object should NOT appear as a single atomic row
    expect(diff.bands.inputs.find((r) => r.field === 'contentControls')).toBeUndefined();
  });

  test('a content control present in A but absent in B produces a field-level row', () => {
    const cc = { title: 'trace-table', type: 'trace', headingLevel: 2, data: {} };
    const a = run({ manifest: { steps: [], inputs: { contentControls: [cc] } } });
    const b = run({ manifest: { steps: [], inputs: { contentControls: [] } } });
    const diff = diffManifests(a, b);
    // Missing in B — at least the title field surfaces as changed
    const row = diff.bands.inputs.find((r) => r.field === 'contentControls[trace-table].title');
    expect(row).toBeDefined();
    expect(row?.a).toBe('trace-table');
    expect(row?.b).toBeUndefined();
  });

  test('primitive arrays without a stable key are compared atomically (one row, not index-per-row)', () => {
    const a = run({ manifest: { steps: [], inputs: { suites: [15, 16, 30] } } });
    const b = run({ manifest: { steps: [], inputs: { suites: [15, 16, 30, 32] } } });
    const diff = diffManifests(a, b);
    // One atomic row for the whole array, not separate rows for [2] and [3]
    expect(diff.bands.inputs).toContainEqual(
      expect.objectContaining({ field: 'suites', severity: 'info' })
    );
    expect(diff.bands.inputs.find((r) => r.field === 'suites[2]')).toBeUndefined();
  });
});

describe('diffManifests — cross-type banner and unchanged band', () => {
  test('flags crossType when docType differs', () => {
    const diff = diffManifests(run({ docType: 'SVD' }), run({ docType: 'STP' }));
    expect(diff.crossType).toBe(true);
  });

  test('flags crossType when project differs', () => {
    const diff = diffManifests(run({ project: 'Cube-ADCS' }), run({ project: 'AirPro' }));
    expect(diff.crossType).toBe(true);
  });

  test('does not flag crossType for two runs of the same doc type and project', () => {
    const diff = diffManifests(run(), run());
    expect(diff.crossType).toBe(false);
  });

  test('a docType/project mismatch is not duplicated as an ordinary diff row', () => {
    const diff = diffManifests(run({ docType: 'SVD' }), run({ docType: 'STP' }));
    expect(diff.bands.inputs.find((r) => r.field === 'docType')).toBeUndefined();
  });

  test('matching templateName lands in the unchanged band', () => {
    const diff = diffManifests(run(), run());
    expect(diff.bands.unchanged).toContainEqual({
      field: 'templateName',
      a: 'Software Version Description.dotx',
      b: 'Software Version Description.dotx',
      severity: 'info',
    });
  });
});

describe('diffManifests — degrades gracefully with no manifest', () => {
  test('a run missing its manifest (e.g. still running) produces an empty diff, not a throw', () => {
    const a = run({ manifest: undefined });
    const b = run({ manifest: undefined });
    expect(() => diffManifests(a, b)).not.toThrow();
    const diff = diffManifests(a, b);
    expect(diff.bands.outcomes).toEqual([]);
    expect(diff.bands.volumes).toEqual([]);
  });
});

describe('findBaselineRun', () => {
  beforeEach(() => jest.clearAllMocks());

  test('queries by project+docType+succeeded, excluding the run itself, newest first', async () => {
    const baseline = { runId: 'baseline-run' };
    mockFindOne.mockResolvedValue(baseline);
    const result = await findBaselineRun(run({ runId: 'run-a' }));
    expect(result).toBe(baseline);
  });

  test('returns undefined when no baseline exists', async () => {
    mockFindOne.mockResolvedValue(null);
    expect(await findBaselineRun(run())).toBeUndefined();
  });
});
