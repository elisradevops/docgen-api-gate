import { AuthSession } from '../../models/AuthSession';

describe('AuthSession schema', () => {
  const validFields = {
    sessionTokenHash: 'hash-of-session-token',
    homeAccountId: 'home-account-id-123',
    transport: 'cookie',
    csrfTokenHash: 'hash-of-csrf-token',
    idleExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    absoluteExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
  };

  test('validates with all required fields present', () => {
    const doc = new AuthSession(validFields);
    expect(doc.validateSync()).toBeUndefined();
  });

  test('validates without the optional ID-token-derived fields', () => {
    const doc = new AuthSession(validFields);
    expect(doc.displayName).toBeUndefined();
    expect(doc.userPrincipalName).toBeUndefined();
    expect(doc.tenantId).toBeUndefined();
    expect(doc.validateSync()).toBeUndefined();
  });

  test('accepts the optional ID-token-derived fields when present', () => {
    const doc = new AuthSession({
      ...validFields,
      displayName: 'Eden Zvi Schwartz',
      userPrincipalName: 'eden@korentec.onmicrosoft.com',
      tenantId: 'tenant-guid',
    });
    expect(doc.validateSync()).toBeUndefined();
  });

  test('defaults lastSeenAt to now when not supplied', () => {
    const doc = new AuthSession(validFields);
    expect(doc.lastSeenAt).toBeInstanceOf(Date);
  });

  test.each(['sessionTokenHash', 'homeAccountId', 'transport', 'csrfTokenHash', 'idleExpiresAt', 'absoluteExpiresAt'])(
    'fails validation when %s is missing',
    (field) => {
      const fields = { ...validFields } as any;
      delete fields[field];
      const doc = new AuthSession(fields);
      const error = doc.validateSync();
      expect(error).toBeDefined();
      expect(error?.errors[field]).toBeDefined();
    }
  );

  test('rejects a transport value outside the cookie/bearer enum', () => {
    const doc = new AuthSession({ ...validFields, transport: 'websocket' });
    const error = doc.validateSync();
    expect(error?.errors.transport).toBeDefined();
  });

  test('declares a TTL index on absoluteExpiresAt', () => {
    const indexes = AuthSession.schema.indexes() as any[];
    const ttlIndex = indexes.find((entry) => Object.prototype.hasOwnProperty.call(entry[0], 'absoluteExpiresAt'));
    expect(ttlIndex?.[1]).toMatchObject({ expireAfterSeconds: 0 });
  });

  test('declares an index on homeAccountId (the MSAL cache partition key lookup path)', () => {
    const indexes = AuthSession.schema.indexes() as any[];
    const homeAccountIndex = indexes.find((entry) => Object.prototype.hasOwnProperty.call(entry[0], 'homeAccountId'));
    expect(homeAccountIndex).toBeDefined();
  });
});
