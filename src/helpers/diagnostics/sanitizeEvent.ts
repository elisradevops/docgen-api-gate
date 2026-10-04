// Turns one incoming DiagnosticEvent (from another process over POST /diagnostics/logs, or from
// this process's own logger) into a LogEvent-shaped plain object — the single allowlist/clamp
// path for both, so an own-process event gets the same bounds (and its request `context`) as a
// relayed one.
import { LOG_EVENT_RETENTION_MS } from '../../models/LogEvent';
import { computeSignature } from './signature';

export const RETAIN_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_LEN = 2000;
const MAX_STACK_LEN = 4000;

function clampString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

// Whitelists and clamps one ingested event into a LogEvent-shaped plain object, or returns
// undefined for a malformed one (dropped, not a batch-failing error). Every field is coerced
// to a string (or dropped) here — that IS the backstop for an event arriving over HTTP from
// another process: an unlisted field (a stray minioSecretKey, say) is never even read, let
// alone persisted. redactValue (util/logger.ts) isn't applicable here the way it is in
// runManifest.ts's buildInputs — it redacts sensitive *keys* inside a nested object, and
// every field surviving this allowlist is already a flat string; redacting a secret
// interpolated inline inside message/err.message/err.stack text is the same known limit the
// redact() winston format itself documents (a call-site problem, not a format one) — the
// call-site fixes upstream (Phase 1/4) are what keep sensitive values out of message text at
// the source.
const CAPTURED_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

// Keep in step with CONTEXT_LIMITS in docgen-data-provider-package/src/utils/logSink.ts.
const MAX_CONTEXT_URL_LEN = 1000;
const MAX_CONTEXT_BODY_LEN = 2000;
const MAX_CONTEXT_RESPONSE_LEN = 300;

// Allowlisted keys only, each type-checked and bounded — the sending service already
// sanitized this, but ingest is the trust boundary, so it re-validates rather than trusting
// the shape (nothing outside this list can ever reach the collection through this field).
function sanitizeContext(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const context: Record<string, unknown> = {};
  const method = clampString(c.method, 10);
  const url = clampString(c.url, MAX_CONTEXT_URL_LEN);
  const requestBody = clampString(c.requestBody, MAX_CONTEXT_BODY_LEN);
  const responseExcerpt = clampString(c.responseExcerpt, MAX_CONTEXT_RESPONSE_LEN);
  if (method) context.method = method;
  if (url) context.url = url;
  if (requestBody) context.requestBody = requestBody;
  if (responseExcerpt) context.responseExcerpt = responseExcerpt;
  if (typeof c.status === 'number' && Number.isFinite(c.status)) context.status = c.status;
  if (typeof c.attempt === 'number' && Number.isFinite(c.attempt)) context.attempt = c.attempt;
  return Object.keys(context).length ? context : undefined;
}

export function sanitizeEvent(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const event = raw as Record<string, unknown>;
  if (typeof event.level !== 'string' || !CAPTURED_LEVELS.has(event.level)) return undefined;
  if (typeof event.service !== 'string' || typeof event.message !== 'string') return undefined;

  // Only debug/info can be provisional — an error/warn is never purged on success.
  const retainPending = event.retainPending === true && (event.level === 'debug' || event.level === 'info');
  const message = clampString(event.message, MAX_MESSAGE_LEN) ?? '';
  const err =
    event.err && typeof event.err === 'object'
      ? {
          message: clampString((event.err as Record<string, unknown>).message, MAX_MESSAGE_LEN) ?? '',
          code: clampString((event.err as Record<string, unknown>).code, 100),
          stack: clampString((event.err as Record<string, unknown>).stack, MAX_STACK_LEN),
        }
      : undefined;

  return {
    ts: typeof event.ts === 'string' ? new Date(event.ts) : new Date(),
    level: event.level,
    service: clampString(event.service, 200),
    version: clampString(event.version, 100) ?? 'unknown',
    runId: clampString(event.runId, 100),
    docType: clampString(event.docType, 40),
    step: clampString(event.step, 200),
    contentControlType: clampString(event.contentControlType, 200),
    contentControlTitle: clampString(event.contentControlTitle, 200),
    project: clampString(event.project, 200),
    userId: clampString(event.userId, 200),
    message,
    err,
    context: sanitizeContext(event.context),
    signature: computeSignature(message),
    // retain-on-failure debug/info rows are provisional: kept only if the run fails. Giving them
    // a short expiry means a late arrival (one that lands after the success-time cleanup) ages
    // out on its own instead of lingering for the full retention.
    expiresAt: new Date(Date.now() + (retainPending ? RETAIN_PENDING_TTL_MS : LOG_EVENT_RETENTION_MS)),
    retainPending: retainPending ? true : undefined,
  };
}
