// CSRF protection for state-changing SharePoint-session routes. Mandatory
// for the cookie transport, since that session cookie is SameSite=None
// (required for the OAuth callback + ADO-iframe context) and so gets zero
// CSRF protection from SameSite alone — replaced here with a strict-Origin
// allowlist plus a double-submit token compare. Skipped for bearer
// transport (no ambient credential a cross-site request could ride) and
// for no session at all (on-prem NTLM routes, which never carry
// req.spSession) — nothing to protect in either case.
//
// Must run AFTER attachSessionIfPresent/requireSession.
import { Response, NextFunction } from 'express';
import { verifyCsrf } from '../../services/auth/SessionService';
import { getAllowedOrigins } from '../../util/authConfig';

const CSRF_HEADER = 'x-csrf-token';

export async function requireCsrf(req: any, res: Response, next: NextFunction): Promise<void> {
  if (!req.spSession) {
    next();
    return;
  }

  const origin = req.headers?.origin;
  if (!origin) {
    res.status(403).json({ success: false, error: 'csrf_origin_missing' });
    return;
  }

  let allowedOrigins: string[];
  try {
    allowedOrigins = getAllowedOrigins();
  } catch {
    allowedOrigins = [];
  }
  if (!allowedOrigins.includes(origin)) {
    res.status(403).json({ success: false, error: 'csrf_origin_not_allowed' });
    return;
  }

  if (req.spSession?.transport === 'bearer') {
    next();
    return;
  }

  const csrfToken = req.headers?.[CSRF_HEADER];
  if (typeof csrfToken !== 'string' || !csrfToken) {
    res.status(403).json({ success: false, error: 'csrf_token_missing' });
    return;
  }

  const rawSessionToken = req.spSessionRawToken;
  const valid = rawSessionToken ? await verifyCsrf(rawSessionToken, csrfToken) : false;
  if (!valid) {
    res.status(403).json({ success: false, error: 'csrf_token_invalid' });
    return;
  }

  next();
}
