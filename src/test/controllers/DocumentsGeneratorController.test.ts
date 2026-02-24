import { DocumentsGeneratorController } from '../../controllers/DocumentsGeneratorController';
import { buildRes } from '../utils/testResponse';
import JSZip from 'jszip';

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

  test('creates direct-download zip with main and internal validation excel files', async () => {
    const mainExcelBase64 = Buffer.from('main-excel-content').toString('base64');
    const internalExcelBase64 = Buffer.from('internal-validation-content').toString('base64');
    const zipBase64 = await new JSZip()
      .file('mewp.xlsx', 'main-excel-content')
      .file('mewp-internal-validation.xlsx', 'internal-validation-content')
      .generateAsync({ type: 'base64' });

    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({
        data: {
          FileName: 'mewp.xlsx',
          Base64: mainExcelBase64,
          ApplicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      })
      .mockResolvedValueOnce({ data: { isExcelSpreadsheet: true } })
      .mockResolvedValueOnce({
        data: {
          FileName: 'mewp-internal-validation.xlsx',
          Base64: internalExcelBase64,
          ApplicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      })
      .mockResolvedValueOnce({
        data: {
          FileName: 'mewp.zip',
          Base64: zipBase64,
          ApplicationType: 'application/zip',
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
          title: 'test-reporter-content-control',
          type: 'testReporter',
          headingLevel: 1,
          data: { testPlanId: 12, includeInternalValidationReport: true },
        },
      ],
    });
    const res = buildRes();

    const result = await controller.createJSONDoc(req, res);
    expect(result).toEqual(
      expect.objectContaining({
        FileName: 'mewp.zip',
        ApplicationType: 'application/zip',
      })
    );

    const zip = await JSZip.loadAsync(Buffer.from(result.Base64, 'base64'));
    expect(Object.keys(zip.files).sort()).toEqual(['mewp-internal-validation.xlsx', 'mewp.xlsx']);
    await expect(zip.file('mewp.xlsx')!.async('string')).resolves.toBe('main-excel-content');
    await expect(zip.file('mewp-internal-validation.xlsx')!.async('string')).resolves.toBe(
      'internal-validation-content'
    );

    expect(axios.post.mock.calls.map((call: any[]) => call[0])).toEqual([
      'http://cc/generate-doc-template',
      'http://jw/api/excel/create',
      'http://cc/generate-content-control',
      'http://jw/api/excel/create',
      'http://jw/api/excel/create-zip',
    ]);
  });

  test('end-to-end MEWP standalone zip flow keeps required report fields in both excel payloads', async () => {
    const mewpCoverageColumns = [
      'L2 REQ ID',
      'L2 REQ Title',
      'L2 SubSystem',
      'L2 Run Status',
      'Bug ID',
      'Bug Title',
      'Bug Responsibility',
      'L3 REQ ID',
      'L3 REQ Title',
      'L4 REQ ID',
      'L4 REQ Title',
    ];
    const internalValidationColumns = [
      'Test Case ID',
      'Test Case Title',
      'Mentioned but Not Linked',
      'Linked but Not Mentioned',
      'Validation Status',
    ];

    genMock.generateContentControls.mockResolvedValueOnce([
      {
        title: 'mewp-l2-implementation-content-control',
        isExcelSpreadsheet: true,
        wordObjects: [
          {
            type: 'MewpCoverageReporter',
            testPlanName: 'MEWP L2 Coverage - Plan A',
            columnOrder: mewpCoverageColumns,
            rows: [
              {
                'L2 REQ ID': 'SR0538',
                'L2 REQ Title': 'Requirement 0538',
                'L2 SubSystem': 'ESUK',
                'L2 Run Status': 'Fail',
                'Bug ID': 101,
                'Bug Title': 'Bug 101',
                'Bug Responsibility': 'ESUK',
                'L3 REQ ID': '9001',
                'L3 REQ Title': 'L3 Req',
                'L4 REQ ID': '',
                'L4 REQ Title': '',
              },
            ],
          },
        ],
      },
    ]);

    let excelCreateCall = 0;
    const zipBase64 = await new JSZip()
      .file('mewp-l2-coverage-report.xlsx', 'coverage-excel')
      .file('mewp-internal-validation-report.xlsx', 'internal-validation-excel')
      .generateAsync({ type: 'base64' });
    axios.post.mockImplementation((url: string, payload: any) => {
      if (url === 'http://cc/generate-doc-template') {
        return Promise.resolve({ data: { template: true } });
      }

      if (url === 'http://cc/generate-content-control') {
        expect(payload.contentControlOptions).toEqual(
          expect.objectContaining({
            type: 'internalValidationReporter',
            title: 'mewp-internal-validation-content-control',
            data: expect.objectContaining({
              includeInternalValidationReport: true,
            }),
          })
        );
        return Promise.resolve({
          data: {
            title: 'mewp-internal-validation-content-control',
            isExcelSpreadsheet: true,
            wordObjects: [
              {
                type: 'InternalValidationReporter',
                testPlanName: 'MEWP Internal Validation - Plan A',
                columnOrder: internalValidationColumns,
                rows: [
                  {
                    'Test Case ID': 3001,
                    'Test Case Title': 'TC 3001',
                    'Mentioned but Not Linked': 'Step 2: SR0538-1',
                    'Linked but Not Mentioned': '',
                    'Validation Status': 'Fail',
                  },
                ],
              },
            ],
          },
        });
      }

      if (url === 'http://jw/api/excel/create') {
        excelCreateCall += 1;
        const control = payload?.JsonDataList?.[0];
        const object = control?.wordObjects?.[0];
        expect(control?.isExcelSpreadsheet).toBe(true);

        if (excelCreateCall === 1) {
          expect(object?.type).toBe('MewpCoverageReporter');
          expect(object?.columnOrder).toEqual(mewpCoverageColumns);
          expect(object?.rows?.[0]).toEqual(
            expect.objectContaining({
              'L2 REQ ID': 'SR0538',
              'L2 REQ Title': 'Requirement 0538',
              'L2 SubSystem': 'ESUK',
              'L2 Run Status': 'Fail',
              'Bug ID': 101,
              'Bug Title': 'Bug 101',
              'Bug Responsibility': 'ESUK',
              'L3 REQ ID': '9001',
              'L3 REQ Title': 'L3 Req',
              'L4 REQ ID': '',
              'L4 REQ Title': '',
            })
          );
          return Promise.resolve({
            data: {
              FileName: 'mewp-l2-coverage-report.xlsx',
              Base64: Buffer.from('coverage-excel').toString('base64'),
              ApplicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            },
          });
        }

        expect(object?.type).toBe('InternalValidationReporter');
        expect(object?.columnOrder).toEqual(internalValidationColumns);
        expect(object?.rows?.[0]).toEqual(
          expect.objectContaining({
            'Test Case ID': 3001,
            'Mentioned but Not Linked': 'Step 2: SR0538-1',
            'Validation Status': 'Fail',
          })
        );
        return Promise.resolve({
          data: {
            FileName: 'mewp-internal-validation-report.xlsx',
            Base64: Buffer.from('internal-validation-excel').toString('base64'),
            ApplicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
        });
      }

      if (url === 'http://jw/api/excel/create-zip') {
        expect(payload?.files).toHaveLength(2);
        return Promise.resolve({
          data: {
            FileName: 'mewp-reports.zip',
            Base64: zipBase64,
            ApplicationType: 'application/zip',
          },
        });
      }

      throw new Error(`Unexpected URL in axios.post mock: ${url}`);
    });

    const req = makeReq({
      teamProjectName: 'MEWP',
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
          data: {
            testPlanId: 34,
            testSuiteArray: [101],
            includeInternalValidationReport: true,
          },
        },
      ],
    });
    const res = buildRes();

    const result = await controller.createJSONDoc(req, res);
    expect(result).toEqual(
      expect.objectContaining({
        FileName: 'mewp-reports.zip',
        ApplicationType: 'application/zip',
      })
    );
    expect(excelCreateCall).toBe(2);

    const zip = await JSZip.loadAsync(Buffer.from(result.Base64, 'base64'));
    expect(Object.keys(zip.files).sort()).toEqual([
      'mewp-internal-validation-report.xlsx',
      'mewp-l2-coverage-report.xlsx',
    ]);
  });

  test('uploads generated zip to minio when direct download is disabled', async () => {
    const mainExcelBase64 = Buffer.from('main').toString('base64');
    const internalExcelBase64 = Buffer.from('internal').toString('base64');

    axios.post
      .mockResolvedValueOnce({ data: { template: true } })
      .mockResolvedValueOnce({
        data: {
          fileName: 'mewp.xlsx',
          base64: mainExcelBase64,
          applicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      })
      .mockResolvedValueOnce({ data: { isExcelSpreadsheet: true } })
      .mockResolvedValueOnce({
        data: {
          fileName: 'mewp-internal-validation.xlsx',
          base64: internalExcelBase64,
          applicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      })
      .mockResolvedValueOnce({
        data: 'http://minio/attach-ments/reports/mewp.zip',
      });
    genMock.generateContentControls.mockResolvedValueOnce([{ isExcelSpreadsheet: true }]);

    const req = makeReq({
      uploadProperties: {
        bucketName: 'ATTACH_MENTS',
        fileName: 'mewp.xlsx',
        subDirectoryInBucket: 'reports',
      },
      contentControls: [
        {
          title: 'test-reporter-content-control',
          type: 'testReporter',
          headingLevel: 2,
          data: { testPlanId: 34, includeInternalValidationReport: true },
        },
      ],
    });
    const res = buildRes();

    const result = await controller.createJSONDoc(req, res);
    expect(result).toBe('http://minio/attach-ments/reports/mewp.zip');
    expect(axios.post).toHaveBeenLastCalledWith(
      'http://jw/api/excel/create-zip',
      expect.objectContaining({
        uploadProperties: expect.objectContaining({
          fileName: 'mewp.zip',
          subDirectoryInBucket: 'reports',
        }),
        files: expect.any(Array),
      })
    );
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
