'use strict';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AxiosInstance } from 'axios';

export interface RunContext {
  runId: string;
  // Best-effort, not an authenticated signal: 'ui' means the caller supplied a valid
  // x-docgen-run-id (the frontend does this per Phase 3); 'pipeline' means api-gate had to
  // mint one. /jsonDocument/create carries no session middleware to derive this more directly.
  // Optional because only attachRunContext ever sets it — other store.run(...) call sites
  // (tests, other repos' copies of this file) have no notion of trigger.
  trigger?: 'ui' | 'pipeline';
  // Phase 6b — per-run capture policy read by DiagnosticsTransport (logger.ts). Absent means
  // 'normal' (today's warn/error-only behavior), the same optionality contract as `trigger`.
  // Client-settable (x-docgen-capture-mode), so same trust-boundary treatment as runId: only
  // the two named values survive attachRunContext's validation, anything else is dropped.
  captureMode?: 'verbose' | 'retain-on-failure';
  // What the client asked for via x-docgen-capture-mode. NOT acted on: the header is
  // unauthenticated, so attachRunContext only records the request. captureMode above is set
  // later, by authorizeCaptureMode (helpers/diagnostics/captureAuthorization.ts), once the
  // request's ADO credentials have been verified.
  requestedCaptureMode?: 'verbose' | 'retain-on-failure';
  // The frontend's working session (ses-<uuid>): picker calls are logged under it as their run id
  // and the generation that follows records it on its DocumentRun, so the activity that led up to
  // a run can be shown with it. Only generation reads this.
  sessionId?: string;
  // Phase 7b — set by DocumentsGeneratorController.createRunRecord *after* attachRunContext has
  // already started the store's run() call, since docType and project are only knowable once
  // the request body (not just headers) has been parsed. runContextStore.run(obj, next) stores
  // an object reference, so mutating it here is visible to everything downstream in the same
  // request, including installRunIdForwarding's interceptor on every later outbound call — no
  // header at middleware time the way captureMode has one.
  docType?: string;
  project?: string;
}

// Symbol.for uses the global symbol registry, so every duplicated copy of this file across
// the DocGen packages — hoisted or nested at any depth by npm — converges on the same
// AsyncLocalStorage instance. Keying by module identity instead would silently split into
// two stores and runId would go missing with no visible error.
const KEY = Symbol.for('elisradevops.docgen.runContext');

export const runContextStore: AsyncLocalStorage<RunContext> =
  ((globalThis as Record<symbol, unknown>)[KEY] as AsyncLocalStorage<RunContext> | undefined) ??
  ((globalThis as Record<symbol, unknown>)[KEY] = new AsyncLocalStorage<RunContext>());

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CAPTURE_MODES = new Set(['verbose', 'retain-on-failure']);

function resolveCaptureMode(headerValue: string | string[] | undefined): 'verbose' | 'retain-on-failure' | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return raw && CAPTURE_MODES.has(raw) ? (raw as 'verbose' | 'retain-on-failure') : undefined;
}

// api-gate is the trust boundary for x-docgen-run-id (Key Decision #5): it is
// client-settable by the frontend or an SVD pipeline caller, so it must be validated
// before ever entering a log field or being forwarded downstream, or it's log injection
// plus an unbounded field. An absent or malformed value is replaced with a freshly
// minted id rather than passed through — this is also what "prefer the frontend-supplied
// documentId when present and valid" means once the frontend sends it as this header.
export function resolveRunId(headerValue: string | string[] | undefined, mintPrefix = ''): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (raw && RUN_ID_PATTERN.test(raw)) return raw;
  return `${mintPrefix}${randomUUID()}`;
}

// Only document generation has a DocumentRun. Every other request (the pickers' test-plan /
// query / project lookups, dashboard polling, ...) still needs a correlation id for its log
// lines, but presenting a bare uuid as a "run" sent people hunting for a run that never
// existed. Those ids are minted with this prefix, so they read as what they are — and still
// fit RUN_ID_PATTERN (<= 64 chars: 4 + 36). A client-supplied valid id is never re-prefixed.
export const REQUEST_ID_PREFIX = 'req-';
const GENERATION_PATH = '/jsondocument/create';
function isGenerationRequest(req: Request): boolean {
  const path = typeof req.path === 'string' ? req.path.replace(/\/+$/, '').toLowerCase() : undefined;
  // An unknown path (nothing to judge by) is treated as generation: the safe default keeps
  // plain run ids rather than mislabelling a real run as a request.
  return path === undefined || path === GENERATION_PATH;
}

export const SESSION_ID_PREFIX = 'ses-';
const SESSION_ID_PATTERN = /^ses-[A-Za-z0-9_-]{1,60}$/;

/** True for ids that only correlate log lines (a request or a session) — there is no run behind them. */
export function isCorrelationOnlyId(id: string | undefined): boolean {
  return !!id && (id.startsWith(REQUEST_ID_PREFIX) || id.startsWith(SESSION_ID_PREFIX));
}

function resolveSessionId(headerValue: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return raw && SESSION_ID_PATTERN.test(raw) ? raw : undefined;
}

// x-docgen-project / x-docgen-doc-type come from the picker calls (project names may be non-ASCII,
// so the frontend percent-encodes them). Client-settable, so same treatment as every other header
// that reaches a log field: decode defensively, drop control characters (log injection), trim, bound.
const PROJECT_MAX = 128;
const DOC_TYPE_MAX = 40;
export function sanitizeContextHeader(headerValue: string | string[] | undefined, max: number): string | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== 'string' || !raw) return undefined;
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // not percent-encoded (or malformed): use as sent
  }
  value = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return value || undefined;
}

// First middleware in the chain (see app.ts) so the whole request lifecycle — including
// every downstream axios call made while handling it — runs inside the run context. Mints
// once per incoming request, which for createJSONDoc means once per generation, not once
// per outbound call.
export function attachRunContext(req: Request, res: Response, next: NextFunction): void {
  const rawHeader = req.header('x-docgen-run-id');
  const wasClientSupplied = typeof rawHeader === 'string' && RUN_ID_PATTERN.test(rawHeader);
  const runId = resolveRunId(rawHeader, isGenerationRequest(req) ? '' : REQUEST_ID_PREFIX);
  const requestedCaptureMode = resolveCaptureMode(req.header('x-docgen-capture-mode'));
  // Echoed back so a pipeline caller that didn't send one can pick up the minted id (Phase 5).
  res.setHeader('x-docgen-run-id', runId);
  const generation = isGenerationRequest(req);
  // For generation, project and doc type come from the request body (createRunRecord) — the
  // headers are not trusted there. For every other request (the pickers) they are the only
  // source, and are what lets those records be filtered by project and doc type.
  const project = generation ? undefined : sanitizeContextHeader(req.header('x-docgen-project'), PROJECT_MAX);
  const docType = generation
    ? undefined
    : sanitizeContextHeader(req.header('x-docgen-doc-type'), DOC_TYPE_MAX)?.toUpperCase();
  runContextStore.run(
    {
      runId,
      trigger: wasClientSupplied ? 'ui' : 'pipeline',
      requestedCaptureMode,
      sessionId: resolveSessionId(req.header('x-docgen-session-id')),
      docType,
      project,
    },
    next
  );
}

// The correlation headers are for DocGen's own services. The default axios instance is also used
// for SharePoint/Graph and presigned-URL calls, which must not receive a run id, project name or
// doc type — so headers are added only when the request targets content-control or json-to-word
// (origins read at call time, like the rest of this repo's config).
function internalOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const raw of [process.env.dgContentControlUrl, process.env.jsonToWordPostUrl]) {
    if (!raw) continue;
    try {
      origins.add(new URL(raw).origin);
    } catch {
      // an unparsable configured URL simply contributes no allowed origin
    }
  }
  return origins;
}

function isInternalTarget(config: { url?: string; baseURL?: string }): boolean {
  try {
    const target = new URL(config.url ?? '', config.baseURL);
    return internalOrigins().has(target.origin);
  } catch {
    return false;
  }
}

// Forwards the ambient runId as an outbound header on every request to an internal DocGen service
// made through the given axios instance, so content-control/json-to-word see the same id api-gate is logging
// under. A no-op outside a run (e.g. a call made at module load, before any request).
// `axios.create()` instances (DataProviderController's ccClient) don't share the default
// instance's interceptors, so each one needs this called on it explicitly; the plain
// `import axios from 'axios'` default instance used elsewhere in this repo only needs it
// installed once, since every such import resolves to the same module-cached singleton.
// HTTP header values must be printable ASCII; Node refuses to send anything else ("Invalid character
// in header content"), which failed the whole call for a project with a non-ASCII name. Such values
// are percent-encoded (content-control decodes them); an ASCII value goes through exactly as before,
// so what json-to-word and content-control show for ordinary names is unchanged.
export function toHeaderValue(value: string): string {
  return /[^\x20-\x7e]/.test(value) ? encodeURIComponent(value) : value;
}

export function installRunIdForwarding(instance: AxiosInstance): void {
  instance.interceptors.request.use((config) => {
    const store = runContextStore.getStore();
    if (store?.runId && isInternalTarget(config)) {
      config.headers = config.headers ?? {};
      (config.headers as Record<string, string>)['x-docgen-run-id'] = store.runId;
      // Phase 6b — content-control's own attachRunContext reads this the same way it reads
      // x-docgen-run-id, so a run's capture mode survives the hop into the next process.
      if (store.captureMode) {
        (config.headers as Record<string, string>)['x-docgen-capture-mode'] = store.captureMode;
      }
      // Phase 7b — content-control's own attachRunContext reads this the same way it reads
      // x-docgen-capture-mode, so docType survives the hop into the next process.
      if (store.docType) {
        (config.headers as Record<string, string>)['x-docgen-doc-type'] = toHeaderValue(store.docType);
      }
      // Phase 7c — project is set by DocumentsGeneratorController.createRunRecord after the
      // store is already open; it's available by the time any outbound call is made.
      if (store.project) {
        (config.headers as Record<string, string>)['x-docgen-project'] = toHeaderValue(store.project);
      }
    }
    return config;
  });
}
