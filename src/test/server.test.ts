const listenMock = jest.fn((port: number | string, cb?: () => void) => {
  if (cb) {
    cb();
  }
});

jest.mock('../util/mongodb', () => ({
  __esModule: true,
  default: jest.fn(),
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
});
