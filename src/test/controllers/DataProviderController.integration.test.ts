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
      error: { detail: 'upstream boom' },
    });
  });
});
