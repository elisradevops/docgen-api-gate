import express from 'express';
import * as bodyParser from 'body-parser';
import cors from 'cors';
import { Routes } from './routes/JsonDocRoutes';
import { injectRootSpan } from './helpers/openTracing/tracer-middleware';
import multer from 'multer'; // Import multer

export default class App {
  public app: express.Application;
  public routePrv: Routes = new Routes();
  private upload = multer({ dest: 'uploads/' }); // Configure multer with the destination folder

  constructor() {
    this.app = express();
    this.config();
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(injectRootSpan);
    this.routePrv.routes(this.app, this.upload); // Pass multer instance to routes
  }

  private config(): void {
    this.app.use(bodyParser.json());
    this.app.use(bodyParser.urlencoded({ extended: false }));
  }
}
