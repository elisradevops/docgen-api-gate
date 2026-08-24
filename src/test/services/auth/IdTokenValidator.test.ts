import { assertIdTokenClaims } from '../../../services/auth/IdTokenValidator';

describe('assertIdTokenClaims', () => {
  const expected = { nonce: 'expected-nonce', tenantId: 'expected-tenant', clientId: 'expected-client' };
  const validClaims = { nonce: 'expected-nonce', tid: 'expected-tenant', aud: 'expected-client' };

  test('does not throw when every claim matches', () => {
    expect(() => assertIdTokenClaims(validClaims, expected)).not.toThrow();
  });

  test('throws on a nonce mismatch', () => {
    expect(() => assertIdTokenClaims({ ...validClaims, nonce: 'wrong' }, expected)).toThrow(/nonce mismatch/i);
  });

  test('throws when nonce is missing', () => {
    expect(() => assertIdTokenClaims({ ...validClaims, nonce: undefined }, expected)).toThrow(/nonce mismatch/i);
  });

  test('throws on a tenant mismatch', () => {
    expect(() => assertIdTokenClaims({ ...validClaims, tid: 'wrong-tenant' }, expected)).toThrow(/tenant mismatch/i);
  });

  test('throws when tid is missing', () => {
    expect(() => assertIdTokenClaims({ ...validClaims, tid: undefined }, expected)).toThrow(/tenant mismatch/i);
  });

  test('throws on an audience mismatch', () => {
    expect(() => assertIdTokenClaims({ ...validClaims, aud: 'wrong-client' }, expected)).toThrow(/audience mismatch/i);
  });

  test('throws when aud is missing', () => {
    expect(() => assertIdTokenClaims({ ...validClaims, aud: undefined }, expected)).toThrow(/audience mismatch/i);
  });

  test('checks nonce before tenant before audience (fails on the first bad claim encountered)', () => {
    expect(() => assertIdTokenClaims({ nonce: 'wrong', tid: 'wrong-too', aud: 'wrong-also' }, expected)).toThrow(/nonce mismatch/i);
  });
});
