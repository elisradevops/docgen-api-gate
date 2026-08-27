jest.mock('../../../models/MsalTokenCache', () => ({
  __esModule: true,
  MsalTokenCache: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
}));
jest.mock('../../../util/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import { MsalTokenCache } from '../../../models/MsalTokenCache';
import logger from '../../../util/logger';
import { MongoCacheClient, HomeAccountPartitionManager } from '../../../services/auth/MongoTokenCachePlugin';
import { resetAuthConfigCacheForTests } from '../../../util/authConfig';
import { encryptCacheBlob } from '../../../util/tokenCacheCipher';

const mockFindOne = MsalTokenCache.findOne as jest.Mock;
const mockFindOneAndUpdate = MsalTokenCache.findOneAndUpdate as jest.Mock;

describe('MongoCacheClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAuthConfigCacheForTests();
    process.env.CLIENT_ID = 'client';
    process.env.TENANT_ID = 'tenant';
    process.env.CLIENT_SECRET = 'secret';
    process.env.REDIRECT_URI = 'https://docgen.example.com/auth/callback';
    process.env.SESSION_SECRET = 'e'.repeat(32);
  });

  describe('get', () => {
    test('returns an empty string for an empty key without querying the database (fresh-code-redemption case)', async () => {
      const client = new MongoCacheClient();
      const result = await client.get('');
      expect(result).toBe('');
      expect(mockFindOne).not.toHaveBeenCalled();
    });

    test('returns an empty string when no cache row exists for the partition', async () => {
      mockFindOne.mockResolvedValueOnce(null);
      const client = new MongoCacheClient();
      expect(await client.get('home-1')).toBe('');
    });

    test('decrypts and returns the cached blob for a known partition', async () => {
      const blob = encryptCacheBlob('{"Account":{}}');
      mockFindOne.mockResolvedValueOnce({
        ciphertext: blob.ciphertext,
        iv: blob.iv,
        authTag: blob.authTag,
        keyVersion: blob.keyVersion,
      });

      const client = new MongoCacheClient();
      const result = await client.get('home-1');

      expect(result).toBe('{"Account":{}}');
      expect(mockFindOne).toHaveBeenCalledWith({ homeAccountId: 'home-1' });
    });

    test('treats a corrupted/tampered blob as a cache miss (fails closed, not a thrown error)', async () => {
      mockFindOne.mockResolvedValueOnce({
        ciphertext: 'not-valid-base64-ciphertext!!',
        iv: 'AAAAAAAAAAAAAAAA',
        authTag: 'AAAAAAAAAAAAAAAAAAAAAA==',
        keyVersion: 1,
      });

      const client = new MongoCacheClient();
      const result = await client.get('home-1');

      expect(result).toBe('');
      expect((logger.error as jest.Mock)).toHaveBeenCalled();
    });
  });

  describe('set', () => {
    test('returns the input value without writing when the key is empty', async () => {
      const client = new MongoCacheClient();
      const result = await client.set('', 'some-cache-blob');
      expect(result).toBe('some-cache-blob');
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });

    test('upserts an encrypted blob under the given partition key', async () => {
      mockFindOneAndUpdate.mockResolvedValueOnce({});
      const client = new MongoCacheClient();

      await client.set('home-1', '{"Account":{}}');

      const [[query, update, options]] = mockFindOneAndUpdate.mock.calls;
      expect(query).toEqual({ homeAccountId: 'home-1' });
      expect(options).toEqual({ upsert: true });
      expect(update.$set.ciphertext).toBeDefined();
      expect(update.$set.ciphertext).not.toContain('Account');
      expect(update.$set.expiresAt).toBeInstanceOf(Date);
    });
  });
});

describe('HomeAccountPartitionManager', () => {
  test('getKey returns the known homeAccountId when constructed with one', async () => {
    const manager = new HomeAccountPartitionManager('home-1');
    expect(await manager.getKey()).toBe('home-1');
  });

  test('getKey returns an empty string when no homeAccountId is known yet (fresh code redemption)', async () => {
    const manager = new HomeAccountPartitionManager();
    expect(await manager.getKey()).toBe('');
  });

  test('extractKey returns the homeAccountId from the account entity, regardless of the known key', async () => {
    const manager = new HomeAccountPartitionManager();
    expect(await manager.extractKey({ homeAccountId: 'discovered-home-id' })).toBe('discovered-home-id');
  });
});
