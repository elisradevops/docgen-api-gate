import { SessionHandleCode } from '../../models/SessionHandleCode';

describe('SessionHandleCode schema', () => {
  const validFields = {
    codeHash: 'hash-of-one-time-code',
    sessionTokenCiphertext: 'base64-ciphertext',
    sessionTokenIv: 'base64-iv',
    sessionTokenAuthTag: 'base64-authtag',
    expiresAt: new Date(Date.now() + 60 * 1000),
  };

  test('validates with all required fields present', () => {
    const doc = new SessionHandleCode(validFields);
    expect(doc.validateSync()).toBeUndefined();
  });

  test('defaults sessionTokenKeyVersion to 1 when not supplied', () => {
    const doc = new SessionHandleCode(validFields);
    expect(doc.sessionTokenKeyVersion).toBe(1);
  });

  test.each(['codeHash', 'sessionTokenCiphertext', 'sessionTokenIv', 'sessionTokenAuthTag', 'expiresAt'])(
    'fails validation when %s is missing',
    (field) => {
      const fields = { ...validFields } as any;
      delete fields[field];
      const doc = new SessionHandleCode(fields);
      const error = doc.validateSync();
      expect(error).toBeDefined();
      expect(error?.errors[field]).toBeDefined();
    }
  );

  test('declares a unique index on codeHash', () => {
    const pathIsUnique = (SessionHandleCode.schema.path('codeHash') as any)?.options?.unique;
    expect(pathIsUnique).toBe(true);
  });

  test('declares a TTL index on expiresAt', () => {
    const indexes = SessionHandleCode.schema.indexes() as any[];
    const ttlIndex = indexes.find((entry) => Object.prototype.hasOwnProperty.call(entry[0], 'expiresAt'));
    expect(ttlIndex?.[1]).toMatchObject({ expireAfterSeconds: 0 });
  });
});
