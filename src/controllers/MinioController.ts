import { Request, Response } from 'express';
import { MinioRequest } from 'models/MinioRequest';

import logger from '../util/logger';
import fs from 'fs';
import path from 'path';

var Minio = require('minio');

export class MinioController {
  private getMewpExternalMaxBytes() {
    const configured = Number(process.env.MEWP_EXTERNAL_MAX_FILE_SIZE_BYTES || 0);
    return Number.isFinite(configured) && configured > 0 ? configured : 20 * 1024 * 1024;
  }

  private getMewpExternalRetentionDays() {
    const configured = Number(process.env.MEWP_EXTERNAL_INGESTION_RETENTION_DAYS || 0);
    return Number.isFinite(configured) && configured > 0 ? configured : 1;
  }

  private toUploadError(message: string, statusCode = 422, code = 'MEWP_EXTERNAL_UPLOAD_VALIDATION_FAILED') {
    const error: any = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
  }

  private getContentType(fileName: string) {
    const lower = String(fileName || '').toLowerCase();
    if (lower.endsWith('.docx')) {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    if (lower.endsWith('.doc')) {
      return 'application/msword';
    }
    if (lower.endsWith('.dotx')) {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.template';
    }
    if (lower.endsWith('.dot')) {
      return 'application/msword';
    }
    if (lower.endsWith('.pdf')) {
      return 'application/pdf';
    }
    if (lower.endsWith('.xlsx')) {
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    if (lower.endsWith('.xls')) {
      return 'application/vnd.ms-excel';
    }
    if (lower.endsWith('.csv')) {
      return 'text/csv';
    }
    if (lower.endsWith('.json')) {
      return 'application/json';
    }
    return 'application/octet-stream';
  }

  public async getBucketFileList(req: Request, res: Response) {
    return new Promise((resolve, reject) => {
      let jsonReq = JSON.stringify(req.params);
      let minioRequest: MinioRequest = JSON.parse(jsonReq);
      const s3Client = this.initS3Client();
      try {
        let objects = [];
        let url = this.SetUrl(minioRequest, req);
        this.handleStream(s3Client, req, minioRequest, url, objects, resolve);
        return objects;
      } catch (err) {
        logger.error(err);
        reject(err.message);
      }
    });
  }

  public async uploadFile(req: Request, res: Response) {
    return new Promise((resolve, reject) => {
      // Ensure the file is provided in the request
      if (!req.file) {
        logger.error('No file provided');
        return reject('No file provided');
      }

      const { docType, teamProjectName, isExternalUrl, createdBy, createdById } = req.body;
      let { bucketName } = req.body;
      const uploadPurpose = String(req.body?.purpose || '').trim().toLowerCase();
      const isMewpExternalIngestion =
        uploadPurpose === 'mewpexternalingestion' || uploadPurpose === 'mewp-external-ingestion';

      if (bucketName === 'templates') {
        const allowedMimeTypes = new Set<string>([
          'application/vnd.openxmlformats-officedocument.wordprocessingml.template', // .dotx
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
        ]);
        if (!allowedMimeTypes.has(req.file.mimetype)) {
          logger.error(`Not a valid template. Received mimetype: ${req.file.mimetype}`);
          return reject('Not a valid template. Only *.dotx or *.docx files are allowed');
        }
      }

      if (isMewpExternalIngestion) {
        const normalizedDocType = String(docType || '')
          .trim()
          .toLowerCase();
        if (normalizedDocType !== 'bugs' && normalizedDocType !== 'l3l4') {
          return reject(
            this.toUploadError(`Invalid MEWP ingestion docType '${docType}'. Allowed values: bugs, l3l4`)
          );
        }
        if (!String(teamProjectName || '').trim()) {
          return reject(this.toUploadError('teamProjectName is required for MEWP ingestion uploads'));
        }

        const lowerName = String(req.file?.originalname || '').toLowerCase();
        const hasAllowedExtension =
          lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls') || lowerName.endsWith('.csv');
        if (!hasAllowedExtension) {
          return reject(this.toUploadError('Only .xlsx, .xls or .csv files are allowed for MEWP ingestion'));
        }

        const maxBytes = this.getMewpExternalMaxBytes();
        const fileSize = Number(req.file?.size || 0);
        if (fileSize <= 0 || fileSize > maxBytes) {
          return reject(
            this.toUploadError(
              `File size is invalid. Maximum allowed size is ${maxBytes} bytes.`,
              fileSize > maxBytes ? 413 : 422
            )
          );
        }

        bucketName = String(process.env.MEWP_EXTERNAL_INGESTION_BUCKET || 'mewp-external-ingestion').trim();
      }
      // Prepare the Minio request with file and folder details
      const minioRequest = {
        bucketName: bucketName, // Use dynamic or environment variables as needed
        folderName: isMewpExternalIngestion
          ? `${teamProjectName}/mewp-external-ingestion/${String(docType || '')
              .trim()
              .toLowerCase()}`
          : `${teamProjectName}/${docType}`, // Use dynamic or environment variables as needed
        fileName: req.file.originalname,
      };
      const s3Client = this.initS3Client();
      let url = '';
      this.standardizeRequest(minioRequest);
      const objectName = `${minioRequest.folderName}/${minioRequest.fileName}`;
      const encodedObjectName = this.encodeObjectPath(objectName);
      let suffix = `${bucketName}/${encodedObjectName}`;
      if (!isMewpExternalIngestion && isExternalUrl === true) {
        url = `${process.env.minioPublicEndPoint}/${suffix}`;
      } else {
        url = `${process.env.MINIOSERVER}/${suffix}`;
      }
      // Read the uploaded file from the temporary 'uploads' directory where multer stores it
      const filePath = path.resolve(req.file.path);
      const fileStream = fs.createReadStream(filePath);
      const fileStat = fs.statSync(filePath);
      const uploadMetadata: Record<string, string> = {};
      if (String(createdBy || '').trim()) {
        uploadMetadata.createdBy = String(createdBy).trim();
      }
      if (String(createdById || '').trim()) {
        uploadMetadata.createdById = String(createdById).trim();
      }
      // Ensure the bucket exists before uploading the file
      s3Client
        .bucketExists(minioRequest.bucketName)
        .then((exists) => {
          if (!exists) {
            return s3Client.makeBucket(minioRequest.bucketName, process.env.MINIO_REGION);
          }
        })
        .then(async () => {
          if (!isMewpExternalIngestion) return;
          const retentionDays = this.getMewpExternalRetentionDays();
          const lifecycleConfig = {
            Rule: [
              {
                ID: 'MewpExternalIngestionRetention',
                Status: 'Enabled',
                Filter: {
                  Prefix: `${teamProjectName}/mewp-external-ingestion/`,
                },
                Expiration: {
                  Days: retentionDays,
                },
              },
            ],
          };
          await s3Client.setBucketLifecycle(minioRequest.bucketName, lifecycleConfig);
        })
        .then(() => {
          // Upload the file to Minio
          s3Client.putObject(
            minioRequest.bucketName,
            objectName,
            fileStream,
            fileStat.size,
            uploadMetadata,
            (err, etag) => {
            // Delete the temporary file after uploading to Minio
            fs.unlinkSync(filePath);
            if (err) {
              logger.error('Error uploading file:', err);
              return reject(err);
            }
            return resolve({
              fileItem: {
                url,
                text: objectName,
                objectName,
                bucketName: minioRequest.bucketName,
                etag: etag?.etag || undefined,
                name: req.file.originalname,
                contentType: req.file.mimetype,
                sizeBytes: Number(req.file.size || fileStat.size || 0),
                sourceType: isMewpExternalIngestion ? 'mewpExternalIngestion' : 'generic',
              },
            });
            }
          );
        })
        .catch((err) => {
          logger.error(err);
          return reject(err.message);
        });
    });
  }

  public async deleteFile(req: Request, res: Response) {
    return new Promise((resolve, reject) => {
      // Remove any surrounding quotes from the target etag
      const targetEtag = req.params.etag.replace(/^"|"$/g, '');
      const targetProject = req.params.projectName || '';
      if (targetProject === 'shared') {
        throw new Error('Cannot delete shared templates');
      }
      logger.debug(`Deleting file with etag: ${targetEtag} from project ${targetProject}`);
      const bucketName = req.params.bucketName || 'templates';
      const s3Client = this.initS3Client();
      let foundKey: string | null = null;

      const stream = s3Client.listObjectsV2(bucketName, targetProject, true);
      stream.on('data', (obj) => {
        // Clean the etag of the current object (remove surrounding quotes if any)
        const objEtag = obj.etag || '';

        // Compare the normalized etags
        if (objEtag && objEtag === targetEtag) {
          logger.info(`Found matching object: ${obj.name} with etag ${objEtag}`);
          foundKey = obj.name;
        }
      });
      stream.on('end', () => {
        if (foundKey) {
          s3Client.removeObject(bucketName, foundKey, (err) => {
            if (err) {
              logger.error(`Error deleting file ${foundKey}:`, err);
              return reject(err.message);
            }
            return resolve(`File ${foundKey} deleted successfully from ${bucketName}`);
          });
        } else {
          logger.error(`No object found with etag: ${targetEtag}`);
          return reject(`File with etag ${req.params.etag} not found`);
        }
      });
      stream.on('error', (err) => {
        logger.error(err);
        return reject(err.message);
      });
    });
  }

  public async getJSONContentFromFile(req: Request, res: Response) {
    return new Promise((resolve, reject) => {
      let jsonReq = JSON.stringify(req.params);
      let minioRequest: MinioRequest = JSON.parse(jsonReq);
      const s3Client = this.initS3Client();
      this.standardizeRequest(minioRequest);
      let miniData = '';

      s3Client.getObject(
        minioRequest.bucketName,
        minioRequest.folderName + '/' + minioRequest.fileName,
        (err, dataStream) => {
          if (err) {
            logger.error(err);
            return reject(`error due to ${err.code} - ${err.key}`);
          }
          dataStream.on('data', (chunk) => {
            miniData += chunk;
          });
          dataStream.on('end', () => {
            let cleaned = String(miniData).replace(/(\r\n|\n|\r)/gm, '');
            cleaned = String(cleaned).replace(/ /g, '');
            const json = JSON.parse(cleaned);
            return resolve(json);
          });
          dataStream.on('error', (streamErr) => {
            logger.error(streamErr);
            return reject(streamErr);
          });
        }
      );
    });
  }

  public async getJSONContentFromObject(req: Request, res: Response) {
    return new Promise((resolve, reject) => {
      const bucketName = String(req.params.bucketName || '').trim();
      const objectName = String((req.params as any).objectName || '').trim();
      if (!bucketName || !objectName) {
        return reject('bucketName and objectName are required');
      }
      const s3Client = this.initS3Client();
      let miniData = '';

      s3Client.getObject(bucketName, objectName, (err, dataStream) => {
        if (err) {
          logger.error(err);
          return reject(`error due to ${err.code} - ${err.key}`);
        }
        dataStream.on('data', (chunk) => {
          miniData += chunk;
        });
        dataStream.on('end', () => {
          try {
            const json = JSON.parse(miniData);
            return resolve(json);
          } catch (parseErr) {
            logger.error(parseErr);
            return reject('Failed to parse JSON content');
          }
        });
        dataStream.on('error', (streamErr) => {
          logger.error(streamErr);
          return reject(streamErr);
        });
      });
    });
  }

  public async downloadFile(req: Request, res: Response) {
    return new Promise((resolve, reject) => {
      const bucketName = String(req.params.bucketName || '').trim();
      const rawObjectName = String((req.params as any).objectName || '').trim();
      if (!bucketName || !rawObjectName) {
        return reject('bucketName and objectName are required');
      }
      const s3Client = this.initS3Client();
      let objectName = rawObjectName;
      try {
        objectName = decodeURIComponent(rawObjectName);
      } catch {
        // leave as-is if decoding fails
      }
      s3Client.getObject(bucketName, objectName, (err, dataStream) => {
        if (err) {
          logger.error(err);
          return reject(`error due to ${err.code} - ${err.key}`);
        }
        const fileName = objectName.split('/').pop() || 'file';
        res.status(200);
        res.setHeader('Content-Type', this.getContentType(fileName));
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        dataStream.on('end', () => {
          resolve(undefined);
        });
        dataStream.on('error', (streamErr) => {
          logger.error(streamErr);
          reject(streamErr);
        });
        dataStream.pipe(res);
      });
    });
  }
  public async createBucketIfDoesentExsist(req: Request, res: Response) {
    return new Promise((resolve, reject) => {
      let jsonReq = JSON.stringify(req.body);
      let minioRequest: MinioRequest = JSON.parse(jsonReq);
      const s3Client = this.initS3Client();
      this.standardizeRequest(minioRequest);

      // Define the lifecycle policy
      const lifecycleConfig = {
        Rule: [
          {
            ID: 'Expire after one day',
            Status: 'Enabled',
            Filter: {
              Prefix: '',
            },
            Expiration: {
              Days: 1,
            },
          },
        ],
      };

      s3Client
        .bucketExists(minioRequest.bucketName)
        .then((exsistRes) => {
          if (exsistRes) {
            logger.info(`Bucket - ${minioRequest.bucketName} exsists.`);
            return resolve(`Bucket - ${minioRequest.bucketName} exsists.`);
          } else {
            let policy = {
              Version: '2012-10-17',
              Statement: [
                {
                  Sid: 'PublicRead',
                  Effect: 'Allow',
                  Principal: '*',
                  Action: ['s3:GetObject', 's3:GetObjectVersion'],
                  Resource: [`arn:aws:s3:::${minioRequest.bucketName}/*`],
                },
              ],
            };
            s3Client
              .makeBucket(minioRequest.bucketName, process.env.MINIO_REGION)
              .then(() => s3Client.setBucketPolicy(minioRequest.bucketName, JSON.stringify(policy)))
              .then(() => s3Client.setBucketLifecycle(minioRequest.bucketName, lifecycleConfig))
              .catch((err) => {
                logger.error(err);
                return reject(err.message);
              });

            logger.info(
              `Bucket ${minioRequest.bucketName} created successfully in "${process.env.MINIO_REGION}".`
            );
            return resolve(
              `Bucket ${minioRequest.bucketName} created successfully in ${process.env.MINIO_REGION}.`
            );
          }
        })
        .catch((err) => {
          logger.error(err);
          return reject(err.message);
        });
    });
  }

  private standardizeRequest(minioRequest: MinioRequest) {
    minioRequest.bucketName = minioRequest.bucketName.toLowerCase();
    minioRequest.bucketName = minioRequest.bucketName.replace('_', '-');
    minioRequest.bucketName = minioRequest.bucketName.replace(' ', '');
  }

  private initS3Client() {
    return new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT,
      port: 9000,
      useSSL: false,
      accessKey: process.env.MINIO_ROOT_USER,
      secretKey: process.env.MINIO_ROOT_PASSWORD,
    });
  }

  private SetUrl(minioRequest: MinioRequest, req) {
    let url = '';
    this.standardizeRequest(minioRequest);
    let docType = req.query.docType;
    let projectName = req.query.projectName;
    let prefix =
      projectName === undefined ? `${minioRequest.bucketName}` : `${minioRequest.bucketName}/${projectName}`;
    let suffix = docType === undefined ? `${prefix}/` : `${prefix}/${docType}/`;
    if (req.query.isExternalUrl == 'true') {
      url = `${process.env.minioPublicEndPoint}/${suffix}`;
    } else {
      url = `${process.env.MINIOSERVER}/${suffix}`;
    }
    return url;
  }

  private encodeObjectPath(objectPath: string) {
    return String(objectPath || '')
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  private handleStream(
    s3Client: any,
    req: Request,
    minioRequest: MinioRequest,
    url: string,
    objects: any[],
    resolve: (value: unknown) => void
  ) {
    let docType = req.query.docType;
    let projectName = req.query.projectName;
    let recurse: boolean = req.query.recurse === 'true';
    const metadataPromises: Promise<void>[] = [];

    let stream: any = undefined;
    // If no docType is provided, list all objects in the bucket
    if (docType === undefined) {
      stream = !recurse
        ? s3Client.listObjectsV2(minioRequest.bucketName)
        : s3Client.listObjectsV2(minioRequest.bucketName, !projectName ? 'shared' : `${projectName}`, true);
    } else {
      stream =
        projectName === undefined
          ? s3Client.listObjectsV2(minioRequest.bucketName, docType, true)
          : s3Client.listObjectsV2(minioRequest.bucketName, `${projectName}/${docType}`, true);
    }

    stream.on('data', (obj) => {
      const rawPrefix = typeof obj?.prefix === 'string' ? String(obj.prefix).trim() : '';
      const rawName = String(obj?.name || '').trim();
      const isDocFormsRootListing = minioRequest.bucketName === 'document-forms' && docType === undefined && !recurse;

      // listObjectsV2 can emit "prefix" entries without a name when not fully recursive.
      // We need those for the "document-forms" root listing (to build doc type tabs),
      // but they should not appear as rows in normal document/template listings.
      if (!rawName && rawPrefix) {
        if (isDocFormsRootListing) {
          objects.push({ prefix: rawPrefix });
        }
        return;
      }

      if (rawName && rawName.endsWith('/')) {
        if (isDocFormsRootListing) {
          objects.push({ prefix: rawName });
        }
        return;
      }

      if (!rawName) return;
      // Hide internal sidecar objects (full input snapshots) from normal listings.
      if (rawName.includes('/__input__/') || rawName.startsWith('__input__/') || rawName.endsWith('.input.json')) {
        return;
      }
      const fileName = rawName.includes('/') && !recurse ? rawName.split('/').pop() : rawName;
      if (!fileName) return;
      obj.url = url + this.encodeObjectPath(fileName);

      // Create a promise for each metadata fetch operation
      const metadataPromise = (async () => {
        try {
          if (obj?.name) {
            const stat = await s3Client.statObject(minioRequest.bucketName, obj.name);
            obj.createdBy =
              stat.metaData['createdBy'] ||
              stat.metaData['createdby'] ||
              stat.metaData['x-amz-meta-createdBy'] ||
              stat.metaData['x-amz-meta-createdby'] ||
              '';
            obj.createdById =
              stat.metaData['createdById'] ||
              stat.metaData['createdbyid'] ||
              stat.metaData['x-amz-meta-createdById'] ||
              stat.metaData['x-amz-meta-createdbyid'] ||
              '';
            obj.inputSummary =
              stat.metaData['inputSummary'] ||
              stat.metaData['inputsummary'] ||
              stat.metaData['x-amz-meta-inputSummary'] ||
              stat.metaData['x-amz-meta-inputsummary'] ||
              stat.metaData['input'] ||
              stat.metaData['generationinput'] ||
              '';
            obj.inputDetailsKey =
              stat.metaData['inputDetailsKey'] ||
              stat.metaData['inputdetailskey'] ||
              stat.metaData['x-amz-meta-inputDetailsKey'] ||
              stat.metaData['x-amz-meta-inputdetailskey'] ||
              stat.metaData['inputDetails'] ||
              stat.metaData['inputdetails'] ||
              '';
          }
        } catch (error) {
          logger.error(`Error fetching metadata for ${obj.name}:`, error);
          obj.createdBy = '';
          obj.createdById = '';
          obj.inputSummary = '';
          obj.inputDetailsKey = '';
        }
        objects.push(obj);
      })();

      metadataPromises.push(metadataPromise);
    });

    stream.on('end', async () => {
      try {
        await Promise.all(metadataPromises);
        resolve(objects);
      } catch (error) {
        logger.error('Error processing metadata:', error);
        resolve([]);
      }
    });

    stream.on('error', (err) => {
      logger.error('Stream error:', err);
      resolve([]);
    });
  }
}
