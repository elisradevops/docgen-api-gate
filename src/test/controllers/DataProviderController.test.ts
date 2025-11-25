import { buildRes } from '../utils/testResponse';
import { DataProviderController } from '../../controllers/DataProviderController';

jest.mock('axios', () => {
  const post = jest.fn();
  const create = jest.fn(() => ({ post }));
  return { __esModule: true, default: { create }, create, post } as any;
});

// Silence logger if used indirectly
jest.mock('../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('DataProviderController', () => {
  const axiosMod = require('axios');
  let controller: DataProviderController;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.dgContentControlUrl = 'http://cc.example';
    controller = new DataProviderController();
  });

  /**
   * getTeamProjects (missing creds)
   * Returns 400 when both X-Ado-Org-Url and X-Ado-PAT headers are missing.
   */
  test('getTeamProjects: 400 when missing PAT and orgUrl headers', async () => {
    const req: any = { headers: {}, query: {} };
    const res = buildRes();

    await controller.getTeamProjects(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Missing credentials: X-Ado-Org-Url and X-Ado-PAT are required',
    });
  });

  /**
   * checkOrgUrl (missing orgUrl)
   * Returns 400 when X-Ado-Org-Url header is missing.
   */
  test('checkOrgUrl: 400 when missing orgUrl header', async () => {
    const req: any = { headers: {} };
    const res = buildRes();

    await controller.checkOrgUrl(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Missing X-Ado-Org-Url header' });
  });

  /**
   * getGitRepoList (success)
   * Forwards request to content-control service and returns 200 with upstream data.
   */
  test('getGitRepoList: forwards to content-control on success', async () => {
    const req: any = {
      headers: { 'x-ado-org-url': 'https://org', 'x-ado-pat': 'pat' },
      query: { teamProjectId: 'tp' },
    };
    const res = buildRes();

    axiosMod.create().post.mockResolvedValueOnce({ data: [{ id: 1 }] });

    await controller.getGitRepoList(req, res);

    expect(axiosMod.create).toHaveBeenCalled();
    expect(axiosMod.create().post).toHaveBeenCalledWith('/azure/git/repos', {
      orgUrl: 'https://org',
      token: 'pat',
      teamProjectId: 'tp',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual([{ id: 1 }]);
  });

  /**
   * getRepoPullRequests (propagates upstream error)
   * If the content-control call fails with a response error, propagate status and error body.
   */
  test('getRepoPullRequests: propagates upstream error status and message', async () => {
    const req: any = {
      headers: { 'x-ado-org-url': 'https://org', 'x-ado-pat': 'pat' },
      params: { repoId: 'r1' },
      query: { teamProjectId: 'tp' },
    };
    const res = buildRes();

    axiosMod.create().post.mockRejectedValueOnce({ response: { status: 503, data: { msg: 'cc down' } } });

    await controller.getRepoPullRequests(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toEqual({
      message: 'Upstream error calling /azure/git/repos/r1/pull-requests',
      error: { msg: 'cc down' },
    });
  });

  /**
   * Success forwarding suite
   * Table-driven tests that verify each controller method forwards to the correct path
   * with the expected payload and responds with 200 and upstream data.
   */
  describe('success forwarding for all endpoints', () => {
    const headers = { 'x-ado-org-url': 'https://org', 'x-ado-pat': 'pat' };
    const ok = { data: { ok: true } };

    const cases: Array<{
      name: string;
      call: (c: DataProviderController, r: any, s: any) => Promise<void>;
      req: any;
      path: string;
      payload: any;
    }> = [
      {
        name: 'getTeamProjects',
        call: (c, r, s) => c.getTeamProjects(r, s),
        req: { headers, query: {} },
        path: '/azure/projects',
        payload: { orgUrl: 'https://org', token: 'pat' },
      },
      {
        name: 'getUserProfile',
        call: (c, r, s) => c.getUserProfile(r, s),
        req: { headers },
        path: '/azure/user/profile',
        payload: { orgUrl: 'https://org', token: 'pat' },
      },
      {
        name: 'getCollectionLinkTypes',
        call: (c, r, s) => c.getCollectionLinkTypes(r, s),
        req: { headers },
        path: '/azure/link-types',
        payload: { orgUrl: 'https://org', token: 'pat' },
      },
      {
        name: 'getSharedQueries',
        call: (c, r, s) => c.getSharedQueries(r, s),
        req: { headers, query: { teamProjectId: 'tp', docType: 'STD', path: 'shared' } },
        path: '/azure/queries',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp', path: 'shared', docType: 'STD' },
      },
      {
        name: 'getFieldsByType',
        call: (c, r, s) => c.getFieldsByType(r, s),
        req: { headers, query: { teamProjectId: 'tp', type: 'Bug' } },
        path: '/azure/fields',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp', type: 'Bug' },
      },
      {
        name: 'getQueryResults',
        call: (c, r, s) => c.getQueryResults(r, s),
        req: { headers, params: { queryId: 'q1' }, query: { teamProjectId: 'tp' } },
        path: '/azure/queries/q1/results',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp' },
      },
      {
        name: 'getTestPlansList',
        call: (c, r, s) => c.getTestPlansList(r, s),
        req: { headers, query: { teamProjectId: 'tp' } },
        path: '/azure/tests/plans',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp' },
      },
      {
        name: 'getTestSuitesByPlan',
        call: (c, r, s) => c.getTestSuitesByPlan(r, s),
        req: {
          headers,
          params: { testPlanId: 'p1' },
          query: { teamProjectId: 'tp', includeChildren: 'false' },
        },
        path: '/azure/tests/plans/p1/suites',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp', includeChildren: false },
      },
      {
        name: 'getGitRepoList',
        call: (c, r, s) => c.getGitRepoList(r, s),
        req: { headers, query: { teamProjectId: 'tp' } },
        path: '/azure/git/repos',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp' },
      },
      {
        name: 'getGitRepoBranches',
        call: (c, r, s) => c.getGitRepoBranches(r, s),
        req: { headers, params: { repoId: 'r1' }, query: { teamProjectId: 'tp' } },
        path: '/azure/git/repos/r1/branches',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp' },
      },
      {
        name: 'getGitRepoCommits',
        call: (c, r, s) => c.getGitRepoCommits(r, s),
        req: { headers, params: { repoId: 'r1' }, query: { teamProjectId: 'tp', versionIdentifier: 'main' } },
        path: '/azure/git/repos/r1/commits',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp', versionIdentifier: 'main' },
      },
      {
        name: 'getRepoPullRequests',
        call: (c, r, s) => c.getRepoPullRequests(r, s),
        req: { headers, params: { repoId: 'r1' }, query: { teamProjectId: 'tp' } },
        path: '/azure/git/repos/r1/pull-requests',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp' },
      },
      {
        name: 'getRepoRefs',
        call: (c, r, s) => c.getRepoRefs(r, s),
        req: { headers, params: { repoId: 'r1' }, query: { teamProjectId: 'tp', type: 'heads' } },
        path: '/azure/git/repos/r1/refs',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp', type: 'heads' },
      },
      {
        name: 'getPipelineList',
        call: (c, r, s) => c.getPipelineList(r, s),
        req: { headers, query: { teamProjectId: 'tp' } },
        path: '/azure/pipelines',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp' },
      },
      {
        name: 'getPipelineRuns',
        call: (c, r, s) => c.getPipelineRuns(r, s),
        req: { headers, params: { pipelineId: 'pl1' }, query: { teamProjectId: 'tp' } },
        path: '/azure/pipelines/pl1/runs',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp' },
      },
      {
        name: 'getReleaseDefinitionList',
        call: (c, r, s) => c.getReleaseDefinitionList(r, s),
        req: { headers, query: { teamProjectId: 'tp' } },
        path: '/azure/pipelines/releases/definitions',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp' },
      },
      {
        name: 'getReleaseDefinitionHistory',
        call: (c, r, s) => c.getReleaseDefinitionHistory(r, s),
        req: { headers, params: { definitionId: 'd1' }, query: { teamProjectId: 'tp' } },
        path: '/azure/pipelines/releases/definitions/d1/history',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp' },
      },
      {
        name: 'getWorkItemTypeList',
        call: (c, r, s) => c.getWorkItemTypeList(r, s),
        req: { headers, query: { teamProjectId: 'tp' } },
        path: '/azure/work-item-types',
        payload: { orgUrl: 'https://org', token: 'pat', teamProjectId: 'tp' },
      },
    ];

    test.each(cases)('%s forwards with correct path and payload', async ({ call, req, path, payload }) => {
      const res = buildRes();
      axiosMod.create().post.mockResolvedValueOnce(ok);
      await call(controller, req, res);
      expect(axiosMod.create().post).toHaveBeenCalledWith(path, payload);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.body).toEqual(ok.data);
    });
  });

  /**
   * Missing credentials suite
   * Ensures all relevant methods return 400 when authentication headers are not provided.
   */
  describe('missing creds returns 400 across relevant methods', () => {
    const methods = [
      'getTeamProjects',
      'getUserProfile',
      'getCollectionLinkTypes',
      'getSharedQueries',
      'getFieldsByType',
      'getQueryResults',
      'getTestPlansList',
      'getTestSuitesByPlan',
      'getGitRepoList',
      'getGitRepoBranches',
      'getGitRepoCommits',
      'getRepoPullRequests',
      'getRepoRefs',
      'getPipelineList',
      'getPipelineRuns',
      'getReleaseDefinitionList',
      'getReleaseDefinitionHistory',
      'getWorkItemTypeList',
    ] as const;

    test.each(methods)('%s returns 400 when creds missing', async (method) => {
      const res = buildRes();
      const req: any = { headers: {}, params: {}, query: {} };
      await (controller as any)[method](req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.body).toEqual({ message: 'Missing credentials: X-Ado-Org-Url and X-Ado-PAT are required' });
    });
  });
});
