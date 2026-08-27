// Session-resolution middleware. Tries the Authorization: Bearer header
// first (ADO-embedded transport), then the __Host- session cookie
// (standalone transport) — either missing or no longer live gets a
// machine-readable 401 the frontend reacts to by reopening the sign-in
// popup, never a silent retry.
import { Response, NextFunction } from 'express';
import { resolveSession } from '../../services/auth/SessionService';
import { parseCookieHeader, sessionCookieName } from '../../util/cookies';

const BEARER_PREFIX = 'Bearer ';

function extractRawToken(req: any): string | null {
  const authHeader = req.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith(BEARER_PREFIX)) {
    return authHeader.slice(BEARER_PREFIX.length).trim();
  }
  const cookies = parseCookieHeader(req.headers?.cookie);
  return cookies[sessionCookieName] || null;
}

export async function requireSession(req: any, res: Response, next: NextFunction): Promise<void> {
  const rawToken = extractRawToken(req);
  if (!rawToken) {
    res.status(401).json({ success: false, error: 'reauth_required' });
    return;
  }

  const session = await resolveSession(rawToken);
  if (!session) {
    res.status(401).json({ success: false, error: 'reauth_required' });
    return;
  }

  req.spSession = session;
  req.spSessionRawToken = rawToken; // needed by requireCsrf's double-submit compare
  next();
}
