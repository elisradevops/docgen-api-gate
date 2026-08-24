// CSPRNG token minting + comparison helpers shared by every OAuth
// transaction/session record: `state`, `nonce`, opaque session tokens,
// handle codes, and CSRF tokens all go through here rather than each
// caller rolling its own crypto.
import { randomBytes, createHash, timingSafeEqual } from 'crypto';

// 32 bytes -> 43 base64url chars, well within RFC 7636's 43-128 range for a
// PKCE code_verifier and plenty of entropy for anything else minted here.
export function newOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

// Only the hash is ever persisted for session/handle tokens (see
// AuthSession/SessionHandleCode models) — a database dump yields no usable
// credential.
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// Constant-time string compare. A length mismatch still runs a same-length
// dummy comparison so it can't short-circuit into a faster return than a
// same-length mismatch would — both paths take one full timingSafeEqual call.
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
