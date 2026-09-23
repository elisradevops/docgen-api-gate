import axios from 'axios';
import { DocumentRequest } from '../../models/DocumentRequest';
import logger from '../../util/logger';

export class JSONDocumentGenerator {
  // Promise.allSettled rather than Promise.all so a failing content control doesn't leave
  // its siblings running unobserved — every failure is captured into the thrown error's
  // contentControlFailures, which DocumentsGeneratorController folds into the run's error
  // chain. The overall call still rejects if any content control failed: partial documents
  // are not a supported outcome here, only partial *visibility* into what failed is new.
  public async generateContentControls(documentRequest: DocumentRequest): Promise<any> {
    const settled = await Promise.allSettled(
      documentRequest.contentControls.map(async (contentControl) => {
        logger.info(`generating ${contentControl.type} content for: ${contentControl.title}`);
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
          return contentControlResponse.data;
        } catch (err) {
          logger.error(`Error adding content control ${contentControl.title}`, err);
          throw err;
        }
      }),
    );

    const failures = settled
      .map((result, index) => ({ result, contentControl: documentRequest.contentControls[index] }))
      .filter(({ result }) => result.status === 'rejected');

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
      throw aggregateError;
    }

    return (settled as PromiseFulfilledResult<any>[]).map((result) => result.value);
  }
}
