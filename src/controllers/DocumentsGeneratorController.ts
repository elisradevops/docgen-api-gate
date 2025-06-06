import { Request, Response } from 'express';
import { DocumentRequest } from '../models/DocumentRequest';
import { JSONDocumentGenerator } from '../helpers/JsonDocGenerators/JsonDocumentGenerator';
import axios from 'axios';
import logger from '../util/logger';

export class DocumentsGeneratorController {
  public async createJSONDoc(req: Request, res: Response): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        let json = JSON.stringify(req.body);
        let documentRequest: DocumentRequest = JSON.parse(json);
        if (!documentRequest.uploadProperties.AwsAccessKeyId) {
          documentRequest.uploadProperties.AwsAccessKeyId = process.env.MINIO_ROOT_USER;
        }
        if (!documentRequest.uploadProperties.AwsSecretAccessKey) {
          documentRequest.uploadProperties.AwsSecretAccessKey = process.env.MINIO_ROOT_PASSWORD;
        }
        if (!documentRequest.uploadProperties.Region) {
          documentRequest.uploadProperties.Region = process.env.MINIO_REGION;
        }
        if (!documentRequest.uploadProperties.ServiceUrl) {
          documentRequest.uploadProperties.ServiceUrl = process.env.MINIOSERVER;
        }
        documentRequest.uploadProperties.bucketName =
          documentRequest.uploadProperties.bucketName.toLowerCase();
        documentRequest.uploadProperties.bucketName = documentRequest.uploadProperties.bucketName.replace(
          '_',
          '-'
        );
        documentRequest.uploadProperties.bucketName = documentRequest.uploadProperties.bucketName.replace(
          ' ',
          ''
        );
        let jsonDocumentGenerator: JSONDocumentGenerator = new JSONDocumentGenerator();
        try {
          //generate document template
          let docTemplateResponce: any = await axios.post(
            `${process.env.dgContentControlUrl}/generate-doc-template`,
            {
              orgUrl: documentRequest.tfsCollectionUri,
              token: documentRequest.PAT,
              projectName: documentRequest.teamProjectName,
              outputType: 'json',
              templateUrl: documentRequest.templateFile,
              minioEndPoint: documentRequest.uploadProperties.ServiceUrl,
              minioAccessKey: documentRequest.uploadProperties.AwsAccessKeyId,
              minioSecretKey: documentRequest.uploadProperties.AwsSecretAccessKey,
              attachmentsBucketName: 'attachments',
            }
          );

          logger.debug('generated template');
          let docTemplate = docTemplateResponce.data;
          docTemplate.uploadProperties = documentRequest.uploadProperties;
          //generate content controls
          let contentControls = await jsonDocumentGenerator.generateContentControls(documentRequest);
          docTemplate.JsonDataList = contentControls;
          docTemplate.minioAttachmentData = [];
          contentControls.forEach((contentControl) => {
            if (contentControl.minioAttachmentData) {
              docTemplate.minioAttachmentData = docTemplate.minioAttachmentData.concat(
                contentControl.minioAttachmentData
              );
            }
          });

          // Generate the final document
          const isExcelSpreadsheet = contentControls.some(
            (contentControl) => contentControl.isExcelSpreadsheet
          );

          let documentUrl: any = await axios.post(
            `${process.env.jsonToWordPostUrl}/api/${!isExcelSpreadsheet ? 'word' : 'excel'}/create`,
            docTemplate
          );
          return resolve(documentUrl.data);
        } catch (err) {
          if (err.response) {
            const responseError = err.response.data;
            // Pass the full error object for more details, including stack trace
            throw new Error(responseError.message);
          }
          throw err;
        }
      } catch (err) {
        return reject(err.message);
      }
    });
  }
}
