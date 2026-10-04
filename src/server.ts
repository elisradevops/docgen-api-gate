import dotenv from 'dotenv';
dotenv.config();
import App from './app';
import logger from './util/logger';
import connectToDatabase, { disconnectMongo } from './util/mongodb';
import { assertAuthConfig } from './util/authConfig';
import { installMongoLogSink, MongoLogSink } from './services/diagnostics/mongoLogSink';

const app = new App().app;
let diagnosticsSink: MongoLogSink | undefined;
let server: ReturnType<typeof app.listen> | undefined;

// A Mongo-down request that isn't already caught locally (see
// requireSession/requireMongo) would otherwise surface only as an
// unhandled rejection with no response ever sent to the client. Log it
// rather than crash the process — a crash-and-restart loop is worse than a
// slow/failed individual request while Mongo is down.
process.on('unhandledRejection', (reason: any) => {
  logger.error(`Unhandled promise rejection: ${reason?.message || reason}`, reason);
});
// Unlike unhandledRejection above, an uncaught synchronous exception means the process is in an
// unknown state — continuing risks corrupted in-memory state, not just one failed request.
process.on('uncaughtException', (error: Error) => {
  logger.error(`Uncaught exception: ${error.message}`, error);
  // MongoLogSink.push() only flushes immediately at FLUSH_BATCH_SIZE (500) buffered events —
  // otherwise this record sits in memory until the next FLUSH_INTERVAL_MS timer tick (2s
  // default), which process.exit() would never let happen. Give it one short, bounded chance to
  // flush before exiting, so the crash's own diagnostic record isn't the one thing lost.
  const flushDeadline = new Promise<void>((resolve) => setTimeout(resolve, 2000).unref());
  Promise.race([diagnosticsSink?.flush() ?? Promise.resolve(), flushDeadline]).finally(() => {
    process.exit(1);
  });
});

const envShutdownMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '', 10);
const SHUTDOWN_TIMEOUT_MS = Number.isFinite(envShutdownMs) && envShutdownMs > 0 ? envShutdownMs : 10000;

// Bounded — a genuinely stuck in-flight request must not block shutdown indefinitely. Falls
// back to force-continuing after SHUTDOWN_TIMEOUT_MS rather than waiting for Kubernetes' own
// SIGKILL at the end of the termination grace period.
const closeServer = (): Promise<void> =>
  new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.error(`HTTP server did not close within ${SHUTDOWN_TIMEOUT_MS}ms — forcing shutdown with connections still open`);
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
    server.close(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });

const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down`);
  // Stop accepting new connections and let in-flight requests finish before tearing down the
  // dependencies they might still be using — previously the server was never closed, so SIGTERM
  // cut off in-flight requests immediately.
  await closeServer();
  // Flush before disconnecting — a buffered-but-unflushed batch would otherwise be lost, and
  // disconnectMongo() below would make the flush no-op anyway (isMongoConnected() reads false).
  diagnosticsSink?.stop();
  await diagnosticsSink?.flush();
  // An open MongoClient socket keeps the event loop alive and can block
  // graceful pod termination.
  await disconnectMongo();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const startServer = async () => {
  try {
    // Fail fast on a misconfigured OAuth/session env (missing CLIENT_SECRET,
    // http:// REDIRECT_URI, wildcard CORS_ALLOWED_ORIGINS, etc.) before
    // accepting any traffic.
    assertAuthConfig();
    await connectToDatabase();
    diagnosticsSink = installMongoLogSink();
    server = app.listen(process.env.PORT || 3000, () => {
      logger.info(`dg-api-gate listening on port ${process.env.PORT || 3000}`);
      logger.info(`dg-content-control url: ${process.env.dgContentControlUrl}`);
      logger.info(`jsontoword url: ${process.env.jsonToWordPostUrl}`);
      logger.info(`minio root user : ${process.env.MINIO_ROOT_USER}`);
      logger.info(`minio region : ${process.env.MINIO_REGION}`);
      logger.info(`minio endpoint : ${process.env.MINIO_ENDPOINT}`);
    });
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};

startServer();
