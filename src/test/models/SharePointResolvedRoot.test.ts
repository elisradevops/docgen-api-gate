import { SharePointResolvedRoot } from '../../models/SharePointResolvedRoot';

describe('SharePointResolvedRoot schema', () => {
  const validFields = {
    homeAccountId: 'home-account-id-123',
    shareUrlHash: 'hash-of-sharing-url',
    driveId: 'drive-abc',
    itemId: 'item-def',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };

  test('validates with all required fields present', () => {
    const doc = new SharePointResolvedRoot(validFields);
    expect(doc.validateSync()).toBeUndefined();
  });

  test('validates without the optional name field', () => {
    const doc = new SharePointResolvedRoot(validFields);
    expect(doc.name).toBeUndefined();
    expect(doc.validateSync()).toBeUndefined();
  });

  test('accepts an optional name', () => {
    const doc = new SharePointResolvedRoot({ ...validFields, name: 'DocGen Templates' });
    expect(doc.validateSync()).toBeUndefined();
  });

  test('defaults resolvedAt to now when not supplied', () => {
    const doc = new SharePointResolvedRoot(validFields);
    expect(doc.resolvedAt).toBeInstanceOf(Date);
  });

  test.each(['homeAccountId', 'shareUrlHash', 'driveId', 'itemId', 'expiresAt'])(
    'fails validation when %s is missing',
    (field) => {
      const fields = { ...validFields } as any;
      delete fields[field];
      const doc = new SharePointResolvedRoot(fields);
      const error = doc.validateSync();
      expect(error).toBeDefined();
      expect(error?.errors[field]).toBeDefined();
    }
  );

  test('declares a compound unique index on {homeAccountId, shareUrlHash} — one resolved root per user per link', () => {
    const indexes = SharePointResolvedRoot.schema.indexes() as any[];
    const compound = indexes.find(
      (entry) =>
        Object.prototype.hasOwnProperty.call(entry[0], 'homeAccountId') && Object.prototype.hasOwnProperty.call(entry[0], 'shareUrlHash')
    );
    expect(compound).toBeDefined();
    expect(compound?.[1]).toMatchObject({ unique: true });
  });

  test('declares a TTL index on expiresAt', () => {
    const indexes = SharePointResolvedRoot.schema.indexes() as any[];
    const ttlIndex = indexes.find(
      (entry) => Object.prototype.hasOwnProperty.call(entry[0], 'expiresAt') && !Object.prototype.hasOwnProperty.call(entry[0], 'homeAccountId')
    );
    expect(ttlIndex?.[1]).toMatchObject({ expireAfterSeconds: 0 });
  });
});
