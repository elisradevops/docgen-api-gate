// Implements MSAL Node's distributed-cache extension points against the
// existing Mongoose connection. `MongoCacheClient` is the get/set half
// (ICacheClient); `HomeAccountPartitionManager` tells
// DistributedCachePlugin which partition to read/write (IPartitionManager).
// beforeCacheAccess calls getKey() to decide what to load; afterCacheAccess
// calls extractKey() on the newly-written account to decide what to save —
// how a fresh redemption (homeAccountId not yet known) still lands in the
// right partition once MSAL discovers it.
import { ICacheClient, IPartitionManager, DistributedCachePlugin } from '@azure/msal-node';
import { MsalTokenCache } from '../../models/MsalTokenCache';
import { encryptCacheBlob, decryptCacheBlob } from '../../util/tokenCacheCipher';
import logger from '../../util/logger';

// ~90 days, matching Entra's typical refresh-token inactivity window — a
// cache row that hasn't been written to in that long is for a user who
// hasn't used the app in 90 days, at which point re-auth is expected.
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// Structural subset of MSAL's internal AccountEntity — only the field this
// plugin actually reads. Avoids a compile-time dependency on
// @azure/msal-common's internal (not part of docgen-api-gate's own
// package.json) module layout for a single field read.
interface AccountEntityLike {
  homeAccountId: string;
}

export class MongoCacheClient implements ICacheClient {
  async get(key: string): Promise<string> {
    if (!key) return '';
    const doc = await MsalTokenCache.findOne({ homeAccountId: key });
    if (!doc) return '';
    try {
      return decryptCacheBlob({
        ciphertext: doc.ciphertext,
        iv: doc.iv,
        authTag: doc.authTag,
        keyVersion: doc.keyVersion,
      });
    } catch (error) {
      // Corrupted blob or rotated-out key fails closed as a cache miss, not
      // a 500 — worst case is a forced re-sign-in, never a security hole.
      logger.error(`Failed to decrypt MSAL token cache for a session partition: ${error.message}`);
      return '';
    }
  }

  async set(key: string, value: string): Promise<string> {
    if (!key) return value;
    const blob = encryptCacheBlob(value);
    await MsalTokenCache.findOneAndUpdate(
      { homeAccountId: key },
      {
        $set: {
          ciphertext: blob.ciphertext,
          iv: blob.iv,
          authTag: blob.authTag,
          keyVersion: blob.keyVersion,
          expiresAt: new Date(Date.now() + CACHE_TTL_MS),
        },
      },
      { upsert: true }
    );
    return value;
  }
}

export class HomeAccountPartitionManager implements IPartitionManager {
  // `knownHomeAccountId` is undefined during a fresh code redemption, before
  // MSAL creates the account entity — getKey() returning '' is correct
  // there, since nothing exists yet to load.
  constructor(private readonly knownHomeAccountId?: string) {}

  async getKey(): Promise<string> {
    return this.knownHomeAccountId ?? '';
  }

  async extractKey(accountEntity: AccountEntityLike): Promise<string> {
    return accountEntity.homeAccountId;
  }
}

export function createPartitionedCachePlugin(homeAccountId?: string): {
  cachePlugin: DistributedCachePlugin;
  partitionManager: HomeAccountPartitionManager;
} {
  const partitionManager = new HomeAccountPartitionManager(homeAccountId);
  const cachePlugin = new DistributedCachePlugin(new MongoCacheClient(), partitionManager);
  return { cachePlugin, partitionManager };
}
