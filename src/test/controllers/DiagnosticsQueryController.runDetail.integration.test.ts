// The incident in one request: a run that finished "succeeded" (no step threw) but whose content-control
// logged errors. Real controller + real getRunDetail; only the Mongo models are faked, so this pins the
// JSON the Monitoring page actually receives.
const mockFindOne = jest.fn();
const mockAggregate = jest.fn();

jest.mock('../../util/mongodb', () => ({ __esModule: true, isMongoConnected: jest.fn(() => true) }));
jest.mock('../../models/DocumentRun', () => ({
  __esModule: true,
  DocumentRun: { findOne: (...args: any[]) => mockFindOne(...args) },
}));
jest.mock('../../models/LogEvent', () => ({
  __esModule: true,
  LogEvent: { aggregate: (...args: any[]) => mockAggregate(...args) },
}));

import { DiagnosticsQueryController } from '../../controllers/DiagnosticsQueryController';

function buildRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (code: number) => ((res.statusCode = code), res);
  res.json = (body: unknown) => ((res.body = body), res);
  return res;
}

const succeededRun = (steps: any[]) => ({ runId: 'r1', status: 'succeeded', manifest: { steps, artifacts: [] } });
const step = (name: string) => ({ name, type: 'generate-content-control', status: 'succeeded', durationMs: 10, errorCount: 0 });

describe('GET /diagnostics/runs/:runId for a succeeded run that logged errors', () => {
  beforeEach(() => jest.clearAllMocks());

  test('reports the logged errors on the run and on the step that produced them', async () => {
    mockFindOne.mockResolvedValue(succeededRun([step('SVD'), step('Requirements')]));
    mockAggregate.mockResolvedValue([
      { _id: { level: 'error', title: 'SVD' }, count: 2 },
      { _id: { level: 'warn', title: 'SVD' }, count: 3 },
    ]);
    const res = buildRes();

    await new DiagnosticsQueryController().getRunDetail({ params: { runId: 'r1' } } as any, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.run.status).toBe('succeeded');
    expect(res.body.loggedErrors).toBe(2);
    expect(res.body.loggedWarnings).toBe(3);
    expect(res.body.timeline.find((t: any) => t.name === 'SVD')).toMatchObject({ errorCount: 2, warnCount: 3 });
    expect(res.body.timeline.find((t: any) => t.name === 'Requirements')).toMatchObject({ errorCount: 0 });
  });

  test('a clean run reports zero, so the page shows no "succeeded with errors" chip', async () => {
    mockFindOne.mockResolvedValue(succeededRun([step('SVD')]));
    mockAggregate.mockResolvedValue([]);
    const res = buildRes();

    await new DiagnosticsQueryController().getRunDetail({ params: { runId: 'r1' } } as any, res);

    expect(res.body.loggedErrors).toBe(0);
    expect(res.body.loggedWarnings).toBe(0);
  });

  test('when the log store cannot be read the counts are absent, not zero', async () => {
    mockFindOne.mockResolvedValue(succeededRun([step('SVD')]));
    mockAggregate.mockRejectedValue(new Error('mongo down'));
    const res = buildRes();

    await new DiagnosticsQueryController().getRunDetail({ params: { runId: 'r1' } } as any, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.loggedErrors).toBeUndefined();
    expect(res.body.loggedWarnings).toBeUndefined();
  });
});
