import { MsalTokenCache } from '../../models/MsalTokenCache';

describe('MsalTokenCache schema', () => {
  const validFields = {
    homeAccountId: 'home-account-id-123',
    ciphertext: 'base64-ciphertext',
    iv: 'base64-iv',
    authTag: 'base64-authtag',
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  };

  test('validates with all required fields present', () => {
    const doc = new MsalTokenCache(validFields);
    expect(doc.validateSync()).toBeUndefined();
  });

  test('defaults keyVersion to 1 when not supplied', () => {
    const doc = new MsalTokenCache(validFields);
    expect(doc.keyVersion).toBe(1);
  });

  test('accepts an explicit keyVersion for rotation', () => {
    const doc = new MsalTokenCache({ ...validFields, keyVersion: 2 });
    expect(doc.keyVersion).toBe(2);
    expect(doc.validateSync()).toBeUndefined();
  });

  test.each(['homeAccountId', 'ciphertext', 'iv', 'authTag', 'expiresAt'])(
    'fails validation when %s is missing',
    (field) => {
      const fields = { ...validFields } as any;
      delete fields[field];
      const doc = new MsalTokenCache(fields);
      const error = doc.validateSync();
      expect(error).toBeDefined();
      expect(error?.errors[field]).toBeDefined();
    }
  );

  test('declares a unique index on homeAccountId (one cache row per user)', () => {
    const pathIsUnique = (MsalTokenCache.schema.path('homeAccountId') as any)?.options?.unique;
    expect(pathIsUnique).toBe(true);
  });

  test('declares a TTL index on expiresAt', () => {
    const indexes = MsalTokenCache.schema.indexes() as any[];
    const ttlIndex = indexes.find((entry) => Object.prototype.hasOwnProperty.call(entry[0], 'expiresAt'));
    expect(ttlIndex?.[1]).toMatchObject({ expireAfterSeconds: 0 });
  });
});
