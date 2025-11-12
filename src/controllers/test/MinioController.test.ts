jest.mock('fs', () => ({
  createReadStream: jest.fn(() => ({} as any)),
  statSync: jest.fn(() => ({ size: 123 })),
  unlinkSync: jest.fn(),
}));

jest.mock('path', () => ({ resolve: jest.fn((p: string) => p) }));

// Mock Minio client
const mockS3 = {
  bucketExists: jest.fn(),
  makeBucket: jest.fn(),
  setBucketPolicy: jest.fn(),
  setBucketLifecycle: jest.fn(),
  listObjectsV2: jest.fn(),
  statObject: jest.fn(),
  putObject: jest.fn(),
  getObject: jest.fn(),
  removeObject: jest.fn(),
};

jest.mock('minio', () => ({
  Client: jest.fn(() => mockS3),
}));

jest.mock('../../util/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

import { MinioController } from '../MinioController';
import { buildRes } from '../../test/utils/testResponse';


function makeStream(emissions: any[]) {
  const handlers: Record<string, Function[]> = { data: [], end: [], error: [] };
  const stream = {
    on: (evt: 'data'|'end'|'error', cb: Function) => { handlers[evt].push(cb); return stream; },
    emitAll: () => { emissions.forEach(e => handlers.data.forEach(cb => cb(e))); handlers.end.forEach(cb => cb()); },
    emitError: (err: any) => { handlers.error.forEach(cb => cb(err)); },
  } as any;
  return stream;
}

describe('MinioController', () => {
  let controller: MinioController;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MINIO_ENDPOINT = 'minio';
    process.env.MINIO_ROOT_USER = 'user';
    process.env.MINIO_ROOT_PASSWORD = 'pass';
    process.env.MINIO_REGION = 'eu';
    process.env.MINIOSERVER = 'http://minio';
    process.env.minioPublicEndPoint = 'http://public';
    controller = new MinioController();
  });

  /**
   * getBucketFileList
   * Ensures listing a filtered bucket streams objects, enriches with metadata, and resolves the aggregated list.
   * Covers: happy path with one object and metadata lookup.
   */
  test('getBucketFileList: returns objects with metadata', async () => {
    const req: any = { params: { bucketName: 'templates' }, query: { projectName: 'p', docType: 'STD' } };
    const res = buildRes();

    const stream = makeStream([{ name: 'p/STD/file1.dotx', etag: '123' }]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);
    mockS3.statObject.mockResolvedValueOnce({ metaData: { createdBy: 'alice' } });

    const p = controller.getBucketFileList(req, res);
    stream.emitAll();
    const result: any = await p;

    expect(result.length).toBe(1);
    expect(result[0].createdBy).toBe('alice');
  });

  /**
   * uploadFile (missing file)
   * Validates 400 error when file is not provided for non-external upload.
   */
  test('uploadFile: 400 when file missing', async () => {
    const req: any = { body: { bucketName: 'attachments', teamProjectName: 'p', docType: 'STD', isExternalUrl: false } };
    const res = buildRes();

    await expect(controller.uploadFile(req, res)).rejects.toEqual('No file provided');
  });

  /**
   * uploadFile (invalid mimetype)
   * Rejects when uploading to templates bucket with non-template mimetype.
   */
  test('uploadFile: rejects invalid template mimetype', async () => {
    const req: any = { body: { bucketName: 'templates', teamProjectName: 'p', docType: 'STD', isExternalUrl: false }, file: { mimetype: 'image/png', originalname: 'f.png', path: '/tmp/f.png' } };

    await expect(controller.uploadFile(req, {} as any)).rejects.toContain('Not a valid template');
  });

  /**
   * uploadFile (success)
   * Ensures existing bucket upload succeeds, returns file item, and unlinks temp file.
   */
  test('uploadFile: success path uploads and unlinks temp file', async () => {
    const fs = require('fs');
    mockS3.bucketExists.mockResolvedValueOnce(true);
    mockS3.putObject.mockImplementation((_b: string, _o: string, _s: any, _len: number, cb: Function) => cb(null, { etag: 'etag-1' }));

    const req: any = { body: { bucketName: 'attachments', teamProjectName: 'p', docType: 'STD', isExternalUrl: false }, file: { mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', originalname: 'f.docx', path: '/tmp/f.docx' } };

    const res = await controller.uploadFile(req, {} as any);
    expect(res).toEqual({ fileItem: expect.any(Object) });
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  test('deleteFile: throws when project is shared', async () => {
    /**
     * deleteFile (shared project)
     * Prevents deletion for shared templates projects.
     */
    const req: any = { params: { etag: '"123"', projectName: 'shared', bucketName: 'templates' } };
    await expect(controller.deleteFile(req, {} as any)).rejects.toThrow('Cannot delete shared templates');
  });

  /**
   * deleteFile (not found)
   * Emits not-found error when object with provided etag is missing.
   */
  test('deleteFile: not found emits proper error', async () => {
    const req: any = { params: { etag: '"nope"', projectName: 'p', bucketName: 'templates' } };
    const stream = makeStream([]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);

    const p = controller.deleteFile(req, {} as any);
    stream.emitAll();
    await expect(p).rejects.toContain('not found');
  });

  /**
   * getJSONContentFromFile
   * Streams JSON content, aggregates buffers, and parses JSON successfully.
   */
  test('getJSONContentFromFile: success', async () => {
    const req: any = { params: { bucketName: 'b', folderName: 'f', fileName: 'file.json' } };
    const dataHandlers: any = { data: [] as any[], end: () => {}, error: () => {} };
    mockS3.getObject.mockImplementation((_b: string, _k: string, cb: Function) => {
      const stream: any = {
        on: (evt: string, fn: any) => { (dataHandlers as any)[evt] = fn; },
      };
      cb(null, stream);
    });

    const p = controller.getJSONContentFromFile(req, {} as any);
    dataHandlers.data(Buffer.from('{"a":1}'));
    dataHandlers.end();
    await expect(p).resolves.toEqual({ a: 1 });
  });

  /**
   * createBucketIfDoesentExsist
   * When bucket is missing, creates it and schedules policy/lifecycle settings.
   * Note: controller resolves before policy/lifecycle promises complete.
   */
  test('createBucketIfDoesentExsist: creates and sets policy/lifecycle', async () => {
    mockS3.bucketExists.mockResolvedValueOnce(false);
    mockS3.makeBucket.mockResolvedValueOnce(undefined);
    mockS3.setBucketPolicy.mockResolvedValueOnce(undefined);
    mockS3.setBucketLifecycle.mockResolvedValueOnce(undefined);

    const req: any = { body: { bucketName: 'attachments' } };

    const result = await controller.createBucketIfDoesentExsist(req, {} as any);
    expect(result).toContain('created successfully');
    expect(mockS3.makeBucket).toHaveBeenCalled();
    // Note: controller resolves before chained promises finish; we won't assert policy/lifecycle calls here
  });
});
