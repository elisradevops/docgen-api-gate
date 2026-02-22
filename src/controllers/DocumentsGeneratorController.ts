import { Request, Response } from 'express';
import { DocumentRequest } from '../models/DocumentRequest';
import { JSONDocumentGenerator } from '../helpers/JsonDocGenerators/JsonDocumentGenerator';
import axios from 'axios';
import logger from '../util/logger';

type DownloadableFile = {
  fileName: string;
  base64: string;
  applicationType: string;
};

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

          const shouldCreateZipPackage = this.shouldGenerateInternalValidationZip(documentRequest, contentControls);
          if (shouldCreateZipPackage) {
            const zipUrlOrDownload = await this.generateInternalValidationZipPackage(documentRequest, docTemplate);
            return resolve(zipUrlOrDownload);
          }

          const isExcelSpreadsheet = contentControls.some((contentControl) => contentControl.isExcelSpreadsheet);
          const isMewpStandaloneFlow = this.hasMewpStandaloneReporterControl(documentRequest);
          if (isExcelSpreadsheet && isMewpStandaloneFlow) {
            const mewpNames = this.buildMewpStandaloneFileNames(documentRequest.uploadProperties.fileName);
            docTemplate.uploadProperties = {
              ...(docTemplate.uploadProperties || {}),
              fileName: mewpNames.mainExcelFileName,
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

  private shouldGenerateInternalValidationZip(documentRequest: DocumentRequest, contentControls: any[]): boolean {
    const hasExcelOutput = Array.isArray(contentControls)
      ? contentControls.some((control) => !!control?.isExcelSpreadsheet)
      : false;
    if (!hasExcelOutput) return false;

    return this.getInternalValidationSourceControls(documentRequest).length > 0;
  }

  private async generateInternalValidationZipPackage(documentRequest: DocumentRequest, docTemplate: any): Promise<any> {
    const sourceControls = this.getInternalValidationSourceControls(documentRequest);
    const isMewpStandaloneFlow = sourceControls.some((control: any) =>
      this.isMewpStandaloneReporterControl(control)
    );
    const baseFileName = this.getBaseFileName(documentRequest.uploadProperties.fileName);
    const fallbackNames = {
      mainExcelFileName: `${baseFileName}.xlsx`,
      internalValidationFileName: `${baseFileName}-internal-validation.xlsx`,
      zipFileName: `${baseFileName}.zip`,
    };
    const mewpStandaloneNames = this.buildMewpStandaloneFileNames(baseFileName);
    const { mainExcelFileName, internalValidationFileName, zipFileName } = isMewpStandaloneFlow
      ? mewpStandaloneNames
      : fallbackNames;

    const shouldIncludeInternalValidation = sourceControls.some(
      (control: any) => !!control?.data?.includeInternalValidationReport
    );

    const mainExcelPayload = {
      ...docTemplate,
      uploadProperties: {
        ...docTemplate.uploadProperties,
        fileName: mainExcelFileName,
        enableDirectDownload: true,
        EnableDirectDownload: true,
      },
    };
    const mainExcel = await this.createExcelDirectDownload(mainExcelPayload);
    const zipFiles: any[] = [this.toDownloadableObject(mainExcel)];

    if (shouldIncludeInternalValidation) {
      const internalValidationContentControls = await this.generateInternalValidationContentControls(
        documentRequest,
        sourceControls
      );
      if (internalValidationContentControls.length > 0) {
        const internalExcelPayload = {
          uploadProperties: {
            ...documentRequest.uploadProperties,
            fileName: internalValidationFileName,
            enableDirectDownload: true,
            EnableDirectDownload: true,
          },
          JsonDataList: internalValidationContentControls,
          minioAttachmentData: [],
          formattingSettings: documentRequest.formattingSettings,
        };
        const internalExcel = await this.createExcelDirectDownload(internalExcelPayload);
        zipFiles.push(this.toDownloadableObject(internalExcel));
      }
    }

    const zipPayload = {
      uploadProperties: {
        ...documentRequest.uploadProperties,
        fileName: zipFileName,
      },
      files: zipFiles,
    };
    const zipResponse: any = await axios.post(`${process.env.jsonToWordPostUrl}/api/excel/create-zip`, zipPayload);
    return zipResponse.data;
  }

  private getInternalValidationSourceControls(documentRequest: DocumentRequest): any[] {
    return (documentRequest.contentControls || []).filter(
      (control: any) =>
        (String(control?.type || '').toLowerCase() === 'testreporter' ||
          String(control?.type || '').toLowerCase() === 'mewpstandalonereporter') &&
        !!control?.data?.includeInternalValidationReport
    );
  }

  private isMewpStandaloneReporterControl(control: any): boolean {
    return String(control?.type || '').trim().toLowerCase() === 'mewpstandalonereporter';
  }

  private hasMewpStandaloneReporterControl(documentRequest: DocumentRequest): boolean {
    return Array.isArray(documentRequest?.contentControls)
      ? documentRequest.contentControls.some((control: any) => this.isMewpStandaloneReporterControl(control))
      : false;
  }

  private buildMewpStandaloneFileNames(rawBaseName: string): {
    mainExcelFileName: string;
    internalValidationFileName: string;
    zipFileName: string;
  } {
    const baseName = this.getBaseFileName(rawBaseName);
    const mewpRoot = /(?:^|-)mewp(?:-|$)/i.test(baseName) ? baseName : `${baseName}-mewp`;
    const normalize = (value: string) =>
      String(value || '')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    const zipBase = normalize(`${mewpRoot}-reports`);
    return {
      mainExcelFileName: `mewp-l2-coverage-report.xlsx`,
      internalValidationFileName: `mewp-internal-validation-report.xlsx`,
      zipFileName: `${zipBase}.zip`,
    };
  }

  private async generateInternalValidationContentControls(
    documentRequest: DocumentRequest,
    sourceControls: any[]
  ): Promise<any[]> {
    const controls = Array.isArray(sourceControls)
      ? sourceControls
      : this.getInternalValidationSourceControls(documentRequest);

    return Promise.all(
      controls.map(async (contentControl: any) => {
        const response = await axios.post(`${process.env.dgContentControlUrl}/generate-content-control`, {
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
            title: 'mewp-internal-validation-content-control',
            type: 'internalValidationReporter',
            headingLevel: contentControl.headingLevel,
            data: {
              ...contentControl.data,
              useRelFallback:
                String(contentControl?.type || '').toLowerCase() === 'mewpstandalonereporter'
                  ? contentControl?.data?.useRelFallback !== false
                  : false,
            },
            isExcelSpreadsheet: true,
          },
          formattingSettings: documentRequest.formattingSettings,
        });
        return response.data;
      })
    );
  }

  private async createExcelDirectDownload(payload: any): Promise<DownloadableFile> {
    const response: any = await axios.post(`${process.env.jsonToWordPostUrl}/api/excel/create`, payload);
    const downloadable = this.normalizeDownloadableObject(response?.data || {});
    if (!downloadable.fileName || !downloadable.base64) {
      throw new Error('Failed to create downloadable excel payload');
    }
    return downloadable;
  }

  private normalizeDownloadableObject(data: any): DownloadableFile {
    return {
      fileName: String(data?.FileName || data?.fileName || '').trim(),
      base64: String(data?.Base64 || data?.base64 || '').trim(),
      applicationType: String(data?.ApplicationType || data?.applicationType || '').trim(),
    };
  }

  private toDownloadableObject(file: DownloadableFile): any {
    return {
      FileName: file.fileName,
      Base64: file.base64,
      ApplicationType: file.applicationType,
    };
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
}
