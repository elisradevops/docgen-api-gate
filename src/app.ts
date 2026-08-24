import express from 'express';
import cors, { CorsOptions } from 'cors';
import { Routes } from './routes/JsonDocRoutes';
import { injectRootSpan } from './helpers/openTracing/tracer-middleware';
import multer from 'multer'; // Import multer
import { getAllowedOrigins } from './util/authConfig';
import logger from './util/logger';

export default class App {
  public app: express.Application;
  public routePrv: Routes = new Routes();
  private upload = multer({
    dest: 'uploads/',
    limits: { fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE_BYTES || 50 * 1024 * 1024) },
  }); // Configure multer with destination and file size cap

  constructor() {
    this.app = express();
    this.config();
    const corsOptions = this.createCorsOptions();
    this.app.use(cors(corsOptions));
    this.app.options('*', cors(corsOptions));
    this.app.use(injectRootSpan);
    this.routePrv.routes(this.app, this.upload); // Pass multer instance to routes
  }

  private config(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: false }));
  }

  private createCorsOptions(): CorsOptions {
    // Unset/empty CORS_ALLOWED_ORIGINS means "trust no cross-origin
    // request" — allow-all plus credentials:true below would be a
    // session-theft hole for the SharePoint auth cookie.
    let allowedOrigins: string[] = [];
    try {
      allowedOrigins = getAllowedOrigins();
      if (allowedOrigins.length === 0) {
        logger.warn(
          'CORS_ALLOWED_ORIGINS is unset — all cross-origin browser requests will be blocked. Set it to the frontend origin(s) if the app is served from a different origin than this API.'
        );
      }
    } catch (error) {
      // Fail loud but not fatal at construction time (existing tests build
      // `new App()` with no env at all) — assertAuthConfig() in server.ts
      // is the actual boot-time hard stop for a genuinely misconfigured
      // deployment.
      logger.error(`Invalid CORS_ALLOWED_ORIGINS configuration: ${error.message}`);
    }

    return {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`CORS blocked for origin: ${origin}`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Ado-Org-Url', 'X-Ado-PAT', 'X-User-Id', 'Authorization', 'X-Csrf-Token'],
      optionsSuccessStatus: 204,
    };
  }
}
