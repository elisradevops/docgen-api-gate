// Request-level guard for Mongo-backed routes (Favorites). Without this,
// a query issued while MongoDB is unreachable buffers for mongoose's
// default 10s and then surfaces as a generic 500 "buffering timed out"
// error. This waits briefly for the background reconnect loop in
// util/mongodb to catch up and, failing that, returns a fast, honest,
// retryable 503 instead.
import { Response, NextFunction } from 'express';
import { ensureMongoConnection } from '../../util/mongodb';

const DB_WAIT_MS = Number(process.env.MONGODB_REQUEST_WAIT_MS) || 3000;

export async function requireMongo(_req: any, res: Response, next: NextFunction): Promise<void> {
  if (await ensureMongoConnection(DB_WAIT_MS)) {
    next();
    return;
  }

  res.set({ 'Retry-After': '5' });
  res.status(503).json({
    message: 'Database temporarily unavailable, reconnecting. Please retry.',
    error: 'db_unavailable',
  });
}
