import { MinioController } from '../../controllers/MinioController';
import logger from '../../util/logger';

/**
 * SharePoint Helper Functions
 * Utility functions for SharePoint operations
 */

/**
 * Get existing files from MinIO for a specific docType
 * @param minioController - Instance of MinioController
 * @param bucketName - MinIO bucket name
 * @param projectName - Project name
 * @param docType - Document type (STD, STR, SVD, SRS)
 * @returns Array of existing files with name, etag, and size
 */
export async function getMinioFiles(
  minioController: MinioController,
  bucketName: string,
  projectName: string,
  docType: string
): Promise<Array<{ name: string; etag: string; size: number }>> {
  try {
    const mockReq: any = {
      params: { bucketName },
      query: { docType, projectName, isExternalUrl: false, recurse: false },
    };
    const mockRes: any = {};

    const minioFiles: any = await minioController.getBucketFileList(mockReq, mockRes);

    if (minioFiles && Array.isArray(minioFiles)) {
      return minioFiles.map((f: any) => ({
        name: f.name,
        etag: f.etag || '',
        size: f.size || 0,
      }));
    }
    return [];
  } catch (error) {
    logger.error(`Error fetching MinIO files for ${docType}: ${error}`);
    return [];
  }
}

/**
 * Extract filename from a path (handles both SharePoint and MinIO paths)
 * @param path - Full file path
 * @returns Filename without path
 */
export function extractFileName(path: string): string {
  return path.split('/').pop() || path;
}

/**
 * Compare file sizes (handles type mismatches between string and number)
 * @param size1 - First size (can be string or number)
 * @param size2 - Second size (can be string or number)
 * @returns True if sizes are equal
 */
export function compareSizes(size1: string | number, size2: string | number): boolean {
  return Number(size1) === Number(size2);
}
