import { DocumentsGeneratorController } from '../DocumentsGeneratorController';
import { buildRes } from '../../test/utils/testResponse';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../../util/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

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
});
