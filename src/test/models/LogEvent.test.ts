import { LogEvent, LOG_EVENT_RETENTION_MS } from '../../models/LogEvent';

describe('LogEvent schema', () => {
  const validFields = {
    ts: new Date(),
    level: 'error',
    service: 'dg-content-control',
    version: '1.131.0',
    runId: 'run-123',
    message: 'Failed fetching work item <n>',
    signature: 'failed fetching work item <n>',
    expiresAt: new Date(Date.now() + LOG_EVENT_RETENTION_MS),
  };

  test('validates with all required fields present', () => {
    const doc = new LogEvent(validFields);
    expect(doc.validateSync()).toBeUndefined();
  });

  test.each(['ts', 'level', 'service', 'version', 'message', 'signature', 'expiresAt'])(
    'fails validation when %s is missing',
    (field) => {
      const fields = { ...validFields } as any;
      delete fields[field];
      const doc = new LogEvent(fields);
      const error = doc.validateSync();
      expect(error).toBeDefined();
      expect(error?.errors[field]).toBeDefined();
    }
  );

  test('rejects a level outside the debug/info/warn/error enum', () => {
    const doc = new LogEvent({ ...validFields, level: 'silly' });
    const error = doc.validateSync();
    expect(error).toBeDefined();
    expect(error?.errors.level).toBeDefined();
  });

  test.each(['debug', 'info'])(
    '%s is a valid level (Phase 6b — verbose/retain-on-failure capture)',
    (level) => {
      const doc = new LogEvent({ ...validFields, level });
      expect(doc.validateSync()).toBeUndefined();
    }
  );

  test('accepts an optional retainPending flag', () => {
    const doc = new LogEvent({ ...validFields, level: 'debug', retainPending: true });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.retainPending).toBe(true);
  });

  test('accepts an optional err subdocument', () => {
    const doc = new LogEvent({
      ...validFields,
      err: { message: 'boom', code: 'ECONN', stack: 'Error: boom\n at x' },
    });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.err?.code).toBe('ECONN');
  });

  test('declares a TTL index on expiresAt', () => {
    const indexes = LogEvent.schema.indexes() as any[];
    const ttlIndex = indexes.find((entry) => Object.prototype.hasOwnProperty.call(entry[0], 'expiresAt'));
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex?.[1]).toMatchObject({ expireAfterSeconds: 0 });
  });

  test('declares a compound index on runId+ts for the run-detail timeline', () => {
    const indexes = LogEvent.schema.indexes() as any[];
    const runIdIndex = indexes.find(
      (entry) =>
        Object.prototype.hasOwnProperty.call(entry[0], 'runId') &&
        Object.prototype.hasOwnProperty.call(entry[0], 'ts')
    );
    expect(runIdIndex).toBeDefined();
  });

  test('declares a compound index on signature+ts for top-errors/Issue keying', () => {
    const indexes = LogEvent.schema.indexes() as any[];
    const signatureIndex = indexes.find(
      (entry) =>
        Object.prototype.hasOwnProperty.call(entry[0], 'signature') &&
        Object.prototype.hasOwnProperty.call(entry[0], 'ts')
    );
    expect(signatureIndex).toBeDefined();
  });

  test('declares a compound index on level+ts for the newest-first Logs feed', () => {
    const indexes = LogEvent.schema.indexes() as any[];
    const levelIndex = indexes.find(
      (entry) =>
        Object.prototype.hasOwnProperty.call(entry[0], 'level') &&
        Object.prototype.hasOwnProperty.call(entry[0], 'ts')
    );
    expect(levelIndex).toBeDefined();
  });
});
