import {
  parseCookieHeader,
  sessionCookieOptions,
  clearedSessionCookieOptions,
  sessionCookieName,
  csrfCookieName,
  csrfCookieOptions,
  clearedCsrfCookieOptions,
  preAuthCookieName,
  preAuthCookieOptions,
  clearedPreAuthCookieOptions,
} from '../../util/cookies';

describe('cookies', () => {
  describe('parseCookieHeader', () => {
    test('returns an empty object for an undefined header', () => {
      expect(parseCookieHeader(undefined)).toEqual({});
    });

    test('returns an empty object for an empty header', () => {
      expect(parseCookieHeader('')).toEqual({});
    });

    test('parses a single cookie', () => {
      expect(parseCookieHeader('foo=bar')).toEqual({ foo: 'bar' });
    });

    test('parses multiple cookies separated by "; "', () => {
      expect(parseCookieHeader('foo=bar; baz=qux')).toEqual({ foo: 'bar', baz: 'qux' });
    });

    test('handles duplicate cookie names by keeping the last value', () => {
      expect(parseCookieHeader('foo=first; foo=second')).toEqual({ foo: 'second' });
    });

    test('strips surrounding quotes from a quoted value', () => {
      expect(parseCookieHeader('foo="bar"')).toEqual({ foo: 'bar' });
    });

    test('URL-decodes percent-encoded values', () => {
      expect(parseCookieHeader('foo=a%20b%3Dc')).toEqual({ foo: 'a b=c' });
    });

    test('falls back to the raw value on a malformed percent-escape instead of throwing', () => {
      expect(() => parseCookieHeader('foo=%')).not.toThrow();
      expect(parseCookieHeader('foo=%')).toEqual({ foo: '%' });
    });

    test('ignores segments with no "=" separator', () => {
      expect(parseCookieHeader('foo=bar; malformed; baz=qux')).toEqual({ foo: 'bar', baz: 'qux' });
    });

    test('ignores an entry with an empty name', () => {
      expect(parseCookieHeader('=novalue; foo=bar')).toEqual({ foo: 'bar' });
    });
  });

  describe('sessionCookieOptions', () => {
    test('sets HttpOnly, Secure, SameSite=None, Path=/, and no Domain', () => {
      const options = sessionCookieOptions(60_000);
      expect(options).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
        maxAge: 60_000,
      });
      expect(options).not.toHaveProperty('domain');
    });
  });

  describe('clearedSessionCookieOptions', () => {
    test('sets maxAge to 0 while keeping the same security attributes', () => {
      const options = clearedSessionCookieOptions();
      expect(options).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
        maxAge: 0,
      });
      expect(options).not.toHaveProperty('domain');
    });
  });

  test('sessionCookieName uses the __Host- prefix', () => {
    expect(sessionCookieName.startsWith('__Host-')).toBe(true);
  });

  describe('csrfCookieOptions', () => {
    test('is deliberately NOT HttpOnly (client JS must read it to echo as a header), but still Secure/SameSite=None', () => {
      const options = csrfCookieOptions(60_000);
      expect(options).toMatchObject({
        httpOnly: false,
        secure: true,
        sameSite: 'none',
        path: '/',
        maxAge: 60_000,
      });
    });
  });

  describe('clearedCsrfCookieOptions', () => {
    test('sets maxAge to 0 while keeping httpOnly:false', () => {
      const options = clearedCsrfCookieOptions();
      expect(options).toMatchObject({ httpOnly: false, secure: true, sameSite: 'none', maxAge: 0 });
    });
  });

  test('csrfCookieName is distinct from sessionCookieName and does not use the __Host- prefix (not needed — it is not the auth credential)', () => {
    expect(csrfCookieName).not.toBe(sessionCookieName);
  });

  describe('preAuthCookieOptions', () => {
    test('uses SameSite=Lax (not None) — sufficient for a top-level GET callback navigation, unlike the session cookie', () => {
      const options = preAuthCookieOptions();
      expect(options).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
      });
      expect(options).not.toHaveProperty('domain');
    });

    test('sets a maxAge matching the 10-minute OAuthTransaction TTL', () => {
      const options = preAuthCookieOptions();
      expect(options.maxAge).toBe(10 * 60 * 1000);
    });
  });

  describe('clearedPreAuthCookieOptions', () => {
    test('sets maxAge to 0 while keeping SameSite=Lax', () => {
      const options = clearedPreAuthCookieOptions();
      expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', maxAge: 0 });
    });
  });

  test('preAuthCookieName uses the __Host- prefix and is distinct from the session cookie', () => {
    expect(preAuthCookieName.startsWith('__Host-')).toBe(true);
    expect(preAuthCookieName).not.toBe(sessionCookieName);
  });
});
