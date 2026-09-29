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
export function resolveRunId(headerValue: string | string[] | undefined): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (raw && RUN_ID_PATTERN.test(raw)) return raw;
  return randomUUID();
}

// First middleware in the chain (see app.ts) so the whole request lifecycle — including
// every downstream axios call made while handling it — runs inside the run context. Mints
// once per incoming request, which for createJSONDoc means once per generation, not once
// per outbound call.
export function attachRunContext(req: Request, res: Response, next: NextFunction): void {
  const rawHeader = req.header('x-docgen-run-id');
  const wasClientSupplied = typeof rawHeader === 'string' && RUN_ID_PATTERN.test(rawHeader);
  const runId = resolveRunId(rawHeader);
  const captureMode = resolveCaptureMode(req.header('x-docgen-capture-mode'));
  // Echoed back so a pipeline caller that didn't send one can pick up the minted id (Phase 5).
  res.setHeader('x-docgen-run-id', runId);
  runContextStore.run({ runId, trigger: wasClientSupplied ? 'ui' : 'pipeline', captureMode }, next);
}

// Forwards the ambient runId as an outbound header on every request made through the given
// axios instance, so content-control/json-to-word see the same id api-gate is logging
// under. A no-op outside a run (e.g. a call made at module load, before any request).
// `axios.create()` instances (DataProviderController's ccClient) don't share the default
// instance's interceptors, so each one needs this called on it explicitly; the plain
// `import axios from 'axios'` default instance used elsewhere in this repo only needs it
// installed once, since every such import resolves to the same module-cached singleton.
export function installRunIdForwarding(instance: AxiosInstance): void {
  instance.interceptors.request.use((config) => {
    const store = runContextStore.getStore();
    if (store?.runId) {
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
        (config.headers as Record<string, string>)['x-docgen-doc-type'] = store.docType;
      }
      // Phase 7c — project is set by DocumentsGeneratorController.createRunRecord after the
      // store is already open; it's available by the time any outbound call is made.
      if (store.project) {
        (config.headers as Record<string, string>)['x-docgen-project'] = store.project;
      }
    }
    return config;
  });
}
