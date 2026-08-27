const mockGetAuthCodeUrl = jest.fn();
const mockAcquireTokenByCode = jest.fn();
const mockAcquireTokenSilent = jest.fn();
const mockGetAccountByHomeId = jest.fn();
const mockCcaConstructor = jest.fn();

class FakeInteractionRequiredAuthError extends Error {}

jest.mock('@azure/msal-node', () => ({
  __esModule: true,
  ConfidentialClientApplication: jest.fn().mockImplementation((config: any) => {
    mockCcaConstructor(config);
    return {
      getAuthCodeUrl: mockGetAuthCodeUrl,
      acquireTokenByCode: mockAcquireTokenByCode,
      acquireTokenSilent: mockAcquireTokenSilent,
      getTokenCache: () => ({ getAccountByHomeId: mockGetAccountByHomeId }),
    };
  }),
  InteractionRequiredAuthError: FakeInteractionRequiredAuthError,
}));

jest.mock('../../../services/auth/MongoTokenCachePlugin', () => ({
  __esModule: true,
  createPartitionedCachePlugin: jest.fn().mockReturnValue({ cachePlugin: {}, partitionManager: {} }),
}));

import { buildAuthCodeUrl, redeemAuthCode, createTokenProvider, ReauthRequiredError } from '../../../services/auth/MsalClientService';
import { resetAuthConfigCacheForTests } from '../../../util/authConfig';
import { createPartitionedCachePlugin } from '../../../services/auth/MongoTokenCachePlugin';

describe('MsalClientService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAuthConfigCacheForTests();
    process.env.CLIENT_ID = 'the-client-id';
    process.env.TENANT_ID = 'the-tenant-id';
    process.env.CLIENT_SECRET = 'the-client-secret';
    process.env.REDIRECT_URI = 'https://docgen.example.com/auth/callback';
    process.env.SESSION_SECRET = 'f'.repeat(32);
  });

  describe('buildAuthCodeUrl', () => {
    test('requests the exact scope set: openid, profile, offline_access, Files.Read.All — no User.Read, no write scopes', async () => {
      mockGetAuthCodeUrl.mockResolvedValueOnce('https://login.microsoftonline.com/authorize?...');

      await buildAuthCodeUrl({ state: 'state-1', nonce: 'nonce-1', codeVerifier: 'verifier-1' });

      const [[request]] = mockGetAuthCodeUrl.mock.calls;
      expect(request.scopes).toEqual([
        'openid',
        'profile',
        'offline_access',
        'https://graph.microsoft.com/Files.Read.All',
      ]);
      expect(request.scopes).not.toContain('https://graph.microsoft.com/User.Read');
      expect(request.scopes.some((s: string) => /ReadWrite/.test(s))).toBe(false);
    });

    test('computes an S256 code challenge from the verifier and never sends the verifier itself', async () => {
      mockGetAuthCodeUrl.mockResolvedValueOnce('https://login.microsoftonline.com/authorize?...');

      await buildAuthCodeUrl({ state: 'state-1', nonce: 'nonce-1', codeVerifier: 'my-secret-verifier' });

      const [[request]] = mockGetAuthCodeUrl.mock.calls;
      expect(request.codeChallengeMethod).toBe('S256');
      expect(request.codeChallenge).toBeDefined();
      expect(request.codeChallenge).not.toBe('my-secret-verifier');
    });

    test('passes state, nonce, and the configured redirectUri through', async () => {
      mockGetAuthCodeUrl.mockResolvedValueOnce('https://login.microsoftonline.com/authorize?...');

      await buildAuthCodeUrl({ state: 'state-1', nonce: 'nonce-1', codeVerifier: 'verifier-1' });

      const [[request]] = mockGetAuthCodeUrl.mock.calls;
      expect(request.state).toBe('state-1');
      expect(request.nonce).toBe('nonce-1');
      expect(request.redirectUri).toBe('https://docgen.example.com/auth/callback');
    });

    test('builds the CCA with no known homeAccountId (nothing to load for a not-yet-authenticated user)', async () => {
      mockGetAuthCodeUrl.mockResolvedValueOnce('https://login.microsoftonline.com/authorize?...');

      await buildAuthCodeUrl({ state: 's', nonce: 'n', codeVerifier: 'v' });

      expect(createPartitionedCachePlugin).toHaveBeenCalledWith(undefined);
    });
  });

  describe('redeemAuthCode', () => {
    test('exchanges the code with the same scope set and the provided codeVerifier', async () => {
      mockAcquireTokenByCode.mockResolvedValueOnce({ account: { homeAccountId: 'home-1' } });

      await redeemAuthCode({ code: 'auth-code-1', codeVerifier: 'verifier-1', state: 'state-1' });

      const [[request]] = mockAcquireTokenByCode.mock.calls;
      expect(request.code).toBe('auth-code-1');
      expect(request.codeVerifier).toBe('verifier-1');
      expect(request.state).toBe('state-1');
      expect(request.scopes).toEqual([
        'openid',
        'profile',
        'offline_access',
        'https://graph.microsoft.com/Files.Read.All',
      ]);
    });

    test('returns the full AuthenticationResult from MSAL', async () => {
      const fakeResult = { account: { homeAccountId: 'home-1' }, accessToken: 'abc' };
      mockAcquireTokenByCode.mockResolvedValueOnce(fakeResult);

      const result = await redeemAuthCode({ code: 'c', codeVerifier: 'v' });

      expect(result).toBe(fakeResult);
    });
  });

  describe('createTokenProvider', () => {
    test('builds the CCA scoped to the given homeAccountId', async () => {
      mockGetAccountByHomeId.mockResolvedValueOnce({ homeAccountId: 'home-1' });
      mockAcquireTokenSilent.mockResolvedValueOnce({ accessToken: 'graph-token-1' });

      const provider = createTokenProvider('home-1');
      await provider();

      expect(createPartitionedCachePlugin).toHaveBeenCalledWith('home-1');
    });

    test('throws ReauthRequiredError when no cached account exists for the homeAccountId', async () => {
      mockGetAccountByHomeId.mockResolvedValueOnce(null);

      const provider = createTokenProvider('home-1');

      await expect(provider()).rejects.toThrow(ReauthRequiredError);
    });

    test('returns the fresh access token on a successful silent refresh, only requesting the Graph resource scope', async () => {
      mockGetAccountByHomeId.mockResolvedValueOnce({ homeAccountId: 'home-1' });
      mockAcquireTokenSilent.mockResolvedValueOnce({ accessToken: 'graph-token-1' });

      const provider = createTokenProvider('home-1');
      const token = await provider();

      expect(token).toBe('graph-token-1');
      const [[request]] = mockAcquireTokenSilent.mock.calls;
      expect(request.scopes).toEqual(['https://graph.microsoft.com/Files.Read.All']);
    });

    test('maps InteractionRequiredAuthError to ReauthRequiredError', async () => {
      mockGetAccountByHomeId.mockResolvedValueOnce({ homeAccountId: 'home-1' });
      mockAcquireTokenSilent.mockRejectedValueOnce(new FakeInteractionRequiredAuthError('consent expired'));

      const provider = createTokenProvider('home-1');

      await expect(provider()).rejects.toThrow(ReauthRequiredError);
    });

    test('propagates an unrelated error unchanged', async () => {
      mockGetAccountByHomeId.mockResolvedValueOnce({ homeAccountId: 'home-1' });
      mockAcquireTokenSilent.mockRejectedValueOnce(new Error('network down'));

      const provider = createTokenProvider('home-1');

      await expect(provider()).rejects.toThrow('network down');
    });

    // Regression test for the bug this design specifically fixes:
    // syncTemplates used to capture ONE token/credentials object and reuse
    // it across a whole download loop that could outlive a 60-90 minute
    // access token. createTokenProvider's whole purpose is that EVERY
    // invocation re-acquires (MSAL itself decides whether that's a cache
    // hit or a real network refresh) — assert it is actually called once
    // per invocation, not cached by this layer.
    test('calls acquireTokenSilent once per invocation, not once total across multiple calls', async () => {
      mockGetAccountByHomeId.mockResolvedValue({ homeAccountId: 'home-1' });
      mockAcquireTokenSilent.mockResolvedValue({ accessToken: 'graph-token-1' });

      const provider = createTokenProvider('home-1');
      await provider();
      await provider();
      await provider();

      expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(3);
    });
  });
});
