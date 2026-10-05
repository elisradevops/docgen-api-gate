import { DocumentsGeneratorController } from '../../controllers/DocumentsGeneratorController';
import { buildRes } from '../utils/testResponse';
import { runContextStore } from '../../util/runContext';
import mongoose from 'mongoose';

jest.mock('axios', () => ({
  post: jest.fn(),
  // The template preflight's ranged GET. Unmocked it returns undefined, which the preflight treats
  // as "could not verify" and moves on, so tests that don't care about it are unaffected.
  get: jest.fn(),
}));

jest.mock('../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  readOwnVersion: jest.fn(() => '1.0.0-test'),
  redactValue: jest.fn((value: unknown) => value),
}));

jest.mock('../../models/LogEvent', () => ({
  __esModule: true,
  LogEvent: { deleteMany: jest.fn().mockResolvedValue(undefined), updateMany: jest.fn().mockResolvedValue(undefined) },
  LOG_EVENT_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
}));

jest.mock('../../models/DocumentRun', () => ({
  __esModule: true,
  DocumentRun: {
    create: jest.fn().mockResolvedValue(undefined),
    updateOne: jest.fn().mockResolvedValue(undefined),
  },
  DOCUMENT_RUN_RETENTION_MS: 90 * 24 * 60 * 60 * 1000,
}));

const genMock = { generateContentControls: jest.fn() };
jest.mock('../../helpers/JsonDocGenerators/JsonDocumentGenerator', () => ({
  JSONDocumentGenerator: jest.fn().mockImplementation(() => genMock),
}));

describe('DocumentsGeneratorController', () => {
  const axios = require('axios');
  let controller: DocumentsGeneratorController;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MINIO_ROOT_USER = 'user';
    process.env.MINIO_ROOT_PASSWORD = 'pass';
    process.env.MINIO_REGION = 'eu';
    process.env.MINIOSERVER = 'http://minio';
    process.env.dgContentControlUrl = 'http://cc';
    process.env.jsonToWordPostUrl = 'http://jw';
    controller = new DocumentsGeneratorController();
  });

  /**
   * makeReq
   * Helper to construct a default document request body with optional overrides.
   */
  function makeReq(overrides: any = {}) {
    return {
      body: {
        tfsCollectionUri: 'https://org',
        PAT: 'pat',
        teamProjectName: 'project',
        templateFile: 'http://template.dotx',
        formattingSettings: {},
        uploadProperties: { bucketName: 'ATTACH_MENTS' },
        ...overrides,
      },
    } as any;
  }

  /**
   * success flow
   * Calls content-control to generate placeholders, generates content controls, and posts to json-to-word service.
   * Expects a URL to the created document.
   */
  test('success flow resolves with document URL', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({ data: { url: 'http://doc' } });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ cc: 1 }], steps: [], artifacts: [] });

    const req = makeReq();
    const res = buildRes();

    const result = await controller.createJSONDoc(req, res);
    expect(result).toEqual({ url: 'http://doc' });
    expect(axios.post).toHaveBeenNthCalledWith(
      1,
      'http://cc/generate-doc-template',
      expect.objectContaining({ orgUrl: 'https://org', token: 'pat', projectName: 'project' })
    );
    expect(axios.post).toHaveBeenNthCalledWith(2, 'http://jw/api/word/create', expect.any(Object));
  });

  test('supports template-less requests (empty templateFile) for WordService generation', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { templatePath: '' } })
      .mockResolvedValueOnce({ data: { url: 'http://doc' } });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ cc: 1 }], steps: [], artifacts: [] });

    const req = makeReq({
      templateFile: '',
      contentControls: [
        {
          title: 'historical-compare-report-content-control',
          type: 'historical-compare-report',
          skin: 'time-machine-report',
          headingLevel: 1,
          data: {
            teamProjectName: 'project',
            queryName: 'Shared Query',
            compareResult: { rows: [] },
          },
        },
      ],
    });

    const result = await controller.createJSONDoc(req, buildRes());
    expect(result).toEqual({ url: 'http://doc' });
    expect(axios.post).toHaveBeenNthCalledWith(
      1,
      'http://cc/generate-doc-template',
      expect.objectContaining({
        templateUrl: '',
      })
    );
    expect(axios.post).toHaveBeenNthCalledWith(
      2,
      'http://jw/api/word/create',
      expect.objectContaining({
        templatePath: '',
      })
    );
  });

  /**
   * upstream error handling
   * If the template generation upstream call fails, controller rejects with upstream message.
   */
  test('upstream template call error transforms and rejects with message', async () => {
    axios.post.mockRejectedValueOnce({ response: { data: { message: 'bad template' } } });

    const req = makeReq();
    const res = buildRes();

    await expect(controller.createJSONDoc(req, res)).rejects.toEqual(
      expect.objectContaining({ message: 'bad template', statusCode: 500 })
    );
  });

  /**
   * internal error handling
   * If generating content controls fails internally, controller rejects with the thrown error message.
   */
  test('internal error rejects with message', async () => {
    axios.post.mockResolvedValueOnce({ data: { template: true } });
    genMock.generateContentControls.mockRejectedValueOnce(new Error('gen failed'));

    const req = makeReq();
    const res = buildRes();

    await expect(controller.createJSONDoc(req, res)).rejects.toEqual(
      expect.objectContaining({ message: 'gen failed', statusCode: 500 })
    );
  });
  test('normalizes bucket name and fills default upload properties from env', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({ data: { url: 'http://doc' } });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ cc: 1 }], steps: [], artifacts: [] });

    const req = makeReq({ uploadProperties: { bucketName: 'ATTACH_MENTS ' } });
    const res = buildRes();

    const result = await controller.createJSONDoc(req, res);
    expect(result).toEqual({ url: 'http://doc' });

    expect(axios.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        minioEndPoint: 'http://minio',
        minioAccessKey: 'user',
        minioSecretKey: 'pass',
      })
    );

    const secondCallBody = axios.post.mock.calls[1][1];
    expect(secondCallBody.uploadProperties.bucketName).toBe('attach-ments');
  });

  test('uses excel endpoint when content controls contain spreadsheet', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({ data: { url: 'http://excel-doc' } });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ isExcelSpreadsheet: true }], steps: [], artifacts: [] });

    const req = makeReq();
    const res = buildRes();

    const result = await controller.createJSONDoc(req, res);
    expect(result).toEqual({ url: 'http://excel-doc' });
    expect(axios.post.mock.calls[1][0]).toBe('http://jw/api/excel/create');
  });

  test('MEWP standalone without internal validation returns a single excel file (no zip)', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({
        data: {
          FileName: 'mewp.xlsx',
          Base64: Buffer.from('main-excel').toString('base64'),
          ApplicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ isExcelSpreadsheet: true }], steps: [], artifacts: [] });

    const req = makeReq({
      uploadProperties: {
        bucketName: 'ATTACH_MENTS',
        fileName: 'mewp.xlsx',
        enableDirectDownload: true,
      },
      contentControls: [
        {
          title: 'mewp-l2-implementation-content-control',
          type: 'mewpStandaloneReporter',
          headingLevel: 2,
          data: { testPlanId: 34, includeInternalValidationReport: false },
        },
      ],
    });
    const result = await controller.createJSONDoc(req, buildRes());
    expect(result).toEqual(
      expect.objectContaining({
        FileName: 'mewp.xlsx',
        ApplicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
    );
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post.mock.calls[1][0]).toBe('http://jw/api/excel/create');
    expect(axios.post.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        uploadProperties: expect.objectContaining({
          fileName: 'mewp-l2-coverage-report.xlsx',
        }),
      })
    );
  });

  test('MEWP standalone appends request timestamp to output file names', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({
        data: {
          FileName: 'mewp-l2-coverage-report-2026-02-23-11-50-11.xlsx',
          Base64: Buffer.from('main-excel').toString('base64'),
          ApplicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ isExcelSpreadsheet: true }], steps: [], artifacts: [] });

    const req = makeReq({
      uploadProperties: {
        bucketName: 'ATTACH_MENTS',
        fileName: 'MEWP-Test-Reporter-2026-02-23-11:50:11.xlsx',
        enableDirectDownload: true,
      },
      contentControls: [
        {
          title: 'mewp-l2-implementation-content-control',
          type: 'mewpStandaloneReporter',
          headingLevel: 2,
          data: { testPlanId: 34, includeInternalValidationReport: false },
        },
      ],
    });

    const result = await controller.createJSONDoc(req, buildRes());
    expect(result).toEqual(
      expect.objectContaining({
        FileName: 'mewp-l2-coverage-report-2026-02-23-11-50-11.xlsx',
      })
    );
    expect(axios.post.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        uploadProperties: expect.objectContaining({
          fileName: 'mewp-l2-coverage-report-2026-02-23-11-50-11.xlsx',
        }),
      })
    );
  });

  test('json-to-word service error transforms and rejects with message', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockRejectedValueOnce({ response: { data: { message: 'json-to-word failed' } } });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ cc: 1 }], steps: [], artifacts: [] });

    const req = makeReq();
    const res = buildRes();

    await expect(controller.createJSONDoc(req, res)).rejects.toEqual(
      expect.objectContaining({ message: 'json-to-word failed', statusCode: 500 })
    );
  });

  test('json-to-word validation error preserves status/code for upstream 4xx handling', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockRejectedValueOnce({
        response: {
          status: 422,
          data: { message: 'schema invalid', code: 'MEWP_EXTERNAL_FILE_VALIDATION_FAILED' },
        },
      });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ cc: 1 }], steps: [], artifacts: [] });

    const req = makeReq();
    const res = buildRes();

    await expect(controller.createJSONDoc(req, res)).rejects.toMatchObject({
      message: 'schema invalid',
      statusCode: 422,
      code: 'MEWP_EXTERNAL_FILE_VALIDATION_FAILED',
      details: expect.objectContaining({
        message: 'schema invalid',
        code: 'MEWP_EXTERNAL_FILE_VALIDATION_FAILED',
      }),
    });
  });

  test('internal validation reporter generates a single excel file (no zip)', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({
        data: {
          FileName: 'mewp-internal-validation-report.xlsx',
          Base64: Buffer.from('internal-validation-content').toString('base64'),
          ApplicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ isExcelSpreadsheet: true }], steps: [], artifacts: [] });

    const req = makeReq({
      uploadProperties: {
        bucketName: 'ATTACH_MENTS',
        fileName: 'MEWP-Test-Reporter.xlsx',
      },
      contentControls: [
        {
          title: 'mewp-internal-validation-content-control',
          type: 'internalValidationReporter',
          headingLevel: 2,
          data: { testPlanId: 34 },
        },
      ],
    });

    const result = await controller.createJSONDoc(req, buildRes());
    expect(result).toEqual(
      expect.objectContaining({
        FileName: 'mewp-internal-validation-report.xlsx',
        ApplicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
    );
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post.mock.calls[1][0]).toBe('http://jw/api/excel/create');
    expect(axios.post.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        uploadProperties: expect.objectContaining({
          fileName: 'mewp-internal-validation-report.xlsx',
        }),
      })
    );
    expect(axios.post.mock.calls.some((call: any[]) => call[0].includes('/create-zip'))).toBe(false);
  });

  test('legacy includeInternalValidationReport flag does not trigger zip generation', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({
        data: {
          FileName: 'mewp-l2-coverage-report.xlsx',
          Base64: Buffer.from('main').toString('base64'),
          ApplicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ isExcelSpreadsheet: true }], steps: [], artifacts: [] });

    const req = makeReq({
      uploadProperties: {
        bucketName: 'ATTACH_MENTS',
        fileName: 'mewp.xlsx',
      },
      contentControls: [
        {
          title: 'mewp-l2-implementation-content-control',
          type: 'mewpStandaloneReporter',
          headingLevel: 2,
          data: {
            testPlanId: 34,
            includeInternalValidationReport: true,
          },
        },
      ],
    });

    await controller.createJSONDoc(req, buildRes());
    expect(axios.post.mock.calls.some((call: any[]) => call[0].includes('/create-zip'))).toBe(false);
  });

  function makeFlatReq(overrides: any = {}) {
    return {
      body: {
        tfsCollectionUri: 'https://org',
        PAT: 'pat',
        teamProjectName: 'project',
        templateFile: '',
        formattingSettings: {},
        uploadProperties: { bucketName: 'ATTACH_MENTS' },
        contentControls: [
          {
            title: 'test-reporter-flat-content-control',
            type: 'testReporterFlat',
            headingLevel: 1,
            data: { testPlanId: 12 },
          },
        ],
        ...overrides,
      },
    } as any;
  }

  test('flat test reporter flow resolves with document URL', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { flat: true } })
      .mockResolvedValueOnce({ data: { url: 'http://excel-doc' } });

    const req = makeFlatReq();
    const res = buildRes();

    const result = await controller.createFlatTestReporterDoc(req, res);
    expect(result).toEqual({ url: 'http://excel-doc' });
    expect(axios.post).toHaveBeenNthCalledWith(
      1,
      'http://cc/generate-test-reporter-flat',
      expect.objectContaining({ orgUrl: 'https://org', token: 'pat', projectName: 'project' })
    );
    expect(axios.post.mock.calls[1][0]).toBe('http://jw/api/excel/create');
  });

  test('flat test reporter normalizes bucket name and fills upload properties', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { flat: true } })
      .mockResolvedValueOnce({ data: { url: 'http://excel-doc' } });

    const req = makeFlatReq({ uploadProperties: { bucketName: 'ATTACH_MENTS ' } });
    const res = buildRes();

    const result = await controller.createFlatTestReporterDoc(req, res);
    expect(result).toEqual({ url: 'http://excel-doc' });

    const firstCallBody = axios.post.mock.calls[0][1];
    expect(firstCallBody).toEqual(
      expect.objectContaining({
        minioEndPoint: 'http://minio',
        minioAccessKey: 'user',
        minioSecretKey: 'pass',
      })
    );

    const secondCallBody = axios.post.mock.calls[1][1];
    expect(secondCallBody.uploadProperties.bucketName).toBe('attach-ments');
  });

  test('flat test reporter upstream error rejects with message', async () => {
    axios.post.mockRejectedValueOnce({ response: { data: { message: 'flat cc failed' } } });

    const req = makeFlatReq();
    const res = buildRes();

    await expect(controller.createFlatTestReporterDoc(req, res)).rejects.toEqual('flat cc failed');
  });

  test('flat test reporter json-to-word error rejects with message', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { flat: true } })
      .mockRejectedValueOnce({ response: { data: { message: 'flat excel failed' } } });

    const req = makeFlatReq();
    const res = buildRes();

    await expect(controller.createFlatTestReporterDoc(req, res)).rejects.toEqual('flat excel failed');
  });

  test('validateMewpExternalFiles forwards request and returns validation result', async () => {
    axios.post.mockResolvedValueOnce({
      data: { valid: true, bugs: { valid: true }, l3l4: { valid: true } },
    });

    const req: any = {
      body: {
        tfsCollectionUri: 'https://org',
        PAT: 'pat',
        teamProjectName: 'MEWP',
        templateFile: 'http://template.dotx',
        formattingSettings: { trimAdditionalSpacingInTables: true },
        uploadProperties: {
          ServiceUrl: 'http://minio',
          AwsAccessKeyId: 'ak',
          AwsSecretAccessKey: 'sk',
        },
        externalBugsFile: { bucketName: 'mewp-external-ingestion', objectName: 'MEWP/x/bugs.csv' },
        externalL3L4File: { bucketName: 'mewp-external-ingestion', objectName: 'MEWP/x/l3l4.csv' },
      },
    };

    const result = await controller.validateMewpExternalFiles(req, buildRes());
    expect(result).toEqual({ valid: true, bugs: { valid: true }, l3l4: { valid: true } });
    expect(axios.post).toHaveBeenCalledWith(
      'http://cc/validate-mewp-external-files',
      expect.objectContaining({
        orgUrl: 'https://org',
        projectName: 'MEWP',
        contentControlOptions: {
          data: {
            externalBugsFile: { bucketName: 'mewp-external-ingestion', objectName: 'MEWP/x/bugs.csv' },
            externalL3L4File: { bucketName: 'mewp-external-ingestion', objectName: 'MEWP/x/l3l4.csv' },
          },
        },
      })
    );
  });

  test('validateMewpExternalFiles preserves status/code/details on upstream error', async () => {
    axios.post.mockRejectedValueOnce({
      response: {
        status: 422,
        data: {
          message: 'External Bugs file validation failed',
          code: 'MEWP_EXTERNAL_FILE_VALIDATION_FAILED',
          details: { valid: false, bugs: { missingRequiredColumns: ['SR'] } },
        },
      },
    });

    const req: any = {
      body: {
        tfsCollectionUri: 'https://org',
        PAT: 'pat',
        teamProjectName: 'MEWP',
        uploadProperties: {},
      },
    };

    await expect(controller.validateMewpExternalFiles(req, buildRes())).rejects.toMatchObject({
      statusCode: 422,
      code: 'MEWP_EXTERNAL_FILE_VALIDATION_FAILED',
      details: expect.objectContaining({
        message: 'External Bugs file validation failed',
      }),
    });
  });
});

describe('DocumentsGeneratorController — Phase 6b retain-on-failure prune', () => {
  const axios = require('axios');
  const { LogEvent } = require('../../models/LogEvent');
  const mockDeleteMany = LogEvent.deleteMany as jest.Mock;
  const mockUpdateMany = LogEvent.updateMany as jest.Mock;
  let controller: DocumentsGeneratorController;
  let prevReadyState: number;

  function makeReq(overrides: any = {}) {
    return {
      body: {
        tfsCollectionUri: 'https://org',
        PAT: 'pat',
        teamProjectName: 'project',
        templateFile: 'http://template.dotx',
        formattingSettings: {},
        uploadProperties: { bucketName: 'ATTACH_MENTS' },
        ...overrides,
      },
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.dgContentControlUrl = 'http://cc';
    process.env.jsonToWordPostUrl = 'http://jw';
    controller = new DocumentsGeneratorController();
    prevReadyState = (mongoose.connection as any).readyState;
    (mongoose.connection as any).readyState = 1; // isMongoConnected() reads this directly
  });

  afterEach(() => {
    (mongoose.connection as any).readyState = prevReadyState;
  });

  test('gives retainPending LogEvents a short expiry (not an immediate delete) when the generation succeeds', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({ data: { url: 'http://doc' } });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ cc: 1 }], steps: [], artifacts: [] });

    await runContextStore.run({ runId: 'run-success' }, () => controller.createJSONDoc(makeReq(), buildRes()));

    const [filter, update] = mockUpdateMany.mock.calls[0];
    expect(filter).toEqual({ runId: 'run-success', retainPending: true });
    const msUntilExpiry = update.$set.expiresAt.getTime() - Date.now();
    expect(msUntilExpiry).toBeGreaterThan(0);
    expect(msUntilExpiry).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  test('pins retainPending LogEvents to the full retention when the generation fails', async () => {
    axios.post.mockRejectedValueOnce({ response: { data: { message: 'doc-template failed' } } });

    await expect(
      runContextStore.run({ runId: 'run-failure' }, () => controller.createJSONDoc(makeReq(), buildRes()))
    ).rejects.toBeDefined();

    expect(mockDeleteMany).not.toHaveBeenCalled();
    const [filter, update] = mockUpdateMany.mock.calls[0];
    expect(filter).toEqual({ runId: 'run-failure', retainPending: true });
    expect(update.$set.expiresAt.getTime() - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000);
  });
});

describe('DocumentsGeneratorController — Phase 7a docType on DocumentRun', () => {
  const axios = require('axios');
  const { DocumentRun } = require('../../models/DocumentRun');
  const mockCreate = DocumentRun.create as jest.Mock;
  let controller: DocumentsGeneratorController;
  let prevReadyState: number;

  function makeReq(overrides: any = {}) {
    return {
      body: {
        tfsCollectionUri: 'https://org',
        PAT: 'pat',
        teamProjectName: 'project',
        templateFile: 'http://template.dotx',
        formattingSettings: {},
        uploadProperties: { bucketName: 'ATTACH_MENTS' },
        ...overrides,
      },
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.dgContentControlUrl = 'http://cc';
    process.env.jsonToWordPostUrl = 'http://jw';
    controller = new DocumentsGeneratorController();
    prevReadyState = (mongoose.connection as any).readyState;
    (mongoose.connection as any).readyState = 1;
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({ data: { url: 'http://doc' } });
    genMock.generateContentControls.mockResolvedValueOnce({ results: [{ cc: 1 }], steps: [], artifacts: [] });
  });

  afterEach(() => {
    (mongoose.connection as any).readyState = prevReadyState;
  });

  test('stores captureMode on the run only when verbose capture was requested AND authorized', async () => {
    // First post = check-org-url validation, then the two generation calls.
    axios.post.mockReset();
    axios.post
      .mockResolvedValueOnce({ data: { valid: true } })
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({ data: { url: 'http://doc' } });
    await runContextStore.run({ runId: 'run-cap-ok', requestedCaptureMode: 'verbose' }, () =>
      controller.createJSONDoc(makeReq(), buildRes())
    );
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-cap-ok', captureMode: 'verbose' }));
  });

  test('ignores a capture request whose credentials fail validation, and still generates', async () => {
    axios.post.mockReset();
    axios.post
      .mockRejectedValueOnce(new Error('Request failed with status code 401'))
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({ data: { url: 'http://doc' } });
    await runContextStore.run({ runId: 'run-cap-bad', requestedCaptureMode: 'verbose' }, () =>
      controller.createJSONDoc(makeReq({ PAT: 'bad-pat-for-this-test' }), buildRes())
    );
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-cap-bad', captureMode: undefined }));
  });

  test('a missing template fails the run before any content is fetched, naming the template', async () => {
    axios.get.mockResolvedValueOnce({ status: 404, data: { destroy: jest.fn() } });
    const res = buildRes();
    const err: any = await runContextStore
      .run({ runId: 'run-no-template' }, () =>
        controller.createJSONDoc(makeReq({ templateFile: 'http://s3/templates/shared/STD/STD.dotx' }), res)
      )
      .catch((e: any) => e);
    expect(err).toMatchObject({ statusCode: 404, code: 'TEMPLATE_NOT_FOUND' });
    expect(err.message).toContain('templates/shared/STD/STD.dotx');
    expect(axios.post).not.toHaveBeenCalled(); // never reached content-control or json-to-word
    expect(genMock.generateContentControls).not.toHaveBeenCalled();
  });

  test('a repeated request for a run id that is already recorded is rejected without generating again', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));
    const res = buildRes();
    const err: any = await runContextStore
      .run({ runId: 'run-dup' }, () => controller.createJSONDoc(makeReq(), res))
      .catch((e: any) => e);
    expect(err).toMatchObject({ statusCode: 409, code: 'DUPLICATE_RUN' });
    expect(err.message).toContain('run-dup');
    expect(axios.post).not.toHaveBeenCalled();
    expect(genMock.generateContentControls).not.toHaveBeenCalled();
    // The original run is still in flight: the duplicate must not mark it failed.
    expect(DocumentRun.updateOne).not.toHaveBeenCalled();
  });

  test('a non-duplicate failure to record the run does not stop generation', async () => {
    mockCreate.mockRejectedValueOnce(new Error('mongo down'));
    const res = buildRes();
    const result = await runContextStore.run({ runId: 'run-mongo-err' }, () =>
      controller.createJSONDoc(makeReq(), res)
    );
    expect(result).toEqual({ url: 'http://doc' });
    expect(genMock.generateContentControls).toHaveBeenCalledTimes(1);
  });

  test('stores the curated input on the run when it starts', async () => {
    await runContextStore.run({ runId: 'run-input' }, () =>
      controller.createJSONDoc(
        makeReq({
          uploadProperties: {
            bucketName: 'b',
            fileName: 'f',
            inputSummary: 'Doc Type: STD | Test Plan: 42',
            inputDetails: JSON.stringify({ version: 1, docType: 'STD' }),
            AwsAccessKeyId: 'k',
            AwsSecretAccessKey: 's',
            Region: 'eu',
            ServiceUrl: 'http://minio',
            EnableDirectDownload: false,
          },
        }),
        buildRes()
      )
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-input',
        input: { summary: 'Doc Type: STD | Test Plan: 42', details: { version: 1, docType: 'STD' } },
      })
    );
  });

  test('a run that fails at the template check still records its input and inputs', async () => {
    const { DocumentRun } = require('../../models/DocumentRun');
    axios.get.mockResolvedValueOnce({ status: 404, data: { destroy: jest.fn() } });
    await runContextStore
      .run({ runId: 'run-early-fail' }, () =>
        controller.createJSONDoc(
          makeReq({
            templateFile: 'http://s3/templates/shared/STD/STD.dotx',
            uploadProperties: {
              bucketName: 'b',
              fileName: 'f',
              inputSummary: 'Doc Type: STD',
              inputDetails: JSON.stringify({ version: 1 }),
              AwsAccessKeyId: 'k',
              AwsSecretAccessKey: 's',
              Region: 'eu',
              ServiceUrl: 'http://minio',
              EnableDirectDownload: false,
            },
          }),
          buildRes()
        )
      )
      .catch(() => undefined);
    // The run record carries the curated input from the start...
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-early-fail', input: expect.anything() }));
    // ...and the manifest written when the run failed already holds the technical inputs, which
    // used to be recorded only after content generation (so an early failure had none).
    const failedUpdate = (DocumentRun.updateOne as jest.Mock).mock.calls.find(([, u]) => u.$set?.status === 'failed');
    expect(failedUpdate?.[1].$set.manifest.inputs).toMatchObject({ templateName: 'http://s3/templates/shared/STD/STD.dotx' });
  });

  test('createJSONDoc walks the run context through its stages in order', async () => {
    const seen: string[] = [];
    const record = () => {
      const step = runContextStore.getStore()?.step;
      if (step && seen[seen.length - 1] !== step) seen.push(step);
    };
    axios.post.mockReset();
    axios.post
      .mockImplementationOnce(async () => {
        record(); // generate-doc-template
        return { data: { template: true } };
      })
      .mockImplementationOnce(async () => {
        record(); // render-document
        return { data: { url: 'http://doc' } };
      });
    axios.get.mockImplementationOnce(async () => {
      record(); // validate-template
      return { status: 206, data: { destroy: jest.fn() } };
    });
    genMock.generateContentControls.mockReset(); // drop the result beforeEach queued
    genMock.generateContentControls.mockImplementationOnce(async () => {
      record(); // generate-content-controls
      return { results: [{ cc: 1 }], steps: [], artifacts: [] };
    });
    await runContextStore.run({ runId: 'run-steps' }, () =>
      controller.createJSONDoc(makeReq({ templateFile: 'http://s3/templates/shared/STD/STD.dotx' }), buildRes())
    );
    expect(seen).toEqual(['validate-template', 'generate-doc-template', 'generate-content-controls', 'render-document']);
  });

  test('stores the session id on the run record', async () => {
    await runContextStore.run({ runId: 'run-sess', sessionId: 'ses-9d2f' }, () =>
      controller.createJSONDoc(makeReq(), buildRes())
    );
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-sess', sessionId: 'ses-9d2f' }));
  });

  test('persists the explicit docType from the request', async () => {
    await runContextStore.run({ runId: 'run-explicit' }, () =>
      controller.createJSONDoc(makeReq({ docType: 'svd' }), buildRes())
    );

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ docType: 'SVD' }));
  });

  test('falls back to deriving docType from templateFile when none is supplied', async () => {
    await runContextStore.run({ runId: 'run-fallback' }, () =>
      controller.createJSONDoc(
        makeReq({ templateFile: 'http://host/templates/shared/SVD/Software%20Version%20Description.dotx' }),
        buildRes()
      )
    );

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ docType: 'SVD' }));
  });

  test('leaves docType undefined for a template-less request', async () => {
    await runContextStore.run({ runId: 'run-no-template' }, () =>
      controller.createJSONDoc(makeReq({ templateFile: '' }), buildRes())
    );

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ docType: undefined }));
  });

  // Phase 7b — proves the precondition installRunIdForwarding's interceptor depends on: the
  // RunContext object itself (not just the DocumentRun record) carries docType.
  test('mutates the RunContext object with docType', async () => {
    const runContext: { runId?: string; docType?: string } = { runId: 'run-mutate' };
    await runContextStore.run(runContext as any, () =>
      controller.createJSONDoc(makeReq({ docType: 'svd' }), buildRes())
    );
    expect(runContext.docType).toBe('SVD');
  });

  // ...and independent of the Mongo/runId guard, since it's set before that early return.
  test('mutates the RunContext object with docType even when Mongo is down / there is no runId', async () => {
    (mongoose.connection as any).readyState = 0;
    const noMongoContext: { docType?: string } = {};
    await runContextStore.run(noMongoContext as any, () =>
      controller.createJSONDoc(makeReq({ docType: 'stp' }), buildRes())
    );
    expect(noMongoContext.docType).toBe('STP');
  });
});
