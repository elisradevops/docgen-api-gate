import { EventEmitter } from 'events';
import mongoose from 'mongoose';
import connectToDatabase, {
  isMongoConnected,
  ensureMongoConnection,
  probeMongoConnection,
  disconnectMongo,
  _resetMongoStateForTest,
} from '../../util/mongodb';
import logger from '../../util/logger';

class FakeConnection extends EventEmitter {
  readyState = 0;
  db: any = undefined;
}

jest.mock('mongoose', () => {
  const connection = new (require('events').EventEmitter)();
  connection.readyState = 0;
  connection.db = undefined;
  return {
    __esModule: true,
    default: {
      connect: jest.fn(),
      disconnect: jest.fn(),
      set: jest.fn(),
      connection,
    },
  };
});

jest.mock('../../util/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

const asMockConnect = () => (mongoose as any).connect as jest.Mock;
const asMockDisconnect = () => (mongoose as any).disconnect as jest.Mock;
const getConnection = () => mongoose.connection as unknown as FakeConnection;
const getMockLogger = () => logger as unknown as { info: jest.Mock; error: jest.Mock; warn: jest.Mock };

// Simulates the real mongoose behavior the module relies on: a resolved
// connect() implies readyState flips to 1 and a 'connected' event fires.
// The extra microtask tick before mutating state mirrors real network I/O —
// without it, a synchronous mock would emit 'connected' before callers (like
// ensureMongoConnection) have subscribed, which never happens with a real
// socket.
const connectSucceeds = () =>
  asMockConnect().mockImplementationOnce(async () => {
    await Promise.resolve();
    getConnection().readyState = 1;
    getConnection().emit('connected');
  });

const connectFails = (message = 'boom') =>
  asMockConnect().mockImplementationOnce(async () => {
    await Promise.resolve();
    throw new Error(message);
  });

describe('util/mongodb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    delete process.env.MONGODB_URI;
    getConnection().readyState = 0;
    getConnection().db = undefined;
    _resetMongoStateForTest();
  });

  afterEach(() => {
    _resetMongoStateForTest();
    jest.useRealTimers();
  });

  describe('connectToDatabase', () => {
    test('connects to default URI with explicit timeouts and logs success', async () => {
      connectSucceeds();

      await connectToDatabase();

      expect(asMockConnect()).toHaveBeenCalledWith(
        'mongodb://root:example@mongodb:27017/docgen?authSource=admin',
        expect.objectContaining({
          useNewUrlParser: true,
          useUnifiedTopology: true,
          useCreateIndex: true,
          useFindAndModify: false,
          serverSelectionTimeoutMS: expect.any(Number),
          connectTimeoutMS: expect.any(Number),
          heartbeatFrequencyMS: expect.any(Number),
        })
      );
      expect(getMockLogger().info).toHaveBeenCalledWith('Connected to MongoDB successfully');
      expect(isMongoConnected()).toBe(true);
    });

    test('never throws on failure and schedules a background reconnect', async () => {
      connectFails('boom');

      await expect(connectToDatabase()).resolves.toBeUndefined();

      expect(getMockLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('MongoDB connection attempt 1 failed: boom')
      );
      expect(isMongoConnected()).toBe(false);
    });

    test('recovers on its own once Mongo comes back, with no restart required', async () => {
      connectFails('boom');
      await connectToDatabase();
      expect(asMockConnect()).toHaveBeenCalledTimes(1);

      connectSucceeds();
      await jest.runOnlyPendingTimersAsync();

      expect(asMockConnect()).toHaveBeenCalledTimes(2);
      expect(getMockLogger().info).toHaveBeenCalledWith(
        expect.stringContaining('Reconnected to MongoDB after 1 failed attempt(s)')
      );
      expect(isMongoConnected()).toBe(true);
    });
  });

  describe('ensureMongoConnection', () => {
    test('resolves immediately when already connected', async () => {
      getConnection().readyState = 1;

      await expect(ensureMongoConnection(1000)).resolves.toBe(true);
      expect(asMockConnect()).not.toHaveBeenCalled();
    });

    test('nudges a reconnect attempt and resolves true once connected', async () => {
      connectSucceeds();

      const result = ensureMongoConnection(5000);
      await jest.advanceTimersByTimeAsync(0);

      await expect(result).resolves.toBe(true);
      expect(asMockConnect()).toHaveBeenCalledTimes(1);
    });

    test('resolves false on timeout and leaves no dangling listener', async () => {
      const connection = getConnection();
      const listenerCountBefore = connection.listenerCount('connected');

      const result = ensureMongoConnection(1000);
      await jest.advanceTimersByTimeAsync(1000);

      await expect(result).resolves.toBe(false);
      expect(connection.listenerCount('connected')).toBe(listenerCountBefore);
    });
  });

  describe('probeMongoConnection', () => {
    test('returns false when not connected', async () => {
      getConnection().readyState = 0;
      await expect(probeMongoConnection()).resolves.toBe(false);
    });

    test('returns true when the ping succeeds', async () => {
      getConnection().readyState = 1;
      getConnection().db = { admin: () => ({ command: jest.fn().mockResolvedValue({ ok: 1 }) }) };

      await expect(probeMongoConnection(1000)).resolves.toBe(true);
    });

    test('returns false when the ping rejects', async () => {
      getConnection().readyState = 1;
      getConnection().db = { admin: () => ({ command: jest.fn().mockRejectedValue(new Error('down')) }) };

      await expect(probeMongoConnection(1000)).resolves.toBe(false);
    });
  });

  describe('disconnectMongo', () => {
    test('clears any pending reconnect timer and disconnects', async () => {
      connectFails('boom');
      await connectToDatabase();

      await disconnectMongo();

      expect(asMockDisconnect()).toHaveBeenCalled();
      // No further reconnect attempt should fire after disconnect.
      await jest.advanceTimersByTimeAsync(60000);
      expect(asMockConnect()).toHaveBeenCalledTimes(1);
    });
  });
});
