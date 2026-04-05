import { Request, Response } from 'express';
import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';

export class DataProviderController {
  private ccClient: AxiosInstance;

  constructor() {
    const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 200, keepAliveMsecs: 10000 });
    const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 200, keepAliveMsecs: 10000 });

    this.ccClient = axios.create({
      baseURL: process.env.dgContentControlUrl,
      httpAgent,
      httpsAgent,
      timeout: 20000,
    });
  }

  private getCreds(req: Request, res: Response): { orgUrl: string; token: string } | null {
    const orgUrl = String(req.headers['x-ado-org-url'] || '').trim();
    const token = String(req.headers['x-ado-pat'] || '').trim();
    if (!orgUrl || !token) {
      res.status(400).json({ message: 'Missing credentials: X-Ado-Org-Url and X-Ado-PAT are required' });
      return null;
    }
    return { orgUrl, token };
  }

  private async forward(res: Response, path: string, payload: any) {
    try {
      const { data } = await this.ccClient.post(path, payload);
      res.status(200).json(data);
    } catch (err: any) {
      const status = err?.response?.status || 500;
      const upstreamData = err?.response?.data;
      const upstreamMessage =
        typeof upstreamData === 'string'
          ? upstreamData
          : typeof upstreamData?.message === 'string'
          ? upstreamData.message
          : '';
      res.status(status).json({
        message: upstreamMessage || `Upstream error calling ${path}`,
        upstreamPath: path,
        error: upstreamData || err?.message || String(err),
      });
    }
  }

  private toValidTimestamp(value: string): number | null {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const ts = Date.parse(raw);
    if (!Number.isFinite(ts)) return null;
    return ts;
  }

  private validateCompareRange(
    baselineValue: string,
    compareToValue: string,
    baselineLabel: string,
    compareToLabel: string,
  ): string | null {
    const baselineTs = this.toValidTimestamp(baselineValue);
    if (baselineTs == null) return `${baselineLabel} must be a valid date-time`;

    const compareToTs = this.toValidTimestamp(compareToValue);
    if (compareToTs == null) return `${compareToLabel} must be a valid date-time`;

    if (baselineTs === compareToTs) {
      return `${baselineLabel} and ${compareToLabel} must be different`;
    }

    if (baselineTs > compareToTs) {
      return `${compareToLabel} must be later than ${baselineLabel}`;
    }

    return null;
  }

  // Management
  public async checkOrgUrl(req: Request, res: Response) {
    const orgUrl = String(req.headers['x-ado-org-url'] || '').trim();
    if (!orgUrl) {
      res.status(400).json({ message: 'Missing X-Ado-Org-Url header' });
      return;
    }
    // Optional: include PAT for combined URL + PAT validation
    const token = String(req.headers['x-ado-pat'] || '').trim();
    await this.forward(res, '/azure/check-org-url', { orgUrl, token });
  }

  public async getTeamProjects(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    await this.forward(res, '/azure/projects', { orgUrl: creds.orgUrl, token: creds.token });
  }

  public async getUserProfile(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    await this.forward(res, '/azure/user/profile', { orgUrl: creds.orgUrl, token: creds.token });
  }

  public async getCollectionLinkTypes(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    await this.forward(res, '/azure/link-types', { orgUrl: creds.orgUrl, token: creds.token });
  }

  // Queries & fields
  public async getSharedQueries(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { teamProjectId = '', docType = '', path = 'shared' } = req.query as Record<string, string>;
    await this.forward(res, `/azure/queries`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
      path,
      docType,
    });
  }

  public async getFieldsByType(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { teamProjectId = '', type = '' } = req.query as Record<string, string>;
    await this.forward(res, '/azure/fields', {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
      type,
    });
  }

  public async getQueryResults(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { queryId } = req.params;
    const { teamProjectId = '' } = req.query as Record<string, string>;
    await this.forward(res, `/azure/queries/${encodeURIComponent(queryId)}/results`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
    });
  }

  public async getHistoricalQueries(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { teamProjectId = '', path = 'shared' } = req.query as Record<string, string>;
    await this.forward(res, '/azure/queries/historical', {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
      path,
    });
  }

  public async getHistoricalQueryResults(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { queryId } = req.params;
    const { teamProjectId = '', asOf = '' } = req.query as Record<string, string>;
    await this.forward(res, `/azure/queries/${encodeURIComponent(queryId)}/historical-results`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
      asOf,
    });
  }

  public async compareHistoricalQueryResults(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const queryId = String(req.params?.queryId || '').trim();
    const { teamProjectId = '', baselineAsOf = '', compareToAsOf = '' } = req.query as Record<string, string>;
    const normalizedBaseline = String(baselineAsOf || '').trim();
    const normalizedCompareTo = String(compareToAsOf || '').trim();

    if (!queryId) {
      res.status(400).json({ message: 'queryId is required' });
      return;
    }
    if (!normalizedBaseline || !normalizedCompareTo) {
      res.status(400).json({ message: 'baselineAsOf and compareToAsOf are required' });
      return;
    }
    const validationError = this.validateCompareRange(
      normalizedBaseline,
      normalizedCompareTo,
      'baselineAsOf',
      'compareToAsOf',
    );
    if (validationError) {
      res.status(400).json({ message: validationError });
      return;
    }

    await this.forward(res, `/azure/queries/${encodeURIComponent(queryId)}/historical-compare`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
      baselineAsOf: normalizedBaseline,
      compareToAsOf: normalizedCompareTo,
    });
  }

  public async getTimeMachineAsOf(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;

    const {
      teamProject = '',
      queryId = '',
      asOf = '',
    } = (req.body || {}) as {
      teamProject?: string;
      queryId?: string;
      asOf?: string;
    };
    const normalizedTeamProject = String(teamProject || '').trim();
    const normalizedQueryId = String(queryId || '').trim();
    const normalizedAsOf = String(asOf || '').trim();

    if (!normalizedTeamProject || !normalizedQueryId || !normalizedAsOf) {
      res.status(400).json({
        message: 'teamProject, queryId, and asOf are required',
      });
      return;
    }

    await this.forward(res, `/azure/queries/${encodeURIComponent(normalizedQueryId)}/historical-results`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId: normalizedTeamProject,
      asOf: normalizedAsOf,
    });
  }

  public async compareTimeMachine(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;

    const {
      teamProject = '',
      queryId = '',
      baselineTimestamp = '',
      compareToTimestamp = '',
    } = (req.body || {}) as {
      teamProject?: string;
      queryId?: string;
      baselineTimestamp?: string;
      compareToTimestamp?: string;
    };
    const normalizedTeamProject = String(teamProject || '').trim();
    const normalizedQueryId = String(queryId || '').trim();
    const normalizedBaseline = String(baselineTimestamp || '').trim();
    const normalizedCompareTo = String(compareToTimestamp || '').trim();

    if (!normalizedTeamProject || !normalizedQueryId || !normalizedBaseline || !normalizedCompareTo) {
      res.status(400).json({
        message: 'teamProject, queryId, baselineTimestamp, and compareToTimestamp are required',
      });
      return;
    }
    const validationError = this.validateCompareRange(
      normalizedBaseline,
      normalizedCompareTo,
      'baselineTimestamp',
      'compareToTimestamp',
    );
    if (validationError) {
      res.status(400).json({ message: validationError });
      return;
    }

    await this.forward(res, `/azure/queries/${encodeURIComponent(normalizedQueryId)}/historical-compare`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId: normalizedTeamProject,
      baselineAsOf: normalizedBaseline,
      compareToAsOf: normalizedCompareTo,
    });
  }

  // Tests
  public async getTestPlansList(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { teamProjectId = '' } = req.query as Record<string, string>;
    await this.forward(res, '/azure/tests/plans', {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
    });
  }

  public async getTestSuitesByPlan(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { testPlanId } = req.params;
    const { teamProjectId = '', includeChildren = 'true' } = req.query as Record<string, string>;
    await this.forward(res, `/azure/tests/plans/${encodeURIComponent(testPlanId)}/suites`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
      includeChildren: includeChildren === 'true',
    });
  }

  // Git
  public async getGitRepoList(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { teamProjectId = '' } = req.query as Record<string, string>;
    await this.forward(res, '/azure/git/repos', {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
    });
  }

  public async getGitRepoBranches(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { repoId } = req.params;
    const { teamProjectId = '' } = req.query as Record<string, string>;
    await this.forward(res, `/azure/git/repos/${encodeURIComponent(repoId)}/branches`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
    });
  }

  public async getGitRepoCommits(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { repoId } = req.params;
    const { teamProjectId = '', versionIdentifier = '' } = req.query as Record<string, string>;
    await this.forward(res, `/azure/git/repos/${encodeURIComponent(repoId)}/commits`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
      versionIdentifier,
    });
  }

  public async getRepoPullRequests(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { repoId } = req.params;
    const { teamProjectId = '' } = req.query as Record<string, string>;
    await this.forward(res, `/azure/git/repos/${encodeURIComponent(repoId)}/pull-requests`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
    });
  }

  public async getRepoRefs(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { repoId } = req.params;
    const { teamProjectId = '', type = '' } = req.query as Record<string, string>;
    await this.forward(res, `/azure/git/repos/${encodeURIComponent(repoId)}/refs`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
      type,
    });
  }

  // Pipelines & releases
  public async getPipelineList(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { teamProjectId = '' } = req.query as Record<string, string>;
    await this.forward(res, '/azure/pipelines', {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
    });
  }

  public async getPipelineRuns(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { pipelineId } = req.params;
    const { teamProjectId = '' } = req.query as Record<string, string>;
    await this.forward(res, `/azure/pipelines/${encodeURIComponent(pipelineId)}/runs`, {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
    });
  }

  public async getReleaseDefinitionList(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { teamProjectId = '' } = req.query as Record<string, string>;
    await this.forward(res, '/azure/pipelines/releases/definitions', {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
    });
  }

  public async getReleaseDefinitionHistory(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { definitionId } = req.params;
    const { teamProjectId = '' } = req.query as Record<string, string>;
    await this.forward(
      res,
      `/azure/pipelines/releases/definitions/${encodeURIComponent(definitionId)}/history`,
      {
        orgUrl: creds.orgUrl,
        token: creds.token,
        teamProjectId,
      }
    );
  }

  public async getWorkItemTypeList(req: Request, res: Response) {
    const creds = this.getCreds(req, res);
    if (!creds) return;
    const { teamProjectId = '' } = req.query as Record<string, string>;
    await this.forward(res, '/azure/work-item-types', {
      orgUrl: creds.orgUrl,
      token: creds.token,
      teamProjectId,
    });
  }
}
