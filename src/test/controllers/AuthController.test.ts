jest.mock('../../util/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('../../util/authConfig', () => ({
  __esModule: true,
  getAuthConfig: jest.fn(),
  getAllowedOrigins: jest.fn(),
}));
jest.mock('../../services/auth/OAuthTransactionService', () => ({
  __esModule: true,
  createTransaction: jest.fn(),
  consumeTransaction: jest.fn(),
}));
jest.mock('../../services/auth/MsalClientService', () => ({
  __esModule: true,
  buildAuthCodeUrl: jest.fn(),
  redeemAuthCode: jest.fn(),
}));
jest.mock('../../services/auth/IdTokenValidator', () => ({
  __esModule: true,
  assertIdTokenClaims: jest.fn(),
}));
jest.mock('../../services/auth/SessionService', () => ({
  __esModule: true,
  createSession: jest.fn(),
  revokeSession: jest.fn(),
  issueHandleCode: jest.fn(),
  consumeHandleCode: jest.fn(),
}));

import { AuthController } from '../../controllers/AuthController';
import { getAuthConfig, getAllowedOrigins } from '../../util/authConfig';
import { createTransaction, consumeTransaction } from '../../services/auth/OAuthTransactionService';
import { buildAuthCodeUrl, redeemAuthCode } from '../../services/auth/MsalClientService';
import { assertIdTokenClaims } from '../../services/auth/IdTokenValidator';
import { createSession, revokeSession, issueHandleCode, consumeHandleCode } from '../../services/auth/SessionService';
import { buildRes } from '../utils/testResponse';
import { preAuthCookieName, sessionCookieName, csrfCookieName } from '../../util/cookies';

const mockGetAuthConfig = getAuthConfig as jest.Mock;
const mockGetAllowedOrigins = getAllowedOrigins as jest.Mock;
const mockCreateTransaction = createTransaction as jest.Mock;
const mockConsumeTransaction = consumeTransaction as jest.Mock;
const mockBuildAuthCodeUrl = buildAuthCodeUrl as jest.Mock;
const mockRedeemAuthCode = redeemAuthCode as jest.Mock;
const mockAssertIdTokenClaims = assertIdTokenClaims as jest.Mock;
const mockCreateSession = createSession as jest.Mock;
const mockRevokeSession = revokeSession as jest.Mock;
const mockIssueHandleCode = issueHandleCode as jest.Mock;
const mockConsumeHandleCode = consumeHandleCode as jest.Mock;

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllowedOrigins.mockReturnValue(['https://docgen.example.com']);
    mockGetAuthConfig.mockReturnValue({
      clientId: 'client-1',
      tenantId: 'tenant-1',
      clientSecret: 'secret-1',
      redirectUri: 'https://docgen.example.com/auth/callback',
      sessionSecret: 'x'.repeat(32),
    });
    controller = new AuthController();
  });

  describe('login', () => {
    test('rejects a missing opener query param with 400 and creates no transaction', async () => {
      const req: any = { query: {} };
      const res = buildRes();

      await controller.login(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'invalid_opener_origin' });
      expect(mockCreateTransaction).not.toHaveBeenCalled();
    });

    test('rejects an opener origin not present in the allowlist', async () => {
      const req: any = { query: { opener: 'https://attacker.example.com' } };
      const res = buildRes();

      await controller.login(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'invalid_opener_origin' });
      expect(mockCreateTransaction).not.toHaveBeenCalled();
    });

    test('treats getAllowedOrigins() throwing as an empty allowlist (fail closed)', async () => {
      mockGetAllowedOrigins.mockImplementationOnce(() => {
        throw new Error('misconfigured');
      });
      const req: any = { query: { opener: 'https://docgen.example.com' } };
      const res = buildRes();

      await controller.login(req, res);

      expect(res.statusCode).toBe(400);
    });

    test('creates a cookie-transport transaction by default, sets the pre-auth cookie, and redirects to the auth URL', async () => {
      mockCreateTransaction.mockResolvedValueOnce({
        state: 'state-1',
        codeVerifier: 'verifier-1',
        nonce: 'nonce-1',
        openerOrigin: 'https://docgen.example.com',
        transport: 'cookie',
      });
      mockBuildAuthCodeUrl.mockResolvedValueOnce('https://login.microsoftonline.com/authorize?state=state-1');
      const req: any = { query: { opener: 'https://docgen.example.com' } };
      const res = buildRes();

      await controller.login(req, res);

      expect(mockCreateTransaction).toHaveBeenCalledWith({ openerOrigin: 'https://docgen.example.com', transport: 'cookie' });
      expect(res.cookies[preAuthCookieName]).toBeDefined();
      expect(res.cookies[preAuthCookieName].value).toBe('state-1');
      expect(res.redirectedTo).toBe('https://login.microsoftonline.com/authorize?state=state-1');
    });

    test('selects the bearer transport when mode=ado', async () => {
      mockCreateTransaction.mockResolvedValueOnce({
        state: 's',
        codeVerifier: 'v',
        nonce: 'n',
        openerOrigin: 'https://docgen.example.com',
        transport: 'bearer',
      });
      mockBuildAuthCodeUrl.mockResolvedValueOnce('https://login.microsoftonline.com/authorize?...');
      const req: any = { query: { opener: 'https://docgen.example.com', mode: 'ado' } };
      const res = buildRes();

      await controller.login(req, res);

      expect(mockCreateTransaction).toHaveBeenCalledWith({ openerOrigin: 'https://docgen.example.com', transport: 'bearer' });
    });
  });

  describe('callback', () => {
    function baseReq(overrides: any = {}): any {
      return {
        query: { state: 'state-1', code: 'auth-code-1' },
        headers: { cookie: `${preAuthCookieName}=state-1` },
        ...overrides,
      };
    }

    test('rejects a missing state with 400 and never consumes a transaction', async () => {
      const req: any = { query: {}, headers: {} };
      const res = buildRes();

      await controller.callback(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'missing_state' });
      expect(mockConsumeTransaction).not.toHaveBeenCalled();
    });

    test('rejects when the pre-auth cookie is missing entirely', async () => {
      const req: any = { query: { state: 'state-1' }, headers: {} };
      const res = buildRes();

      await controller.callback(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'state_mismatch' });
      expect(mockConsumeTransaction).not.toHaveBeenCalled();
    });

    test('rejects when the pre-auth cookie value does not match the state query param (login-CSRF defense)', async () => {
      const req: any = baseReq({ query: { state: 'state-1' }, headers: { cookie: `${preAuthCookieName}=different-state` } });
      const res = buildRes();

      await controller.callback(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'state_mismatch' });
      expect(mockConsumeTransaction).not.toHaveBeenCalled();
    });

    test('rejects an unknown/expired/already-consumed state with 400 (replay defense)', async () => {
      mockConsumeTransaction.mockResolvedValueOnce(null);
      const req: any = baseReq();
      const res = buildRes();

      await controller.callback(req, res);

      expect(mockConsumeTransaction).toHaveBeenCalledWith('state-1');
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'invalid_or_expired_state' });
      expect(mockRedeemAuthCode).not.toHaveBeenCalled();
    });

    test('clears the pre-auth cookie once the transaction is consumed', async () => {
      mockConsumeTransaction.mockResolvedValueOnce({
        state: 'state-1',
        codeVerifier: 'v',
        nonce: 'n',
        openerOrigin: 'https://docgen.example.com',
        transport: 'cookie',
      });
      mockRedeemAuthCode.mockResolvedValueOnce({
        account: { homeAccountId: 'home-1', name: 'Eden', username: 'eden@x.com', tenantId: 'tenant-1' },
        idTokenClaims: { nonce: 'n', tid: 'tenant-1', aud: 'client-1' },
      });
      mockCreateSession.mockResolvedValueOnce({ sessionToken: 'session-tok', csrfToken: 'csrf-tok' });
      const req: any = baseReq();
      const res = buildRes();

      await controller.callback(req, res);

      expect(res.clearedCookies).toContain(preAuthCookieName);
    });

    test('reports an upstream OAuth error via the postMessage callback page, not a raw JSON error', async () => {
      mockConsumeTransaction.mockResolvedValueOnce({
        state: 'state-1',
        codeVerifier: 'v',
        nonce: 'n',
        openerOrigin: 'https://docgen.example.com',
        transport: 'cookie',
      });
      const req: any = baseReq({ query: { state: 'state-1', error: 'access_denied', error_description: 'User cancelled' } });
      const res = buildRes();

      await controller.callback(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.text).toContain('docgen:sp-auth');
      // The stable short code is sent separately from Entra's verbose
      // description — the frontend maps friendly copy off the code and
      // only falls back to the description for codes it doesn't recognize.
      expect(res.text).toContain('access_denied');
      expect(res.text).toContain('User cancelled');
      expect(res.text).toContain('https://docgen.example.com');
      expect(mockRedeemAuthCode).not.toHaveBeenCalled();
    });

    test('reports a missing code via the callback page', async () => {
      mockConsumeTransaction.mockResolvedValueOnce({
        state: 'state-1',
        codeVerifier: 'v',
        nonce: 'n',
        openerOrigin: 'https://docgen.example.com',
        transport: 'cookie',
      });
      const req: any = baseReq({ query: { state: 'state-1' } });
      const res = buildRes();

      await controller.callback(req, res);

      expect(res.text).toContain('missing_code');
      expect(mockRedeemAuthCode).not.toHaveBeenCalled();
    });

    test('validates the ID token claims against the transaction nonce and the configured tenant/client', async () => {
      mockConsumeTransaction.mockResolvedValueOnce({
        state: 'state-1',
        codeVerifier: 'verifier-1',
        nonce: 'nonce-1',
        openerOrigin: 'https://docgen.example.com',
        transport: 'cookie',
      });
      mockRedeemAuthCode.mockResolvedValueOnce({
        account: { homeAccountId: 'home-1', name: 'Eden', username: 'eden@x.com', tenantId: 'tenant-1' },
        idTokenClaims: { nonce: 'nonce-1', tid: 'tenant-1', aud: 'client-1' },
      });
      mockCreateSession.mockResolvedValueOnce({ sessionToken: 'session-tok', csrfToken: 'csrf-tok' });
      const req: any = baseReq();
      const res = buildRes();

      await controller.callback(req, res);

      expect(mockAssertIdTokenClaims).toHaveBeenCalledWith(
        { nonce: 'nonce-1', tid: 'tenant-1', aud: 'client-1' },
        { nonce: 'nonce-1', tenantId: 'tenant-1', clientId: 'client-1' }
      );
    });

    test('cookie transport: sets the session and CSRF cookies and sends an ok:true callback page with no handleCode', async () => {
      mockConsumeTransaction.mockResolvedValueOnce({
        state: 'state-1',
        codeVerifier: 'v',
        nonce: 'n',
        openerOrigin: 'https://docgen.example.com',
        transport: 'cookie',
      });
      mockRedeemAuthCode.mockResolvedValueOnce({
        account: { homeAccountId: 'home-1', name: 'Eden', username: 'eden@x.com', tenantId: 'tenant-1' },
        idTokenClaims: { nonce: 'n', tid: 'tenant-1', aud: 'client-1' },
      });
      mockCreateSession.mockResolvedValueOnce({ sessionToken: 'session-tok', csrfToken: 'csrf-tok' });
      const req: any = baseReq();
      const res = buildRes();

      await controller.callback(req, res);

      expect(res.cookies[sessionCookieName].value).toBe('session-tok');
      expect(res.cookies[csrfCookieName].value).toBe('csrf-tok');
      expect(mockIssueHandleCode).not.toHaveBeenCalled();
      expect(res.text).toContain('docgen:sp-auth');
      expect(res.text).not.toContain('handleCode');
    });

    test('bearer transport: issues a handle code and sends it in the callback page, without setting cookies', async () => {
      mockConsumeTransaction.mockResolvedValueOnce({
        state: 'state-1',
        codeVerifier: 'v',
        nonce: 'n',
        openerOrigin: 'https://docgen.example.com',
        transport: 'bearer',
      });
      mockRedeemAuthCode.mockResolvedValueOnce({
        account: { homeAccountId: 'home-1', name: 'Eden', username: 'eden@x.com', tenantId: 'tenant-1' },
        idTokenClaims: { nonce: 'n', tid: 'tenant-1', aud: 'client-1' },
      });
      mockCreateSession.mockResolvedValueOnce({ sessionToken: 'session-tok', csrfToken: 'csrf-tok' });
      mockIssueHandleCode.mockResolvedValueOnce('one-time-handle-code');
      const req: any = baseReq();
      const res = buildRes();

      await controller.callback(req, res);

      expect(mockIssueHandleCode).toHaveBeenCalledWith('session-tok');
      expect(res.cookies[sessionCookieName]).toBeUndefined();
      expect(res.text).toContain('one-time-handle-code');
    });

    test('a redemption failure after a valid state still reports via the callback page (trusted openerOrigin), not a raw 500', async () => {
      mockConsumeTransaction.mockResolvedValueOnce({
        state: 'state-1',
        codeVerifier: 'v',
        nonce: 'n',
        openerOrigin: 'https://docgen.example.com',
        transport: 'cookie',
      });
      mockRedeemAuthCode.mockRejectedValueOnce(new Error('invalid_grant'));
      const req: any = baseReq();
      const res = buildRes();

      await controller.callback(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.text).toContain('docgen:sp-auth');
      expect(res.text).toContain('sign_in_failed');
    });

    test('an ID-token-claims validation failure is reported the same way', async () => {
      mockConsumeTransaction.mockResolvedValueOnce({
        state: 'state-1',
        codeVerifier: 'v',
        nonce: 'n',
        openerOrigin: 'https://docgen.example.com',
        transport: 'cookie',
      });
      mockRedeemAuthCode.mockResolvedValueOnce({
        account: { homeAccountId: 'home-1' },
        idTokenClaims: { nonce: 'wrong', tid: 'tenant-1', aud: 'client-1' },
      });
      mockAssertIdTokenClaims.mockImplementationOnce(() => {
        throw new Error('ID token nonce mismatch');
      });
      const req: any = baseReq();
      const res = buildRes();

      await controller.callback(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.text).toContain('sign_in_failed');
      expect(mockCreateSession).not.toHaveBeenCalled();
    });
  });

  describe('exchangeSessionHandle', () => {
    test('rejects a missing handleCode with 400', async () => {
      const req: any = { body: {} };
      const res = buildRes();

      await controller.exchangeSessionHandle(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'missing_handle_code' });
      expect(mockConsumeHandleCode).not.toHaveBeenCalled();
    });

    test('rejects an unknown/expired handle code with 400', async () => {
      mockConsumeHandleCode.mockResolvedValueOnce(null);
      const req: any = { body: { handleCode: 'unknown-code' } };
      const res = buildRes();

      await controller.exchangeSessionHandle(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'invalid_or_expired_handle_code' });
    });

    test('returns the raw session token on success', async () => {
      mockConsumeHandleCode.mockResolvedValueOnce({ sessionToken: 'the-session-token' });
      const req: any = { body: { handleCode: 'valid-code' } };
      const res = buildRes();

      await controller.exchangeSessionHandle(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, sessionToken: 'the-session-token' });
    });
  });

  describe('getSessionInfo', () => {
    test('returns displayName/userPrincipalName from the already-resolved session (no fresh Graph call)', async () => {
      const req: any = { spSession: { displayName: 'Eden Zvi Schwartz', userPrincipalName: 'eden@korentec.onmicrosoft.com' } };
      const res = buildRes();

      await controller.getSessionInfo(req, res);

      expect(res.body).toEqual({
        success: true,
        displayName: 'Eden Zvi Schwartz',
        userPrincipalName: 'eden@korentec.onmicrosoft.com',
      });
    });
  });

  describe('logout', () => {
    test('revokes the session and clears both the session and CSRF cookies', async () => {
      const req: any = { spSessionRawToken: 'raw-session-token' };
      const res = buildRes();

      await controller.logout(req, res);

      expect(mockRevokeSession).toHaveBeenCalledWith('raw-session-token');
      expect(res.clearedCookies).toContain(sessionCookieName);
      expect(res.clearedCookies).toContain(csrfCookieName);
      expect(res.body).toEqual({ success: true });
    });
  });
});
