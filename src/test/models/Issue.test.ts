import { Issue } from '../../models/Issue';

describe('Issue schema', () => {
  const validFields = {
    signature: 'no test cases found for suite: <n>',
    service: '@elisra-devops/docgen-data-provider',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  };

  test('validates with all required fields present', () => {
    const doc = new Issue(validFields);
    expect(doc.validateSync()).toBeUndefined();
  });

  test('defaults status to unresolved and count to 1', () => {
    const doc = new Issue(validFields);
    expect(doc.status).toBe('unresolved');
    expect(doc.count).toBe(1);
  });

  test.each(['signature', 'service', 'firstSeenAt', 'lastSeenAt'])(
    'fails validation when %s is missing',
    (field) => {
      const fields = { ...validFields } as any;
      delete fields[field];
      const doc = new Issue(fields);
      const error = doc.validateSync();
      expect(error).toBeDefined();
      expect(error?.errors[field]).toBeDefined();
    }
  );

  test('rejects a status outside the unresolved/resolved enum', () => {
    const doc = new Issue({ ...validFields, status: 'ignored' });
    const error = doc.validateSync();
    expect(error).toBeDefined();
    expect(error?.errors.status).toBeDefined();
  });

  test('accepts an optional environmentAtFirstSeen subdocument', () => {
    const doc = new Issue({
      ...validFields,
      environmentAtFirstSeen: { service: 'dg-content-control', version: '1.131.0' },
    });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.environmentAtFirstSeen?.version).toBe('1.131.0');
  });

  test('declares a unique compound index on signature+service', () => {
    const indexes = Issue.schema.indexes() as any[];
    const compound = indexes.find(
      (entry) =>
        Object.prototype.hasOwnProperty.call(entry[0], 'signature') &&
        Object.prototype.hasOwnProperty.call(entry[0], 'service')
    );
    expect(compound).toBeDefined();
    expect(compound?.[1]).toMatchObject({ unique: true });
  });

  test('declares a compound index on status+lastSeenAt for the Needs Attention view', () => {
    const indexes = Issue.schema.indexes() as any[];
    const statusIndex = indexes.find(
      (entry) =>
        Object.prototype.hasOwnProperty.call(entry[0], 'status') &&
        Object.prototype.hasOwnProperty.call(entry[0], 'lastSeenAt')
    );
    expect(statusIndex).toBeDefined();
  });

  test('has no TTL index — an issue is retained by its own lifecycle, not age', () => {
    const indexes = Issue.schema.indexes() as any[];
    const ttlIndex = indexes.find((entry) => entry[1]?.expireAfterSeconds !== undefined);
    expect(ttlIndex).toBeUndefined();
  });
});
