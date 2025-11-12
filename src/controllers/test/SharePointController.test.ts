jest.mock('../../util/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('fs', () => ({ writeFileSync: jest.fn() }));

const mockSvc = {
  testConnection: jest.fn(),
  listTemplateFiles: jest.fn(),
  downloadFile: jest.fn(),
};

jest.mock('../../services/SharePointService', () => ({
  SharePointService: jest.fn().mockImplementation(() => mockSvc),
}));

const mockGetMinioFiles = jest.fn();
jest.mock('../../helpers/sharePointHelpers/sharePointHelper', () => ({
  getMinioFiles: (...args: any[]) => mockGetMinioFiles(...args),
}));

// Mock MinioController uploadFile used internally (spy applied after require)

// Mock ConfigModel with Mongoose-like API
jest.mock('../../models/SharePointConfig', () => {
  const MockModel: any = function (doc: any) {
    Object.assign(this, doc);
    this.save = jest.fn().mockResolvedValue(this);
  };
  // findOne returns a query with sort() that resolves to a document or null
  MockModel.findOne = jest.fn((query: any) => ({ sort: jest.fn().mockResolvedValue(null) }));
  // find returns a chainable query
  MockModel.find = jest.fn((query: any) => ({
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  }));
  MockModel.deleteOne = jest.fn(async () => ({ deletedCount: 0 }));
  return { SharePointConfig: MockModel, __mockConfigModel: MockModel };
});

import { buildRes } from '../../test/utils/testResponse';

// Require modules after mocks are declared
const { MinioController } = require('../MinioController');
const { SharePointController } = require('../SharePointController');

describe('SharePointController', () => {
  let controller: InstanceType<typeof SharePointController>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-apply uploadFile spy after clearAllMocks so syncTemplates path uses the mock
    jest.spyOn(MinioController.prototype as any, 'uploadFile').mockImplementation(() => Promise.resolve({ fileItem: {} }));
    controller = new SharePointController();
  });

  describe('testConnection', () => {
    /**
     * testConnection (missing fields)
     * Validates request body validation returns 400 when required fields are missing.
     */
    test('400 on missing fields', async () => {
      const req: any = { body: {} };
      const res = buildRes();
      await controller.testConnection(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
    /**
     * testConnection (success)
     * Ensures a successful connection test responds with 200 and service payload.
     */
    test('200 on success', async () => {
      const req: any = { body: { siteUrl: 'u', library: 'l', folder: 'f', oauthToken: { accessToken: 't' } } };
      const res = buildRes();
      mockSvc.testConnection.mockResolvedValueOnce({ success: true });
      await controller.testConnection(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.body).toEqual({ success: true });
    });
  });

  describe('listFiles', () => {
    /**
     * listFiles (missing fields)
     * Validates input and returns 400 when required fields are missing.
     */
    test('400 on missing fields', async () => {
      const res = buildRes();
      await controller.listFiles({ body: {} } as any, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
    /**
     * listFiles (success)
     * Returns 200 and the files list from SharePoint service.
     */
    test('200 on success', async () => {
      const res = buildRes();
      mockSvc.listTemplateFiles.mockResolvedValueOnce([{ name: 'a' }]);
      await controller.listFiles({ body: { siteUrl: 'u', library: 'l', folder: 'f', oauthToken: { accessToken: 't' } } } as any, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.body).toEqual({ success: true, files: [{ name: 'a' }] });
    });
  });

  describe('checkConflicts', () => {
    /**
     * checkConflicts (missing fields)
     * Returns 400 when required fields are not provided.
     */
    test('400 on missing fields', async () => {
      const res = buildRes();
      await controller.checkConflicts({ body: {} } as any, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
    /**
     * checkConflicts (computes conflict/new/invalid)
     * Aggregates SharePoint and MinIO results to identify conflicts, new files, and invalid files by docType.
     */
    test('returns conflicts, newFiles, invalidFiles', async () => {
      const files = [
        { name: 'STD/file1.dotx', length: 10, docType: 'STD' },
        { name: 'BAD/file2.dotx', length: 20, docType: 'BAD' },
        { name: 'STR/file3.dotx', length: 30, docType: 'STR' },
      ];
      mockSvc.listTemplateFiles.mockResolvedValueOnce(files);
      mockGetMinioFiles.mockResolvedValueOnce([{ name: 'project/STD/file1.dotx', size: 99 }]); // cause conflict by size change
      mockGetMinioFiles.mockResolvedValueOnce([]); // for STR

      const res = buildRes();
      await controller.checkConflicts({ body: { siteUrl: 'u', library: 'l', folder: 'f', oauthToken: { accessToken: 't' }, bucketName: 'templates', projectName: 'project' } } as any, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.body.conflicts.length).toBe(1);
      expect(res.body.newFiles.length).toBe(1);
      expect(res.body.invalidFiles.length).toBe(1);
    });
  });

  describe('syncTemplates', () => {
    /**
     * syncTemplates (missing fields)
     * Returns 400 when required fields are missing in the body.
     */
    test('400 on missing fields', async () => {
      const res = buildRes();
      await controller.syncTemplates({ body: {} } as any, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
    /**
     * syncTemplates (skip identical, upload changed)
     * Skips identical templates and uploads only changed ones; responds with synced and skipped lists.
     */
    test('skips identical and uploads others', async () => {
      const files = [
        { name: 'STD/file1.dotx', length: 10, docType: 'STD', serverRelativeUrl: '/x' },
        { name: 'STR/file2.dotx', length: 20, docType: 'STR', serverRelativeUrl: '/y' },
      ];
      mockSvc.listTemplateFiles.mockReset();
      mockGetMinioFiles.mockReset();
      mockSvc.downloadFile.mockReset();
      // First get list
      mockSvc.listTemplateFiles.mockResolvedValueOnce(files);
      // Identical check calls per file
      mockGetMinioFiles.mockResolvedValueOnce([{ name: 'project/STD/file1.dotx', size: 10 }]); // identical -> skip
      mockGetMinioFiles.mockResolvedValueOnce([]); // STR -> not identical
      // Download content for non-identical STR file
      mockSvc.downloadFile.mockResolvedValueOnce(Buffer.from('abcd'));

      const res = buildRes();
      await controller.syncTemplates({ body: { siteUrl: 'u', library: 'l', folder: 'f', oauthToken: { accessToken: 't' }, bucketName: 'templates', projectName: 'project' } } as any, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.body.syncedFiles).toEqual(['STR/file2.dotx']);
      expect(res.body.skippedFiles).toContain('STD/file1.dotx');
    });
  });

  describe('config endpoints', () => {
    /**
     * saveConfig (update path)
     * When an existing config is found, updates it and responds with 200.
     */
    test('saveConfig: update existing config', async () => {
      const res = buildRes();
      const { __mockConfigModel } = require('../../models/SharePointConfig');
      // update path: findOne returns existing doc with save
      __mockConfigModel.findOne.mockResolvedValueOnce({ userId: 'u1', projectName: 'p1', siteUrl: 's', library: 'l', folder: 'f', displayName: 'd', save: jest.fn().mockResolvedValue(null) });
      await controller.saveConfig({ body: { userId: 'u1', projectName: 'p1', siteUrl: 's2', library: 'l2', folder: 'f2', displayName: 'd2' } } as any, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    /**
     * getConfig (found and not found)
     * Returns 404 when no config is found; returns 200 with the config when it exists.
     */
    test('getConfig: found and not found', async () => {
      const res1 = buildRes();
      const { __mockConfigModel } = require('../../models/SharePointConfig');
      // not found
      __mockConfigModel.findOne.mockImplementationOnce(() => ({ sort: jest.fn().mockResolvedValue(null) }));
      await controller.getConfig({ headers: { 'x-user-id': 'u1' }, query: { projectName: 'p1' } } as any, res1);
      expect(res1.status).toHaveBeenCalledWith(404);

      // found with save
      __mockConfigModel.findOne.mockImplementationOnce(() => ({
        sort: jest.fn().mockResolvedValue({ userId: 'u1', projectName: 'p1', siteUrl: 's', library: 'l', folder: 'f', displayName: 'd', lastUsed: new Date(0), save: jest.fn().mockResolvedValue(null) }),
      }));
      const res2 = buildRes();
      await controller.getConfig({ headers: { 'x-user-id': 'u1' }, query: { projectName: 'p1' } } as any, res2);
      expect(res2.status).toHaveBeenCalledWith(200);
      expect(res2.body.success).toBe(true);
    });

    /**
     * getConfigs (requires userId)
     * Returns 400 if the x-user-id header is missing.
     */
    test('getConfigs: requires userId', async () => {
      const res = buildRes();
      await controller.getConfigs({ headers: {} } as any, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    /**
     * getAllConfigs (requires userId)
     * Returns 400 if the x-user-id header is missing.
     */
    test('getAllConfigs: requires userId', async () => {
      const res = buildRes();
      await controller.getAllConfigs({ headers: {} } as any, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    /**
     * deleteConfig (missing fields and success)
     * Returns 400 when required fields missing; returns 200 on successful deletion.
     */
    test('deleteConfig: missing fields and success', async () => {
      const res1 = buildRes();
      await controller.deleteConfig({ headers: {}, query: {} } as any, res1);
      expect(res1.status).toHaveBeenCalledWith(400);

      const { __mockConfigModel } = require('../../models/SharePointConfig');
      __mockConfigModel.deleteOne.mockResolvedValueOnce({ deletedCount: 1 });
      const res2 = buildRes();
      await controller.deleteConfig({ headers: { 'x-user-id': 'u1' }, query: { projectName: 'p1' } } as any, res2);
      expect(res2.status).toHaveBeenCalledWith(200);
    });
  });
});
