jest.mock('../../../services/auth/SessionService', () => ({
  __esModule: true,
  resolveSession: jest.fn(),
}));

import { resolveSession } from '../../../services/auth/SessionService';
import { requireSession } from '../../../helpers/auth/requireSession';
import { buildRes } from '../../utils/testResponse';
import { sessionCookieName } from '../../../util/cookies';

const mockResolveSession = resolveSession as jest.Mock;

describe('requireSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('responds 401 reauth_required when neither an Authorization header nor a session cookie is present', async () => {
    const req: any = { headers: {} };
    const res = buildRes();
    const next = jest.fn();

    await requireSession(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'reauth_required' });
    expect(next).not.toHaveBeenCalled();
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  test('prefers the Authorization: Bearer header over a cookie when both are present', async () => {
    mockResolveSession.mockResolvedValueOnce({ sessionId: 's1', homeAccountId: 'h1', transport: 'bearer' });
    const req: any = {
      headers: { authorization: 'Bearer bearer-token-value', cookie: `${sessionCookieName}=cookie-token-value` },
    };
    const res = buildRes();
    const next = jest.fn();

    await requireSession(req, res, next);

    expect(mockResolveSession).toHaveBeenCalledWith('bearer-token-value');
    expect(next).toHaveBeenCalled();
  });

  test('falls back to the session cookie when no Authorization header is present', async () => {
    mockResolveSession.mockResolvedValueOnce({ sessionId: 's1', homeAccountId: 'h1', transport: 'cookie' });
    const req: any = { headers: { cookie: `${sessionCookieName}=cookie-token-value; other=x` } };
    const res = buildRes();
    const next = jest.fn();

    await requireSession(req, res, next);

    expect(mockResolveSession).toHaveBeenCalledWith('cookie-token-value');
    expect(next).toHaveBeenCalled();
  });

  test('responds 401 when the resolved token does not map to a live session', async () => {
    mockResolveSession.mockResolvedValueOnce(null);
    const req: any = { headers: { authorization: 'Bearer expired-token' } };
    const res = buildRes();
    const next = jest.fn();

    await requireSession(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'reauth_required' });
    expect(next).not.toHaveBeenCalled();
  });

  test('attaches spSession and spSessionRawToken to the request on success', async () => {
    const session = { sessionId: 's1', homeAccountId: 'h1', transport: 'cookie' };
    mockResolveSession.mockResolvedValueOnce(session);
    const req: any = { headers: { authorization: 'Bearer the-raw-token' } };
    const res = buildRes();
    const next = jest.fn();

    await requireSession(req, res, next);

    expect(req.spSession).toEqual(session);
    expect(req.spSessionRawToken).toBe('the-raw-token');
  });

  test('ignores a malformed Authorization header that does not start with "Bearer "', async () => {
    const req: any = { headers: { authorization: 'Basic something' } };
    const res = buildRes();
    const next = jest.fn();

    await requireSession(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(mockResolveSession).not.toHaveBeenCalled();
  });
});
