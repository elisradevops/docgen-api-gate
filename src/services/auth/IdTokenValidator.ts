// MSAL already validates signature, issuer, and expiry. This adds the two
// checks specific to this app's own transaction/config: nonce must match
// what this app generated for this sign-in attempt (anti-replay), and the
// tenant must match the single tenant this app is registered against.
export interface IdTokenClaimsSubset {
  nonce?: string;
  tid?: string;
  aud?: string;
}

export interface ExpectedIdTokenClaims {
  nonce: string;
  tenantId: string;
  clientId: string;
}

export function assertIdTokenClaims(claims: IdTokenClaimsSubset, expected: ExpectedIdTokenClaims): void {
  if (!claims.nonce || claims.nonce !== expected.nonce) {
    throw new Error('ID token nonce mismatch');
  }
  if (!claims.tid || claims.tid !== expected.tenantId) {
    throw new Error('ID token tenant mismatch');
  }
  if (!claims.aud || claims.aud !== expected.clientId) {
    throw new Error('ID token audience mismatch');
  }
}
