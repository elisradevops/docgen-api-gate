jest.mock('../../../models/AuthSession', () => ({
  __esModule: true,
  AuthSession: {
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findOneAndDelete: jest.fn(),
    findOne: jest.fn(),
  },
}));
jest.mock('../../../models/SessionHandleCode', () => ({
  __esModule: true,
  SessionHandleCode: {
    create: jest.fn(),
    findOneAndDelete: jest.fn(),
  },
}));
jest.mock('../../../models/MsalTokenCache', () => ({
  __esModule: true,
  MsalTokenCache: {
    deleteOne: jest.fn(),
  },
}));

import { AuthSession } from '../../../models/AuthSession';
import { SessionHandleCode } from '../../../models/SessionHandleCode';
import { MsalTokenCache } from '../../../models/MsalTokenCache';
import {
  createSession,
  resolveSession,
  revokeSession,
  verifyCsrf,
  issueHandleCode,
  consumeHandleCode,
} from '../../../services/auth/SessionService';
import { hashToken } from '../../../util/randomTokens';

const mockAuthSessionCreate = AuthSession.create as jest.Mock;
const mockAuthSessionFindOneAndUpdate = AuthSession.findOneAndUpdate as jest.Mock;
const mockAuthSessionFindOneAndDelete = AuthSession.findOneAndDelete as jest.Mock;
const mockAuthSessionFindOne = AuthSession.findOne as jest.Mock;
const mockHandleCodeCreate = SessionHandleCode.create as jest.Mock;
const mockHandleCodeFindOneAndDelete = SessionHandleCode.findOneAndDelete as jest.Mock;
const mockMsalCacheDeleteOne = MsalTokenCache.deleteOne as jest.Mock;

describe('SessionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CLIENT_ID = 'client';
    process.env.TENANT_ID = 'tenant';
    process.env.CLIENT_SECRET = 'secret';
    process.env.REDIRECT_URI = 'https://docgen.example.com/auth/callback';
    process.env.SESSION_SECRET = 'd'.repeat(32);
  });

  describe('createSession', () => {
    test('persists only the hash of the session token and csrf token, never the raw values', async () => {
      mockAuthSessionCreate.mockResolvedValueOnce({});

      const { sessionToken, csrfToken } = await createSession({ homeAccountId: 'home-1', transport: 'cookie' });

      const [[callArgs]] = mockAuthSessionCreate.mock.calls;
      expect(callArgs.sessionTokenHash).toBe(hashToken(sessionToken));
      expect(callArgs.csrfTokenHash).toBe(hashToken(csrfToken));
      expect(JSON.stringify(callArgs)).not.toContain(sessionToken);
      expect(JSON.stringify(callArgs)).not.toContain(csrfToken);
    });

    test('sets idle expiry to ~60 minutes and absolute expiry to ~8 hours from now', async () => {
      mockAuthSessionCreate.mockResolvedValueOnce({});
      const before = Date.now();

      await createSession({ homeAccountId: 'home-1', transport: 'cookie' });

      const [[callArgs]] = mockAuthSessionCreate.mock.calls;
      expect((callArgs.idleExpiresAt as Date).getTime() - before).toBeCloseTo(60 * 60 * 1000, -3);
      expect((callArgs.absoluteExpiresAt as Date).getTime() - before).toBeCloseTo(8 * 60 * 60 * 1000, -3);
    });

    test('carries through the optional ID-token-derived fields', async () => {
      mockAuthSessionCreate.mockResolvedValueOnce({});

      await createSession({
        homeAccountId: 'home-1',
        transport: 'bearer',
        displayName: 'Eden Zvi Schwartz',
        userPrincipalName: 'eden@korentec.onmicrosoft.com',
        tenantId: 'tenant-guid',
      });

      const [[callArgs]] = mockAuthSessionCreate.mock.calls;
      expect(callArgs).toMatchObject({
        displayName: 'Eden Zvi Schwartz',
        userPrincipalName: 'eden@korentec.onmicrosoft.com',
        tenantId: 'tenant-guid',
        transport: 'bearer',
      });
    });
  });

  describe('resolveSession', () => {
    test('returns null immediately for an empty token without querying the database', async () => {
      const result = await resolveSession('');
      expect(result).toBeNull();
      expect(mockAuthSessionFindOneAndUpdate).not.toHaveBeenCalled();
    });

    test('returns null when no live (unexpired) session matches', async () => {
      mockAuthSessionFindOneAndUpdate.mockResolvedValueOnce(null);
      const result = await resolveSession('some-raw-token');
      expect(result).toBeNull();
    });

    test('returns the session and slides idleExpiresAt forward on a hit', async () => {
      mockAuthSessionFindOneAndUpdate.mockResolvedValueOnce({
        _id: 'mongo-id-1',
        homeAccountId: 'home-1',
        transport: 'cookie',
        displayName: 'Eden',
        userPrincipalName: 'eden@korentec.onmicrosoft.com',
      });

      const result = await resolveSession('raw-token');

      expect(result).toEqual({
        sessionId: 'mongo-id-1',
        homeAccountId: 'home-1',
        transport: 'cookie',
        displayName: 'Eden',
        userPrincipalName: 'eden@korentec.onmicrosoft.com',
      });
      const [[query, update]] = mockAuthSessionFindOneAndUpdate.mock.calls;
      expect(query.sessionTokenHash).toBe(hashToken('raw-token'));
      expect(update.$set.idleExpiresAt).toBeInstanceOf(Date);
    });
  });

  describe('revokeSession', () => {
    test('deletes the session and its MSAL token cache row', async () => {
      mockAuthSessionFindOneAndDelete.mockResolvedValueOnce({ homeAccountId: 'home-1' });

      await revokeSession('raw-token');

      expect(mockAuthSessionFindOneAndDelete).toHaveBeenCalledWith({ sessionTokenHash: hashToken('raw-token') });
      expect(mockMsalCacheDeleteOne).toHaveBeenCalledWith({ homeAccountId: 'home-1' });
    });

    test('does nothing to the token cache when no session was found', async () => {
      mockAuthSessionFindOneAndDelete.mockResolvedValueOnce(null);

      await revokeSession('raw-token');

      expect(mockMsalCacheDeleteOne).not.toHaveBeenCalled();
    });
  });

  describe('verifyCsrf', () => {
    test('returns false when no session matches the raw session token', async () => {
      mockAuthSessionFindOne.mockResolvedValueOnce(null);
      expect(await verifyCsrf('raw-session-token', 'csrf-token')).toBe(false);
    });

    test('returns true when the csrf token hash matches', async () => {
      mockAuthSessionFindOne.mockResolvedValueOnce({ csrfTokenHash: hashToken('correct-csrf') });
      expect(await verifyCsrf('raw-session-token', 'correct-csrf')).toBe(true);
    });

    test('returns false when the csrf token hash does not match', async () => {
      mockAuthSessionFindOne.mockResolvedValueOnce({ csrfTokenHash: hashToken('correct-csrf') });
      expect(await verifyCsrf('raw-session-token', 'wrong-csrf')).toBe(false);
    });
  });

  describe('issueHandleCode / consumeHandleCode', () => {
    test('issueHandleCode encrypts the raw session token, never storing it in plaintext', async () => {
      mockHandleCodeCreate.mockResolvedValueOnce({});

      await issueHandleCode('the-raw-session-token');

      const [[callArgs]] = mockHandleCodeCreate.mock.calls;
      expect(callArgs.sessionTokenCiphertext).toBeDefined();
      expect(callArgs.sessionTokenCiphertext).not.toContain('the-raw-session-token');
      expect(callArgs.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 1000 + 100);
    });

    test('consumeHandleCode decrypts and returns the original raw session token', async () => {
      let capturedBlob: any;
      mockHandleCodeCreate.mockImplementationOnce((args: any) => {
        capturedBlob = args;
        return Promise.resolve({});
      });

      const code = await issueHandleCode('the-raw-session-token');

      mockHandleCodeFindOneAndDelete.mockResolvedValueOnce({
        sessionTokenCiphertext: capturedBlob.sessionTokenCiphertext,
        sessionTokenIv: capturedBlob.sessionTokenIv,
        sessionTokenAuthTag: capturedBlob.sessionTokenAuthTag,
        sessionTokenKeyVersion: capturedBlob.sessionTokenKeyVersion,
      });

      const result = await consumeHandleCode(code);

      expect(result).toEqual({ sessionToken: 'the-raw-session-token' });
      expect(mockHandleCodeFindOneAndDelete).toHaveBeenCalledWith({
        codeHash: hashToken(code),
        expiresAt: { $gt: expect.any(Date) },
      });
    });

    test('consumeHandleCode returns null when the code is unknown or already consumed', async () => {
      mockHandleCodeFindOneAndDelete.mockResolvedValueOnce(null);
      expect(await consumeHandleCode('unknown-code')).toBeNull();
    });
  });
});
