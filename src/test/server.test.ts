const closeMock = jest.fn((cb?: () => void) => {
  if (cb) cb();
});
const listenMock = jest.fn((port: number | string, cb?: () => void) => {
  if (cb) {
    cb();
  }
  return { close: closeMock };
});

jest.mock('../util/mongodb', () => ({
  __esModule: true,
  default: jest.fn(),
  disconnectMongo: jest.fn(),
}));

jest.mock('../app', () => ({
  __esModule: true,
  default: jest.fn(() => ({ app: { listen: listenMock } })),
}));

jest.mock('../util/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const getMockLogger = () =>
  require('../util/logger').default as unknown as { info: jest.Mock; error: jest.Mock };
const getConnectMock = () => require('../util/mongodb').default as jest.Mock;

describe('server bootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    // Each import of '../server' re-registers SIGTERM/SIGINT listeners on the real, shared
    // `process` object (module-level code, re-run fresh by resetModules) — without this, they
    // accumulate across tests and process.emit('SIGTERM') in a later test also fires every
    // earlier test's stale listener.
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.env.PORT = '4000';
    process.env.dgContentControlUrl = 'http://cc';
    process.env.jsonToWordPostUrl = 'http://jw';
    process.env.MINIO_ROOT_USER = 'user';
    process.env.MINIO_ROOT_PASSWORD = 'pass';
    process.env.MINIO_REGION = 'eu';
    process.env.MINIO_ENDPOINT = 'http://minio';
    // Required by assertAuthConfig(), now called before connectToDatabase().
    process.env.CLIENT_ID = 'client-123';
    process.env.TENANT_ID = 'tenant-456';
    process.env.CLIENT_SECRET = 'secret-789';
    process.env.REDIRECT_URI = 'http://localhost:4000/auth/callback';
    process.env.SESSION_SECRET = 'a'.repeat(32);
  });

  // Unconditional, not just in the fake-timer test's own cleanup — if that test's assertions
  // throw before reaching its manual jest.useRealTimers()/env cleanup, fake-timer state and the
  // env var would otherwise leak into whichever test runs next.
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.SHUTDOWN_TIMEOUT_MS;
  });

  test('logs error and exits when the auth config is invalid, without attempting a DB connection', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    delete process.env.CLIENT_SECRET;
    const connectMock = getConnectMock();

    await import('../server');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(connectMock).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  test('starts server after successful DB connection', async () => {
    const connectMock = getConnectMock();
    connectMock.mockResolvedValueOnce(undefined);

    await import('../server');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(connectMock).toHaveBeenCalled();
    expect(listenMock).toHaveBeenCalledWith('4000', expect.any(Function));
  });

  test('logs error and exits on DB failure', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const connectMock = getConnectMock();
    connectMock.mockRejectedValueOnce(new Error('db-fail'));

    await import('../server');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  test('an uncaught exception is logged with its stack and exits the process — unlike a rejected promise, it is not safe to keep running', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const connectMock = getConnectMock();
    connectMock.mockResolvedValueOnce(undefined);

    await import('../server');
    await new Promise<void>((resolve) => setImmediate(resolve));
    exitSpy.mockClear();

    const boom = new Error('boom');
    process.emit('uncaughtException', boom);

    const logger = getMockLogger();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'), boom);

    // process.exit(1) now happens after a bounded attempt to flush the diagnostics sink (a
    // Promise.race), not synchronously — let that microtask settle before asserting.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  test('SIGTERM closes the HTTP server (letting in-flight requests finish) before disconnecting Mongo', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const connectMock = getConnectMock();
    connectMock.mockResolvedValueOnce(undefined);
    const disconnectMock = require('../util/mongodb').disconnectMongo as jest.Mock;

    await import('../server');
    await new Promise<void>((resolve) => setImmediate(resolve));
    closeMock.mockClear();
    disconnectMock.mockClear();

    process.emit('SIGTERM');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(closeMock).toHaveBeenCalled();
    expect(disconnectMock).toHaveBeenCalled();
    const closeOrder = closeMock.mock.invocationCallOrder[0];
    const disconnectOrder = disconnectMock.mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(disconnectOrder);

    exitSpy.mockRestore();
  });

  test('shutdown force-continues after SHUTDOWN_TIMEOUT_MS if the HTTP server never finishes closing (a stuck in-flight connection), logging a warning rather than hanging forever', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    process.env.SHUTDOWN_TIMEOUT_MS = '50';
    const connectMock = getConnectMock();
    connectMock.mockResolvedValueOnce(undefined);
    const disconnectMock = require('../util/mongodb').disconnectMongo as jest.Mock;

    await import('../server');
    await new Promise<void>((resolve) => setImmediate(resolve));
    closeMock.mockClear();
    disconnectMock.mockClear();
    // Simulate server.close() never invoking its callback.
    closeMock.mockImplementationOnce(() => {});

    jest.useFakeTimers();
    process.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(50);

    const logger = getMockLogger();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('did not close within'));
    expect(disconnectMock).toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
