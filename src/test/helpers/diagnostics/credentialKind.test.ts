import { credentialKind } from '../../../helpers/credentialKind';

describe('credentialKind', () => {
  test('a JWT-shaped token (a pipeline System.AccessToken) is bearer', () => {
    expect(credentialKind('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl')).toBe('bearer');
  });

  test('an explicit Bearer prefix is bearer', () => {
    expect(credentialKind('Bearer:abc')).toBe('bearer');
    expect(credentialKind('bearer abc')).toBe('bearer');
  });

  test('a personal access token is pat', () => {
    expect(credentialKind('a'.repeat(52))).toBe('pat');
    expect(credentialKind('abcdefghij1234567890abcdefghij1234567890abcdefghijkl')).toBe('pat');
  });

  test('nothing to classify gives undefined, and the token is never part of the result', () => {
    expect(credentialKind(undefined)).toBeUndefined();
    expect(credentialKind('   ')).toBeUndefined();
    expect(JSON.stringify(credentialKind('secret-value-123'))).not.toContain('secret');
  });
});
