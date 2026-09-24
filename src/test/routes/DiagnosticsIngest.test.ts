jest.mock('../../models/LogEvent', () => ({
  __esModule: true,
  LogEvent: {
    insertMany: jest.fn().mockResolvedValue(undefined),
  },
  LOG_EVENT_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
}));

import App from '../../app';
import mongoose from 'mongoose';
import { withLocalAgent } from '../utils/localSupertest';
import { LogEvent } from '../../models/LogEvent';

const mockInsertMany = LogEvent.insertMany as jest.Mock;

describe('POST /diagnostics/logs', () => {
  const ORIGINAL_TOKEN = process.env.DIAGNOSTICS_INGEST_TOKEN;
  let prevReadyState: number;

  function createApp(): any {
    const AppClass = require('../../app').default as typeof App;
    return new AppClass().app;
  }

  beforeAll(() => {
    // Registers all mongoose models (DocumentRun etc., transitively required via app.ts) once,
    // while readyState is still whatever it defaults to. Forcing readyState to 1 *before* a
    // model's first mongoose.model(...) call makes its NativeCollection try to eagerly build
    // indexes against a connection that was never actually opened (conn.db is undefined) —
    // this warm-up require avoids that ordering hazard for the tests below.
    createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DIAGNOSTICS_INGEST_TOKEN = 'the-secret';
    prevReadyState = (mongoose.connection as any).readyState;
    (mongoose.connection as any).readyState = 1; // isMongoConnected() reads this directly
  });

  afterEach(() => {
    process.env.DIAGNOSTICS_INGEST_TOKEN = ORIGINAL_TOKEN;
    (mongoose.connection as any).readyState = prevReadyState;
  });

  test('rejects with 401 when no ingest token header is supplied', async () => {
    const app = createApp();
    await withLocalAgent(app, (agent) => agent.post('/diagnostics/logs').send({ events: [] }).expect(401));
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  test('rejects with 503 when the ingest secret is not configured', async () => {
    delete process.env.DIAGNOSTICS_INGEST_TOKEN;
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent.post('/diagnostics/logs').set('x-docgen-ingest-token', 'anything').send({ events: [] }).expect(503)
    );
  });

  test('accepts a valid batch and reports accepted/rejected counts', async () => {
    const app = createApp();
    const res = await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({
          events: [
            { level: 'error', service: 'dg-content-control', message: 'Failed fetching work item 12345' },
            { level: 'bogus-level', service: 'dg-content-control', message: 'this one is malformed' },
          ],
        })
        .expect(200)
    );
    expect(res.body).toEqual({ accepted: 1, rejected: 1 });
    expect(mockInsertMany).toHaveBeenCalledTimes(1);
  });

  test('rejects with 400 when the payload has no events array', async () => {
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent.post('/diagnostics/logs').set('x-docgen-ingest-token', 'the-secret').send({}).expect(400)
    );
  });

  test('returns 503 without touching the model when Mongo is disconnected', async () => {
    (mongoose.connection as any).readyState = 0;
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({ events: [] })
        .expect(503)
    );
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  test('drops any field outside the whitelist rather than persisting it', async () => {
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({
          events: [
            {
              level: 'error',
              service: 'dg-content-control',
              message: 'upstream call failed',
              err: { message: 'boom', code: 'ECONN' },
              // Not a real LogEvent field — an untrusted sender could put anything here.
              minioSecretKey: 'should-never-reach-mongo',
            },
          ],
        })
        .expect(200)
    );
    const [docs] = mockInsertMany.mock.calls[0];
    expect(docs[0].err.code).toBe('ECONN');
    expect(docs[0].minioSecretKey).toBeUndefined();
  });
});
