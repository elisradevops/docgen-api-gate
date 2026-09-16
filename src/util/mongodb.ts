import mongoose from 'mongoose';
import logger from './logger';

// When running in Docker, use the service name instead of localhost
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://root:example@mongodb:27017/docgen?authSource=admin';

// Mongoose (with useUnifiedTopology) does NOT retry a failed *initial*
// connection on its own — the topology tears down and readyState stays 0
// forever. That is why, historically, a Mongo restart during a deployment
// upgrade required restarting api-gate too. This module adds an explicit
// background reconnect loop plus request-facing helpers so a request can
// fail fast (see requireMongo) instead of buffering against a dead socket.
const SERVER_SELECTION_TIMEOUT_MS = Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS) || 5000;
const CONNECT_TIMEOUT_MS = 10000;
const HEARTBEAT_FREQUENCY_MS = 10000;
// Kept below requireMongo's request-level wait so a buffered query can never
// outlive that guard and surface the misleading "buffering timed out" error.
const BUFFER_TIMEOUT_MS = 3000;

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

mongoose.set('bufferTimeoutMS', BUFFER_TIMEOUT_MS);

const connectionOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useCreateIndex: true,
  useFindAndModify: false,
  serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  connectTimeoutMS: CONNECT_TIMEOUT_MS,
  heartbeatFrequencyMS: HEARTBEAT_FREQUENCY_MS,
};

let listenersRegistered = false;
let reconnectScheduled = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Exponential backoff with jitter, same shape as the house pattern in
// docgen-data-provider-package's executeWithRetry: base 1s, x2, capped at
// 30s, +/-15% jitter so many pods don't hammer mongod in lockstep.
const nextReconnectDelayMs = (attempt: number): number => {
  const exponential = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
  const jitterFactor = 0.85 + Math.random() * 0.3;
  return Math.round(exponential * jitterFactor);
};

const scheduleReconnect = (): void => {
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  const delay = nextReconnectDelayMs(reconnectAttempt);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectScheduled = false;
    if (mongoose.connection.readyState === 0) {
      attemptConnect();
    }
  }, delay);
};

// Never log the raw error object or MONGODB_URI — both can carry the
// connection's credentials.
const attemptConnect = async (): Promise<void> => {
  try {
    await mongoose.connect(MONGODB_URI, connectionOptions);
  } catch (error) {
    reconnectAttempt += 1;
    const log = reconnectAttempt === 1 ? logger.error : logger.warn;
    log(`MongoDB connection attempt ${reconnectAttempt} failed: ${error.message}`);
    scheduleReconnect();
  }
};

const registerConnectionListeners = (): void => {
  if (listenersRegistered) return;
  listenersRegistered = true;

  mongoose.connection.on('connected', () => {
    if (reconnectAttempt > 0) {
      logger.info(`Reconnected to MongoDB after ${reconnectAttempt} failed attempt(s)`);
    } else {
      logger.info('Connected to MongoDB successfully');
    }
    reconnectAttempt = 0;
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB connection lost');
    if (mongoose.connection.readyState === 0) {
      scheduleReconnect();
    }
  });

  mongoose.connection.on('error', (error) => {
    logger.warn(`MongoDB connection error: ${error.message}`);
  });
};

// Boot-time entry point. Keeps its original contract: one awaited attempt
// that never throws, so a Mongo outage never blocks server startup — /health
// and every non-DB route must keep serving. On failure the background
// reconnect loop takes over so the process recovers on its own once Mongo
// comes back, with no pod restart required.
const connectToDatabase = async (): Promise<void> => {
  registerConnectionListeners();
  await attemptConnect();
};

export const isMongoConnected = (): boolean => mongoose.connection.readyState === 1;

/**
 * Waits up to `timeoutMs` for the connection to come up, nudging the
 * reconnect loop if it is idle. Used by request-level guards (requireMongo,
 * requireSession) so a request fails fast with a clean 503 instead of
 * buffering against a dead connection for the mongoose default 10s.
 */
export const ensureMongoConnection = async (timeoutMs: number): Promise<boolean> => {
  if (isMongoConnected()) return true;

  if (mongoose.connection.readyState === 0 && !reconnectScheduled) {
    attemptConnect();
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      mongoose.connection.removeListener('connected', onConnected);
      resolve(false);
    }, timeoutMs);
    const onConnected = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    mongoose.connection.once('connected', onConnected);
  });
};

/**
 * Real connectivity probe rather than a readyState read — a socket can
 * report readyState 1 for a few seconds after the remote mongod restarts.
 * Used by the /ready endpoint and the /health dependency check.
 */
export const probeMongoConnection = async (timeoutMs = 2000): Promise<boolean> => {
  if (!isMongoConnected() || !mongoose.connection.db) return false;
  try {
    await Promise.race([
      mongoose.connection.db.admin().command({ ping: 1 }),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('ping timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
};

export const disconnectMongo = async (): Promise<void> => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectScheduled = false;
  await mongoose.disconnect();
};

// Test-only: resets module state between test cases so a scheduled
// reconnect timer or a stacked listener doesn't leak across tests.
export const _resetMongoStateForTest = (): void => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectScheduled = false;
  reconnectAttempt = 0;
  listenersRegistered = false;
  mongoose.connection.removeAllListeners('connected');
  mongoose.connection.removeAllListeners('disconnected');
  mongoose.connection.removeAllListeners('error');
};

export default connectToDatabase;
