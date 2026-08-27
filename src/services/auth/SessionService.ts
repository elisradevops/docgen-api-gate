// Session lifecycle for both transports (cookie and bearer-handle), plus
// CSRF token issuance — see the models' own doc comments for why only
// hashes are ever persisted for the long-lived session/CSRF tokens.
import { AuthSession } from '../../models/AuthSession';
import { SessionHandleCode } from '../../models/SessionHandleCode';
import { MsalTokenCache } from '../../models/MsalTokenCache';
import { newOpaqueToken, hashToken, timingSafeEqualStr } from '../../util/randomTokens';
import { encryptCacheBlob, decryptCacheBlob } from '../../util/tokenCacheCipher';

const IDLE_TTL_MS = 60 * 60 * 1000; // 60 min rolling
const ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000; // 8h hard cap
const HANDLE_CODE_TTL_MS = 60 * 1000; // 60s, single-use

export type Transport = 'cookie' | 'bearer';

export interface CreateSessionInput {
  homeAccountId: string;
  transport: Transport;
  displayName?: string;
  userPrincipalName?: string;
  tenantId?: string;
}

export interface SessionTokens {
  sessionToken: string; // raw — caller sets this as the cookie value or bearer credential
  csrfToken: string; // raw — caller sets this as the CSRF cookie/response value
}

export async function createSession(input: CreateSessionInput): Promise<SessionTokens> {
  const sessionToken = newOpaqueToken();
  const csrfToken = newOpaqueToken();
  const now = new Date();

  await AuthSession.create({
    sessionTokenHash: hashToken(sessionToken),
    homeAccountId: input.homeAccountId,
    transport: input.transport,
    csrfTokenHash: hashToken(csrfToken),
    displayName: input.displayName,
    userPrincipalName: input.userPrincipalName,
    tenantId: input.tenantId,
    lastSeenAt: now,
    idleExpiresAt: new Date(now.getTime() + IDLE_TTL_MS),
    absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_TTL_MS),
  });

  return { sessionToken, csrfToken };
}

export interface ResolvedSession {
  sessionId: string;
  homeAccountId: string;
  transport: Transport;
  displayName?: string;
  userPrincipalName?: string;
}

// Resolves a raw session token to its session record, sliding the idle
// expiry forward on every successful resolution. Absolute expiry is never
// extended, regardless of activity.
export async function resolveSession(rawToken: string): Promise<ResolvedSession | null> {
  if (!rawToken) return null;
  const now = new Date();

  const doc = await AuthSession.findOneAndUpdate(
    {
      sessionTokenHash: hashToken(rawToken),
      idleExpiresAt: { $gt: now },
      absoluteExpiresAt: { $gt: now },
    },
    { $set: { lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + IDLE_TTL_MS) } },
    { new: true }
  );
  if (!doc) return null;

  return {
    sessionId: String(doc._id),
    homeAccountId: doc.homeAccountId,
    transport: doc.transport as Transport,
    displayName: doc.displayName,
    userPrincipalName: doc.userPrincipalName,
  };
}

// Full sign-out: destroys the session record AND the cached MSAL tokens
// for that user — deleting the cookie/handle alone is not logout, since a
// still-cached refresh token would let a new session be silently minted
// for the same account otherwise.
export async function revokeSession(rawToken: string): Promise<void> {
  const doc = await AuthSession.findOneAndDelete({ sessionTokenHash: hashToken(rawToken) });
  if (doc) {
    await MsalTokenCache.deleteOne({ homeAccountId: doc.homeAccountId });
  }
}

export async function verifyCsrf(rawSessionToken: string, csrfTokenFromRequest: string): Promise<boolean> {
  const doc = await AuthSession.findOne({ sessionTokenHash: hashToken(rawSessionToken) });
  if (!doc) return false;
  return timingSafeEqualStr(hashToken(csrfTokenFromRequest), doc.csrfTokenHash);
}

// Mints a one-time handle code carrying the raw session token, encrypted at
// rest for the ~60 seconds this row exists (see SessionHandleCode — the
// only place the raw token can safely cross the popup->iframe boundary).
export async function issueHandleCode(rawSessionToken: string): Promise<string> {
  const code = newOpaqueToken();
  const blob = encryptCacheBlob(rawSessionToken);
  await SessionHandleCode.create({
    codeHash: hashToken(code),
    sessionTokenCiphertext: blob.ciphertext,
    sessionTokenIv: blob.iv,
    sessionTokenAuthTag: blob.authTag,
    sessionTokenKeyVersion: blob.keyVersion,
    expiresAt: new Date(Date.now() + HANDLE_CODE_TTL_MS),
  });
  return code;
}

// Single-use by construction (findOneAndDelete) — a replayed handle code
// finds nothing, exactly like OAuthTransaction's state consumption.
export async function consumeHandleCode(code: string): Promise<{ sessionToken: string } | null> {
  const doc = await SessionHandleCode.findOneAndDelete({
    codeHash: hashToken(code),
    expiresAt: { $gt: new Date() },
  });
  if (!doc) return null;

  const sessionToken = decryptCacheBlob({
    ciphertext: doc.sessionTokenCiphertext,
    iv: doc.sessionTokenIv,
    authTag: doc.sessionTokenAuthTag,
    keyVersion: doc.sessionTokenKeyVersion,
  });
  return { sessionToken };
}
