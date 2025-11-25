import request from 'supertest';
import axios from 'axios';
import App from '../../app';

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

    const res = await request(app).post('/jsonDocument/create').send(makeBody()).expect(200);

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
});
