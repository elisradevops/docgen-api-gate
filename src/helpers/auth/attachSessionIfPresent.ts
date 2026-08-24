// Unlike requireSession, this never blocks a request — it populates
// req.spSession/req.spSessionRawToken when a valid session exists and
// calls next() either way. Deliberately non-blocking: the SharePoint
// routes are dual-purpose, and on-prem NTLM requests never have a session
// at all. SharePointController.resolveAuth is what actually requires one,
// per-request, when the target siteUrl is Online.
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

export async function attachSessionIfPresent(req: any, _res: Response, next: NextFunction): Promise<void> {
  const rawToken = extractRawToken(req);
  if (!rawToken) {
    next();
    return;
  }

  const session = await resolveSession(rawToken);
  if (session) {
    req.spSession = session;
    req.spSessionRawToken = rawToken;
  }
  next();
}
