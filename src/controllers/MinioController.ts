import { Request, Response } from 'express';
import { MinioRequest } from 'models/MinioRequest';

import logger from '../util/logger';
import fs from 'fs';
import path from 'path';

var Minio = require('minio');

export class MinioController {
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

      if (req.file.mimetype !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.template') {
        logger.error('Not a valid template');
        return reject('Not a valid template. Only *.dotx files are allowed');
      }
      const { docType, teamProjectName, isExternalUrl } = req.body;
      // Prepare the Minio request with file and folder details
      const minioRequest = {
        bucketName: 'templates', // Use dynamic or environment variables as needed
        folderName: `${teamProjectName}/${docType}`, // Use dynamic or environment variables as needed
        fileName: req.file.originalname,
      };
      const s3Client = this.initS3Client();
      let url = '';
      this.standardizeRequest(minioRequest);
      let suffix = `templates/${minioRequest.folderName}/${minioRequest.fileName}`;
      if (isExternalUrl === true) {
        url = `${process.env.minioPublicEndPoint}/${suffix}`;
      } else {
        url = `${process.env.MINIOSERVER}/${suffix}`;
      }
      // Read the uploaded file from the temporary 'uploads' directory where multer stores it
      const filePath = path.resolve(req.file.path);
      const fileStream = fs.createReadStream(filePath);
      const fileStat = fs.statSync(filePath);
      // Define the object name (file path in the Minio bucket)
      const objectName = `${minioRequest.folderName}/${minioRequest.fileName}`;
      // Ensure the bucket exists before uploading the file
      s3Client
        .bucketExists(minioRequest.bucketName)
        .then((exists) => {
          if (!exists) {
            return s3Client.makeBucket(minioRequest.bucketName, process.env.MINIO_REGION);
          }
        })
        .then(() => {
          // Upload the file to Minio
          s3Client.putObject(minioRequest.bucketName, objectName, fileStream, fileStat.size, (err, etag) => {
            // Delete the temporary file after uploading to Minio
            fs.unlinkSync(filePath);
            if (err) {
              logger.error('Error uploading file:', err);
              return reject(err);
            }
            return resolve({ fileItem: { url, text: objectName } });
          });
        })
        .catch((err) => {
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

    let stream: any = undefined;
    if (docType === undefined) {
      stream = s3Client.listObjectsV2(minioRequest.bucketName);
    } else {
      stream =
        projectName === undefined
          ? s3Client.listObjectsV2(minioRequest.bucketName, docType, true)
          : s3Client.listObjectsV2(minioRequest.bucketName, `${projectName}/${docType}`, true);
    }

    stream.on('data', (obj) => {
      const fileName = obj.name?.includes('/') ? obj.name.split('/').pop() : obj.name;
      obj.url = url + fileName;
      objects.push(obj);
    });
    stream.on('end', (obj) => {
      return resolve(objects);
    });
    stream.on('error', (obj) => {
      logger.error(obj);
      return [];
    });
  }
}
