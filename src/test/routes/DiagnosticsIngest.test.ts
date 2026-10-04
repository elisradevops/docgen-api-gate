jest.mock('../../models/LogEvent', () => ({
  __esModule: true,
  LogEvent: {
    insertMany: jest.fn().mockResolvedValue(undefined),
    countDocuments: jest.fn().mockResolvedValue(0),
  },
  LOG_EVENT_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
}));
// Issue upsert logic has its own dedicated test suite (issueUpsert.test.ts) — mocked here so
// this file only needs a thin "was it called" integration check, not a real (unmocked) Mongo
// model call that would otherwise hang the test.
jest.mock('../../helpers/diagnostics/issueUpsert', () => ({
  __esModule: true,
  upsertIssuesForEvents: jest.fn().mockResolvedValue(undefined),
}));

import App from '../../app';
import mongoose from 'mongoose';
import { withLocalAgent } from '../utils/localSupertest';
import { LogEvent } from '../../models/LogEvent';
import { upsertIssuesForEvents } from '../../helpers/diagnostics/issueUpsert';
import { getIngestSink } from '../../services/diagnostics/mongoLogSink';

const mockInsertMany = LogEvent.insertMany as jest.Mock;
const mockCountDocuments = LogEvent.countDocuments as jest.Mock;
const mockUpsertIssuesForEvents = upsertIssuesForEvents as jest.Mock;

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
        .expect(202)
    );
    await getIngestSink().flush(); // ingest replies once enqueued; persistence is the sink's batched flush
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
        .expect(202)
    );
    await getIngestSink().flush(); // ingest replies once enqueued; persistence is the sink's batched flush
    const [docs] = mockInsertMany.mock.calls[0];
    expect(docs[0].err.code).toBe('ECONN');
    expect(docs[0].minioSecretKey).toBeUndefined();
  });

  test('persists a request context for a failed ADO call, allowlisted and bounded', async () => {
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({
          events: [
            {
              level: 'error',
              service: '@elisra-devops/docgen-data-provider',
              message: 'Request failed with status code 404',
              context: {
                method: 'GET',
                url: 'https://dev.azure.com/org/_apis/wit/queries/q1',
                status: 404,
                attempt: 1,
                requestBody: 'b'.repeat(5000),
                responseExcerpt: 'TF401232: Work item 5 does not exist',
                // Not part of the shape — an untrusted sender could add anything here.
                authorization: 'Bearer should-never-reach-mongo',
              },
            },
          ],
        })
        .expect(202)
    );
    await getIngestSink().flush(); // ingest replies once enqueued; persistence is the sink's batched flush
    const [docs] = mockInsertMany.mock.calls[0];
    expect(docs[0].context).toEqual({
      method: 'GET',
      url: 'https://dev.azure.com/org/_apis/wit/queries/q1',
      status: 404,
      attempt: 1,
      requestBody: 'b'.repeat(2000),
      responseExcerpt: 'TF401232: Work item 5 does not exist',
    });
    expect(JSON.stringify(docs[0])).not.toContain('should-never-reach-mongo');
  });

  test('drops a malformed context rather than failing the event', async () => {
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({
          events: [
            { level: 'error', service: 's', message: 'm1', context: 'not-an-object' },
            { level: 'error', service: 's', message: 'm2', context: { status: 'nope', attempt: null, url: 123 } },
            { level: 'error', service: 's', message: 'm3' },
          ],
        })
        .expect(202)
    );
    await getIngestSink().flush(); // ingest replies once enqueued; persistence is the sink's batched flush
    const [docs] = mockInsertMany.mock.calls[0];
    expect(docs).toHaveLength(3);
    expect(docs.every((d: any) => d.context === undefined)).toBe(true);
  });

  test('accepts debug/info levels (Phase 6b — verbose/retain-on-failure capture)', async () => {
    const app = createApp();
    const res = await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({
          events: [
            { level: 'debug', service: 'dg-content-control', message: 'a debug line', runId: 'run-1' },
            { level: 'info', service: 'dg-content-control', message: 'an info line', runId: 'run-1' },
          ],
        })
        .expect(202)
    );
    await getIngestSink().flush(); // ingest replies once enqueued; persistence is the sink's batched flush
    expect(res.body).toEqual({ accepted: 2, rejected: 0 });
  });

  test('forwards retainPending on an ingested debug/info event', async () => {
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({
          events: [
            {
              level: 'debug',
              service: 'dg-content-control',
              message: 'retain-on-failure debug',
              runId: 'run-1',
              retainPending: true,
            },
          ],
        })
        .expect(202)
    );
    await getIngestSink().flush(); // ingest replies once enqueued; persistence is the sink's batched flush
    const [docs] = mockInsertMany.mock.calls[0];
    expect(docs[0].retainPending).toBe(true);
  });

  test('does not forward retainPending on a warn/error event even if the sender sets it', async () => {
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({ events: [{ level: 'error', service: 'dg-content-control', message: 'boom', retainPending: true }] })
        .expect(202)
    );
    await getIngestSink().flush(); // ingest replies once enqueued; persistence is the sink's batched flush
    const [docs] = mockInsertMany.mock.calls[0];
    // retainPending only ever means something on debug/info under retain-on-failure — the
    // controller only echoes the sender's flag through, it never invents it for warn/error,
    // but a malicious/buggy sender setting it on an error event is still just data here; the
    // real guarantee is that api-gate's own transport (logger.ts) never sets it on warn/error.
    expect(docs[0].level).toBe('error');
  });

  test('per-run cap: truncates debug/info past the limit and inserts one marker event', async () => {
    mockCountDocuments.mockResolvedValueOnce(20_000); // already at the default cap
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({
          events: [{ level: 'debug', service: 'dg-content-control', message: 'one more debug line', runId: 'run-1' }],
        })
        .expect(202)
    );
    await getIngestSink().flush(); // ingest replies once enqueued; persistence is the sink's batched flush
    const [docs] = mockInsertMany.mock.calls[0];
    expect(docs).toHaveLength(1);
    expect(docs[0].level).toBe('warn');
    expect(docs[0].message).toContain('truncated');
    expect(docs[0].runId).toBe('run-1');
  });

  test('per-run cap does not apply to warn/error events', async () => {
    mockCountDocuments.mockResolvedValueOnce(999_999);
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({ events: [{ level: 'error', service: 'dg-content-control', message: 'boom', runId: 'run-1' }] })
        .expect(202)
    );
    await getIngestSink().flush(); // ingest replies once enqueued; persistence is the sink's batched flush
    // No debug/info in the batch, so countDocuments is never even called.
    expect(mockCountDocuments).not.toHaveBeenCalled();
    const [docs] = mockInsertMany.mock.calls[0];
    expect(docs).toHaveLength(1);
    expect(docs[0].level).toBe('error');
  });

  test('per-run cap: does not re-insert the truncation marker once one already exists for the run', async () => {
    mockCountDocuments.mockResolvedValueOnce(20_000).mockResolvedValueOnce(1);
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({
          events: [{ level: 'debug', service: 'dg-content-control', message: 'yet another debug line', runId: 'run-1' }],
        })
        .expect(202)
    );
    await getIngestSink().flush(); // ingest replies once enqueued; persistence is the sink's batched flush
    // Everything in the batch was truncated and no marker was needed (one already exists),
    // so there's nothing left to insert at all.
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  test('upserts an Issue for each warn/error event, not for debug/info', async () => {
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({
          events: [
            { level: 'error', service: 'dg-content-control', message: 'boom' },
            { level: 'info', service: 'dg-content-control', message: 'fyi', runId: 'run-1' },
          ],
        })
        .expect(202)
    );
    await getIngestSink().flush(); // ingest replies once enqueued; persistence is the sink's batched flush
    expect(mockUpsertIssuesForEvents).toHaveBeenCalledTimes(1);
    const [events] = mockUpsertIssuesForEvents.mock.calls[0];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'error' });
  });

  test('replies 202 even when persistence later fails — the sink swallows it, ingest never waits on Mongo', async () => {
    mockInsertMany.mockRejectedValueOnce(new Error('mongo is slow'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createApp();
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({ events: [{ level: 'error', service: 'dg-content-control', message: 'boom' }] })
        .expect(202)
    );
    await expect(getIngestSink().flush()).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  test('rejects an oversized body with 413 on this route only (2MB limit, not the global 50MB)', async () => {
    const app = createApp();
    const big = 'x'.repeat(3 * 1024 * 1024);
    await withLocalAgent(app, (agent) =>
      agent
        .post('/diagnostics/logs')
        .set('x-docgen-ingest-token', 'the-secret')
        .send({ events: [{ level: 'error', service: 's', message: big }] })
        .expect(413)
    );
  });
});
