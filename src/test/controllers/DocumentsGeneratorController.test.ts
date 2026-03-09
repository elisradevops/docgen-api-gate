import { DocumentsGeneratorController } from '../../controllers/DocumentsGeneratorController';
import { buildRes } from '../utils/testResponse';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
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
    genMock.generateContentControls.mockResolvedValueOnce([{ cc: 1 }]);

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

  /**
   * upstream error handling
   * If the template generation upstream call fails, controller rejects with upstream message.
   */
  test('upstream template call error transforms and rejects with message', async () => {
    axios.post.mockRejectedValueOnce({ response: { data: { message: 'bad template' } } });

    const req = makeReq();
    const res = buildRes();

    await expect(controller.createJSONDoc(req, res)).rejects.toEqual('bad template');
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

    await expect(controller.createJSONDoc(req, res)).rejects.toEqual('gen failed');
  });
  test('normalizes bucket name and fills default upload properties from env', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({ data: { url: 'http://doc' } });
    genMock.generateContentControls.mockResolvedValueOnce([{ cc: 1 }]);

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
    genMock.generateContentControls.mockResolvedValueOnce([{ isExcelSpreadsheet: true }]);

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
    genMock.generateContentControls.mockResolvedValueOnce([{ isExcelSpreadsheet: true }]);

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
    genMock.generateContentControls.mockResolvedValueOnce([{ isExcelSpreadsheet: true }]);

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
    genMock.generateContentControls.mockResolvedValueOnce([{ cc: 1 }]);

    const req = makeReq();
    const res = buildRes();

    await expect(controller.createJSONDoc(req, res)).rejects.toEqual('json-to-word failed');
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
    genMock.generateContentControls.mockResolvedValueOnce([{ cc: 1 }]);

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
    genMock.generateContentControls.mockResolvedValueOnce([{ isExcelSpreadsheet: true }]);

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
    genMock.generateContentControls.mockResolvedValueOnce([{ isExcelSpreadsheet: true }]);

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
