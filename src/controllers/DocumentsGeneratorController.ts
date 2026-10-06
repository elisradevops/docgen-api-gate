import { Request, Response } from 'express';
import { DocumentRequest } from '../models/DocumentRequest';
import { JSONDocumentGenerator } from '../helpers/JsonDocGenerators/JsonDocumentGenerator';
import axios from 'axios';
import logger from '../util/logger';
import { runContextStore, RunContext } from '../util/runContext';
import { isMongoConnected } from '../util/mongodb';
import {
  DocumentRun,
  IDocumentRunErrorChainEntry,
  IDocumentRunManifest,
  DOCUMENT_RUN_RETENTION_MS,
} from '../models/DocumentRun';
import { LogEvent, LOG_EVENT_RETENTION_MS } from '../models/LogEvent';

// How long a successful run's provisional (retain-on-failure) events linger, so ones still in
// flight from another process can arrive and be swept by the same expiry.
const RETAIN_PENDING_GRACE_MS = 10 * 60 * 1000;
const ACCESS_PROBE_GRACE_MS = 1500;
import { buildEnvironment, buildInputs, buildStep, emptyManifest } from '../helpers/runManifest';
import { resolveDocType } from '../helpers/runDocType';
import { authorizeCaptureMode } from '../helpers/diagnostics/captureAuthorization';
import { assertTemplateExists } from '../helpers/templatePreflight';
import { buildRunInput } from '../helpers/runInput';
import { credentialKind } from '../helpers/credentialKind';
import {
  startAccessProbe,
  describeAccessProblems,
  type AccessProbeResult,
} from '../helpers/diagnostics/accessProbe';

export class DocumentsGeneratorController {
  public async createJSONDoc(req: Request, res: Response): Promise<any> {
    return new Promise(async (resolve, reject) => {
      const runContext = runContextStore.getStore();
      const startedAt = new Date();
      const manifest: IDocumentRunManifest = emptyManifest();
      // Declared outside the try so the failure path can record them too.
      let credential: { kind?: string; identity?: string; name?: string; access?: Record<string, unknown> } | undefined;
      let accessProbe: Promise<AccessProbeResult | undefined> | undefined;
      let probedProject = '';
      try {
        const json = JSON.stringify(req.body);
        const documentRequest: DocumentRequest = JSON.parse(json);
        this.applyUploadDefaults(documentRequest);
        this.normalizeBucket(documentRequest);
        // Before the run record, so the record (and every later log) reflects the effective mode.
        await authorizeCaptureMode(runContext, documentRequest.tfsCollectionUri, documentRequest.PAT);
        // Which kind of credential ran this request, recorded from the start so even a run that fails
        // early says so (never the credential itself).
        credential = { kind: credentialKind(documentRequest.PAT), identity: runContext?.identityKind };
        manifest.environment = buildEnvironment(undefined, credential);
        const runRecord = await this.createRunRecord(runContext, startedAt, documentRequest);
        if (runRecord === 'duplicate') {
          // The same run id is already being (or was) generated: a client retried the request. Do
          // not start a second generation — two would race on the same output file and double the
          // load — and return before the catch below, which would mark the original run failed.
          const duplicate: any = new Error(
            `A document generation with this run id was already started (run ${runContext?.runId}); it was not started again.`
          );
          duplicate.statusCode = 409;
          duplicate.code = 'DUPLICATE_RUN';
          return reject(duplicate);
        }
        // Recorded now, not after content generation: a run that fails early (template, doc
        // template, a content control's fetch) must still say what it was asked to do.
        manifest.inputs = buildInputs(documentRequest);
        // Who the credential is and what it can see in this project: started now, alongside the generation,
        // and given at most ACCESS_PROBE_GRACE_MS at the end (a later answer is patched onto the run). Fails open.
        probedProject = documentRequest.teamProjectName;
        accessProbe = startAccessProbe(documentRequest.tfsCollectionUri, documentRequest.PAT, probedProject);
        // After the run record, so a missing template is recorded on the run; before any data
        // is fetched, so a missing template fails early instead of after the whole generation.
        if (runContext) runContext.step = 'validate-template';
        await assertTemplateExists(documentRequest.templateFile);
        const jsonDocumentGenerator: JSONDocumentGenerator = new JSONDocumentGenerator();

        try {
          let docTemplateResponse: any;
          if (runContext) runContext.step = 'generate-doc-template';
          const docTemplateStartedAt = Date.now();
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
            manifest.steps.push(
              buildStep({
                name: 'generate-doc-template',
                type: 'generate-doc-template',
                status: 'failed',
                startedAt: docTemplateStartedAt,
              })
            );
            throw err;
          }
          manifest.steps.push(
            buildStep({
              name: 'generate-doc-template',
              type: 'generate-doc-template',
              status: 'succeeded',
              startedAt: docTemplateStartedAt,
            })
          );
          manifest.environment = buildEnvironment(this.parseVersionsHeader(docTemplateResponse.headers), credential);

          logger.debug('generated template');
          const docTemplate = docTemplateResponse.data;
          docTemplate.uploadProperties = documentRequest.uploadProperties;
          let contentControls: any[];
          if (runContext) runContext.step = 'generate-content-controls';
          try {
            const generated = await jsonDocumentGenerator.generateContentControls(documentRequest);
            contentControls = generated.results;
            manifest.steps.push(...generated.steps);
            manifest.artifacts.push(...generated.artifacts);
          } catch (err: any) {
            if (Array.isArray(err?.steps)) manifest.steps.push(...err.steps);
            if (Array.isArray(err?.artifacts)) manifest.artifacts.push(...err.artifacts);
            throw err;
          }
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
          if (resolvedCtx && manifest.inputs) manifest.inputs.resolvedContextName = resolvedCtx;
          // What an SVD actually resolved its range to (an omitted from/to is auto-discovered).
          const resolvedRange = (contentControls as any[]).map((c) => c?.resolvedRange).find((r) => !!r);
          if (resolvedRange && manifest.inputs) manifest.inputs.resolvedRange = resolvedRange;
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
          if (runContext) runContext.step = 'render-document';
          const renderStartedAt = Date.now();
          try {
            documentUrl = await axios.post(
              `${process.env.jsonToWordPostUrl}/api/${!isExcelSpreadsheet ? 'word' : 'excel'}/create`,
              docTemplate
            );
          } catch (err: any) {
            err.step = err.step || 'render-document';
            manifest.steps.push(
              buildStep({ name: 'render-document', type: 'render-document', status: 'failed', startedAt: renderStartedAt })
            );
            throw err;
          }
          const finalDocumentUrl = typeof documentUrl.data === 'string' ? documentUrl.data : undefined;
          manifest.steps.push(
            buildStep({ name: 'render-document', type: 'render-document', status: 'succeeded', startedAt: renderStartedAt })
          );
          if (finalDocumentUrl) {
            manifest.artifacts.push({
              kind: 'document',
              name: documentRequest.uploadProperties.fileName,
              url: finalDocumentUrl,
            });
          }
          const probe = await this.awaitProbeBriefly(accessProbe);
          this.mergeAccessProbe(manifest, credential, probe.result, probedProject);
          await this.finalizeRunRecord(runContext, {
            status: 'succeeded',
            documentUrl: finalDocumentUrl,
            manifest,
          });
          void this.patchLateAccessProbe(runContext, credential, probe.late, probedProject);
          await this.expireRetainOnFailureEvents(runContext);
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
        // A run that failed after discovery still says which versions it had resolved.
        if (err?.resolvedRange && manifest.inputs) manifest.inputs.resolvedRange = err.resolvedRange;
        const probe = await this.awaitProbeBriefly(accessProbe);
        this.mergeAccessProbe(manifest, credential, probe.result, probedProject);
        await this.finalizeRunRecord(runContext, {
          status: 'failed',
          errorChain: this.buildErrorChain(err),
          manifest,
        });
        void this.patchLateAccessProbe(runContext, credential, probe.late, probedProject);
        await this.keepRetainOnFailureEvents(runContext);
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
  ): Promise<'created' | 'duplicate' | 'skipped'> {
    const docType = resolveDocType(documentRequest);
    // Set before the Mongo/runId guard below so every log emitted for this request — including
    // ones from a run that never gets a DocumentRun record (no runId, or Mongo down) — still
    // carries docType. runContextStore.run(obj, next) stores an object reference; mutating it
    // here is visible to installRunIdForwarding's interceptor on every later outbound call.
    if (runContext) {
      runContext.docType = docType;
      runContext.project = documentRequest.teamProjectName;
    }
    if (!runContext?.runId || !isMongoConnected()) return 'skipped';
    try {
      await DocumentRun.create({
        runId: runContext.runId,
        status: 'running',
        trigger: runContext.trigger || 'pipeline',
        startedAt,
        userId: documentRequest.userEmail,
        project: documentRequest.teamProjectName,
        docType,
        captureMode: runContext.captureMode,
        sessionId: runContext.sessionId,
        input: buildRunInput(documentRequest),
        templateName: documentRequest.templateFile,
        expiresAt: new Date(startedAt.getTime() + DOCUMENT_RUN_RETENTION_MS),
      });
      return 'created';
    } catch (err: any) {
      if (err?.code === 11000) {
        logger.warn(`Run ${runContext.runId} is already recorded; rejecting the repeated request`);
        return 'duplicate';
      }
      // Monitoring must never break generation — see Phase 6's transport safety rules.
      logger.warn('Failed to create DocumentRun record', err);
      return 'skipped';
    }
  }

  // The .generate-doc-template response's optional x-docgen-versions header — set once per
  // generation by content-control (routes/index.ts), reusing that request rather than adding
  // a probe. Malformed/absent is not an error: environment just falls back to 'unknown'.
  private parseVersionsHeader(headers: any): { service?: string; dataProvider?: string; skins?: string } | undefined {
    const raw = headers?.['x-docgen-versions'];
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch (err) {
      logger.warn('Failed to parse x-docgen-versions header', err);
      return undefined;
    }
  }

  // The probe runs alongside the generation; at the end it is given a short grace so a slow probe never
  // holds the response. A late probe is recorded on the run afterwards (see patchLateAccessProbe).
  private async awaitProbeBriefly(
    probe: Promise<AccessProbeResult | undefined> | undefined
  ): Promise<{ result?: AccessProbeResult; late?: Promise<AccessProbeResult | undefined> }> {
    if (!probe) return {};
    let timer: NodeJS.Timeout | undefined;
    const pending = Symbol('pending');
    try {
      const first = await Promise.race([
        probe.catch(() => undefined),
        new Promise<typeof pending>((resolve) => {
          timer = setTimeout(() => resolve(pending), ACCESS_PROBE_GRACE_MS);
        }),
      ]);
      if (first === pending) return { late: probe.catch(() => undefined) };
      return { result: first as AccessProbeResult | undefined };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Merges the probe's answer into the credential record: the identity class known at request time is kept
  // (the probe only fills it when missing); the display name is recorded on the run on purpose.
  private mergeCredential(
    credential: { kind?: string; identity?: string; name?: string; access?: Record<string, unknown> } | undefined,
    result: AccessProbeResult
  ) {
    return {
      ...credential,
      identity: credential?.identity ?? result.identity?.class,
      name: result.identity?.name,
      access: result.access as Record<string, unknown>,
    };
  }

  // Merges the probe's answer into the run's credential record, and logs one warning when it cannot read
  // something the run is likely to need. Never throws: the probe is diagnostic.
  private mergeAccessProbe(
    manifest: IDocumentRunManifest,
    credential: { kind?: string; identity?: string; name?: string; access?: Record<string, unknown> } | undefined,
    result: AccessProbeResult | undefined,
    project: string
  ): void {
    if (!result) return;
    try {
      const merged = this.mergeCredential(credential, result);
      manifest.environment = { ...(manifest.environment || buildEnvironment(undefined, merged)), credential: merged };
      const problem = describeAccessProblems(result, project);
      if (problem) logger.warn(problem);
    } catch (err: any) {
      logger.debug(`Could not record the access probe: ${err?.message ?? err}`);
    }
  }

  // A probe that answered after the run was finalized: patch only the credential field (the finalize write
  // has completed by then, so it cannot overwrite it) and log the warning now.
  private async patchLateAccessProbe(
    runContext: RunContext | undefined,
    credential: { kind?: string; identity?: string; name?: string; access?: Record<string, unknown> } | undefined,
    late: Promise<AccessProbeResult | undefined> | undefined,
    project: string
  ): Promise<void> {
    if (!late || !runContext?.runId || !isMongoConnected()) return;
    try {
      const result = await late;
      if (!result) return;
      await DocumentRun.updateOne(
        { runId: runContext.runId },
        { $set: { 'manifest.environment.credential': this.mergeCredential(credential, result) } }
      );
      const problem = describeAccessProblems(result, project);
      if (problem) logger.warn(problem);
    } catch (err: any) {
      logger.debug(`Could not record the late access probe: ${err?.message ?? err}`);
    }
  }

  private async finalizeRunRecord(
    runContext: RunContext | undefined,
    update: {
      status: 'succeeded' | 'failed';
      documentUrl?: string;
      errorChain?: IDocumentRunErrorChainEntry[];
      manifest?: IDocumentRunManifest;
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
            manifest: update.manifest,
            errorChain: update.errorChain || [],
          },
        }
      );
    } catch (err) {
      logger.warn('Failed to finalize DocumentRun record', err);
    }
  }

  // Phase 6b — retain-on-failure's "eager-write, prune-on-success" resolution: debug/info
  // events captured under that mode are persisted immediately (like verbose), tagged
  // retainPending, from every process (content-control and the two packages that run
  // in-process inside it — see their own DiagnosticsTransport). This is the one place a run's
  // success is known. Rather than deleting right now, they are given a short expiry: events
  // still buffered in content-control's HttpLogSink arrive after this point, and a delete would
  // miss them (they are inserted already expiring in 24h — see sanitizeEvent). On failure the
  // events are instead pinned to the full retention.
  private async expireRetainOnFailureEvents(runContext: RunContext | undefined): Promise<void> {
    if (!runContext?.runId || !isMongoConnected()) return;
    try {
      await LogEvent.updateMany(
        { runId: runContext.runId, retainPending: true },
        { $set: { expiresAt: new Date(Date.now() + RETAIN_PENDING_GRACE_MS) } }
      );
    } catch (err) {
      logger.warn('Failed to expire retain-on-failure LogEvents', err);
    }
  }

  private async keepRetainOnFailureEvents(runContext: RunContext | undefined): Promise<void> {
    if (!runContext?.runId || !isMongoConnected()) return;
    try {
      await LogEvent.updateMany(
        { runId: runContext.runId, retainPending: true },
        { $set: { expiresAt: new Date(Date.now() + LOG_EVENT_RETENTION_MS) } }
      );
    } catch (err) {
      logger.warn('Failed to pin retain-on-failure LogEvents', err);
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
