// AES-256-GCM encrypt/decrypt for the serialized MSAL token-cache blob
// persisted in MsalTokenCache. The key is never stored — it's derived via
// HKDF from SESSION_SECRET on every call, salted by `keyVersion` so a
// future secret/key rotation can mint a new key without orphaning rows
// encrypted under an older version (old rows simply keep their recorded
// keyVersion and still decrypt correctly).
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'crypto';
import { getAuthConfig } from './authConfig';

export const CURRENT_KEY_VERSION = 1;
const IV_LENGTH_BYTES = 12; // AES-GCM standard/recommended IV size
const KEY_LENGTH_BYTES = 32; // AES-256

function deriveKey(keyVersion: number): Buffer {
  const { sessionSecret } = getAuthConfig();
  const derived = hkdfSync(
    'sha256',
    Buffer.from(sessionSecret, 'utf8'),
    Buffer.from(`docgen-token-cache-v${keyVersion}`, 'utf8'), // salt
    Buffer.from('docgen-sharepoint-oauth-cache', 'utf8'), // info
    KEY_LENGTH_BYTES
  );
  return Buffer.from(derived);
}

export interface EncryptedBlob {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  keyVersion: number;
}

export function encryptCacheBlob(plaintext: string, keyVersion: number = CURRENT_KEY_VERSION): EncryptedBlob {
  const key = deriveKey(keyVersion);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion,
  };
}

// Throws (does not silently return garbage) if `authTag` doesn't match —
// GCM's whole point is that a tampered ciphertext or a wrong key fails
// decryption outright rather than yielding corrupted plaintext.
export function decryptCacheBlob(blob: EncryptedBlob): string {
  const key = deriveKey(blob.keyVersion);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}
