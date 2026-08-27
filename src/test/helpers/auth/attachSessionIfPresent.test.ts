jest.mock('../../../services/auth/SessionService', () => ({
  __esModule: true,
  resolveSession: jest.fn(),
}));

import { resolveSession } from '../../../services/auth/SessionService';
import { attachSessionIfPresent } from '../../../helpers/auth/attachSessionIfPresent';
import { sessionCookieName } from '../../../util/cookies';

const mockResolveSession = resolveSession as jest.Mock;

describe('attachSessionIfPresent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('calls next() without a session when no Authorization header or cookie is present — never blocks', async () => {
    const req: any = { headers: {} };
    const next = jest.fn();

    await attachSessionIfPresent(req, {} as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.spSession).toBeUndefined();
    expect(mockResolveSession).not.toHaveBeenCalled();
  });

  test('calls next() without a session when the token does not resolve to a live session — still never blocks', async () => {
    mockResolveSession.mockResolvedValueOnce(null);
    const req: any = { headers: { authorization: 'Bearer expired-token' } };
    const next = jest.fn();

    await attachSessionIfPresent(req, {} as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.spSession).toBeUndefined();
  });

  test('attaches spSession/spSessionRawToken and calls next() when a bearer token resolves', async () => {
    const session = { sessionId: 's1', homeAccountId: 'h1', transport: 'bearer' };
    mockResolveSession.mockResolvedValueOnce(session);
    const req: any = { headers: { authorization: 'Bearer the-raw-token' } };
    const next = jest.fn();

    await attachSessionIfPresent(req, {} as any, next);

    expect(req.spSession).toEqual(session);
    expect(req.spSessionRawToken).toBe('the-raw-token');
    expect(next).toHaveBeenCalled();
  });

  test('falls back to the session cookie and attaches spSession when no Authorization header is present', async () => {
    const session = { sessionId: 's1', homeAccountId: 'h1', transport: 'cookie' };
    mockResolveSession.mockResolvedValueOnce(session);
    const req: any = { headers: { cookie: `${sessionCookieName}=cookie-token-value` } };
    const next = jest.fn();

    await attachSessionIfPresent(req, {} as any, next);

    expect(mockResolveSession).toHaveBeenCalledWith('cookie-token-value');
    expect(req.spSession).toEqual(session);
    expect(next).toHaveBeenCalled();
  });
});
