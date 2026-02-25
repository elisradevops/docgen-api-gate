import App from '../../app';
import * as fs from 'fs';
import * as path from 'path';
import { withLocalAgent } from '../utils/localSupertest';

describe('JsonDocRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    const uploadDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadDir)) {
      return;
    }

    try {
      const files = fs.readdirSync(uploadDir);
      for (const file of files) {
        const fullPath = path.join(uploadDir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            fs.unlinkSync(fullPath);
          }
        } catch {
          // ignore errors deleting individual files
        }
      }
    } catch {
      // ignore errors reading the uploads directory
    }
  });

  function createAppAndRoutes(): any {
    const AppClass = require('../../app').default as typeof App;
    const appInstance = new AppClass();
    const app = appInstance.app;
    const routes = appInstance.routePrv as any;
    return { app, routes };
  }

  test('GET /jsonDocument returns online status', async () => {
    const { app } = createAppAndRoutes();

    const res = await withLocalAgent(app, (agent) => agent.get('/jsonDocument').expect(200));

    expect(res.body.status).toMatch(/online - /);
  });

  test('POST /jsonDocument/create returns documentUrl on success', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.documentsGeneratorController as any).createJSONDoc = jest
      .fn()
      .mockResolvedValue({ url: 'http://doc' });

    const res = await withLocalAgent(app, (agent) =>
      agent.post('/jsonDocument/create').send({ some: 'payload' }).expect(200)
    );

    expect(routes.documentsGeneratorController.createJSONDoc).toHaveBeenCalled();
    expect(res.body).toEqual({ documentUrl: { url: 'http://doc' } });
  });

  test('POST /jsonDocument/create returns 500 when controller rejects', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.documentsGeneratorController as any).createJSONDoc = jest.fn().mockRejectedValue('boom-doc');

    const res = await withLocalAgent(app, (agent) => agent.post('/jsonDocument/create').send({}).expect(500));

    expect(res.body.message).toContain('Failed to create the document');
    expect(res.body.error).toBe('boom-doc');
  });

  test('POST /jsonDocument/create returns propagated 422 for validation failures', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.documentsGeneratorController as any).createJSONDoc = jest.fn().mockRejectedValue({
      statusCode: 422,
      message: 'External file invalid',
      code: 'MEWP_EXTERNAL_FILE_VALIDATION_FAILED',
    });

    const res = await withLocalAgent(app, (agent) => agent.post('/jsonDocument/create').send({}).expect(422));

    expect(res.body.message).toContain('Failed to create the document External file invalid');
    expect(res.body.error).toEqual(
      expect.objectContaining({
        statusCode: 422,
        code: 'MEWP_EXTERNAL_FILE_VALIDATION_FAILED',
      })
    );
  });

  test('POST /jsonDocument/create-test-reporter-flat returns documentUrl on success', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.documentsGeneratorController as any).createFlatTestReporterDoc = jest
      .fn()
      .mockResolvedValue({ url: 'http://flat-doc' });

    const res = await withLocalAgent(app, (agent) =>
      agent.post('/jsonDocument/create-test-reporter-flat').send({ some: 'payload' }).expect(200)
    );

    expect(routes.documentsGeneratorController.createFlatTestReporterDoc).toHaveBeenCalled();
    expect(res.body).toEqual({ documentUrl: { url: 'http://flat-doc' } });
  });

  test('POST /jsonDocument/create-test-reporter-flat returns 500 when controller rejects', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.documentsGeneratorController as any).createFlatTestReporterDoc = jest
      .fn()
      .mockRejectedValue('boom-flat');

    const res = await withLocalAgent(app, (agent) =>
      agent.post('/jsonDocument/create-test-reporter-flat').send({}).expect(500)
    );

    expect(res.body.message).toContain('Failed to create the flat test reporter document');
    expect(res.body.error).toBe('boom-flat');
  });

  test('POST /jsonDocument/validate-mewp-external-files returns 200 on valid payload', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.documentsGeneratorController as any).validateMewpExternalFiles = jest
      .fn()
      .mockResolvedValue({ valid: true, bugs: { valid: true }, l3l4: { valid: true } });

    const res = await withLocalAgent(app, (agent) =>
      agent
        .post('/jsonDocument/validate-mewp-external-files')
        .send({ teamProjectName: 'MEWP' })
        .expect(200)
    );

    expect(routes.documentsGeneratorController.validateMewpExternalFiles).toHaveBeenCalled();
    expect(res.body).toEqual({ valid: true, bugs: { valid: true }, l3l4: { valid: true } });
  });

  test('POST /jsonDocument/validate-mewp-external-files returns propagated 422 details', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.documentsGeneratorController as any).validateMewpExternalFiles = jest
      .fn()
      .mockRejectedValue({
        statusCode: 422,
        message: 'External Bugs file validation failed',
        code: 'MEWP_EXTERNAL_FILE_VALIDATION_FAILED',
        details: { valid: false, bugs: { missingRequiredColumns: ['SR'] } },
      });

    const res = await withLocalAgent(app, (agent) =>
      agent.post('/jsonDocument/validate-mewp-external-files').send({}).expect(422)
    );

    expect(res.body).toEqual({
      message: 'External Bugs file validation failed',
      code: 'MEWP_EXTERNAL_FILE_VALIDATION_FAILED',
      details: { valid: false, bugs: { missingRequiredColumns: ['SR'] } },
    });
  });

  test('POST /minio/files/uploadFile without file returns 400', async () => {
    const { app } = createAppAndRoutes();

    const res = await withLocalAgent(app, (agent) => agent.post('/minio/files/uploadFile').send({}).expect(400));

    expect(res.body).toEqual({ message: 'No file uploaded' });
  });

  test('GET /minio/bucketFileList forwards list from controller', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.minioController as any).getBucketFileList = jest.fn().mockResolvedValue([{ name: 'file1' }]);

    const res = await withLocalAgent(app, (agent) => agent.get('/minio/bucketFileList/templates').expect(200));

    expect(routes.minioController.getBucketFileList).toHaveBeenCalled();
    expect(res.body).toEqual({ bucketFileList: [{ name: 'file1' }] });
  });

  test('GET /minio/contentFromFile returns contentFromFile on success', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.minioController as any).getJSONContentFromFile = jest.fn().mockResolvedValue({ foo: 'bar' });

    const res = await withLocalAgent(app, (agent) =>
      agent.get('/minio/contentFromFile/templates/proj/file.json').expect(200)
    );

    expect(routes.minioController.getJSONContentFromFile).toHaveBeenCalled();
    expect(res.body).toEqual({ contentFromFile: { foo: 'bar' } });
  });

  test('POST /minio/createBucket returns 200 on success', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.minioController as any).createBucketIfDoesentExsist = jest.fn().mockResolvedValue('ok');

    const res = await withLocalAgent(app, (agent) =>
      agent.post('/minio/createBucket').send({ bucketName: 'templates' }).expect(200)
    );

    expect(routes.minioController.createBucketIfDoesentExsist).toHaveBeenCalled();
    expect(res.body).toEqual({ response: 'ok' });
  });

  test('POST /minio/createBucket returns 404 on controller error', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.minioController as any).createBucketIfDoesentExsist = jest.fn().mockRejectedValue('boom-bucket');

    const res = await withLocalAgent(app, (agent) =>
      agent.post('/minio/createBucket').send({ bucketName: 'templates' }).expect(404)
    );

    expect(res.body).toEqual({ status: 404, message: 'boom-bucket' });
  });

  test('POST /dataBase/createFavorite returns 500 when controller throws', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.dataBaseController as any).createFavorite = jest.fn().mockRejectedValue('db-fail');

    const res = await withLocalAgent(app, (agent) => agent.post('/dataBase/createFavorite').send({}).expect(500));

    expect(res.body.message).toContain('Failed to create/update favorite');
  });

  test('GET /azure/projects delegates to DataProviderController', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.dataProviderController as any).getTeamProjects = jest
      .fn()
      .mockImplementation(async (_req, res) => {
        res.status(200).json({ ok: true });
      });

    const res = await withLocalAgent(app, (agent) =>
      agent
        .get('/azure/projects')
        .set('x-ado-org-url', 'https://org')
        .set('x-ado-pat', 'pat')
        .expect(200)
    );

    expect(routes.dataProviderController.getTeamProjects).toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true });
  });

  test('POST /minio/files/uploadFile returns 200 on controller success', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.minioController as any).uploadFile = jest
      .fn()
      .mockResolvedValue({ fileItem: { name: 'f.docx' } });

    const res = await withLocalAgent(app, (agent) =>
      agent.post('/minio/files/uploadFile').attach('file', Buffer.from('dummy'), 'file.docx').expect(200)
    );

    expect(routes.minioController.uploadFile).toHaveBeenCalled();
    expect(res.body).toEqual({ message: 'File uploaded successfully', fileItem: { name: 'f.docx' } });
  });

  test('POST /minio/files/uploadFile returns 500 on controller error', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.minioController as any).uploadFile = jest.fn().mockRejectedValue('upload-fail');

    const res = await withLocalAgent(app, (agent) =>
      agent.post('/minio/files/uploadFile').attach('file', Buffer.from('dummy'), 'file.docx').expect(500)
    );

    expect(routes.minioController.uploadFile).toHaveBeenCalled();
    expect(res.body.message).toContain('File upload failed');
    expect(res.body.error).toBe('upload-fail');
  });

  test('POST /minio/files/uploadFile returns propagated 422 on MEWP ingestion validation error', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.minioController as any).uploadFile = jest.fn().mockRejectedValue({
      statusCode: 422,
      message: 'Only .xlsx, .xls or .csv files are allowed for MEWP ingestion',
      code: 'MEWP_EXTERNAL_UPLOAD_VALIDATION_FAILED',
    });

    const res = await withLocalAgent(app, (agent) =>
      agent.post('/minio/files/uploadFile').attach('file', Buffer.from('dummy'), 'file.docx').expect(422)
    );

    expect(res.body).toEqual(
      expect.objectContaining({
        code: 'MEWP_EXTERNAL_UPLOAD_VALIDATION_FAILED',
      })
    );
    expect(String(res.body.message || '')).toContain('File upload failed');
  });

  test('DELETE /minio/files/deleteFile returns 200 on success', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.minioController as any).deleteFile = jest.fn().mockResolvedValue('deleted');

    const res = await withLocalAgent(app, (agent) =>
      agent.delete('/minio/files/deleteFile/templates/proj/etag123').expect(200)
    );

    expect(routes.minioController.deleteFile).toHaveBeenCalled();
    expect(res.body).toEqual({ response: 'deleted' });
  });

  test('DELETE /minio/files/deleteFile returns 500 on controller error', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.minioController as any).deleteFile = jest.fn().mockRejectedValue('delete-fail');

    const res = await withLocalAgent(app, (agent) =>
      agent.delete('/minio/files/deleteFile/templates/proj/etag123').expect(500)
    );

    expect(routes.minioController.deleteFile).toHaveBeenCalled();
    expect(res.body.message).toContain('Failed to delete the file');
    expect(res.body.error).toBe('delete-fail');
  });

  test('GET /minio/bucketFileList returns 500 on controller error', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.minioController as any).getBucketFileList = jest.fn().mockRejectedValue('bucket-fail');

    const res = await withLocalAgent(app, (agent) => agent.get('/minio/bucketFileList/templates').expect(500));

    expect(routes.minioController.getBucketFileList).toHaveBeenCalled();
    expect(res.body.message).toContain('Error Occurred while fetching files from bucket');
    expect(res.body.error).toBe('bucket-fail');
  });

  test('GET /minio/contentFromFile returns 404 on controller error', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.minioController as any).getJSONContentFromFile = jest.fn().mockRejectedValue('not-found');

    const res = await withLocalAgent(app, (agent) =>
      agent.get('/minio/contentFromFile/templates/proj/file.json').expect(404)
    );

    expect(routes.minioController.getJSONContentFromFile).toHaveBeenCalled();
    expect(res.body).toEqual({ status: 404, message: 'not-found' });
  });

  test('GET /dataBase/getFavorites returns 200 on success', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.dataBaseController as any).getFavorites = jest.fn().mockImplementation(async (_req, res) => {
      res.status(200).json({ favorites: [] });
    });

    const res = await withLocalAgent(app, (agent) => agent.get('/dataBase/getFavorites').expect(200));

    expect(routes.dataBaseController.getFavorites).toHaveBeenCalled();
    expect(res.body).toEqual({ favorites: [] });
  });

  test('GET /dataBase/getFavorites returns 500 on controller error', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.dataBaseController as any).getFavorites = jest.fn().mockRejectedValue('fav-fail');

    const res = await withLocalAgent(app, (agent) => agent.get('/dataBase/getFavorites').expect(500));

    expect(res.body.message).toContain('Failed to retrieve favorites');
    expect(res.body.error).toBe('fav-fail');
  });

  test('DELETE /dataBase/deleteFavorite returns 200 on success', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.dataBaseController as any).deleteFavorite = jest.fn().mockImplementation(async (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await withLocalAgent(app, (agent) => agent.delete('/dataBase/deleteFavorite/123').expect(200));

    expect(routes.dataBaseController.deleteFavorite).toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true });
  });

  test('DELETE /dataBase/deleteFavorite returns 500 on controller error', async () => {
    const { app, routes } = createAppAndRoutes();
    (routes.dataBaseController as any).deleteFavorite = jest.fn().mockRejectedValue('del-fail');

    const res = await withLocalAgent(app, (agent) => agent.delete('/dataBase/deleteFavorite/123').expect(500));

    expect(res.body.message).toContain('Failed to delete favorite');
    expect(res.body.error).toBe('del-fail');
  });

  test('other Azure proxy routes delegate to DataProviderController', async () => {
    const { app, routes } = createAppAndRoutes();
    const dp: any = routes.dataProviderController;

    const cases: Array<{ method: 'get'; path: string; handler: string }> = [
      { method: 'get', path: '/azure/check-org-url', handler: 'checkOrgUrl' },
      { method: 'get', path: '/azure/user/profile', handler: 'getUserProfile' },
      { method: 'get', path: '/azure/link-types', handler: 'getCollectionLinkTypes' },
      { method: 'get', path: '/azure/queries', handler: 'getSharedQueries' },
      { method: 'get', path: '/azure/fields', handler: 'getFieldsByType' },
      { method: 'get', path: '/azure/queries/q1/results', handler: 'getQueryResults' },
      { method: 'get', path: '/azure/tests/plans', handler: 'getTestPlansList' },
      { method: 'get', path: '/azure/tests/plans/1/suites', handler: 'getTestSuitesByPlan' },
      { method: 'get', path: '/azure/git/repos', handler: 'getGitRepoList' },
      { method: 'get', path: '/azure/git/repos/r1/branches', handler: 'getGitRepoBranches' },
      { method: 'get', path: '/azure/git/repos/r1/commits', handler: 'getGitRepoCommits' },
      { method: 'get', path: '/azure/git/repos/r1/pull-requests', handler: 'getRepoPullRequests' },
      { method: 'get', path: '/azure/git/repos/r1/refs', handler: 'getRepoRefs' },
      { method: 'get', path: '/azure/pipelines', handler: 'getPipelineList' },
      { method: 'get', path: '/azure/pipelines/pl1/runs', handler: 'getPipelineRuns' },
      { method: 'get', path: '/azure/pipelines/releases/definitions', handler: 'getReleaseDefinitionList' },
      {
        method: 'get',
        path: '/azure/pipelines/releases/definitions/d1/history',
        handler: 'getReleaseDefinitionHistory',
      },
      { method: 'get', path: '/azure/work-item-types', handler: 'getWorkItemTypeList' },
    ];

    for (const c of cases) {
      dp[c.handler] = jest.fn().mockImplementation(async (_req, res) => {
        res.status(200).json({ route: c.handler });
      });

      const res = await withLocalAgent(app, (agent) => agent[c.method](c.path).expect(200));

      expect(dp[c.handler]).toHaveBeenCalled();
      expect(res.body).toEqual({ route: c.handler });
    }
  });

  test('SharePoint routes delegate to SharePointController', async () => {
    const { app, routes } = createAppAndRoutes();
    const sp: any = routes.sharePointController;

    sp.testConnection = jest.fn().mockImplementation(async (_req, res) => {
      res.status(200).json({ ok: 'testConnection' });
    });
    sp.listFiles = jest.fn().mockImplementation(async (_req, res) => {
      res.status(200).json({ ok: 'listFiles' });
    });
    sp.checkConflicts = jest.fn().mockImplementation(async (_req, res) => {
      res.status(200).json({ ok: 'checkConflicts' });
    });
    sp.syncTemplates = jest.fn().mockImplementation(async (_req, res) => {
      res.status(200).json({ ok: 'syncTemplates' });
    });
    sp.saveConfig = jest.fn().mockImplementation(async (_req, res) => {
      res.status(200).json({ ok: 'saveConfig' });
    });
    sp.getConfig = jest.fn().mockImplementation(async (_req, res) => {
      res.status(200).json({ ok: 'getConfig' });
    });
    sp.deleteConfig = jest.fn().mockImplementation(async (_req, res) => {
      res.status(200).json({ ok: 'deleteConfig' });
    });
    sp.getConfigs = jest.fn().mockImplementation(async (_req, res) => {
      res.status(200).json({ ok: 'getConfigs' });
    });
    sp.getAllConfigs = jest.fn().mockImplementation(async (_req, res) => {
      res.status(200).json({ ok: 'getAllConfigs' });
    });

    await withLocalAgent(app, async (agent) => {
      await agent.post('/sharepoint/test-connection').expect(200);
      await agent.post('/sharepoint/list-files').expect(200);
      await agent.post('/sharepoint/check-conflicts').expect(200);
      await agent.post('/sharepoint/sync-templates').expect(200);
      await agent.post('/sharepoint/config').expect(200);
      await agent.get('/sharepoint/config').expect(200);
      await agent.delete('/sharepoint/config').expect(200);
      await agent.get('/sharepoint/configs').expect(200);
      await agent.get('/sharepoint/configs/all').expect(200);
    });

    expect(sp.testConnection).toHaveBeenCalled();
    expect(sp.listFiles).toHaveBeenCalled();
    expect(sp.checkConflicts).toHaveBeenCalled();
    expect(sp.syncTemplates).toHaveBeenCalled();
    expect(sp.saveConfig).toHaveBeenCalled();
    expect(sp.getConfig).toHaveBeenCalled();
    expect(sp.deleteConfig).toHaveBeenCalled();
    expect(sp.getConfigs).toHaveBeenCalled();
    expect(sp.getAllConfigs).toHaveBeenCalled();
  });
});
