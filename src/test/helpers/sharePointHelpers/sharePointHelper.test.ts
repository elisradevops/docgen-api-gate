import {
  getMinioFiles,
  extractFileName,
  compareSizes,
} from '../../../helpers/sharePointHelpers/sharePointHelper';
import logger from '../../../util/logger';

jest.mock('../../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockLogger = logger as unknown as {
  error: jest.Mock;
};

describe('sharePointHelper', () => {
  describe('getMinioFiles', () => {
    test('returns mapped files when MinioController returns array', async () => {
      const minioController = {
        getBucketFileList: jest.fn().mockResolvedValue([
          { name: 'file1.docx', etag: 'etag1', size: 100 },
          { name: 'file2.docx', etag: undefined, size: undefined },
        ]),
      } as any;

      const result = await getMinioFiles(minioController, 'bucket', 'project', 'SVD');

      expect(minioController.getBucketFileList).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { bucketName: 'bucket' },
          query: {
            docType: 'SVD',
            projectName: 'project',
            isExternalUrl: false,
            recurse: false,
          },
        }),
        expect.any(Object)
      );

      expect(result).toEqual([
        { name: 'file1.docx', etag: 'etag1', size: 100 },
        { name: 'file2.docx', etag: '', size: 0 },
      ]);
    });

    test('returns empty array when MinioController returns non-array', async () => {
      const minioController = {
        getBucketFileList: jest.fn().mockResolvedValue({ not: 'array' }),
      } as any;

      const result = await getMinioFiles(minioController, 'bucket', 'project', 'STD');

      expect(result).toEqual([]);
    });

    test('logs error and returns empty array when getBucketFileList throws', async () => {
      const minioController = {
        getBucketFileList: jest.fn().mockRejectedValue(new Error('boom-minio')),
      } as any;

      const result = await getMinioFiles(minioController, 'bucket', 'project', 'SRS');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error fetching MinIO files for SRS')
      );
      expect(result).toEqual([]);
    });
  });

  describe('extractFileName', () => {
    test('extracts filename from path', () => {
      expect(extractFileName('/sites/project/Templates/SVD/template.dotx')).toBe('template.dotx');
    });

    test('returns original string when no slash is present', () => {
      expect(extractFileName('just-a-file.docx')).toBe('just-a-file.docx');
    });
  });

  describe('compareSizes', () => {
    test('compares numeric and string sizes as equal', () => {
      expect(compareSizes(100, '100')).toBe(true);
    });

    test('returns false when sizes differ', () => {
      expect(compareSizes('10', 20)).toBe(false);
    });
  });
});
