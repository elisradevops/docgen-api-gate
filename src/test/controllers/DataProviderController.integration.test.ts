import axios from 'axios';
import App from '../../app';
import { withLocalAgent } from '../utils/localSupertest';

jest.mock('axios', () => {
  const post = jest.fn();
  const create = jest.fn(() => ({ post }));
  return { __esModule: true, default: { create, post }, create, post } as any;
});

jest.mock('../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('DataProviderController HTTP integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.dgContentControlUrl = 'http://cc';
  });

  const asMockPost = () => (axios as any).post as jest.Mock;
  const asMockCreate = () => (axios as any).create as jest.Mock;

  function createApp() {
    const AppClass = require('../../app').default as typeof App;
    const appInstance = new AppClass();
    return appInstance.app;
  }

  test('GET /azure/projects forwards to /azure/projects with mapped payload', async () => {
    const ccPost = jest.fn().mockResolvedValueOnce({ data: { items: ['p1'] } });
    asMockCreate().mockReturnValueOnce({ post: ccPost } as any);

    const app = createApp();

    const res = await withLocalAgent(app, (agent) =>
      agent
        .get('/azure/projects')
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .expect(200)
    );

    expect(res.body).toEqual({ items: ['p1'] });
    expect(ccPost).toHaveBeenCalledWith('/azure/projects', {
      orgUrl: 'https://org',
      token: 'pat',
    });
  });

  test('GET /azure/projects returns 400 when credentials missing', async () => {
    const app = createApp();

    const res = await withLocalAgent(app, (agent) => agent.get('/azure/projects').expect(400));

    expect(res.body.message).toContain('Missing credentials');
    // Controller still constructs its axios client in the constructor,
    // but it must not call the upstream post when credentials are missing.
    expect(asMockPost()).not.toHaveBeenCalled();
  });

  test('GET /azure/git/repos/:repoId/branches forwards correctly with query params', async () => {
    const ccPost = jest.fn().mockResolvedValueOnce({ data: { branches: ['main'] } });
    asMockCreate().mockReturnValueOnce({ post: ccPost } as any);

    const app = createApp();

    const res = await withLocalAgent(app, (agent) =>
      agent
        .get('/azure/git/repos/r1/branches')
        .query({ teamProjectId: 'tp1' })
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .expect(200)
    );

    expect(res.body).toEqual({ branches: ['main'] });
    expect(ccPost).toHaveBeenCalledWith('/azure/git/repos/r1/branches', {
      orgUrl: 'https://org',
      token: 'pat',
      teamProjectId: 'tp1',
    });
  });

  test('GET /azure/queries returns upstream error correctly', async () => {
    const error = {
      response: {
        status: 502,
        data: { detail: 'upstream boom' },
      },
    } as any;

    const ccPost = jest.fn().mockRejectedValueOnce(error);
    asMockCreate().mockReturnValueOnce({ post: ccPost } as any);

    const app = createApp();

    const res = await withLocalAgent(app, (agent) =>
      agent
        .get('/azure/queries')
        .query({ teamProjectId: 'tp1', docType: 'STD', path: 'shared' })
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .expect(502)
    );

    expect(res.body).toEqual({
      message: 'Upstream error calling /azure/queries',
      upstreamPath: '/azure/queries',
      error: { detail: 'upstream boom' },
    });
  });

  test('GET /azure/queries forwards path as provided', async () => {
    const ccPost = jest.fn().mockResolvedValueOnce({ data: { items: [] } });
    asMockCreate().mockReturnValueOnce({ post: ccPost } as any);
    const app = createApp();

    await withLocalAgent(app, (agent) =>
      agent
        .get('/azure/queries')
        .query({ teamProjectId: 'tp1', docType: 'STD', path: 'Shared Queries' })
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .expect(200),
    );

    expect(ccPost).toHaveBeenCalledWith('/azure/queries', {
      orgUrl: 'https://org',
      token: 'pat',
      teamProjectId: 'tp1',
      docType: 'STD',
      path: 'Shared Queries',
    });
  });

  test('GET /azure/queries/historical forwards path as provided', async () => {
    const ccPost = jest.fn().mockResolvedValueOnce({ data: { items: [] } });
    asMockCreate().mockReturnValueOnce({ post: ccPost } as any);
    const app = createApp();

    await withLocalAgent(app, (agent) =>
      agent
        .get('/azure/queries/historical')
        .query({ teamProjectId: 'tp1', path: 'Shared Queries' })
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .expect(200),
    );

    expect(ccPost).toHaveBeenCalledWith('/azure/queries/historical', {
      orgUrl: 'https://org',
      token: 'pat',
      teamProjectId: 'tp1',
      path: 'Shared Queries',
    });
  });

  test('GET /azure/queries/:queryId/historical-results preserves upstream message', async () => {
    const error = {
      response: {
        status: 500,
        data: { message: 'WIQL-by-id is not supported for this query type' },
      },
    } as any;

    const ccPost = jest.fn().mockRejectedValueOnce(error);
    asMockCreate().mockReturnValueOnce({ post: ccPost } as any);

    const app = createApp();

    const res = await withLocalAgent(app, (agent) =>
      agent
        .get('/azure/queries/q1/historical-results')
        .query({ teamProjectId: 'tp1', asOf: '2026-03-29T13:17:00.000Z' })
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .expect(500),
    );

    expect(res.body).toEqual({
      message: 'WIQL-by-id is not supported for this query type',
      upstreamPath: '/azure/queries/q1/historical-results',
      error: { message: 'WIQL-by-id is not supported for this query type' },
    });
  });

  test('GET /azure/queries/:queryId/historical-compare forwards compare payload', async () => {
    const ccPost = jest.fn().mockResolvedValueOnce({ data: { summary: { changedCount: 2 } } });
    asMockCreate().mockReturnValueOnce({ post: ccPost } as any);

    const app = createApp();

    const res = await withLocalAgent(app, (agent) =>
      agent
        .get('/azure/queries/q1/historical-compare')
        .query({
          teamProjectId: 'tp1',
          baselineAsOf: '2025-12-22T17:08:00.000Z',
          compareToAsOf: '2025-12-28T08:57:00.000Z',
        })
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .expect(200),
    );

    expect(res.body).toEqual({ summary: { changedCount: 2 } });
    expect(ccPost).toHaveBeenCalledWith('/azure/queries/q1/historical-compare', {
      orgUrl: 'https://org',
      token: 'pat',
      teamProjectId: 'tp1',
      baselineAsOf: '2025-12-22T17:08:00.000Z',
      compareToAsOf: '2025-12-28T08:57:00.000Z',
    });
  });

  test('GET /azure/queries/:queryId/historical-compare returns 400 when compare range is invalid', async () => {
    const ccPost = jest.fn();
    asMockCreate().mockReturnValueOnce({ post: ccPost } as any);

    const app = createApp();

    const res = await withLocalAgent(app, (agent) =>
      agent
        .get('/azure/queries/q1/historical-compare')
        .query({
          teamProjectId: 'tp1',
          baselineAsOf: '2026-03-31T12:00:00.000Z',
          compareToAsOf: '2026-03-31T11:00:00.000Z',
        })
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .expect(400),
    );

    expect(res.body).toEqual({
      message: 'compareToAsOf must be later than baselineAsOf',
    });
    expect(ccPost).not.toHaveBeenCalled();
  });

  test('POST /time-machine/as-of maps contract payload to legacy historical-results upstream call', async () => {
    const ccPost = jest.fn().mockResolvedValueOnce({ data: { rows: [] } });
    asMockCreate().mockReturnValueOnce({ post: ccPost } as any);

    const app = createApp();

    const res = await withLocalAgent(app, (agent) =>
      agent
        .post('/time-machine/as-of')
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .send({
          teamProject: 'tp1',
          queryId: 'q1',
          asOf: '2026-03-29T13:17:00.000Z',
        })
        .expect(200),
    );

    expect(res.body).toEqual({ rows: [] });
    expect(ccPost).toHaveBeenCalledWith('/azure/queries/q1/historical-results', {
      orgUrl: 'https://org',
      token: 'pat',
      teamProjectId: 'tp1',
      asOf: '2026-03-29T13:17:00.000Z',
    });
  });

  test('POST /time-machine/compare maps contract payload to legacy historical-compare upstream call', async () => {
    const ccPost = jest.fn().mockResolvedValueOnce({ data: { rows: [], updatedCount: 0 } });
    asMockCreate().mockReturnValueOnce({ post: ccPost } as any);

    const app = createApp();

    const res = await withLocalAgent(app, (agent) =>
      agent
        .post('/time-machine/compare')
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .send({
          teamProject: 'tp1',
          queryId: 'q1',
          baselineTimestamp: '2025-12-22T17:08:00.000Z',
          compareToTimestamp: '2025-12-28T08:57:00.000Z',
        })
        .expect(200),
    );

    expect(res.body).toEqual({ rows: [], updatedCount: 0 });
    expect(ccPost).toHaveBeenCalledWith('/azure/queries/q1/historical-compare', {
      orgUrl: 'https://org',
      token: 'pat',
      teamProjectId: 'tp1',
      baselineAsOf: '2025-12-22T17:08:00.000Z',
      compareToAsOf: '2025-12-28T08:57:00.000Z',
    });
  });

  test('POST /time-machine/compare returns 400 when timestamps are invalid', async () => {
    const ccPost = jest.fn();
    asMockCreate().mockReturnValueOnce({ post: ccPost } as any);

    const app = createApp();

    const res = await withLocalAgent(app, (agent) =>
      agent
        .post('/time-machine/compare')
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .send({
          teamProject: 'tp1',
          queryId: 'q1',
          baselineTimestamp: 'not-a-date',
          compareToTimestamp: '2025-12-28T08:57:00.000Z',
        })
        .expect(400),
    );

    expect(res.body).toEqual({
      message: 'baselineTimestamp must be a valid date-time',
    });
    expect(ccPost).not.toHaveBeenCalled();
  });

  test('POST /time-machine/as-of returns 400 when required payload fields are missing', async () => {
    const app = createApp();

    const res = await withLocalAgent(app, (agent) =>
      agent
        .post('/time-machine/as-of')
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .send({ teamProject: 'tp1', queryId: '' })
        .expect(400),
    );

    expect(res.body).toEqual({
      message: 'teamProject, queryId, and asOf are required',
    });
  });
});
