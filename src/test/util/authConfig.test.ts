import { getAuthConfig, getAllowedOrigins, assertAuthConfig, resetAuthConfigCacheForTests } from '../../util/authConfig';

const REQUIRED_VARS = ['CLIENT_ID', 'TENANT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'SESSION_SECRET'];
const VALID_SESSION_SECRET = 'a'.repeat(32);

function setValidEnv(overrides: Record<string, string | undefined> = {}) {
  process.env.CLIENT_ID = overrides.CLIENT_ID ?? 'client-123';
  process.env.TENANT_ID = overrides.TENANT_ID ?? 'tenant-456';
  process.env.CLIENT_SECRET = overrides.CLIENT_SECRET ?? 'secret-789';
  process.env.REDIRECT_URI = overrides.REDIRECT_URI ?? 'https://docgen.example.com/auth/callback';
  process.env.SESSION_SECRET = overrides.SESSION_SECRET ?? VALID_SESSION_SECRET;
}

describe('authConfig', () => {
  beforeEach(() => {
    resetAuthConfigCacheForTests();
    for (const name of REQUIRED_VARS) delete process.env[name];
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  describe('getAuthConfig', () => {
    test('returns the parsed config when every var is present and valid', () => {
      setValidEnv();
      expect(getAuthConfig()).toEqual({
        clientId: 'client-123',
        tenantId: 'tenant-456',
        clientSecret: 'secret-789',
        redirectUri: 'https://docgen.example.com/auth/callback',
        sessionSecret: VALID_SESSION_SECRET,
      });
    });

    test.each(REQUIRED_VARS)('throws when %s is missing', (missingVar) => {
      setValidEnv();
      delete process.env[missingVar];
      expect(() => getAuthConfig()).toThrow(new RegExp(missingVar));
    });

    test.each(REQUIRED_VARS)('throws when %s is blank', (blankVar) => {
      setValidEnv({ [blankVar]: '   ' });
      expect(() => getAuthConfig()).toThrow(new RegExp(blankVar));
    });

    test('rejects a non-https, non-localhost REDIRECT_URI', () => {
      setValidEnv({ REDIRECT_URI: 'http://docgen.example.com/auth/callback' });
      expect(() => getAuthConfig()).toThrow(/must be https/i);
    });

    test('accepts http://localhost as the documented Entra exception', () => {
      setValidEnv({ REDIRECT_URI: 'http://localhost:30001/auth/callback' });
      expect(() => getAuthConfig()).not.toThrow();
    });

    test('accepts http://127.0.0.1', () => {
      setValidEnv({ REDIRECT_URI: 'http://127.0.0.1:30001/auth/callback' });
      expect(() => getAuthConfig()).not.toThrow();
    });

    test('rejects an unparsable REDIRECT_URI', () => {
      setValidEnv({ REDIRECT_URI: 'not-a-url' });
      expect(() => getAuthConfig()).toThrow(/not a valid URL/i);
    });

    test('rejects a SESSION_SECRET shorter than 32 characters', () => {
      setValidEnv({ SESSION_SECRET: 'too-short' });
      expect(() => getAuthConfig()).toThrow(/at least 32 characters/i);
    });

    test('memoizes after the first successful call', () => {
      setValidEnv();
      const first = getAuthConfig();
      process.env.CLIENT_ID = 'changed-after-first-call';
      const second = getAuthConfig();
      expect(second).toBe(first);
      expect(second.clientId).toBe('client-123');
    });
  });

  describe('getAllowedOrigins', () => {
    test('returns an empty array when unset (deny-all default, not allow-all)', () => {
      expect(getAllowedOrigins()).toEqual([]);
    });

    test('parses a comma-separated list and trims whitespace', () => {
      process.env.CORS_ALLOWED_ORIGINS = ' https://a.example.com , https://b.example.com ';
      expect(getAllowedOrigins()).toEqual(['https://a.example.com', 'https://b.example.com']);
    });

    test('drops empty entries from stray commas', () => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://a.example.com,,';
      expect(getAllowedOrigins()).toEqual(['https://a.example.com']);
    });

    test('throws if the list contains a bare wildcard', () => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://a.example.com,*';
      expect(() => getAllowedOrigins()).toThrow(/must not include/i);
    });
  });

  describe('assertAuthConfig', () => {
    test('does not throw when everything is valid', () => {
      setValidEnv();
      expect(() => assertAuthConfig()).not.toThrow();
    });

    test('throws when the base config is invalid', () => {
      expect(() => assertAuthConfig()).toThrow();
    });

    test('throws when CORS_ALLOWED_ORIGINS contains a wildcard even if the base config is valid', () => {
      setValidEnv();
      process.env.CORS_ALLOWED_ORIGINS = '*';
      expect(() => assertAuthConfig()).toThrow(/must not include/i);
    });
  });
});
