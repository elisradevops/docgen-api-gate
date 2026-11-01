const mockFindOne = jest.fn();

jest.mock('../../../models/DocumentRun', () => ({
  __esModule: true,
  DocumentRun: { findOne: (...args: any[]) => mockFindOne(...args) },
}));

const mockAggregate = jest.fn();
jest.mock('../../../models/LogEvent', () => ({
  __esModule: true,
  LogEvent: { aggregate: (...args: any[]) => mockAggregate(...args) },
}));

import { buildTimeline, getRunDetail, applyLoggedCounts } from '../../../helpers/diagnostics/runDetail';

describe('buildTimeline', () => {
  test('returns an empty timeline for a run with no manifest steps', () => {
    expect(buildTimeline(undefined)).toEqual([]);
    expect(buildTimeline([])).toEqual([]);
  });

  test('computes cumulative start offsets from array order', () => {
    const steps: any[] = [
      { name: 'generate-doc-template', type: 'generate-doc-template', status: 'succeeded', durationMs: 400, errorCount: 0 },
      { name: 'sys-overview', type: 'generate-content-control', status: 'failed', durationMs: 8100, errorCount: 1, warnCount: 1 },
    ];
    const timeline = buildTimeline(steps);
    expect(timeline[0]).toMatchObject({ name: 'generate-doc-template', startOffsetMs: 0, durationMs: 400 });
    expect(timeline[1]).toMatchObject({ name: 'sys-overview', startOffsetMs: 400, durationMs: 8100 });
  });

  test('maps a step type to its known service', () => {
    const steps: any[] = [
      { name: 'a', type: 'generate-doc-template', status: 'succeeded', durationMs: 1, errorCount: 0 },
      { name: 'b', type: 'render-document', status: 'succeeded', durationMs: 1, errorCount: 0 },
    ];
    const timeline = buildTimeline(steps);
    expect(timeline[0].service).toBe('dg-content-control');
    expect(timeline[1].service).toBe('json-to-word');
  });

  test('falls back to "unknown" for an unrecognized step type', () => {
    const steps: any[] = [{ name: 'a', type: 'some-future-step', status: 'succeeded', durationMs: 1, errorCount: 0 }];
    expect(buildTimeline(steps)[0].service).toBe('unknown');
  });
});

describe('applyLoggedCounts', () => {
  const steps = (): any[] => [
    { name: 'generate-doc-template', type: 'generate-doc-template', status: 'succeeded', durationMs: 1, errorCount: 0 },
    { name: 'svd', type: 'generate-content-control', status: 'succeeded', durationMs: 1, errorCount: 0 },
    { name: 'other', type: 'generate-content-control', status: 'succeeded', durationMs: 1, errorCount: 0 },
  ];

  test('puts logged errors/warnings on the step whose title matches, leaving others untouched', () => {
    const timeline = applyLoggedCounts(buildTimeline(steps()), [
      { level: 'error', title: 'svd', count: 2 },
      { level: 'warn', title: 'svd', count: 3 },
    ]);
    expect(timeline[1]).toMatchObject({ errorCount: 2, warnCount: 3 });
    expect(timeline[0].errorCount).toBe(0);
    expect(timeline[2].errorCount).toBe(0);
    expect(timeline[2].warnCount).toBeUndefined();
  });

  test('never lowers a stored errorCount (a failed step keeps its 1)', () => {
    const failed: any[] = [{ name: 'svd', type: 'generate-content-control', status: 'failed', durationMs: 1, errorCount: 1 }];
    const timeline = applyLoggedCounts(buildTimeline(failed), [{ level: 'error', title: 'svd', count: 0 }]);
    expect(timeline[0].errorCount).toBe(1);
  });

  test('is a no-op without any logged counts', () => {
    const base = buildTimeline(steps());
    expect(applyLoggedCounts(base, [])).toEqual(base);
  });
});

describe('getRunDetail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAggregate.mockResolvedValue([]);
  });

  test('returns undefined when the run does not exist', async () => {
    mockFindOne.mockResolvedValue(null);
    expect(await getRunDetail('missing')).toBeUndefined();
  });

  test('returns the run and its derived timeline', async () => {
    const run = { runId: 'r1', manifest: { steps: [{ name: 'a', type: 'render-document', status: 'succeeded', durationMs: 500, errorCount: 0 }] } };
    mockFindOne.mockResolvedValue(run);
    const detail = await getRunDetail('r1');
    expect(detail?.run).toBe(run);
    expect(detail?.timeline).toHaveLength(1);
  });

  test('reports logged error/warn totals for the run and merges them into the matching step', async () => {
    mockFindOne.mockResolvedValue({
      runId: 'r1',
      status: 'succeeded',
      manifest: { steps: [{ name: 'svd', type: 'generate-content-control', status: 'succeeded', durationMs: 5, errorCount: 0 }] },
    });
    mockAggregate.mockResolvedValue([
      { _id: { level: 'error', title: 'svd' }, count: 2 },
      { _id: { level: 'warn', title: 'svd' }, count: 1 },
      { _id: { level: 'error' }, count: 1 }, // not attributed to any content control
    ]);
    const detail = await getRunDetail('r1');
    expect(mockAggregate.mock.calls[0][0][0]).toEqual({ $match: { runId: 'r1', level: { $in: ['error', 'warn'] } } });
    expect(detail?.loggedErrors).toBe(3);
    expect(detail?.loggedWarnings).toBe(1);
    expect(detail?.timeline[0]).toMatchObject({ errorCount: 2, warnCount: 1 });
  });

  test('a failing log aggregate never fails the run detail (falls back to stored counts)', async () => {
    mockFindOne.mockResolvedValue({ runId: 'r1', manifest: { steps: [{ name: 'a', type: 'render-document', status: 'succeeded', durationMs: 1, errorCount: 0 }] } });
    mockAggregate.mockRejectedValue(new Error('mongo down'));
    const detail = await getRunDetail('r1');
    expect(detail?.timeline[0].errorCount).toBe(0);
    expect(detail?.loggedErrors).toBeUndefined();
  });

  test('degrades to an empty timeline for a run with no manifest (e.g. still running)', async () => {
    mockFindOne.mockResolvedValue({ runId: 'r1', manifest: undefined });
    const detail = await getRunDetail('r1');
    expect(detail?.timeline).toEqual([]);
  });
});
