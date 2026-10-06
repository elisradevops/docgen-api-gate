// Which kind of credential a generation request carries, from the token's own shape. The token itself is
// never stored or logged. A pipeline's System.AccessToken is a bearer (JWT-style) token; a person's
// personal access token is not. Same shape test the data provider applies before choosing how to
// authenticate (docgen-data-provider TFSServices / TestDataProvider.isBearerToken).
export type CredentialKind = 'bearer' | 'pat';

export function credentialKind(token: string | undefined): CredentialKind | undefined {
  const raw = String(token || '').trim();
  if (!raw) return undefined;
  if (/^bearer[:\s]/i.test(raw)) return 'bearer';
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw) ? 'bearer' : 'pat';
}
