// The only module that constructs a ConfidentialClientApplication. A fresh
// CCA is built per operation (cheap — this is MSAL Node's own documented
// distributed-cache pattern), scoped to a cache-plugin partition that
// either targets a known homeAccountId (silent refresh) or none yet (a
// fresh code redemption, before the resulting account is known).
import { createHash } from 'crypto';
import {
  ConfidentialClientApplication,
  AuthenticationResult,
  InteractionRequiredAuthError,
} from '@azure/msal-node';
import { getAuthConfig } from '../../util/authConfig';
import { createPartitionedCachePlugin } from './MongoTokenCachePlugin';

// openid/profile/offline_access are the standard OIDC scopes (ID token +
// refresh token issuance); Files.Read.All is the only Graph permission this
// app requests. Deliberately no User.Read — the ID token's own claims
// already supply displayName/UPN.
const AUTH_CODE_SCOPES = ['openid', 'profile', 'offline_access', 'https://graph.microsoft.com/Files.Read.All'];
// Silent (cache-refresh) requests only ever re-request the resource scope
// — openid/profile/offline_access aren't valid to pass to acquireTokenSilent,
// they're implicit in the cached refresh token.
const SILENT_SCOPES = ['https://graph.microsoft.com/Files.Read.All'];

export type GraphTokenProvider = () => Promise<string>;

export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

function buildConfidentialClientApplication(homeAccountId?: string): ConfidentialClientApplication {
  const { clientId, tenantId, clientSecret } = getAuthConfig();
  const { cachePlugin } = createPartitionedCachePlugin(homeAccountId);
  return new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret,
    },
    cache: { cachePlugin },
  });
}

function computeCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

export interface BuildAuthCodeUrlInput {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export async function buildAuthCodeUrl(input: BuildAuthCodeUrlInput): Promise<string> {
  const { redirectUri } = getAuthConfig();
  const cca = buildConfidentialClientApplication();
  return cca.getAuthCodeUrl({
    scopes: AUTH_CODE_SCOPES,
    redirectUri,
    state: input.state,
    nonce: input.nonce,
    codeChallenge: computeCodeChallenge(input.codeVerifier),
    codeChallengeMethod: 'S256',
  });
}

export interface RedeemAuthCodeInput {
  code: string;
  codeVerifier: string;
  state?: string;
}

export async function redeemAuthCode(input: RedeemAuthCodeInput): Promise<AuthenticationResult> {
  const { redirectUri } = getAuthConfig();
  // No known homeAccountId yet — this is exactly the scenario
  // HomeAccountPartitionManager's getKey()/extractKey() split exists for.
  const cca = buildConfidentialClientApplication();
  return cca.acquireTokenByCode({
    scopes: AUTH_CODE_SCOPES,
    redirectUri,
    code: input.code,
    codeVerifier: input.codeVerifier,
    state: input.state,
  });
}

// Returns a closure that calls acquireTokenSilent on EVERY invocation, so a
// caller looping over many downloads always has a fresh token even if the
// loop outlives a 60-90 minute access token. MSAL caches the underlying
// network call itself while the token is still valid, so this is cheap.
export function createTokenProvider(homeAccountId: string): GraphTokenProvider {
  return async () => {
    const cca = buildConfidentialClientApplication(homeAccountId);
    const account = await cca.getTokenCache().getAccountByHomeId(homeAccountId);
    if (!account) {
      throw new ReauthRequiredError('No cached Microsoft sign-in found for this session');
    }
    try {
      const result = await cca.acquireTokenSilent({ account, scopes: SILENT_SCOPES });
      return result.accessToken;
    } catch (error: any) {
      if (error instanceof InteractionRequiredAuthError) {
        throw new ReauthRequiredError(error.message);
      }
      throw error;
    }
  };
}
