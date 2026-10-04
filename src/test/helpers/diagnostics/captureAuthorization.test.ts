jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../util/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import axios from 'axios';
import logger from '../../../util/logger';
import { authorizeCaptureMode, clearCaptureAuthorizationCache } from '../../../helpers/diagnostics/captureAuthorization';
import type { RunContext } from '../../../util/runContext';

const mockPost = axios.post as jest.Mock;
const ctx = (over: Partial<RunContext> = {}): RunContext => ({ runId: 'r1', requestedCaptureMode: 'verbose', ...over });

describe('authorizeCaptureMode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCaptureAuthorizationCache();
    process.env.dgContentControlUrl = 'http://cc';
    mockPost.mockResolvedValue({ data: { valid: true } });
  });

  test('does nothing, and makes no call, when capture was not requested', async () => {
    const c = ctx({ requestedCaptureMode: undefined });
    await authorizeCaptureMode(c, 'https://org', 'pat');
    expect(mockPost).not.toHaveBeenCalled();
    expect(c.captureMode).toBeUndefined();
  });

  test('activates the requested mode once the credentials validate via content-control', async () => {
    const c = ctx();
    await authorizeCaptureMode(c, 'https://org', 'the-pat');
    expect(mockPost).toHaveBeenCalledWith('http://cc/azure/check-org-url', { orgUrl: 'https://org', token: 'the-pat' }, expect.any(Object));
    expect(c.captureMode).toBe('verbose');
  });

  test('keeps retain-on-failure as requested when authorized', async () => {
    const c = ctx({ requestedCaptureMode: 'retain-on-failure' });
    await authorizeCaptureMode(c, 'https://org', 'pat');
    expect(c.captureMode).toBe('retain-on-failure');
  });

  test('fails closed when validation is rejected, without throwing, and never logs the PAT', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), { config: { data: '{"token":"secret-pat"}' } }));
    const c = ctx();
    await expect(authorizeCaptureMode(c, 'https://org', 'secret-pat')).resolves.toBeUndefined();
    expect(c.captureMode).toBeUndefined();
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('secret-pat');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('fails closed when credentials are missing', async () => {
    const c = ctx();
    await authorizeCaptureMode(c, undefined, undefined);
    expect(mockPost).not.toHaveBeenCalled();
    expect(c.captureMode).toBeUndefined();
  });

  test('caches a successful validation (by hash) so a repeat run makes no second call', async () => {
    await authorizeCaptureMode(ctx(), 'https://org', 'pat');
    const second = ctx();
    await authorizeCaptureMode(second, 'https://org', 'pat');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(second.captureMode).toBe('verbose');
  });

  test('does not cache a failure, and a different PAT is validated separately', async () => {
    mockPost.mockRejectedValueOnce(new Error('boom'));
    await authorizeCaptureMode(ctx(), 'https://org', 'pat');
    await authorizeCaptureMode(ctx(), 'https://org', 'pat');
    await authorizeCaptureMode(ctx(), 'https://org', 'other-pat');
    expect(mockPost).toHaveBeenCalledTimes(3);
  });

  test('is a no-op without a run context', async () => {
    await expect(authorizeCaptureMode(undefined, 'https://org', 'pat')).resolves.toBeUndefined();
  });
});
