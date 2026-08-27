import { encryptCacheBlob, decryptCacheBlob, CURRENT_KEY_VERSION } from '../../util/tokenCacheCipher';
import { resetAuthConfigCacheForTests } from '../../util/authConfig';

const VALID_SESSION_SECRET = 'b'.repeat(32);

describe('tokenCacheCipher', () => {
  beforeEach(() => {
    resetAuthConfigCacheForTests();
    process.env.CLIENT_ID = 'client';
    process.env.TENANT_ID = 'tenant';
    process.env.CLIENT_SECRET = 'secret';
    process.env.REDIRECT_URI = 'https://docgen.example.com/auth/callback';
    process.env.SESSION_SECRET = VALID_SESSION_SECRET;
  });

  test('round-trips plaintext through encrypt then decrypt', () => {
    const plaintext = JSON.stringify({ hello: 'world', tokens: ['a', 'b'] });
    const blob = encryptCacheBlob(plaintext);
    expect(decryptCacheBlob(blob)).toBe(plaintext);
  });

  test('encrypted blob does not contain the plaintext', () => {
    const plaintext = 'a-very-recognizable-secret-marker';
    const blob = encryptCacheBlob(plaintext);
    expect(blob.ciphertext).not.toContain(plaintext);
  });

  test('records the key version used', () => {
    const blob = encryptCacheBlob('anything');
    expect(blob.keyVersion).toBe(CURRENT_KEY_VERSION);
  });

  test('produces a different ciphertext each time (random IV)', () => {
    const a = encryptCacheBlob('same plaintext');
    const b = encryptCacheBlob('same plaintext');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  test('throws when the authTag has been tampered with', () => {
    const blob = encryptCacheBlob('sensitive data');
    const tampered = { ...blob, authTag: Buffer.from('0'.repeat(32), 'hex').toString('base64') };
    expect(() => decryptCacheBlob(tampered)).toThrow();
  });

  test('throws when the ciphertext has been tampered with', () => {
    const blob = encryptCacheBlob('sensitive data');
    const tamperedBytes = Buffer.from(blob.ciphertext, 'base64');
    tamperedBytes[0] = tamperedBytes[0] ^ 0xff;
    const tampered = { ...blob, ciphertext: tamperedBytes.toString('base64') };
    expect(() => decryptCacheBlob(tampered)).toThrow();
  });

  test('throws when decrypted under a different SESSION_SECRET (simulated via wrong keyVersion input path)', () => {
    const blob = encryptCacheBlob('secret payload');
    // Same keyVersion number but a different underlying secret should fail
    // to decrypt — simulate by changing the secret after encrypting.
    resetAuthConfigCacheForTests();
    process.env.SESSION_SECRET = 'c'.repeat(32);
    expect(() => decryptCacheBlob(blob)).toThrow();
  });
});
