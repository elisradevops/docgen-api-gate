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
