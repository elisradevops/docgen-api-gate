jest.mock('../../../models/LogEvent', () => ({
  __esModule: true,
  LogEvent: {
    insertMany: jest.fn().mockResolvedValue(undefined),
    estimatedDocumentCount: jest.fn().mockResolvedValue(0),
    countDocuments: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    }),
    deleteMany: jest.fn().mockResolvedValue(undefined),
  },
  LOG_EVENT_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
  LOG_EVENT_MAX_DOCUMENTS: 500_000,
}));
jest.mock('../../../util/mongodb', () => ({
  __esModule: true,
  isMongoConnected: jest.fn().mockReturnValue(true),
}));
// Issue upsert logic has its own dedicated test suite (issueUpsert.test.ts) — mocked here so
// this file only needs a thin "was it called" integration check, not a real (unmocked) Mongo
// model call that would otherwise hang the test.
jest.mock('../../../helpers/diagnostics/issueUpsert', () => ({
  __esModule: true,
  upsertIssueForEvent: jest.fn().mockResolvedValue(undefined),
}));

import { LogEvent } from '../../../models/LogEvent';
import { isMongoConnected } from '../../../util/mongodb';
import { upsertIssueForEvent } from '../../../helpers/diagnostics/issueUpsert';
import { MongoLogSink } from '../../../services/diagnostics/mongoLogSink';
import type { DiagnosticEvent } from '../../../util/logSink';

const mockInsertMany = LogEvent.insertMany as jest.Mock;
const mockCountDocuments = LogEvent.countDocuments as jest.Mock;
const mockIsMongoConnected = isMongoConnected as jest.Mock;
const mockUpsertIssueForEvent = upsertIssueForEvent as jest.Mock;

function makeEvent(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return {
    ts: new Date().toISOString(),
    level: 'error',
    service: 'dg-api-gate',
    version: '2.42.0',
    message: 'Failed fetching work item 12345',
    ...overrides,
  };
}

describe('MongoLogSink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMongoConnected.mockReturnValue(true);
  });

  test('buffers events without flushing until the batch size is reached', () => {
    const sink = new MongoLogSink();
    sink.push(makeEvent());
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  test('flush() is a no-op when Mongo is not connected', async () => {
    mockIsMongoConnected.mockReturnValue(false);
    const sink = new MongoLogSink();
    sink.push(makeEvent());
    await sink.flush();
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  test('flush() writes buffered events with a computed signature and expiresAt', async () => {
    const sink = new MongoLogSink();
    sink.push(makeEvent({ message: 'Failed fetching work item 12345' }));
    await sink.flush();
    expect(mockInsertMany).toHaveBeenCalledTimes(1);
    const [docs, opts] = mockInsertMany.mock.calls[0];
    expect(opts).toMatchObject({ ordered: false });
    expect(docs).toHaveLength(1);
    expect(docs[0].signature).toBe('failed fetching work item <n>');
    expect(docs[0].expiresAt).toBeInstanceOf(Date);
  });

  test('a throwing insertMany does not throw out of flush()', async () => {
    mockInsertMany.mockRejectedValueOnce(new Error('mongo is down'));
    const sink = new MongoLogSink();
    sink.push(makeEvent());
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  test('drops the oldest event under backpressure once the buffer cap is hit', () => {
    const sink = new MongoLogSink();
    // Buffer.length (10_000, at BUFFER_MAX) is also >= FLUSH_BATCH_SIZE (500), so an
    // un-stubbed push() would trigger a real flush and empty the buffer before this test can
    // inspect it — stub flush() to isolate the backpressure/drop behavior from the
    // separately-tested flush-on-batch-size behavior.
    jest.spyOn(sink, 'flush').mockResolvedValue(undefined);
    (sink as any).buffer = new Array(10_000).fill(0).map(() => makeEvent());
    sink.push(makeEvent({ message: 'the newest event' }));
    const buffer: DiagnosticEvent[] = (sink as any).buffer;
    expect(buffer).toHaveLength(10_000);
    expect(buffer[buffer.length - 1].message).toBe('the newest event');
  });

  test('flush() with an empty buffer never calls insertMany', async () => {
    const sink = new MongoLogSink();
    await sink.flush();
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  test('push() auto-flushes once the batch size threshold is reached', () => {
    const sink = new MongoLogSink();
    const flushSpy = jest.spyOn(sink, 'flush').mockResolvedValue(undefined);
    // FLUSH_BATCH_SIZE defaults to 500 — push exactly that many to cross the threshold.
    for (let i = 0; i < 500; i++) sink.push(makeEvent());
    expect(flushSpy).toHaveBeenCalled();
  });

  test('flush() prunes the oldest overflow once the document cap is exceeded', async () => {
    const mockDeleteMany = LogEvent.deleteMany as jest.Mock;
    const mockEstimated = LogEvent.estimatedDocumentCount as jest.Mock;
    const mockFind = LogEvent.find as jest.Mock;
    mockEstimated.mockResolvedValue(500_010);
    mockFind.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ _id: 'a' }, { _id: 'b' }]),
    });
    const sink = new MongoLogSink();
    sink.push(makeEvent());
    await sink.flush();
    expect(mockDeleteMany).toHaveBeenCalledWith({ _id: { $in: ['a', 'b'] } });
  });

  test('flush() does not re-check the prune threshold within the throttle window', async () => {
    const mockEstimated = LogEvent.estimatedDocumentCount as jest.Mock;
    mockEstimated.mockResolvedValue(500_010);
    const sink = new MongoLogSink();
    sink.push(makeEvent());
    await sink.flush();
    sink.push(makeEvent());
    await sink.flush();
    // Only the first flush's prune check runs; the second is inside the 60s throttle window.
    expect(mockEstimated).toHaveBeenCalledTimes(1);
  });

  test('flush() forwards retainPending on a debug/info event', async () => {
    const sink = new MongoLogSink();
    sink.push(makeEvent({ level: 'debug', message: 'retain-on-failure debug', runId: 'run-1', retainPending: true }));
    await sink.flush();
    const [docs] = mockInsertMany.mock.calls[0];
    expect(docs[0].retainPending).toBe(true);
  });

  test('per-run cap: truncates debug/info past the limit and inserts one marker event', async () => {
    mockCountDocuments.mockResolvedValueOnce(20_000); // already at the default cap
    const sink = new MongoLogSink();
    sink.push(makeEvent({ level: 'debug', message: 'one more debug line', runId: 'run-1' }));
    await sink.flush();
    const [docs] = mockInsertMany.mock.calls[0];
    expect(docs).toHaveLength(1);
    expect(docs[0].level).toBe('warn');
    expect(docs[0].message).toContain('truncated');
    expect(docs[0].runId).toBe('run-1');
  });

  test('per-run cap does not apply to warn/error events', async () => {
    const sink = new MongoLogSink();
    sink.push(makeEvent({ level: 'error', message: 'boom', runId: 'run-1' }));
    await sink.flush();
    expect(mockCountDocuments).not.toHaveBeenCalled();
    const [docs] = mockInsertMany.mock.calls[0];
    expect(docs).toHaveLength(1);
    expect(docs[0].level).toBe('error');
  });

  test('per-run cap: does not re-insert the truncation marker once one already exists for the run', async () => {
    // First call (total count) over the cap, second call (marker-existence count) > 0 — a
    // long-truncated run flushing in many small batches must not re-insert the marker every
    // single flush (caught live during Phase 6b verification with a deliberately low cap).
    mockCountDocuments.mockResolvedValueOnce(20_000).mockResolvedValueOnce(1);
    const sink = new MongoLogSink();
    sink.push(makeEvent({ level: 'debug', message: 'yet another debug line', runId: 'run-1' }));
    await sink.flush();
    const [docs] = mockInsertMany.mock.calls[0];
    expect(docs).toHaveLength(0);
  });

  test('flush() upserts an Issue for each warn/error event, not for debug/info', async () => {
    const sink = new MongoLogSink();
    sink.push(makeEvent({ level: 'error', message: 'boom', runId: 'run-1' }));
    sink.push(makeEvent({ level: 'warn', message: 'careful', runId: 'run-1' }));
    await sink.flush();
    expect(mockUpsertIssueForEvent).toHaveBeenCalledTimes(2);
    expect(mockUpsertIssueForEvent).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
    expect(mockUpsertIssueForEvent).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });
});
