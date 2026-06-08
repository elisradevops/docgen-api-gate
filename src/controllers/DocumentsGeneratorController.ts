import { Request, Response } from 'express';
import { DocumentRequest } from '../models/DocumentRequest';
import { JSONDocumentGenerator } from '../helpers/JsonDocGenerators/JsonDocumentGenerator';
import axios from 'axios';
import logger from '../util/logger';

export class DocumentsGeneratorController {
  public async createJSONDoc(req: Request, res: Response): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        const json = JSON.stringify(req.body);
        const documentRequest: DocumentRequest = JSON.parse(json);
        this.applyUploadDefaults(documentRequest);
        this.normalizeBucket(documentRequest);
        const jsonDocumentGenerator: JSONDocumentGenerator = new JSONDocumentGenerator();

        try {
          const docTemplateResponse: any = await axios.post(
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
              formattingSettings: documentRequest.formattingSettings,
            }
          );

          logger.debug('generated template');
          const docTemplate = docTemplateResponse.data;
          docTemplate.uploadProperties = documentRequest.uploadProperties;
          const contentControls = await jsonDocumentGenerator.generateContentControls(documentRequest);
          docTemplate.JsonDataList = contentControls;
          docTemplate.minioAttachmentData = [];
          contentControls.forEach((contentControl) => {
            if (contentControl.minioAttachmentData) {
              docTemplate.minioAttachmentData = docTemplate.minioAttachmentData.concat(
                contentControl.minioAttachmentData
              );
            }
          });
          docTemplate.formattingSettings = documentRequest.formattingSettings;

          const isExcelSpreadsheet = contentControls.some((contentControl) => contentControl.isExcelSpreadsheet);
          const isMewpStandaloneFlow = this.hasMewpStandaloneReporterControl(documentRequest);
          const isInternalValidationFlow = this.hasInternalValidationReporterControl(documentRequest);
          if (isExcelSpreadsheet && isMewpStandaloneFlow) {
            const mewpNames = this.buildMewpStandaloneFileNames(documentRequest.uploadProperties.fileName);
            docTemplate.uploadProperties = {
              ...(docTemplate.uploadProperties || {}),
              fileName: mewpNames.mainExcelFileName,
            };
          } else if (isExcelSpreadsheet && isInternalValidationFlow) {
            const internalValidationFileName = this.buildInternalValidationFileName(
              documentRequest.uploadProperties.fileName
            );
            docTemplate.uploadProperties = {
              ...(docTemplate.uploadProperties || {}),
              fileName: internalValidationFileName,
            };
          }
          const documentUrl: any = await axios.post(
            `${process.env.jsonToWordPostUrl}/api/${!isExcelSpreadsheet ? 'word' : 'excel'}/create`,
            docTemplate
          );
          return resolve(documentUrl.data);
        } catch (err) {
          if (err.response) {
            const responseError = err.response.data || {};
            const statusCode = Number(err?.response?.status || 500);
            const shouldPreserveHttpContext = !!responseError?.code || statusCode === 422;
            if (shouldPreserveHttpContext) {
              const wrapped: any = new Error(responseError.message || 'Content generation failed');
              wrapped.statusCode = statusCode;
              wrapped.code = responseError?.code;
              wrapped.details = responseError;
              throw wrapped;
            }
            throw new Error(responseError.message);
          }
          throw err;
        }
      } catch (err) {
        if ((err as any)?.statusCode) {
          return reject(err);
        }
        return reject((err as any)?.message || err);
      }
    });
  }

  public async createFlatTestReporterDoc(req: Request, res: Response): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        let json = JSON.stringify(req.body);
        let documentRequest: DocumentRequest = JSON.parse(json);
        this.applyUploadDefaults(documentRequest);
        this.normalizeBucket(documentRequest);

        try {
          const contentControls = await Promise.all(
            documentRequest.contentControls.map(async (contentControl) => {
              let contentControlResponse = await axios.post(
                `${process.env.dgContentControlUrl}/generate-test-reporter-flat`,
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
                  contentControlOptions: {
                    title: contentControl.title,
                    type: contentControl.type,
                    headingLevel: contentControl.headingLevel,
                    data: contentControl.data,
                    isExcelSpreadsheet: true,
                  },
                  formattingSettings: documentRequest.formattingSettings,
                }
              );
              return contentControlResponse.data;
            })
          );

          const excelModel = {
            uploadProperties: documentRequest.uploadProperties,
            JsonDataList: contentControls,
            minioAttachmentData: [],
            formattingSettings: documentRequest.formattingSettings,
          };

          let documentUrl: any = await axios.post(`${process.env.jsonToWordPostUrl}/api/excel/create`, excelModel);
          return resolve(documentUrl.data);
        } catch (err) {
          if (err.response) {
            const responseError = err.response.data;
            throw new Error(responseError.message);
          }
          throw err;
        }
      } catch (err) {
        return reject(err.message);
      }
    });
  }

  public async validateMewpExternalFiles(req: Request, res: Response): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        const body = req.body || {};
        const payload = {
          orgUrl: body.tfsCollectionUri || body.orgUrl,
          token: body.PAT || body.token,
          projectName: body.teamProjectName || body.projectName,
          outputType: 'json',
          templateUrl: body.templateFile || body.templateUrl || '',
          minioEndPoint: body?.uploadProperties?.ServiceUrl || process.env.MINIOSERVER,
          minioAccessKey: body?.uploadProperties?.AwsAccessKeyId || process.env.MINIO_ROOT_USER,
          minioSecretKey: body?.uploadProperties?.AwsSecretAccessKey || process.env.MINIO_ROOT_PASSWORD,
          attachmentsBucketName: 'attachments',
          contentControlOptions: {
            data: {
              externalBugsFile: body?.externalBugsFile,
              externalL3L4File: body?.externalL3L4File,
            },
          },
          formattingSettings: body?.formattingSettings,
        };

        const response = await axios.post(`${process.env.dgContentControlUrl}/validate-mewp-external-files`, payload);
        return resolve(response.data);
      } catch (err: any) {
        if (err?.response) {
          const wrapped: any = new Error(err?.response?.data?.message || 'Validation failed');
          wrapped.statusCode = Number(err?.response?.status || 500);
          wrapped.code = err?.response?.data?.code;
          wrapped.details = err?.response?.data;
          return reject(wrapped);
        }
        return reject(err);
      }
    });
  }

  private applyUploadDefaults(documentRequest: DocumentRequest) {
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
  }

  private normalizeBucket(documentRequest: DocumentRequest) {
    documentRequest.uploadProperties.bucketName = documentRequest.uploadProperties.bucketName.toLowerCase();
    documentRequest.uploadProperties.bucketName = documentRequest.uploadProperties.bucketName.replace('_', '-');
    documentRequest.uploadProperties.bucketName = documentRequest.uploadProperties.bucketName.replace(' ', '');
  }

  private isMewpStandaloneReporterControl(control: any): boolean {
    return String(control?.type || '').trim().toLowerCase() === 'mewpstandalonereporter';
  }

  private hasMewpStandaloneReporterControl(documentRequest: DocumentRequest): boolean {
    return Array.isArray(documentRequest?.contentControls)
      ? documentRequest.contentControls.some((control: any) => this.isMewpStandaloneReporterControl(control))
      : false;
  }

  private isInternalValidationReporterControl(control: any): boolean {
    return String(control?.type || '').trim().toLowerCase() === 'internalvalidationreporter';
  }

  private hasInternalValidationReporterControl(documentRequest: DocumentRequest): boolean {
    return Array.isArray(documentRequest?.contentControls)
      ? documentRequest.contentControls.some((control: any) => this.isInternalValidationReporterControl(control))
      : false;
  }

  private buildMewpStandaloneFileNames(rawBaseName: string): {
    mainExcelFileName: string;
  } {
    const timestampSuffix = this.getRequestTimestampSuffix(rawBaseName);
    return {
      mainExcelFileName: `mewp-l2-coverage-report${timestampSuffix}.xlsx`,
    };
  }

  private buildInternalValidationFileName(rawBaseName: string): string {
    const timestampSuffix = this.getRequestTimestampSuffix(rawBaseName);
    return `mewp-internal-validation-report${timestampSuffix}.xlsx`;
  }

  private getBaseFileName(rawName: string): string {
    const safe = String(rawName || 'report').trim();
    if (!safe) return 'report';
    const withoutExtension = safe.replace(/\.(zip|xlsx|xls|docx|doc)$/i, '');
    const sanitized = withoutExtension
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return sanitized || 'report';
  }

  private getRequestTimestampSuffix(rawName: string): string {
    const safe = String(rawName || '').trim();
    if (!safe) return '';

    const withoutExtension = safe.replace(/\.(zip|xlsx|xls|docx|doc)$/i, '');
    const timestampWithColonMatch = withoutExtension.match(/(\d{4}-\d{2}-\d{2}-\d{2}:\d{2}:\d{2})$/);
    const timestampWithDashMatch = withoutExtension.match(/(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})$/);
    const timestampToken = timestampWithColonMatch?.[1] || timestampWithDashMatch?.[1] || '';
    if (!timestampToken) return '';

    return `-${timestampToken.replace(/:/g, '-')}`;
  }
}
