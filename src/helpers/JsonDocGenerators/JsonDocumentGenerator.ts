import axios from 'axios';
import { DocumentRequest } from '../../models/DocumentRequest';
import logger from '../../util/logger';

export class JSONDocumentGenerator {
  public async generateContentControls(documentRequest: DocumentRequest): Promise<any> {
    return Promise.all(
      documentRequest.contentControls.map(async (contentControl) => {
        logger.info(`generating ${contentControl.type} content for: ${contentControl.title}`);
        try {
          // 'empty'-type content controls (e.g. Meeting-Summary's unselected optional section) go
          // through the same /generate-content-control call as every other type below — content-control
          // now has a matching 'empty' case that still writes+uploads a real {jsonPath, jsonName}
          // pointer, which json-to-word's JsonDataList processing requires for every entry.
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
                forceClean: contentControl.forceClean || false,
              },
              formattingSettings: documentRequest.formattingSettings,
            },
          );
          return {
            ...contentControlResponse.data,
            forceClean: contentControl.forceClean || false,
          };
        } catch (err) {
          logger.error(`Error adding content control ${contentControl.title}`);
          throw err;
        }
      }),
    );
  }
}
