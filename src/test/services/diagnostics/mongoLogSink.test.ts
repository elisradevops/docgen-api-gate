jest.mock('../../../models/LogEvent', () => ({
  __esModule: true,
  LogEvent: {
    insertMany: jest.fn().mockResolvedValue(undefined),
    estimatedDocumentCount: jest.fn().mockResolvedValue(0),
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

import { LogEvent } from '../../../models/LogEvent';
import { isMongoConnected } from '../../../util/mongodb';
import { MongoLogSink } from '../../../services/diagnostics/mongoLogSink';
import type { DiagnosticEvent } from '../../../util/logSink';

const mockInsertMany = LogEvent.insertMany as jest.Mock;
const mockIsMongoConnected = isMongoConnected as jest.Mock;

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
});
