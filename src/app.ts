import express from 'express';
import cors, { CorsOptions } from 'cors';
import { Routes } from './routes/JsonDocRoutes';
import { injectRootSpan } from './helpers/openTracing/tracer-middleware';
import multer from 'multer'; // Import multer

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
    const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    const allowAllOrigins = !allowedOrigins.length || allowedOrigins.includes('*');
    return {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowAllOrigins || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`CORS blocked for origin: ${origin}`));
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Ado-Org-Url', 'X-Ado-PAT'],
      optionsSuccessStatus: 204,
    };
  }
}
