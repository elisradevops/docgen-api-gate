jest.mock('../../../services/auth/SessionService', () => ({
  __esModule: true,
  verifyCsrf: jest.fn(),
}));
jest.mock('../../../util/authConfig', () => ({
  __esModule: true,
  getAllowedOrigins: jest.fn(),
}));

import { verifyCsrf } from '../../../services/auth/SessionService';
import { getAllowedOrigins } from '../../../util/authConfig';
import { requireCsrf } from '../../../helpers/auth/requireCsrf';
import { buildRes } from '../../utils/testResponse';

const mockVerifyCsrf = verifyCsrf as jest.Mock;
const mockGetAllowedOrigins = getAllowedOrigins as jest.Mock;

describe('requireCsrf', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllowedOrigins.mockReturnValue(['https://docgen.example.com']);
  });

  test('skips entirely when there is no session at all (on-prem NTLM call — never has one)', async () => {
    const req: any = { headers: {} };
    const res = buildRes();
    const next = jest.fn();

    await requireCsrf(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockGetAllowedOrigins).not.toHaveBeenCalled();
    expect(mockVerifyCsrf).not.toHaveBeenCalled();
  });

  test('rejects a request with no Origin header at all', async () => {
    const req: any = { headers: {}, spSession: { transport: 'cookie' } };
    const res = buildRes();
    const next = jest.fn();

    await requireCsrf(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'csrf_origin_missing' });
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects an Origin not present in the allowlist', async () => {
    const req: any = { headers: { origin: 'https://untrusted.example.com' }, spSession: { transport: 'cookie' } };
    const res = buildRes();
    const next = jest.fn();

    await requireCsrf(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'csrf_origin_not_allowed' });
    expect(next).not.toHaveBeenCalled();
  });

  test('treats a getAllowedOrigins() failure as an empty allowlist (fail closed)', async () => {
    mockGetAllowedOrigins.mockImplementationOnce(() => {
      throw new Error('CORS_ALLOWED_ORIGINS misconfigured');
    });
    const req: any = { headers: { origin: 'https://docgen.example.com' }, spSession: { transport: 'cookie' } };
    const res = buildRes();
    const next = jest.fn();

    await requireCsrf(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  describe('bearer transport', () => {
    test('skips the CSRF-token check entirely once the Origin allowlist passes', async () => {
      const req: any = { headers: { origin: 'https://docgen.example.com' }, spSession: { transport: 'bearer' } };
      const res = buildRes();
      const next = jest.fn();

      await requireCsrf(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(mockVerifyCsrf).not.toHaveBeenCalled();
    });
  });

  describe('cookie transport', () => {
    test('rejects when the X-Csrf-Token header is missing', async () => {
      const req: any = {
        headers: { origin: 'https://docgen.example.com' },
        spSession: { transport: 'cookie' },
        spSessionRawToken: 'raw-session-token',
      };
      const res = buildRes();
      const next = jest.fn();

      await requireCsrf(req, res, next);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'csrf_token_missing' });
      expect(next).not.toHaveBeenCalled();
    });

    test('rejects when verifyCsrf reports a mismatch', async () => {
      mockVerifyCsrf.mockResolvedValueOnce(false);
      const req: any = {
        headers: { origin: 'https://docgen.example.com', 'x-csrf-token': 'wrong-token' },
        spSession: { transport: 'cookie' },
        spSessionRawToken: 'raw-session-token',
      };
      const res = buildRes();
      const next = jest.fn();

      await requireCsrf(req, res, next);

      expect(mockVerifyCsrf).toHaveBeenCalledWith('raw-session-token', 'wrong-token');
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'csrf_token_invalid' });
      expect(next).not.toHaveBeenCalled();
    });

    test('calls next() when the CSRF token verifies', async () => {
      mockVerifyCsrf.mockResolvedValueOnce(true);
      const req: any = {
        headers: { origin: 'https://docgen.example.com', 'x-csrf-token': 'correct-token' },
        spSession: { transport: 'cookie' },
        spSessionRawToken: 'raw-session-token',
      };
      const res = buildRes();
      const next = jest.fn();

      await requireCsrf(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});
