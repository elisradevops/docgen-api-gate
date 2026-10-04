'use strict';

// The one queryable-error-store event shape, emitted by DiagnosticsTransport (logger.ts)
// and consumed by whatever LogSink this process installs (mongoLogSink.ts here; an
// HttpLogSink in docgen-content-control). err is intentionally narrow — {message, code,
// stack} — per the settled Phase 6 schema decision: no generic extra-fields bucket.
export interface DiagnosticEvent {
  ts: string;
  level: string;
  service: string;
  version: string;
  runId?: string;
  docType?: string;
  step?: string;
  contentControlType?: string;
  contentControlTitle?: string;
  project?: string;
  userId?: string;
  message: string;
  err?: { message: string; code?: string; stack?: string };
  // Phase 6b — set on a debug/info event captured under retain-on-failure. Deleted by
  // api-gate at the run's one success point; left alone (and thus permanent, subject to the
  // normal TTL) if the run fails.
  retainPending?: boolean;
}

export interface LogSink {
  push(event: DiagnosticEvent): void;
}

// Symbol.for so every duplicated copy of this file across the DocGen packages — hoisted or
// nested at any depth by npm — converges on the same installed sink, the same reasoning as
// runContext.ts's AsyncLocalStorage. data-provider and skins run in-process inside
// content-control (they're npm dependencies, not separate services), so one sink installed
// by the host process (content-control's index.ts, or api-gate's server.ts) serves every
// logger in that process. When nothing has installed a sink — a package used standalone,
// or any test — getLogSink() returns undefined and DiagnosticsTransport no-ops.
const KEY = Symbol.for('elisradevops.docgen.logSink');

export function getLogSink(): LogSink | undefined {
  return (globalThis as Record<symbol, unknown>)[KEY] as LogSink | undefined;
}

export function installLogSink(sink: LogSink): void {
  (globalThis as Record<symbol, unknown>)[KEY] = sink;
}
