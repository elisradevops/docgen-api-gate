import { Request, Response } from 'express';
import { DocumentRequest } from '../models/DocumentRequest';
import { JSONDocumentGenerator } from '../helpers/JsonDocGenerators/JsonDocumentGenerator';
import axios from 'axios';
import logger from '../util/logger';
import { runContextStore, RunContext } from '../util/runContext';
import { isMongoConnected } from '../util/mongodb';
import { DocumentRun, IDocumentRunErrorChainEntry, DOCUMENT_RUN_RETENTION_MS } from '../models/DocumentRun';

export class DocumentsGeneratorController {
  public async createJSONDoc(req: Request, res: Response): Promise<any> {
    return new Promise(async (resolve, reject) => {
      const runContext = runContextStore.getStore();
      const startedAt = new Date();
      try {
        const json = JSON.stringify(req.body);
        const documentRequest: DocumentRequest = JSON.parse(json);
        this.applyUploadDefaults(documentRequest);
        this.normalizeBucket(documentRequest);
        await this.createRunRecord(runContext, startedAt, documentRequest);
        const jsonDocumentGenerator: JSONDocumentGenerator = new JSONDocumentGenerator();

        try {
          let docTemplateResponse: any;
          try {
            docTemplateResponse = await axios.post(
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
          } catch (err: any) {
            err.step = err.step || 'generate-doc-template';
            throw err;
          }

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

          const resolvedCtx = (contentControls as any[])
            .map((c) => c?.resolvedContextName)
            .find((n) => !!n);
          const hasAutoDiscoveredRange = (documentRequest.contentControls || []).some((cc) => {
            const data = (cc as any).data || {};
            return (data.rangeType === 'release' || data.rangeType === 'pipeline') &&
              (!data.to || String(data.to).trim() === '');
          });
          if (hasAutoDiscoveredRange && resolvedCtx) {
            const date = this.getFormattedDate();
            documentRequest.uploadProperties.fileName = `${documentRequest.teamProjectName}-svd-${resolvedCtx}-${date}`;
          } else if (!documentRequest.uploadProperties.fileName) {
            documentRequest.uploadProperties.fileName = `${documentRequest.teamProjectName}-svd-${this.getFormattedDate()}`;
          }
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
          let documentUrl: any;
          try {
            documentUrl = await axios.post(
              `${process.env.jsonToWordPostUrl}/api/${!isExcelSpreadsheet ? 'word' : 'excel'}/create`,
              docTemplate
            );
          } catch (err: any) {
            err.step = err.step || 'render-document';
            throw err;
          }
          await this.finalizeRunRecord(runContext, {
            status: 'succeeded',
            documentUrl: typeof documentUrl.data === 'string' ? documentUrl.data : undefined,
          });
          return resolve(documentUrl.data);
        } catch (err: any) {
          if (err.response) {
            const responseError = err.response.data || {};
            const statusCode = Number(err?.response?.status || 500);
            const shouldPreserveHttpContext = !!responseError?.code || statusCode === 422;
            if (shouldPreserveHttpContext) {
              const wrapped: any = new Error(responseError.message || 'Content generation failed');
              wrapped.statusCode = statusCode;
              wrapped.code = responseError?.code;
              wrapped.details = responseError;
              wrapped.step = err.step;
              throw wrapped;
            }
            const wrapped: any = new Error(responseError.message);
            wrapped.step = err.step;
            throw wrapped;
          }
          throw err;
        }
      } catch (err: any) {
        await this.finalizeRunRecord(runContext, { status: 'failed', errorChain: this.buildErrorChain(err) });
        if (err?.statusCode) {
          return reject(err);
        }
        return reject(this.toStructuredError(err));
      }
    });
  }

  private async createRunRecord(
    runContext: RunContext | undefined,
    startedAt: Date,
    documentRequest: DocumentRequest
  ): Promise<void> {
    if (!runContext?.runId || !isMongoConnected()) return;
    try {
      await DocumentRun.create({
        runId: runContext.runId,
        status: 'running',
        trigger: runContext.trigger || 'pipeline',
        startedAt,
        userId: documentRequest.userEmail,
        project: documentRequest.teamProjectName,
        templateName: documentRequest.templateFile,
        expiresAt: new Date(startedAt.getTime() + DOCUMENT_RUN_RETENTION_MS),
      });
    } catch (err) {
      // Monitoring must never break generation — see Phase 6's transport safety rules.
      logger.warn('Failed to create DocumentRun record', err);
    }
  }

  private async finalizeRunRecord(
    runContext: RunContext | undefined,
    update: {
      status: 'succeeded' | 'failed';
      documentUrl?: string;
      errorChain?: IDocumentRunErrorChainEntry[];
    }
  ): Promise<void> {
    if (!runContext?.runId || !isMongoConnected()) return;
    try {
      await DocumentRun.updateOne(
        { runId: runContext.runId },
        {
          $set: {
            status: update.status,
            endedAt: new Date(),
            documentUrl: update.documentUrl,
            errorChain: update.errorChain || [],
          },
        }
      );
    } catch (err) {
      logger.warn('Failed to finalize DocumentRun record', err);
    }
  }

  // A single ADO/content-control fan-out failure (JsonDocumentGenerator's allSettled) carries
  // one entry per failed content control; anything else — the doc-template call, the render
  // call, a parse failure — becomes a single api-gate-attributed entry.
  private buildErrorChain(err: any): IDocumentRunErrorChainEntry[] {
    if (Array.isArray(err?.contentControlFailures) && err.contentControlFailures.length > 0) {
      return err.contentControlFailures.map((failure: any) => ({
        service: 'docgen-content-control',
        step: `generate-content-control:${failure.title}`,
        message: failure.message,
        code: failure.code,
        stack: failure.stack,
      }));
    }
    return [
      {
        service: 'docgen-api-gate',
        step: err?.step,
        message: err?.message || String(err),
        code: err?.code,
        stack: err?.stack,
      },
    ];
  }

  // Normalizes whatever createJSONDoc's inner try/catch produced into a plain structured
  // object — previously this path could reject with a bare string (Phase 5's known bug:
  // `reject((err as any)?.message || err)`), which drops statusCode/code/contentControlFailures
  // entirely for anything that wasn't already tagged with a statusCode.
  private toStructuredError(err: any): {
    message: string;
    statusCode: number;
    code?: string;
    details?: any;
    contentControlFailures?: any[];
  } {
    return {
      message: err?.message || String(err),
      statusCode: Number(err?.statusCode) || 500,
      code: err?.code,
      details: err?.details,
      contentControlFailures: err?.contentControlFailures,
    };
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

  private getFormattedDate(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
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
