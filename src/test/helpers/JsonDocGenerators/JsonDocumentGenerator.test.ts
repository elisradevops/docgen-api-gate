import axios from 'axios';
import { JSONDocumentGenerator } from '../../../helpers/JsonDocGenerators/JsonDocumentGenerator';
import { DocumentRequest } from '../../../models/DocumentRequest';
import logger from '../../../util/logger';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockLogger = logger as unknown as {
  info: jest.Mock;
  error: jest.Mock;
};

describe('JSONDocumentGenerator', () => {
  let generator: JSONDocumentGenerator;
  let baseRequest: DocumentRequest;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.dgContentControlUrl = 'http://cc';

    baseRequest = {
      templateFile: 'http://template.dotx',
      uploadProperties: {
        bucketName: 'attachments',
        fileName: 'out.docx',
        AwsAccessKeyId: 'key',
        AwsSecretAccessKey: 'secret',
        Region: 'eu',
        ServiceUrl: 'http://minio',
        EnableDirectDownload: false,
      },
      teamProjectName: 'project',
      tfsCollectionUri: 'https://org',
      PAT: 'pat',
      contentControls: [
        {
          title: 'CC1',
          type: 'paragraph',
          skin: 'skin',
          headingLevel: 1,
          data: { type: 'query', queryId: 'q1' },
          isExcelSpreadsheet: true,
        },
        {
          title: 'CC2',
          type: 'paragraph',
          skin: 'skin',
          headingLevel: 2,
          data: { type: 'query', queryId: 'q2' },
          isExcelSpreadsheet: false,
          forceClean: true,
        },
      ],
      vcrmQueryId: 'vcrm-1',
      userEmail: 'user@example.com',
      formattingSettings: {
        trimAdditionalSpacingInDescriptions: true,
        trimAdditionalSpacingInTables: true,
      },
    };

    generator = new JSONDocumentGenerator();
  });

  test('generateContentControls sends one request per control and returns aggregated data', async () => {
    (mockedAxios.post as jest.Mock)
      .mockResolvedValueOnce({ data: { result: 'r1' } })
      .mockResolvedValueOnce({ data: { result: 'r2' } });

    const result = await generator.generateContentControls(baseRequest);

    expect(result).toEqual([
      { result: 'r1', forceClean: false },
      { result: 'r2', forceClean: true },
    ]);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://cc/generate-content-control',
      expect.objectContaining({
        orgUrl: baseRequest.tfsCollectionUri,
        token: baseRequest.PAT,
        projectName: baseRequest.teamProjectName,
        templateUrl: baseRequest.templateFile,
        minioEndPoint: baseRequest.uploadProperties.ServiceUrl,
        minioAccessKey: baseRequest.uploadProperties.AwsAccessKeyId,
        minioSecretKey: baseRequest.uploadProperties.AwsSecretAccessKey,
        attachmentsBucketName: 'attachments',
        formattingSettings: baseRequest.formattingSettings,
      })
    );

    const [, secondBody] = (mockedAxios.post as jest.Mock).mock.calls[1];
    expect(secondBody.contentControlOptions).toEqual(
      expect.objectContaining({
        title: 'CC2',
        type: 'paragraph',
        skin: 'skin',
        headingLevel: 2,
        data: { type: 'query', queryId: 'q2' },
        isExcelSpreadsheet: false,
        forceClean: true,
      })
    );

    expect(mockLogger.info).toHaveBeenCalledTimes(2);
  });

  test('generateContentControls logs and rethrows when an axios call fails', async () => {
    const boom = new Error('boom');
    (mockedAxios.post as jest.Mock).mockRejectedValueOnce(boom);

    await expect(
      generator.generateContentControls({
        ...baseRequest,
        contentControls: [baseRequest.contentControls[0]],
      })
    ).rejects.toBe(boom);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Error adding content control ${baseRequest.contentControls[0].title}`)
    );
  });

  test('generateContentControls forwards "empty"-type controls through the same upstream call as every other type', async () => {
    // 'empty'-type controls (e.g. Meeting-Summary's unselected optional section) must still get a
    // real {jsonPath, jsonName} MinIO pointer from content-control — json-to-word's JsonDataList
    // processing requires one for every entry, and previously this bypassed the call entirely,
    // producing an entry with no pointer that crashed downstream.
    (mockedAxios.post as jest.Mock).mockResolvedValueOnce({
      data: { jsonPath: 'http://minio/content-controls/x.json', jsonName: 'x.json' },
    });

    const result = await generator.generateContentControls({
      ...baseRequest,
      contentControls: [
        {
          title: 'previous-open-tasks-content-control',
          type: 'empty',
          skin: 'empty',
          headingLevel: 1,
          data: { type: 'empty' },
          isExcelSpreadsheet: false,
          forceClean: true,
        },
      ],
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [, body] = (mockedAxios.post as jest.Mock).mock.calls[0];
    expect(body.contentControlOptions).toEqual(
      expect.objectContaining({ title: 'previous-open-tasks-content-control', type: 'empty' }),
    );
    expect(result).toEqual([
      {
        jsonPath: 'http://minio/content-controls/x.json',
        jsonName: 'x.json',
        forceClean: true,
      },
    ]);
  });
});
