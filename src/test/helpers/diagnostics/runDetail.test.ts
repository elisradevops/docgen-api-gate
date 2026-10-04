const mockFindOne = jest.fn();

jest.mock('../../../models/DocumentRun', () => ({
  __esModule: true,
  DocumentRun: { findOne: (...args: any[]) => mockFindOne(...args) },
}));

import { buildTimeline, getRunDetail } from '../../../helpers/diagnostics/runDetail';

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

describe('getRunDetail', () => {
  beforeEach(() => jest.clearAllMocks());

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

  test('degrades to an empty timeline for a run with no manifest (e.g. still running)', async () => {
    mockFindOne.mockResolvedValue({ runId: 'r1', manifest: undefined });
    const detail = await getRunDetail('r1');
    expect(detail?.timeline).toEqual([]);
  });
});
