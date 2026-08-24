import { newOpaqueToken, hashToken, timingSafeEqualStr } from '../../util/randomTokens';

describe('randomTokens', () => {
  describe('newOpaqueToken', () => {
    test('returns a base64url string with no padding/plus/slash characters', () => {
      const token = newOpaqueToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test('32 bytes decodes to a 43-character token (RFC 7636 PKCE verifier range)', () => {
      const token = newOpaqueToken(32);
      expect(token.length).toBe(43);
    });

    test('respects a custom byte length', () => {
      const token = newOpaqueToken(16);
      expect(token.length).toBe(22);
    });

    test('is not deterministic across calls', () => {
      const a = newOpaqueToken();
      const b = newOpaqueToken();
      expect(a).not.toBe(b);
    });
  });

  describe('hashToken', () => {
    test('is deterministic for the same input', () => {
      expect(hashToken('same-input')).toBe(hashToken('same-input'));
    });

    test('differs for different inputs', () => {
      expect(hashToken('input-a')).not.toBe(hashToken('input-b'));
    });

    test('returns a 64-character hex sha256 digest', () => {
      expect(hashToken('anything')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('timingSafeEqualStr', () => {
    test('returns true for equal strings', () => {
      expect(timingSafeEqualStr('abc123', 'abc123')).toBe(true);
    });

    test('returns false for different same-length strings', () => {
      expect(timingSafeEqualStr('abc123', 'abc124')).toBe(false);
    });

    test('returns false for different-length strings without throwing', () => {
      expect(() => timingSafeEqualStr('short', 'a-much-longer-string')).not.toThrow();
      expect(timingSafeEqualStr('short', 'a-much-longer-string')).toBe(false);
    });

    test('returns false comparing against an empty string', () => {
      expect(timingSafeEqualStr('nonempty', '')).toBe(false);
    });
  });
});
