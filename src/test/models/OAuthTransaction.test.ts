import { OAuthTransaction } from '../../models/OAuthTransaction';

describe('OAuthTransaction schema', () => {
  const validFields = {
    state: 'state-123',
    codeVerifier: 'verifier-456',
    nonce: 'nonce-789',
    openerOrigin: 'https://docgen.example.com',
    transport: 'cookie',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  };

  test('validates with all required fields present', () => {
    const doc = new OAuthTransaction(validFields);
    expect(doc.validateSync()).toBeUndefined();
  });

  test.each(['state', 'codeVerifier', 'nonce', 'openerOrigin', 'transport', 'expiresAt'])(
    'fails validation when %s is missing',
    (field) => {
      const fields = { ...validFields } as any;
      delete fields[field];
      const doc = new OAuthTransaction(fields);
      const error = doc.validateSync();
      expect(error).toBeDefined();
      expect(error?.errors[field]).toBeDefined();
    }
  );

  test('rejects a transport value outside the cookie/bearer enum', () => {
    const doc = new OAuthTransaction({ ...validFields, transport: 'websocket' });
    const error = doc.validateSync();
    expect(error).toBeDefined();
    expect(error?.errors.transport).toBeDefined();
  });

  test('accepts "bearer" as a valid transport', () => {
    const doc = new OAuthTransaction({ ...validFields, transport: 'bearer' });
    expect(doc.validateSync()).toBeUndefined();
  });

  test('declares a TTL index on expiresAt', () => {
    const indexes = OAuthTransaction.schema.indexes() as any[];
    const ttlIndex = indexes.find((entry) => Object.prototype.hasOwnProperty.call(entry[0], 'expiresAt'));
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex?.[1]).toMatchObject({ expireAfterSeconds: 0 });
  });

  test('declares a unique index on state', () => {
    const indexes = OAuthTransaction.schema.indexes() as any[];
    const stateIndex = indexes.find((entry) => Object.prototype.hasOwnProperty.call(entry[0], 'state'));
    // `unique: true` on the path itself also registers a unique index —
    // covered either via schema-level index() or the path option.
    const pathIsUnique = (OAuthTransaction.schema.path('state') as any)?.options?.unique;
    expect(stateIndex || pathIsUnique).toBeTruthy();
  });
});
