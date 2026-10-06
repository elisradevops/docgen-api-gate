jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../util/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import axios from 'axios';
import logger from '../../../util/logger';
import {
  startAccessProbe,
  clearAccessProbeCache,
  accessProbeEnabled,
  sanitizeIdentityName,
  describeAccessProblems,
  AccessProbeResult,
} from '../../../helpers/diagnostics/accessProbe';

const mockPost = axios.post as jest.Mock;
const buildServiceResponse = {
  data: {
    identity: {
      providerDisplayName: 'Project Collection Build Service (Org)',
      descriptor: 'Microsoft.TeamFoundation.ServiceIdentity;abc',
    },
    access: { repositories: { status: 'ok', count: 3 }, releases: { status: 'denied', httpStatus: 403 } },
  },
};

describe('startAccessProbe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAccessProbeCache();
    delete process.env.ACCESS_PROBE;
    process.env.dgContentControlUrl = 'http://cc';
    mockPost.mockResolvedValue(buildServiceResponse);
  });

  test('asks content-control and returns the identity name and class and what the credential can see', async () => {
    const result = await startAccessProbe('https://org/', 'the-pat', 'MEWP');

    expect(mockPost).toHaveBeenCalledWith(
      'http://cc/azure/access-probe',
      { orgUrl: 'https://org/', token: 'the-pat', projectName: 'MEWP' },
      expect.objectContaining({ timeout: expect.any(Number) })
    );
    expect(result).toEqual({
      identity: { name: 'Project Collection Build Service (Org)', class: 'build-service' },
      access: buildServiceResponse.data.access,
    });
  });

  test('prefers the custom display name and strips control characters and length', async () => {
    mockPost.mockResolvedValue({
      data: { identity: { customDisplayName: `  Jane\u0000 Doe\n${'x'.repeat(300)}  `, providerDisplayName: 'ignored' }, access: {} },
    });

    const result = (await startAccessProbe('https://org/', 'pat', 'P')) as AccessProbeResult;

    expect(result.identity!.name!.startsWith('Jane Doex')).toBe(true);
    expect(result.identity!.name).not.toMatch(/[\u0000-\u001f]/);
    expect(result.identity!.name!.length).toBe(120);
    expect(result.identity!.class).toBe('user');
  });

  test('caches per credential and project, so a repeat run makes no second call', async () => {
    await startAccessProbe('https://org/', 'pat', 'MEWP');
    await startAccessProbe('https://org/', 'pat', 'MEWP');
    expect(mockPost).toHaveBeenCalledTimes(1);

    await startAccessProbe('https://org/', 'pat', 'Another');
    await startAccessProbe('https://org/', 'other-pat', 'MEWP');
    expect(mockPost).toHaveBeenCalledTimes(3);
  });

  test('makes no call without a credential, a project or an org, or when switched off', async () => {
    expect(await startAccessProbe('https://org/', undefined, 'P')).toBeUndefined();
    expect(await startAccessProbe('https://org/', 'pat', undefined)).toBeUndefined();
    expect(await startAccessProbe(undefined, 'pat', 'P')).toBeUndefined();
    process.env.ACCESS_PROBE = 'off';
    expect(await startAccessProbe('https://org/', 'pat', 'P')).toBeUndefined();
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('fails open, without throwing and without ever logging the credential', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('timeout of 12000ms exceeded'), { config: { data: '{"token":"secret-pat"}' } }));

    await expect(startAccessProbe('https://org/', 'secret-pat', 'P')).resolves.toBeUndefined();

    expect(JSON.stringify((logger.debug as jest.Mock).mock.calls)).not.toContain('secret-pat');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('ignores a response without an access block, and does not cache it', async () => {
    mockPost.mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce(buildServiceResponse);

    expect(await startAccessProbe('https://org/', 'pat', 'P')).toBeUndefined();
    expect(await startAccessProbe('https://org/', 'pat', 'P')).toBeDefined();
  });

  test('accessProbeEnabled and sanitizeIdentityName', () => {
    expect(accessProbeEnabled(undefined)).toBe(true);
    expect(accessProbeEnabled('on')).toBe(true);
    expect(accessProbeEnabled(' OFF ')).toBe(false);
    expect(sanitizeIdentityName(undefined)).toBeUndefined();
    expect(sanitizeIdentityName('   ')).toBeUndefined();
    expect(sanitizeIdentityName('A\tB')).toBe('AB');
  });
});

describe('describeAccessProblems', () => {
  const result = (access: any, identity: AccessProbeResult['identity'] = { name: 'Build Svc (Org)', class: 'build-service' }): AccessProbeResult => ({
    identity,
    access,
  });

  test('names a denied area with its status and the identity', () => {
    const text = describeAccessProblems(result({ releases: { status: 'denied', httpStatus: 403 }, repositories: { status: 'ok', count: 3 } }), 'MEWP');

    expect(text).toBe('Build Svc (Org) cannot read release definitions (403) in project MEWP; a document generated with it can be empty or incomplete.');
  });

  test('reports an invisible project and no repositories or work items, but not empty builds, releases or test plans', () => {
    const text = describeAccessProblems(
      result({
        project: { status: 'notFound', count: 2 },
        repositories: { status: 'ok', count: 0 },
        workItems: { status: 'ok', count: 0 },
        builds: { status: 'ok', count: 0 },
        releases: { status: 'ok', count: 0 },
        testPlans: { status: 'ok', count: 0 },
      }),
      'MEWP'
    );

    expect(text).toContain('does not see the project in its project list');
    expect(text).toContain('sees no repositories');
    expect(text).toContain('sees no work items');
    expect(text).not.toContain('build definitions');
    expect(text).not.toContain('test plans');
  });

  test('says nothing when the credential sees what it needs', () => {
    expect(describeAccessProblems(result({ repositories: { status: 'ok', count: 12 }, workItems: { status: 'ok', count: 1 }, testPlans: { status: 'notFound' } }), 'P')).toBeUndefined();
  });

  test('falls back to a generic name when the identity is unknown', () => {
    expect(describeAccessProblems({ access: { repositories: { status: 'denied', httpStatus: 401 } } }, 'P')).toMatch(/^the credential cannot read repositories \(401\)/);
    expect(describeAccessProblems(result({ repositories: { status: 'denied', httpStatus: 401 } }, { class: 'build-service' }), 'P')).toMatch(/^a build service identity cannot read/);
  });
});
