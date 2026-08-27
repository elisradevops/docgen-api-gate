// Reads and validates the SharePoint-Online OAuth (BFF) environment once,
// then freezes the result. Two entry points exist deliberately:
//
//  - getAuthConfig() / getAllowedOrigins(): lenient-on-import, throw only
//    when actually called. app.ts calls getAllowedOrigins() during CORS
//    setup, which existing tests construct with no env at all (see
//    JsonDocRoutes.test.ts) — those calls must not explode at module load.
//  - assertAuthConfig(): the loud, fail-fast boot check. server.ts calls
//    this before connectToDatabase() so a misconfigured deployment (missing
//    CLIENT_SECRET, an http:// REDIRECT_URI, etc.) refuses to start instead
//    of silently limping along with a broken auth flow.
export interface AuthConfig {
  clientId: string;
  tenantId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
}

let cachedConfig: AuthConfig | null = null;

function readRequired(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

// Entra rejects non-https redirect URIs except for the documented
// http://localhost exception (any port) — used for local/dev simulation
// against docker-compose. See the plan's "Environment variables" section.
function assertRedirectUriIsSecureOrLocalhost(redirectUri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error(`REDIRECT_URI is not a valid URL: ${redirectUri}`);
  }
  const isHttps = parsed.protocol === 'https:';
  const isLocalhost = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (!isHttps && !isLocalhost) {
    throw new Error(`REDIRECT_URI must be https:// (or http://localhost for local development): ${redirectUri}`);
  }
}

export function getAuthConfig(): AuthConfig {
  if (cachedConfig) return cachedConfig;

  const clientId = readRequired('CLIENT_ID');
  const tenantId = readRequired('TENANT_ID');
  const clientSecret = readRequired('CLIENT_SECRET');
  const redirectUri = readRequired('REDIRECT_URI');
  const sessionSecret = readRequired('SESSION_SECRET');

  assertRedirectUriIsSecureOrLocalhost(redirectUri);
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters — used to derive the token-cache encryption key');
  }

  cachedConfig = { clientId, tenantId, clientSecret, redirectUri, sessionSecret };
  return cachedConfig;
}

// Unset/empty CORS_ALLOWED_ORIGINS means "no cross-origin request is
// trusted" — a deliberate change from this codebase's previous behavior,
// where an unset value meant "allow every origin". That old default is not
// safe once cors() is also configured with credentials:true (see app.ts) —
// allow-all plus credentials is a session-theft hole, not a convenience.
//
// '*' is rejected outright rather than silently treated as allow-all: the
// cors package itself refuses to combine a literal '*' origin with
// credentials, so accepting it here would just move the failure somewhere
// more confusing.
export function getAllowedOrigins(): string[] {
  const origins = String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.includes('*')) {
    throw new Error("CORS_ALLOWED_ORIGINS must not include '*' — credentialed requests require an explicit origin allowlist");
  }
  return origins;
}

export function assertAuthConfig(): void {
  getAuthConfig();
  getAllowedOrigins();
}

// Test-only: getAuthConfig() memoizes on first call, which would otherwise
// leak one test's env vars into the next.
export function resetAuthConfigCacheForTests(): void {
  cachedConfig = null;
}
