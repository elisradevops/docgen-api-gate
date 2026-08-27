import dotenv from 'dotenv';
dotenv.config();
import App from './app';
import logger from './util/logger';
import connectToDatabase from './util/mongodb';
import { assertAuthConfig } from './util/authConfig';

const app = new App().app;
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
