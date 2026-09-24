import axios from 'axios';
import { DocumentRequest } from '../../models/DocumentRequest';
import logger from '../../util/logger';
import { IDocumentRunManifestStep, IDocumentRunManifest } from '../../models/DocumentRun';
import { buildStep } from '../runManifest';

export interface GenerateContentControlsResult {
  results: any[];
  steps: IDocumentRunManifestStep[];
  artifacts: IDocumentRunManifest['artifacts'];
}

export class JSONDocumentGenerator {
  // Promise.allSettled rather than Promise.all so a failing content control doesn't leave
  // its siblings running unobserved — every failure is captured into the thrown error's
  // contentControlFailures, which DocumentsGeneratorController folds into the run's error
  // chain. The overall call still rejects if any content control failed: partial documents
  // are not a supported outcome here, only partial *visibility* into what failed is new.
  //
  // The same allSettled walk also builds one manifest step per content control — fulfilled
  // and rejected alike, since a failed step is exactly what the diff engine's "changed
  // outcomes" band ranks on — and one artifact pointer per uploaded content-control JSON.
  public async generateContentControls(documentRequest: DocumentRequest): Promise<GenerateContentControlsResult> {
    const settled = await Promise.allSettled(
      documentRequest.contentControls.map(async (contentControl) => {
        logger.info(`generating ${contentControl.type} content for: ${contentControl.title}`);
        const startedAt = Date.now();
        try {
          let contentControlResponse = await axios.post(
            `${process.env.dgContentControlUrl}/generate-content-control`,
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
                skin: contentControl.skin,
                headingLevel: contentControl.headingLevel,
                data: contentControl.data,
                isExcelSpreadsheet: contentControl.isExcelSpreadsheet || false,
              },
              formattingSettings: documentRequest.formattingSettings,
            },
          );
          return { data: contentControlResponse.data, startedAt };
        } catch (err: any) {
          logger.error(`Error adding content control ${contentControl.title}`, err);
          err.__startedAt = startedAt;
          throw err;
        }
      }),
    );

    const failures = settled
      .map((result, index) => ({ result, contentControl: documentRequest.contentControls[index] }))
      .filter(({ result }) => result.status === 'rejected');

    const steps: IDocumentRunManifestStep[] = settled.map((result, index) => {
      const contentControl = documentRequest.contentControls[index];
      if (result.status === 'fulfilled') {
        return buildStep({
          name: contentControl.title,
          type: 'generate-content-control',
          status: 'succeeded',
          startedAt: result.value.startedAt,
          outputSummary: result.value.data?.outputSummary,
        });
      }
      const reason: any = result.reason;
      return buildStep({
        name: contentControl.title,
        type: 'generate-content-control',
        status: 'failed',
        startedAt: reason?.__startedAt || Date.now(),
      });
    });

    const artifacts: IDocumentRunManifest['artifacts'] = [];
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const data = result.value.data;
      if (!data?.jsonPath) return;
      artifacts.push({
        kind: 'content-control-json',
        name: data.jsonName || documentRequest.contentControls[index].title,
        url: data.jsonPath,
        contentControlTitle: documentRequest.contentControls[index].title,
      });
    });

    if (failures.length > 0) {
      const aggregateError: any = new Error(
        `Failed generating ${failures.length} of ${settled.length} content control(s): ${failures
          .map(({ contentControl }) => contentControl.title)
          .join(', ')}`,
      );
      aggregateError.contentControlFailures = failures.map(({ result, contentControl }) => {
        const reason: any = (result as PromiseRejectedResult).reason;
        return {
          title: contentControl.title,
          type: contentControl.type,
          message: reason?.message || String(reason),
          code: reason?.code,
          stack: reason?.stack,
        };
      });
      aggregateError.steps = steps;
      aggregateError.artifacts = artifacts;
      throw aggregateError;
    }

    return {
      results: (settled as PromiseFulfilledResult<{ data: any; startedAt: number }>[]).map(
        (result) => result.value.data,
      ),
      steps,
      artifacts,
    };
  }
}
