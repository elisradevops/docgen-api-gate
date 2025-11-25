import axios from 'axios';
import { FileManagerServiceHelper } from '../../../helpers/fileManagerService/fileManagerServiceHelper';
import logger from '../../../util/logger';

jest.mock('axios', () => {
  const post = jest.fn();
  return { __esModule: true, default: { post }, post } as any;
});

jest.mock('../../../util/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const asMockPost = () => (axios as any).post as jest.Mock;
const getMockLogger = () => logger as unknown as { error: jest.Mock; debug: jest.Mock };

describe('FileManagerServiceHelper', () => {
  let helper: FileManagerServiceHelper;

  beforeEach(() => {
    jest.clearAllMocks();
    helper = new FileManagerServiceHelper();
    process.env.MINIO_CLIENT_URL = 'http://minio-client';
    process.env.DOCUMENTROOTDIR = '/mnt/docs';
    process.env.DOCUMENTROOTDIR_WINDOWS_PATH = 'D\\Docs';
  });

  test('perpareTemplateFile posts to download endpoint and returns url', async () => {
    asMockPost().mockResolvedValueOnce({ data: { url: 'http://minio-client/file.dotx' } });

    const headers = { 'x-trace-id': '1' };
    const url = 'http://template.dotx';

    const result = await helper.perpareTemplateFile(url, headers);

    expect(asMockPost()).toHaveBeenCalledWith(
      'http://minio-client/minio/downloadFile/sharedDirectory',
      expect.objectContaining({
        url,
        prefix: expect.any(String),
      }),
      { headers }
    );
    expect(result).toBe('http://minio-client/file.dotx');
  });

  test('perpareTemplateFile logs and throws on error', async () => {
    asMockPost().mockRejectedValueOnce(new Error('boom'));

    await expect(helper.perpareTemplateFile('http://template.dotx', {})).rejects.toThrow(
      'Error downloading template'
    );

    expect(getMockLogger().error).toHaveBeenCalled();
  });

  test('uploadDocument posts to upload endpoint and returns filePath', async () => {
    asMockPost().mockResolvedValueOnce({ data: { filePath: '/tmp/file.docx' } });

    const result = await helper.uploadDocument('bucket', 'file.docx', '/tmp/file.docx', {});

    expect(asMockPost()).toHaveBeenCalledWith(
      'http://minio-client/minio/uploadFile',
      {
        bucketName: 'bucket',
        fileName: 'file.docx',
        filePath: '/tmp/file.docx',
      },
      { headers: {} }
    );
    expect(result).toBe('/tmp/file.docx');
  });

  test('uploadDocument logs error response data and returns undefined on failure', async () => {
    asMockPost().mockRejectedValueOnce({ response: { data: 'upload-fail' } });

    const result = await helper.uploadDocument('bucket', 'file.docx', '/tmp/file.docx', {});

    expect(getMockLogger().error).toHaveBeenCalledWith('upload-fail');
    expect(result).toBeUndefined();
  });

  test('replaceWindowsAndLinuxPaths converts linux path to windows', () => {
    const input = '/mnt/docs/folder/file.docx';

    const result = helper.replaceWindowsAndLinuxPaths(input, 'windows');

    expect(result).toContain('D\\Docs');
    expect(result).toContain('folder');
  });

  test('replaceWindowsAndLinuxPaths converts windows path to linux', () => {
    process.env.DOCUMENTROOTDIR = '/mnt/docs';
    process.env.DOCUMENTROOTDIR_WINDOWS_PATH = 'D\\Docs';

    const input = 'D\\Docs\\folder\\file.docx';

    const result = helper.replaceWindowsAndLinuxPaths(input, 'linux');

    expect(result).toContain('/mnt/docs');
    expect(result).toContain('folder');
  });
});
