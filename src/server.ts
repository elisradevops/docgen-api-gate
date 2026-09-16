import dotenv from 'dotenv';
dotenv.config();
import App from './app';
import logger from './util/logger';
import connectToDatabase, { disconnectMongo } from './util/mongodb';
import { assertAuthConfig } from './util/authConfig';

const app = new App().app;

// A Mongo-down request that isn't already caught locally (see
// requireSession/requireMongo) would otherwise surface only as an
// unhandled rejection with no response ever sent to the client. Log it
// rather than crash the process — a crash-and-restart loop is worse than a
// slow/failed individual request while Mongo is down.
process.on('unhandledRejection', (reason: any) => {
  logger.error(`Unhandled promise rejection: ${reason?.message || reason}`);
});
process.on('uncaughtException', (error: Error) => {
  logger.error(`Uncaught exception: ${error.message}`);
});

const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down`);
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
    app.listen(process.env.PORT || 3000, () => {
      logger.info(`dg-api-gate listening on port ${process.env.PORT || 3000}`);
      logger.info(`dg-content-control url: ${process.env.dgContentControlUrl}`);
      logger.info(`jsontoword url: ${process.env.jsonToWordPostUrl}`);
      logger.info(`minio root user : ${process.env.MINIO_ROOT_USER}`);
      logger.info(`minio root password : ${process.env.MINIO_ROOT_PASSWORD}`);
      logger.info(`minio region : ${process.env.MINIO_REGION}`);
      logger.info(`minio endpoint : ${process.env.MINIO_ENDPOINT}`);
    });
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};

startServer();
