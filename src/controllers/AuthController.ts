import { Request, Response } from 'express';
import logger from '../util/logger';
import { getAuthConfig, getAllowedOrigins } from '../util/authConfig';
import {
  parseCookieHeader,
  sessionCookieName,
  sessionCookieOptions,
  clearedSessionCookieOptions,
  csrfCookieName,
  csrfCookieOptions,
  clearedCsrfCookieOptions,
  preAuthCookieName,
  preAuthCookieOptions,
  clearedPreAuthCookieOptions,
} from '../util/cookies';
import { timingSafeEqualStr } from '../util/randomTokens';
import { buildCallbackPage } from '../util/authCallbackPage';
import { createTransaction, consumeTransaction } from '../services/auth/OAuthTransactionService';
import { buildAuthCodeUrl, redeemAuthCode } from '../services/auth/MsalClientService';
import { assertIdTokenClaims } from '../services/auth/IdTokenValidator';
import { createSession, revokeSession, issueHandleCode, consumeHandleCode } from '../services/auth/SessionService';

const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // matches AuthSession's absoluteExpiresAt cap

export class AuthController {
  // Starts the popup's Authorization Code + PKCE roundtrip. `opener` must be
  // one of this deployment's own CORS origins — it becomes the postMessage
  // target at /auth/callback, so it's never trusted blindly. `mode=ado`
  // selects the bearer/handle-code transport for the ADO-embedded iframe;
  // anything else uses the cookie transport.
  public async login(req: Request, res: Response): Promise<void> {
    const opener = typeof req.query.opener === 'string' ? req.query.opener : '';

    let allowedOrigins: string[] = [];
    try {
      allowedOrigins = getAllowedOrigins();
    } catch (error: any) {
      logger.error(`/auth/login: invalid CORS_ALLOWED_ORIGINS configuration: ${error.message}`);
    }

    if (!opener || !allowedOrigins.includes(opener)) {
      res.status(400).json({ success: false, error: 'invalid_opener_origin' });
      return;
    }

    const transport = req.query.mode === 'ado' ? 'bearer' : 'cookie';

    try {
      const { state, codeVerifier, nonce } = await createTransaction({ openerOrigin: opener, transport });
      res.cookie(preAuthCookieName, state, preAuthCookieOptions());
      const authUrl = await buildAuthCodeUrl({ state, nonce, codeVerifier });
      res.redirect(authUrl);
    } catch (error: any) {
      logger.error(`/auth/login failed: ${error.message}`);
      res.status(500).json({ success: false, error: 'auth_login_failed' });
    }
  }

  // The OAuth redirect target. `state` is checked (constant-time) against
  // the pre-auth cookie before anything else — the login-CSRF defense: only
  // the browser that started /auth/login holds that cookie, so an attacker
  // can't complete their own sign-in and land it in a victim's session. Only
  // once that passes and the transaction is consumed (single-use) is
  // openerOrigin trustworthy enough to postMessage to; any earlier failure
  // returns plain JSON instead.
  public async callback(req: Request, res: Response): Promise<void> {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state) {
      res.status(400).json({ success: false, error: 'missing_state' });
      return;
    }

    const cookies = parseCookieHeader(req.headers.cookie);
    const cookieState = cookies[preAuthCookieName];
    if (!cookieState || !timingSafeEqualStr(state, cookieState)) {
      res.status(400).json({ success: false, error: 'state_mismatch' });
      return;
    }

    const transaction = await consumeTransaction(state);
    if (!transaction) {
      res.status(400).json({ success: false, error: 'invalid_or_expired_state' });
      return;
    }
    res.clearCookie(preAuthCookieName, clearedPreAuthCookieOptions());

    // From here on, transaction.openerOrigin is trustworthy (it was
    // validated against the CORS allowlist at /auth/login time) — safe to
    // use as the postMessage target for both success and failure.
    try {
      const oauthError = typeof req.query.error === 'string' ? req.query.error : '';
      if (oauthError) {
        // Send the stable short code (e.g. 'access_denied') separately from
        // Entra's verbose error_description — the frontend maps friendly
        // copy off the stable code and only falls back to the description
        // for codes it doesn't recognize.
        const description = typeof req.query.error_description === 'string' ? req.query.error_description : oauthError;
        this.sendCallbackResult(res, transaction.openerOrigin, {
          type: 'docgen:sp-auth',
          ok: false,
          error: oauthError,
          errorDescription: description,
        });
        return;
      }

      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) {
        this.sendCallbackResult(res, transaction.openerOrigin, { type: 'docgen:sp-auth', ok: false, error: 'missing_code' });
        return;
      }

      const authResult = await redeemAuthCode({ code, codeVerifier: transaction.codeVerifier, state });
      const { clientId, tenantId } = getAuthConfig();
      assertIdTokenClaims((authResult.idTokenClaims as any) || {}, { nonce: transaction.nonce, tenantId, clientId });

      const homeAccountId = authResult.account?.homeAccountId;
      if (!homeAccountId) {
        throw new Error('MSAL did not return an account for the redeemed code');
      }

      const { sessionToken, csrfToken } = await createSession({
        homeAccountId,
        transport: transaction.transport,
        displayName: authResult.account?.name,
        userPrincipalName: authResult.account?.username,
        tenantId: authResult.account?.tenantId,
      });

      if (transaction.transport === 'bearer') {
        const handleCode = await issueHandleCode(sessionToken);
        this.sendCallbackResult(res, transaction.openerOrigin, { type: 'docgen:sp-auth', ok: true, handleCode });
      } else {
        res.cookie(sessionCookieName, sessionToken, sessionCookieOptions(SESSION_MAX_AGE_MS));
        res.cookie(csrfCookieName, csrfToken, csrfCookieOptions(SESSION_MAX_AGE_MS));
        this.sendCallbackResult(res, transaction.openerOrigin, { type: 'docgen:sp-auth', ok: true });
      }
    } catch (error: any) {
      logger.error(`/auth/callback failed after a valid state: ${error.message}`);
      this.sendCallbackResult(res, transaction.openerOrigin, { type: 'docgen:sp-auth', ok: false, error: 'sign_in_failed' });
    }
  }

  private sendCallbackResult(
    res: Response,
    targetOrigin: string,
    payload: { type: 'docgen:sp-auth'; ok: boolean; handleCode?: string; error?: string; errorDescription?: string }
  ): void {
    const page = buildCallbackPage({ targetOrigin, payload });
    res.set(page.headers).status(200).send(page.html);
  }

  // Bearer-transport only: exchanges the one-time handle code (delivered
  // via postMessage) for the actual bearer session token. No requireSession
  // guard on this route — the handle code itself is the one-time
  // credential that authorizes this exchange.
  public async exchangeSessionHandle(req: Request, res: Response): Promise<void> {
    const handleCode = typeof req.body?.handleCode === 'string' ? req.body.handleCode : '';
    if (!handleCode) {
      res.status(400).json({ success: false, error: 'missing_handle_code' });
      return;
    }

    const result = await consumeHandleCode(handleCode);
    if (!result) {
      res.status(400).json({ success: false, error: 'invalid_or_expired_handle_code' });
      return;
    }

    res.status(200).json({ success: true, sessionToken: result.sessionToken });
  }

  // Returns display-name/UPN sourced from the ID token claims captured at
  // sign-in — never a fresh Graph /me call, which is why User.Read is not
  // among this app's requested scopes.
  public async getSessionInfo(req: Request, res: Response): Promise<void> {
    const session = (req as any).spSession;
    res.status(200).json({
      success: true,
      displayName: session?.displayName,
      userPrincipalName: session?.userPrincipalName,
    });
  }

  public async logout(req: Request, res: Response): Promise<void> {
    const rawToken = (req as any).spSessionRawToken;
    if (rawToken) {
      await revokeSession(rawToken);
    }
    res.clearCookie(sessionCookieName, clearedSessionCookieOptions());
    res.clearCookie(csrfCookieName, clearedCsrfCookieOptions());
    res.status(200).json({ success: true });
  }
}
