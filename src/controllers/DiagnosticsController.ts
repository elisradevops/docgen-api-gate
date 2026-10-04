import { Request, Response } from 'express';
import { sanitizeEvent } from '../helpers/diagnostics/sanitizeEvent';
import { getIngestSink } from '../services/diagnostics/mongoLogSink';
import { isMongoConnected } from '../util/mongodb';

const MAX_BATCH_SIZE = 500;

export class DiagnosticsController {
  // POST /diagnostics/logs — the relay path for services with no Mongo credentials of their
  // own (docgen-content-control, forwarding its own logger's events plus
  // docgen-data-provider-package's and docgen-dg-skins-package's, which run in-process
  // inside it). api-gate's own events go straight through MongoLogSink instead.
  //
  // Validates and enqueues, then replies 202: persistence (per-run cap, insert, Issue upserts)
  // happens in MongoLogSink's batched, bounded flush, so a slow Mongo never holds a request open
  // and a flood is shed by the sink's drop-oldest policy rather than piling up connections.
  public async ingestLogs(req: Request, res: Response): Promise<void> {
    if (!isMongoConnected()) {
      res.status(503).json({ message: 'Diagnostics store unavailable', error: 'db_unavailable' });
      return;
    }
    const events = Array.isArray(req.body?.events) ? req.body.events : undefined;
    if (!events) {
      res.status(400).json({ message: 'Expected { events: [...] }', error: 'invalid_payload' });
      return;
    }
    const batch = events.slice(0, MAX_BATCH_SIZE);
    const sanitized = batch.map(sanitizeEvent).filter((e: unknown): e is Record<string, unknown> => !!e);
    const rejected = batch.length - sanitized.length;
    getIngestSink().enqueueDocs(sanitized);
    res.status(202).json({ accepted: sanitized.length, rejected });
  }
}
