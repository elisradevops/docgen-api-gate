jest.mock('../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  readOwnVersion: jest.fn(() => '9.9.9'),
  redactValue: jest.requireActual('../../util/logger').redactValue,
}));

import { buildEnvironment, buildInputs, buildStep, emptyManifest } from '../../helpers/runManifest';
import { DocumentRequest } from '../../models/DocumentRequest';

describe('runManifest', () => {
  const baseRequest: DocumentRequest = {
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
        type: 'query',
        skin: 'skin',
        headingLevel: 1,
        data: { queryId: 'q1', token: 'super-secret-pat', nested: { password: 'hunter2' } } as any,
        isExcelSpreadsheet: false,
      },
    ],
    vcrmQueryId: 'vcrm-1',
    userEmail: 'user@example.com',
    formattingSettings: {
      trimAdditionalSpacingInDescriptions: true,
      trimAdditionalSpacingInTables: true,
    },
  };

  test('buildInputs allowlists the request and never carries top-level credentials', () => {
    const inputs = buildInputs(baseRequest, 'ctx-name');

    expect(inputs).toMatchObject({
      templateName: baseRequest.templateFile,
      project: baseRequest.teamProjectName,
      orgUrl: baseRequest.tfsCollectionUri,
      resolvedContextName: 'ctx-name',
    });
    expect((inputs as any).PAT).toBeUndefined();
    expect((inputs as any).uploadProperties).toBeUndefined();
  });

  test('buildInputs redacts sensitive keys inside a content control data blob', () => {
    const inputs: any = buildInputs(baseRequest);
    const [cc1] = inputs.contentControls;

    expect(cc1.data.token).toBe('[REDACTED]');
    expect(cc1.data.nested.password).toBe('[REDACTED]');
    expect(cc1.data.queryId).toBe('q1');
  });

  test('buildEnvironment reports api-gate and content-control versions with fallbacks', () => {
    const environment = buildEnvironment({ service: '2.0.0', dataProvider: '1.140.0', skins: '0.28.0' });
    expect(environment.services['dg-api-gate']).toBe('9.9.9');
    expect(environment.services['dg-content-control']).toBe('2.0.0');
    expect(environment.packages['@elisra-devops/docgen-data-provider']).toBe('1.140.0');

    const withoutVersions = buildEnvironment(undefined);
    expect(withoutVersions.services['dg-content-control']).toBe('unknown');
  });

  test('buildStep computes duration and errorCount from status', () => {
    const startedAt = Date.now() - 50;
    const succeeded = buildStep({ name: 'step', type: 'render-document', status: 'succeeded', startedAt });
    const failed = buildStep({ name: 'step', type: 'render-document', status: 'failed', startedAt });

    expect(succeeded.errorCount).toBe(0);
    expect(failed.errorCount).toBe(1);
    expect(succeeded.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('emptyManifest starts with no steps or artifacts', () => {
    expect(emptyManifest()).toEqual({ steps: [], artifacts: [] });
  });
});
