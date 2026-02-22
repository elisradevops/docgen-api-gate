import axios from 'axios';
import App from '../../app';
import { withLocalAgent } from '../utils/localSupertest';
import JSZip from 'jszip';

jest.mock('axios', () => {
  const post = jest.fn();
  const create = jest.fn(() => ({ post }));
  // Support both default import (axios.create / axios.post) and named exports
  return { __esModule: true, default: { create, post }, create, post } as any;
});

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

describe('DocumentsGeneratorController HTTP integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MINIO_ROOT_USER = 'user';
    process.env.MINIO_ROOT_PASSWORD = 'pass';
    process.env.MINIO_REGION = 'eu';
    process.env.MINIOSERVER = 'http://minio';
    process.env.dgContentControlUrl = 'http://cc';
    process.env.jsonToWordPostUrl = 'http://jw';
  });

  function makeBody(overrides: any = {}) {
    return {
      tfsCollectionUri: 'https://org',
      PAT: 'pat',
      teamProjectName: 'project',
      templateFile: 'http://template.dotx',
      formattingSettings: {},
      uploadProperties: { bucketName: 'ATTACH_MENTS' },
      ...overrides,
    };
  }

  test('POST /jsonDocument/create returns documentUrl and calls downstream services correctly', async () => {
    (axios.post as jest.Mock)
      // First call: content-control generate-doc-template
      .mockResolvedValueOnce({ data: { template: true } })
      // Second call: json-to-word create document
      .mockResolvedValueOnce({ data: { url: 'http://doc' } });

    genMock.generateContentControls.mockResolvedValueOnce([{ cc: 1 }]);

    const appInstance = new App();
    const app = appInstance.app;

    const res = await withLocalAgent(app, (agent) => agent.post('/jsonDocument/create').send(makeBody()).expect(200));

    expect(res.body).toEqual({ documentUrl: { url: 'http://doc' } });

    expect(axios.post as jest.Mock).toHaveBeenNthCalledWith(
      1,
      'http://cc/generate-doc-template',
      expect.objectContaining({
        orgUrl: 'https://org',
        token: 'pat',
        projectName: 'project',
        minioEndPoint: 'http://minio',
        minioAccessKey: 'user',
        minioSecretKey: 'pass',
      })
    );

    expect(axios.post as jest.Mock).toHaveBeenNthCalledWith(
      2,
      'http://jw/api/word/create',
      expect.objectContaining({
        uploadProperties: expect.objectContaining({
          bucketName: 'attach-ments',
        }),
      })
    );
  });

  test('POST /jsonDocument/create (MEWP standalone) returns ZIP with mocked coverage/internal-validation reports', async () => {
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
            testPlanName: 'MEWP L2 Coverage - Mock Plan',
            columnOrder: mewpCoverageColumns,
            rows: [
              {
                'L2 REQ ID': 'SR0538',
                'L2 REQ Title': 'Requirement 0538',
                'L2 SubSystem': 'ESUK',
                'L2 Run Status': 'Fail',
                'Bug ID': 12345,
                'Bug Title': 'Mock bug',
                'Bug Responsibility': 'ESUK',
                'L3 REQ ID': '9001',
                'L3 REQ Title': 'Mock L3',
                'L4 REQ ID': '',
                'L4 REQ Title': '',
              },
            ],
          },
        ],
      },
    ]);

    let excelCreateCalls = 0;
    const zipBase64Promise = new JSZip()
      .file('mewp-l2-coverage-report.xlsx', 'mock-main-excel')
      .file('mewp-internal-validation-report.xlsx', 'mock-internal-excel')
      .generateAsync({ type: 'base64' });
    (axios.post as jest.Mock).mockImplementation((url: string, payload: any) => {
      if (url === 'http://cc/generate-doc-template') {
        return Promise.resolve({ data: { template: true } });
      }

      if (url === 'http://cc/generate-content-control') {
        expect(payload.contentControlOptions).toEqual(
          expect.objectContaining({
            type: 'internalValidationReporter',
            title: 'mewp-internal-validation-content-control',
          })
        );
        return Promise.resolve({
          data: {
            title: 'mewp-internal-validation-content-control',
            isExcelSpreadsheet: true,
            wordObjects: [
              {
                type: 'InternalValidationReporter',
                testPlanName: 'MEWP Internal Validation - Mock Plan',
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
        excelCreateCalls += 1;
        const control = payload?.JsonDataList?.[0];
        const object = control?.wordObjects?.[0];

        if (excelCreateCalls === 1) {
          expect(object?.type).toBe('MewpCoverageReporter');
          expect(object?.columnOrder).toEqual(mewpCoverageColumns);
          expect(object?.rows?.[0]).toEqual(
            expect.objectContaining({
              'L2 REQ ID': 'SR0538',
              'L2 REQ Title': 'Requirement 0538',
              'L2 SubSystem': 'ESUK',
              'L2 Run Status': 'Fail',
            })
          );
          return Promise.resolve({
            data: {
              FileName: 'mewp-l2-coverage-report.xlsx',
              Base64: Buffer.from('mock-main-excel').toString('base64'),
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
            Base64: Buffer.from('mock-internal-excel').toString('base64'),
            ApplicationType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
        });
      }

      if (url === 'http://jw/api/excel/create-zip') {
        return zipBase64Promise.then((zipBase64) => ({
          data: {
            FileName: 'mewp-mock-reports.zip',
            Base64: zipBase64,
            ApplicationType: 'application/zip',
          },
        }));
      }

      throw new Error(`Unexpected URL in axios.post mock: ${url}`);
    });

    const appInstance = new App();
    const app = appInstance.app;
    const requestBody = makeBody({
      teamProjectName: 'MEWP',
      uploadProperties: {
        bucketName: 'ATTACH_MENTS',
        fileName: 'mewp-mock.xlsx',
        enableDirectDownload: true,
      },
      contentControls: [
        {
          type: 'mewpStandaloneReporter',
          title: 'mewp-standalone-l2-implementation-content-control',
          headingLevel: 2,
          data: {
            testPlanId: 123,
            testSuiteArray: [456],
            includeInternalValidationReport: true,
            useRelFallback: true,
          },
          isExcelSpreadsheet: true,
        },
      ],
    });

    const res = await withLocalAgent(app, (agent) =>
      agent.post('/jsonDocument/create').send(requestBody).expect(200)
    );

    const documentUrl = res.body?.documentUrl || {};
    expect(documentUrl).toEqual(
      expect.objectContaining({
        FileName: 'mewp-mock-reports.zip',
        ApplicationType: 'application/zip',
      })
    );
    expect(excelCreateCalls).toBe(2);

    const zip = await JSZip.loadAsync(Buffer.from(String(documentUrl.Base64 || ''), 'base64'));
    expect(Object.keys(zip.files).sort()).toEqual([
      'mewp-internal-validation-report.xlsx',
      'mewp-l2-coverage-report.xlsx',
    ]);
    await expect(zip.file('mewp-l2-coverage-report.xlsx')!.async('string')).resolves.toBe(
      'mock-main-excel'
    );
    await expect(zip.file('mewp-internal-validation-report.xlsx')!.async('string')).resolves.toBe(
      'mock-internal-excel'
    );
  });
});
