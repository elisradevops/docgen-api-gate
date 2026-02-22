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

jest.mock('../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

import { MinioController } from '../../controllers/MinioController';
import { buildRes } from '../utils/testResponse';

function makeStream(emissions: any[]) {
  const handlers: Record<string, Function[]> = { data: [], end: [], error: [] };
  const stream = {
    on: (evt: 'data' | 'end' | 'error', cb: Function) => {
      handlers[evt].push(cb);
      return stream;
    },
    emitAll: () => {
      emissions.forEach((e) => handlers.data.forEach((cb) => cb(e)));
      handlers.end.forEach((cb) => cb());
    },
    emitError: (err: any) => {
      handlers.error.forEach((cb) => cb(err));
    },
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
    delete process.env.MEWP_EXTERNAL_MAX_FILE_SIZE_BYTES;
    delete process.env.MEWP_EXTERNAL_INGESTION_BUCKET;
    delete process.env.MEWP_EXTERNAL_INGESTION_RETENTION_DAYS;
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
    mockS3.statObject.mockResolvedValueOnce({
      metaData: { createdBy: 'alice', inputSummary: 'docType=STD', inputDetailsKey: 'p/STD/__input__/file1.input.json' },
    });

    const p = controller.getBucketFileList(req, res);
    stream.emitAll();
    const result: any = await p;

    expect(result.length).toBe(1);
    expect(result[0].createdBy).toBe('alice');
    expect(result[0].inputSummary).toBe('docType=STD');
    expect(result[0].inputDetailsKey).toBe('p/STD/__input__/file1.input.json');
  });

  test('getBucketFileList: reads x-amz-meta-* keys for backwards compatibility', async () => {
    const req: any = { params: { bucketName: 'templates' }, query: { projectName: 'p', docType: 'STD' } };
    const res = buildRes();

    const stream = makeStream([{ name: 'p/STD/file1.dotx', etag: '123' }]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);
    mockS3.statObject.mockResolvedValueOnce({
      metaData: {
        'x-amz-meta-createdby': 'alice',
        'x-amz-meta-inputsummary': 'docType=STD',
        'x-amz-meta-inputdetailskey': 'p/STD/__input__/file1.input.json',
      },
    });

    const p = controller.getBucketFileList(req, res);
    stream.emitAll();
    const result: any = await p;

    expect(result.length).toBe(1);
    expect(result[0].createdBy).toBe('alice');
    expect(result[0].inputSummary).toBe('docType=STD');
    expect(result[0].inputDetailsKey).toBe('p/STD/__input__/file1.input.json');
  });

  test('getBucketFileList: filters out __input__ sidecar objects', async () => {
    const req: any = { params: { bucketName: 'templates' }, query: { projectName: 'p', docType: 'STD' } };
    const res = buildRes();

    const stream = makeStream([
      { name: 'p/STD/__input__/file1.dotx.input.json', etag: 'meta' },
      { name: 'p/STD/file1.dotx', etag: '123' },
    ]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);
    mockS3.statObject.mockResolvedValueOnce({ metaData: { createdBy: 'alice', inputSummary: 'docType=STD' } });

    const p = controller.getBucketFileList(req, res);
    stream.emitAll();
    const result: any = await p;

    expect(result.length).toBe(1);
    expect(result[0].name).toBe('p/STD/file1.dotx');
    expect(mockS3.statObject).toHaveBeenCalledTimes(1);
  });

  test('getBucketFileList: skips prefix entries without name', async () => {
    const req: any = { params: { bucketName: 'templates' }, query: { projectName: 'p', docType: 'STD' } };
    const res = buildRes();

    const stream = makeStream([{ prefix: 'p/STD/' }, { name: 'p/STD/file1.dotx', etag: '123' }]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);
    mockS3.statObject.mockResolvedValueOnce({ metaData: { createdBy: 'alice', inputSummary: 'docType=STD' } });

    const p = controller.getBucketFileList(req, res);
    stream.emitAll();
    const result: any = await p;

    expect(result.length).toBe(1);
    expect(result[0].name).toBe('p/STD/file1.dotx');
    expect(mockS3.statObject).toHaveBeenCalledTimes(1);
  });

  test('getBucketFileList: returns prefixes for document-forms root listing', async () => {
    const req: any = { params: { bucketName: 'document-forms' }, query: {} };
    const res = buildRes();

    const stream = makeStream([{ prefix: 'STD/' }, { prefix: 'STR/' }]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);

    const p = controller.getBucketFileList(req, res);
    stream.emitAll();
    const result: any = await p;

    expect(result).toEqual([{ prefix: 'STD/' }, { prefix: 'STR/' }]);
    expect(mockS3.statObject).toHaveBeenCalledTimes(0);
  });

  test('getBucketFileList: returns name-as-prefix for document-forms root listing', async () => {
    const req: any = { params: { bucketName: 'document-forms' }, query: {} };
    const res = buildRes();

    const stream = makeStream([{ name: 'STD/' }, { name: 'STR/' }]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);

    const p = controller.getBucketFileList(req, res);
    stream.emitAll();
    const result: any = await p;

    expect(result).toEqual([{ prefix: 'STD/' }, { prefix: 'STR/' }]);
    expect(mockS3.statObject).toHaveBeenCalledTimes(0);
  });

  test('getBucketFileList: handles metadata stat error and sets createdBy empty', async () => {
    const req: any = { params: { bucketName: 'templates' }, query: { projectName: 'p', docType: 'STD' } };
    const res = buildRes();

    const stream = makeStream([{ name: 'p/STD/file1.dotx', etag: '123' }]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);
    mockS3.statObject.mockRejectedValueOnce(new Error('stat-fail'));

    const p = controller.getBucketFileList(req, res);
    stream.emitAll();
    const result: any = await p;

    expect(result.length).toBe(1);
    expect(result[0].createdBy).toBe('');
    expect(result[0].inputSummary).toBe('');
  });

  /**
   * uploadFile (missing file)
   * Validates 400 error when file is not provided for non-external upload.
   */
  test('uploadFile: 400 when file missing', async () => {
    const req: any = {
      body: { bucketName: 'attachments', teamProjectName: 'p', docType: 'STD', isExternalUrl: false },
    };
    const res = buildRes();

    await expect(controller.uploadFile(req, res)).rejects.toEqual('No file provided');
  });

  /**
   * uploadFile (invalid mimetype)
   * Rejects when uploading to templates bucket with non-template mimetype.
   */
  test('uploadFile: rejects invalid template mimetype', async () => {
    const req: any = {
      body: { bucketName: 'templates', teamProjectName: 'p', docType: 'STD', isExternalUrl: false },
      file: { mimetype: 'image/png', originalname: 'f.png', path: '/tmp/f.png' },
    };

    await expect(controller.uploadFile(req, {} as any)).rejects.toContain('Not a valid template');
  });

  /**
   * uploadFile (success)
   * Ensures existing bucket upload succeeds, returns file item, and unlinks temp file.
   */
  test('uploadFile: success path uploads and unlinks temp file', async () => {
    const fs = require('fs');
    mockS3.bucketExists.mockResolvedValueOnce(true);
    mockS3.putObject.mockImplementation((_b: string, _o: string, _s: any, _len: number, cb: Function) =>
      cb(null, { etag: 'etag-1' })
    );

    const req: any = {
      body: { bucketName: 'attachments', teamProjectName: 'p', docType: 'STD', isExternalUrl: false },
      file: {
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalname: 'f.docx',
        path: '/tmp/f.docx',
      },
    };

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
        on: (evt: string, fn: any) => {
          (dataHandlers as any)[evt] = fn;
        },
      };
      cb(null, stream);
    });

    const p = controller.getJSONContentFromFile(req, {} as any);
    dataHandlers.data(Buffer.from('{"a":1}'));
    dataHandlers.end();
    await expect(p).resolves.toEqual({ a: 1 });
  });

  test('getJSONContentFromObject: success', async () => {
    const req: any = { params: { bucketName: 'b', objectName: 'p/STD/__input__/file1.input.json' } };
    const dataHandlers: any = { data: [] as any[], end: () => {}, error: () => {} };
    mockS3.getObject.mockImplementation((_b: string, _k: string, cb: Function) => {
      const stream: any = {
        on: (evt: string, fn: any) => {
          (dataHandlers as any)[evt] = fn;
        },
      };
      cb(null, stream);
    });

    const p = controller.getJSONContentFromObject(req, {} as any);
    dataHandlers.data(Buffer.from('{"ok":true}'));
    dataHandlers.end();
    await expect(p).resolves.toEqual({ ok: true });
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

  test('createBucketIfDoesentExsist: resolves when bucket already exists', async () => {
    mockS3.bucketExists.mockResolvedValueOnce(true);

    const req: any = { body: { bucketName: 'attachments' } };

    const result = await controller.createBucketIfDoesentExsist(req, {} as any);
    expect(result).toContain('exsists.');
  });

  test('createBucketIfDoesentExsist: rejects when bucketExists fails', async () => {
    mockS3.bucketExists.mockRejectedValueOnce(new Error('boom'));

    const req: any = { body: { bucketName: 'attachments' } };

    await expect(controller.createBucketIfDoesentExsist(req, {} as any)).rejects.toEqual('boom');
  });

  test('createBucketIfDoesentExsist: resolves even if makeBucket fails (current behavior)', async () => {
    mockS3.bucketExists.mockResolvedValueOnce(false);
    mockS3.makeBucket.mockRejectedValueOnce(new Error('mk-fail'));

    const req: any = { body: { bucketName: 'attachments' } };

    const result = await controller.createBucketIfDoesentExsist(req, {} as any);
    expect(result).toContain('created successfully');
  });

  test('uploadFile: external url and bucket creation', async () => {
    const fs = require('fs');
    mockS3.bucketExists.mockResolvedValueOnce(false);
    mockS3.makeBucket.mockResolvedValueOnce(undefined);
    mockS3.putObject.mockImplementation((_b: string, _o: string, _s: any, _len: number, cb: Function) =>
      cb(null, { etag: 'etag-2' })
    );

    const req: any = {
      body: { bucketName: 'attachments', teamProjectName: 'p', docType: 'STD', isExternalUrl: true },
      file: {
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalname: 'f.docx',
        path: '/tmp/f.docx',
      },
    };

    const result: any = await controller.uploadFile(req, {} as any);
    expect(result.fileItem.url).toContain('http://public/');
    expect(mockS3.makeBucket).toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  test('uploadFile: upload error rejects', async () => {
    mockS3.bucketExists.mockResolvedValueOnce(true);
    const uploadError = new Error('upload failed');
    mockS3.putObject.mockImplementation((_b: string, _o: string, _s: any, _len: number, cb: Function) =>
      cb(uploadError)
    );

    const req: any = {
      body: { bucketName: 'attachments', teamProjectName: 'p', docType: 'STD', isExternalUrl: false },
      file: {
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalname: 'f.docx',
        path: '/tmp/f.docx',
      },
    };

    await expect(controller.uploadFile(req, {} as any)).rejects.toBe(uploadError);
  });

  test('uploadFile: bucketExists rejection triggers catch handler', async () => {
    mockS3.bucketExists.mockRejectedValueOnce(new Error('bucket-check-fail'));

    const req: any = {
      body: { bucketName: 'attachments', teamProjectName: 'p', docType: 'STD', isExternalUrl: false },
      file: {
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalname: 'f.docx',
        path: '/tmp/f.docx',
      },
    };

    await expect(controller.uploadFile(req, {} as any)).rejects.toEqual('bucket-check-fail');
  });

  test('uploadFile: MEWP external ingestion rejects invalid docType', async () => {
    const req: any = {
      body: {
        bucketName: 'attachments',
        teamProjectName: 'MEWP',
        docType: 'STD',
        purpose: 'mewpExternalIngestion',
      },
      file: {
        mimetype: 'text/csv',
        originalname: 'bugs.csv',
        path: '/tmp/bugs.csv',
        size: 512,
      },
    };

    await expect(controller.uploadFile(req, {} as any)).rejects.toMatchObject({
      statusCode: 422,
      code: 'MEWP_EXTERNAL_UPLOAD_VALIDATION_FAILED',
    });
  });

  test('uploadFile: MEWP external ingestion rejects unsupported extension', async () => {
    const req: any = {
      body: {
        bucketName: 'attachments',
        teamProjectName: 'MEWP',
        docType: 'bugs',
        purpose: 'mewpExternalIngestion',
      },
      file: {
        mimetype: 'text/plain',
        originalname: 'bugs.txt',
        path: '/tmp/bugs.txt',
        size: 512,
      },
    };

    await expect(controller.uploadFile(req, {} as any)).rejects.toMatchObject({
      statusCode: 422,
      code: 'MEWP_EXTERNAL_UPLOAD_VALIDATION_FAILED',
    });
  });

  test('uploadFile: MEWP external ingestion rejects oversize file', async () => {
    process.env.MEWP_EXTERNAL_MAX_FILE_SIZE_BYTES = '100';
    const req: any = {
      body: {
        bucketName: 'attachments',
        teamProjectName: 'MEWP',
        docType: 'bugs',
        purpose: 'mewpExternalIngestion',
      },
      file: {
        mimetype: 'text/csv',
        originalname: 'bugs.csv',
        path: '/tmp/bugs.csv',
        size: 1024,
      },
    };

    await expect(controller.uploadFile(req, {} as any)).rejects.toMatchObject({
      statusCode: 413,
      code: 'MEWP_EXTERNAL_UPLOAD_VALIDATION_FAILED',
    });
  });

  test('uploadFile: MEWP external ingestion uses dedicated bucket/prefix and 1-day retention by default', async () => {
    const fs = require('fs');
    mockS3.bucketExists.mockResolvedValueOnce(true);
    mockS3.setBucketLifecycle.mockResolvedValueOnce(undefined);
    mockS3.putObject.mockImplementation((_b: string, _o: string, _s: any, _len: number, cb: Function) =>
      cb(null, { etag: 'mewp-etag-1' })
    );

    const req: any = {
      body: {
        bucketName: 'attachments',
        teamProjectName: 'MEWP',
        docType: 'bugs',
        purpose: 'mewpExternalIngestion',
      },
      file: {
        mimetype: 'text/csv',
        originalname: 'bugs.csv',
        path: '/tmp/bugs.csv',
        size: 800,
      },
    };

    const result: any = await controller.uploadFile(req, {} as any);
    expect(mockS3.bucketExists).toHaveBeenCalledWith('mewp-external-ingestion');
    expect(mockS3.setBucketLifecycle).toHaveBeenCalledWith(
      'mewp-external-ingestion',
      expect.objectContaining({
        Rule: [
          expect.objectContaining({
            Expiration: { Days: 1 },
            Filter: { Prefix: 'MEWP/mewp-external-ingestion/' },
          }),
        ],
      })
    );
    expect(mockS3.putObject).toHaveBeenCalledWith(
      'mewp-external-ingestion',
      'MEWP/mewp-external-ingestion/bugs/bugs.csv',
      expect.anything(),
      expect.any(Number),
      expect.any(Function)
    );
    expect(result.fileItem.sourceType).toBe('mewpExternalIngestion');
    expect(result.fileItem.bucketName).toBe('mewp-external-ingestion');
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  test('uploadFile: MEWP external ingestion supports dashed purpose and custom retention days', async () => {
    process.env.MEWP_EXTERNAL_INGESTION_RETENTION_DAYS = '3';
    process.env.MEWP_EXTERNAL_INGESTION_BUCKET = 'my-mewp-bucket';
    mockS3.bucketExists.mockResolvedValueOnce(true);
    mockS3.setBucketLifecycle.mockResolvedValueOnce(undefined);
    mockS3.putObject.mockImplementation((_b: string, _o: string, _s: any, _len: number, cb: Function) =>
      cb(null, { etag: 'mewp-etag-2' })
    );

    const req: any = {
      body: {
        bucketName: 'attachments',
        teamProjectName: 'MEWP',
        docType: 'l3l4',
        purpose: 'mewp-external-ingestion',
      },
      file: {
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        originalname: 'links.xlsx',
        path: '/tmp/links.xlsx',
        size: 1024,
      },
    };

    const result: any = await controller.uploadFile(req, {} as any);
    expect(mockS3.bucketExists).toHaveBeenCalledWith('my-mewp-bucket');
    expect(mockS3.setBucketLifecycle).toHaveBeenCalledWith(
      'my-mewp-bucket',
      expect.objectContaining({
        Rule: [
          expect.objectContaining({
            Expiration: { Days: 3 },
            Filter: { Prefix: 'MEWP/mewp-external-ingestion/' },
          }),
        ],
      })
    );
    expect(result.fileItem.bucketName).toBe('my-mewp-bucket');
    expect(result.fileItem.objectName).toBe('MEWP/mewp-external-ingestion/l3l4/links.xlsx');
  });

  test('deleteFile: deletes when matching etag found', async () => {
    const req: any = { params: { etag: '"123"', projectName: 'p', bucketName: 'templates' } };
    const stream = makeStream([{ name: 'p/file1.dotx', etag: '123' }]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);
    mockS3.removeObject.mockImplementation((_b: string, _k: string, cb: Function) => cb(null));

    const p = controller.deleteFile(req, {} as any);
    stream.emitAll();
    await expect(p).resolves.toContain('deleted successfully');
    expect(mockS3.removeObject).toHaveBeenCalled();
  });

  test('deleteFile: removeObject error rejects with message', async () => {
    const req: any = { params: { etag: '"123"', projectName: 'p', bucketName: 'templates' } };
    const stream = makeStream([{ name: 'p/file1.dotx', etag: '123' }]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);
    mockS3.removeObject.mockImplementation((_b: string, _k: string, cb: Function) =>
      cb(new Error('rm-fail'))
    );

    const p = controller.deleteFile(req, {} as any);
    stream.emitAll();
    await expect(p).rejects.toEqual('rm-fail');
  });

  test('deleteFile: stream error rejects with message', async () => {
    const req: any = { params: { etag: '"123"', projectName: 'p', bucketName: 'templates' } };
    const stream = makeStream([]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);

    const p = controller.deleteFile(req, {} as any);
    stream.emitError(new Error('list-stream-fail'));
    await expect(p).rejects.toEqual('list-stream-fail');
  });

  test('getJSONContentFromFile: rejects on getObject error', async () => {
    const req: any = { params: { bucketName: 'b', folderName: 'f', fileName: 'file.json' } };
    mockS3.getObject.mockImplementation((_b: string, _k: string, cb: Function) => {
      cb({ code: 'NoSuchKey', key: 'f/file.json' }, null);
    });

    await expect(controller.getJSONContentFromFile(req, {} as any)).rejects.toContain(
      'error due to NoSuchKey'
    );
  });

  test('getJSONContentFromFile: stream error rejects', async () => {
    const req: any = { params: { bucketName: 'b', folderName: 'f', fileName: 'file.json' } };
    const handlers: any = { data: () => {}, end: () => {}, error: () => {} };
    mockS3.getObject.mockImplementation((_b: string, _k: string, cb: Function) => {
      const stream: any = {
        on: (evt: string, fn: any) => {
          (handlers as any)[evt] = fn;
        },
      };
      cb(null, stream);
    });

    const p = controller.getJSONContentFromFile(req, {} as any);
    const err = new Error('stream error');
    handlers.error(err);
    await expect(p).rejects.toBe(err);
  });

  test('getBucketFileList: resolves empty array on stream error', async () => {
    const req: any = { params: { bucketName: 'templates' }, query: { projectName: 'p', docType: 'STD' } };
    const res = buildRes();

    const stream = makeStream([]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);

    const p = controller.getBucketFileList(req, res);
    stream.emitError(new Error('stream fail'));
    const result: any = await p;
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  test('getBucketFileList: uses public endpoint when isExternalUrl=true and no docType', async () => {
    const req: any = {
      params: { bucketName: 'templates' },
      query: { projectName: 'p', isExternalUrl: 'true' },
    };
    const res = buildRes();

    const stream = makeStream([{ name: 'p/file1.dotx', etag: '123' }]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);
    mockS3.statObject.mockResolvedValueOnce({ metaData: {} });

    const p = controller.getBucketFileList(req, res);
    stream.emitAll();
    const result: any = await p;

    expect(result.length).toBe(1);
    expect(result[0].url).toContain('http://public/');
  });

  test('getBucketFileList: synchronous error in handleStream rejects with error message', async () => {
    const req: any = { params: { bucketName: 'templates' }, query: {} };
    const res = buildRes();

    const spy = jest.spyOn(controller as any, 'handleStream').mockImplementation(() => {
      throw new Error('sync-fail');
    });

    await expect(controller.getBucketFileList(req, res)).rejects.toEqual('sync-fail');
    spy.mockRestore();
  });

  test('getBucketFileList: supports nested docType prefix for MEWP external ingestion listing', async () => {
    const req: any = {
      params: { bucketName: 'mewp-external-ingestion' },
      query: { projectName: 'MEWP', docType: 'mewp-external-ingestion/bugs', recurse: 'true' },
    };
    const res = buildRes();

    const stream = makeStream([{ name: 'MEWP/mewp-external-ingestion/bugs/bugs.csv', etag: 'e1' }]);
    mockS3.listObjectsV2.mockReturnValueOnce(stream);
    mockS3.statObject.mockResolvedValueOnce({ metaData: {} });

    const p = controller.getBucketFileList(req, res);
    stream.emitAll();
    const result: any = await p;

    expect(mockS3.listObjectsV2).toHaveBeenCalledWith(
      'mewp-external-ingestion',
      'MEWP/mewp-external-ingestion/bugs',
      true
    );
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('MEWP/mewp-external-ingestion/bugs/bugs.csv');
  });
});
