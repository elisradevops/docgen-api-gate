jest.mock('../../models/DocumentRun', () => ({
  __esModule: true,
  DocumentRun: {
    aggregate: jest.fn().mockResolvedValue([]),
    find: jest.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
    // Two different call shapes hit this same mock: runDetail.ts awaits findOne(...) directly
    // (no .sort()), manifestDiff.ts's findBaselineRun chains .sort(...) on it — the returned
    // object needs to be both thenable itself and support a chained .sort() that resolves too.
    findOne: jest.fn(),
  },
}));
// A bare `jest.mock('axios')` auto-mock replaces axios.create() with a jest.fn() returning
// undefined, which breaks app startup (DataProviderController's ccClient construction calls
// installRunIdForwarding(ccClient), which reads ccClient.interceptors — undefined otherwise).
// Mock only what this file needs (`axios.post`) and keep `create()` shaped like the real thing.
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    // app.ts installs installRunIdForwarding on the bare default import too, not just on
    // axios.create() instances — both need a real-shaped `interceptors`.
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    create: jest.fn(() => ({
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
      post: jest.fn(),
      get: jest.fn(),
    })),
  },
}));
jest.mock('../../models/Issue', () => ({
  __esModule: true,
  Issue: {
    countDocuments: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockReturnValue({ sort: () => ({ limit: () => Promise.resolve([]) }) }),
    findById: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock('../../models/LogEvent', () => ({
  __esModule: true,
  LogEvent: {
    aggregate: jest.fn().mockResolvedValue([]),
    find: jest.fn().mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
    }),
  },
  LOG_EVENT_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
}));

import mongoose from 'mongoose';
import axios from 'axios';
import { withLocalAgent } from '../utils/localSupertest';
import { DocumentRun } from '../../models/DocumentRun';
import { Issue } from '../../models/Issue';
import { LogEvent } from '../../models/LogEvent';

const mockDocumentRunAggregate = DocumentRun.aggregate as jest.Mock;
const mockDocumentRunFindOne = DocumentRun.findOne as jest.Mock;
const mockIssueCountDocuments = Issue.countDocuments as jest.Mock;
const mockIssueFindById = Issue.findById as jest.Mock;
const mockLogEventAggregate = LogEvent.aggregate as jest.Mock;
const mockLogEventFind = LogEvent.find as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;

// findOne is awaited directly by runDetail.ts and chained with .sort() by
// manifestDiff.ts's findBaselineRun — the returned object needs to satisfy both.
function findOneChain(result: unknown) {
  const chain: any = { sort: jest.fn(() => Promise.resolve(result)) };
  chain.then = (resolve: any) => Promise.resolve(result).then(resolve);
  return chain;
}

describe('GET /diagnostics/overview, /diagnostics/issues, /diagnostics/issues/:issueId', () => {
  let prevReadyState: number;

  function createApp(): any {
    const AppClass = require('../../app').default;
    return new AppClass().app;
  }

  beforeAll(() => {
    createApp(); // model index-build ordering warm-up — see DiagnosticsIngest.test.ts
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDocumentRunAggregate.mockResolvedValue([]);
    mockIssueCountDocuments.mockResolvedValue(0);
    mockLogEventAggregate.mockResolvedValue([]);
    mockLogEventFind.mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });
    mockDocumentRunFindOne.mockReturnValue(findOneChain(null));
    process.env.jsonToWordPostUrl = 'http://json-to-word';
    prevReadyState = (mongoose.connection as any).readyState;
    (mongoose.connection as any).readyState = 1;
  });

  afterEach(() => {
    (mongoose.connection as any).readyState = prevReadyState;
  });

  test('GET /diagnostics/overview is reachable with no session and returns counts', async () => {
    const app = createApp();
    const res = await withLocalAgent(app, (agent) => agent.get('/diagnostics/overview').expect(200));
    expect(res.body).toEqual({
      runs: { windowHours: 24, total: 0, succeeded: 0, failed: 0, running: 0 },
      issues: { unresolved: 0, regressed: 0, resolvedRecently: 0 },
    });
  });

  test('GET /diagnostics/overview returns 503 without querying when Mongo is disconnected', async () => {
    (mongoose.connection as any).readyState = 0;
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.get('/diagnostics/overview').expect(503));
    expect(mockDocumentRunAggregate).not.toHaveBeenCalled();
  });

  test('GET /diagnostics/issues defaults to unresolved with no session required', async () => {
    const app = createApp();
    const res = await withLocalAgent(app, (agent) => agent.get('/diagnostics/issues').expect(200));
    expect(res.body).toEqual({ issues: [] });
  });

  test('GET /diagnostics/issues/:issueId returns 404 for an unknown issue', async () => {
    mockIssueFindById.mockResolvedValue(null);
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.get('/diagnostics/issues/does-not-exist').expect(404));
  });

  test('GET /diagnostics/issues/:issueId returns issue, trend, and occurrences', async () => {
    mockIssueFindById.mockResolvedValue({ _id: 'i1', signature: 'sig', service: 'svc', occurrenceRunIds: [] });
    const app = createApp();
    const res = await withLocalAgent(app, (agent) => agent.get('/diagnostics/issues/i1').expect(200));
    expect(res.body.issue).toMatchObject({ _id: 'i1' });
    expect(res.body.trend).toHaveLength(24);
    expect(res.body.occurrences).toEqual([]);
  });

  test('GET /diagnostics/events is reachable with no session and returns {events, nextCursor}', async () => {
    const app = createApp();
    const res = await withLocalAgent(app, (agent) => agent.get('/diagnostics/events').expect(200));
    expect(res.body).toEqual({ events: [], nextCursor: undefined });
  });

  test('GET /diagnostics/events returns 503 without querying when Mongo is disconnected', async () => {
    (mongoose.connection as any).readyState = 0;
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.get('/diagnostics/events').expect(503));
    expect(mockLogEventFind).not.toHaveBeenCalled();
  });

  test('GET /diagnostics/events forwards repeated array query params through to the LogEvent match', async () => {
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.get('/diagnostics/events?service=dg-api-gate&service=dg-content-control').expect(200));
    // find() is called once with the built $match — asserting it received an $in for service
    // proves the array-param parsing survived the full HTTP round trip, not just a unit call.
    const matchArg = mockLogEventFind.mock.calls[0][0];
    expect(matchArg.service).toEqual({ $in: ['dg-api-gate', 'dg-content-control'] });
  });

  test('GET /diagnostics/events/facets is reachable with no session and returns all four dimensions', async () => {
    mockLogEventAggregate.mockResolvedValue([{ level: [], service: [], project: [], docType: [] }]);
    const app = createApp();
    const res = await withLocalAgent(app, (agent) => agent.get('/diagnostics/events/facets').expect(200));
    expect(res.body.facets).toEqual({ level: [], service: [], project: [], docType: [] });
  });

  test('GET /diagnostics/events/facets returns 503 without querying when Mongo is disconnected', async () => {
    (mongoose.connection as any).readyState = 0;
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.get('/diagnostics/events/facets').expect(503));
    expect(mockLogEventAggregate).not.toHaveBeenCalled();
  });

  test('GET /diagnostics/events/histogram is reachable with no session and returns 24 buckets', async () => {
    mockLogEventAggregate.mockResolvedValue([]);
    const app = createApp();
    const res = await withLocalAgent(app, (agent) => agent.get('/diagnostics/events/histogram').expect(200));
    expect(res.body.buckets).toHaveLength(24);
  });

  test('GET /diagnostics/events/histogram returns 503 without querying when Mongo is disconnected', async () => {
    (mongoose.connection as any).readyState = 0;
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.get('/diagnostics/events/histogram').expect(503));
    expect(mockLogEventAggregate).not.toHaveBeenCalled();
  });

  test('GET /diagnostics/runs/:runId returns 404 for an unknown run', async () => {
    mockDocumentRunFindOne.mockReturnValue(findOneChain(null));
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.get('/diagnostics/runs/does-not-exist').expect(404));
  });

  test('GET /diagnostics/runs/:runId returns run and a derived timeline', async () => {
    mockDocumentRunFindOne.mockReturnValue(
      findOneChain({
        runId: 'r1',
        manifest: { steps: [{ name: 'a', type: 'render-document', status: 'succeeded', durationMs: 100, errorCount: 0 }] },
      })
    );
    const app = createApp();
    const res = await withLocalAgent(app, (agent) => agent.get('/diagnostics/runs/r1').expect(200));
    expect(res.body.run.runId).toBe('r1');
    expect(res.body.timeline).toHaveLength(1);
  });

  test('GET /diagnostics/runs/:runId returns 503 without querying when Mongo is disconnected', async () => {
    (mongoose.connection as any).readyState = 0;
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.get('/diagnostics/runs/r1').expect(503));
    expect(mockDocumentRunFindOne).not.toHaveBeenCalled();
  });

  test('GET /diagnostics/compare requires both a and b', async () => {
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.get('/diagnostics/compare?a=r1').expect(400));
  });

  test('GET /diagnostics/compare returns 404 when a run is missing', async () => {
    mockDocumentRunFindOne.mockReturnValueOnce(findOneChain({ runId: 'r1', manifest: { steps: [] } })).mockReturnValueOnce(findOneChain(null));
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.get('/diagnostics/compare?a=r1&b=r2').expect(404));
  });

  test('GET /diagnostics/compare diffs two real runs end to end', async () => {
    mockDocumentRunFindOne
      .mockReturnValueOnce(findOneChain({ runId: 'r1', docType: 'SVD', project: 'P', manifest: { steps: [] } }))
      .mockReturnValueOnce(findOneChain({ runId: 'r2', docType: 'STP', project: 'P', manifest: { steps: [] } }));
    const app = createApp();
    const res = await withLocalAgent(app, (agent) => agent.get('/diagnostics/compare?a=r1&b=r2').expect(200));
    expect(res.body.crossType).toBe(true);
  });

  test('GET /diagnostics/runs/:runId/baseline returns 404 when no baseline exists', async () => {
    mockDocumentRunFindOne
      .mockReturnValueOnce(findOneChain({ runId: 'r1', manifest: { steps: [] } }))
      .mockReturnValueOnce(findOneChain(null));
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.get('/diagnostics/runs/r1/baseline').expect(404));
  });

  test('GET /diagnostics/runs/:runId/baseline returns the baseline runId', async () => {
    mockDocumentRunFindOne
      .mockReturnValueOnce(findOneChain({ runId: 'r1', manifest: { steps: [] } }))
      .mockReturnValueOnce(findOneChain({ runId: 'baseline-1' }));
    const app = createApp();
    const res = await withLocalAgent(app, (agent) => agent.get('/diagnostics/runs/r1/baseline').expect(200));
    expect(res.body).toEqual({ runId: 'baseline-1' });
  });

  test('GET /diagnostics/runs/:runId/report streams a real DOCX response with no MinIO/documents-tab involvement', async () => {
    mockDocumentRunFindOne.mockReturnValue(
      findOneChain({ runId: 'r1', status: 'failed', trigger: 'pipeline', startedAt: new Date(), errorChain: [], manifest: { steps: [] } })
    );
    mockAxiosPost.mockResolvedValue({ data: { Base64: Buffer.from('report bytes').toString('base64') } });
    const app = createApp();
    const res = await withLocalAgent(app, (agent) =>
      agent
        .get('/diagnostics/runs/r1/report')
        .expect(200)
        .expect('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    );
    expect(res.headers['content-disposition']).toContain('attachment');
    // The route calls json-to-word directly with enableDirectDownload — never touches MinIO or
    // any documents-tab-facing endpoint, which this test's mocks don't even define.
    expect(mockAxiosPost).toHaveBeenCalledWith(
      'http://json-to-word/api/word/create',
      expect.objectContaining({ uploadProperties: expect.objectContaining({ enableDirectDownload: true }) })
    );
  });

  test('GET /diagnostics/compare/report streams a real DOCX response for a two-run comparison', async () => {
    mockDocumentRunFindOne
      .mockReturnValueOnce(findOneChain({ runId: 'r1', status: 'failed', trigger: 'pipeline', startedAt: new Date(), errorChain: [], manifest: { steps: [] } }))
      .mockReturnValueOnce(findOneChain({ runId: 'r2', status: 'succeeded', trigger: 'pipeline', startedAt: new Date(), errorChain: [], manifest: { steps: [] } }));
    mockAxiosPost.mockResolvedValue({ data: { Base64: Buffer.from('compare report bytes').toString('base64') } });
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .get('/diagnostics/compare/report?a=r1&b=r2')
        .expect(200)
        .expect('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    );
  });
});
