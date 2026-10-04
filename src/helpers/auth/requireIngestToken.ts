// Request-level guard for the diagnostics ingest endpoint (POST /diagnostics/logs), the one
// path where another DocGen service — not a user session — authenticates to api-gate.
// Deliberately not requireSession: that guard resolves an AuthSession, which a service has
// none of. This is a single shared secret, service-to-service, over the internal docker
// network — the same trust model every other inter-service call in DocGen already has
// (api-gate -> content-control, api-gate -> json-to-word are unauthenticated on that same
// network today), just with one token added since this endpoint writes into a store a
// dashboard reads.
import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireIngestToken(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.DIAGNOSTICS_INGEST_TOKEN;
  // Fails closed: an unconfigured secret means ingest is unreachable, never open.
  if (!configured) {
    res.status(503).json({ message: 'Diagnostics ingest is not configured', error: 'ingest_not_configured' });
    return;
  }
  const provided = req.header('x-docgen-ingest-token');
  if (!provided || !safeEqual(provided, configured)) {
    res.status(401).json({ message: 'Invalid ingest token', error: 'ingest_unauthorized' });
    return;
  }
  next();
}
