// Cookie header parsing + the canonical session-cookie option builder.
// Deliberately no `cookie-parser` dependency — reading a `Cookie` header is
// a handful of lines, and keeping it here means the whole BFF auth feature
// adds zero new backend packages (see the plan's Finding 1).
import { CookieOptions } from 'express';

export const sessionCookieName = '__Host-docgen_sp_session';

export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;

  for (const part of header.split(';')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) continue;
    const rawName = part.slice(0, eqIndex).trim();
    if (!rawName) continue;
    const rawValue = part.slice(eqIndex + 1).trim().replace(/^"(.*)"$/, '$1');
    try {
      result[rawName] = decodeURIComponent(rawValue);
    } catch {
      // A malformed %-escape shouldn't crash cookie parsing for every other
      // cookie on the request — fall back to the raw value for this one.
      result[rawName] = rawValue;
    }
  }
  return result;
}

// `SameSite=None` is mandatory, not a preference: the OAuth callback is a
// cross-site top-level navigation from login.microsoftonline.com, and the
// ADO-embedded iframe's calls are cross-site sub-resource requests. This
// gives zero CSRF protection on its own — see requireCsrf.ts for that.
//
// No `domain` attribute is set anywhere — required by the `__Host-` cookie
// name prefix, which browsers enforce: Secure + Path=/ + no Domain, or the
// Set-Cookie is silently rejected entirely.
export function sessionCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function clearedSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: 0,
  };
}

// The double-submit CSRF cookie. Deliberately NOT HttpOnly — client JS must
// read it and echo it back as the X-Csrf-Token header; its value is
// meaningless to an attacker who can't also set a custom header, which a
// cross-site form/img/link request can't do. `__Host-` prefixed like the
// session cookie above — Secure + Path=/ + no Domain already satisfy it.
export const csrfCookieName = '__Host-docgen_csrf';

export function csrfCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: false,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function clearedCsrfCookieOptions(): CookieOptions {
  return {
    httpOnly: false,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: 0,
  };
}

// The short-lived pre-auth cookie: set at GET /auth/login, checked at
// GET /auth/callback as the login-CSRF defense. SameSite=Lax is enough
// here because the callback arrives as a top-level GET navigation from
// login.microsoftonline.com, which Lax permits.
export const preAuthCookieName = '__Host-docgen_preauth';
const PRE_AUTH_MAX_AGE_MS = 10 * 60 * 1000; // matches OAuthTransaction's TTL

export function preAuthCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: PRE_AUTH_MAX_AGE_MS,
  };
}

export function clearedPreAuthCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  };
}
