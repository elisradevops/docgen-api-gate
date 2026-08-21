/**
 * Throttle-aware retry for both SharePoint transports (on-prem NTLM and
 * Online/Graph) — kept in one place so the two don't drift, same rationale
 * as sharePointFileValidation.ts.
 *
 * Neither transport had any retry/backoff/timeout handling before this —
 * a single 429/503 (or a hung request, with no timeout at all) used to
 * abort the entire recursive scan. This wraps the shared request choke
 * point (SharePointService.makeSharePointRequest / GraphSharePointService's
 * get()) rather than every call site, so callers that deliberately expect
 * failures (resolveSiteFromUrl's candidate-URL walk, up to 15 probes) are
 * NOT retried here and stay fast-fail.
 */
import logger from '../util/logger';

export const RETRYABLE_STATUSES = [429, 503];
export const MAX_RETRY_ATTEMPTS = 2; // 2 retries = 3 total attempts
export const BASE_BACKOFF_MS = 500; // 500ms, then 1000ms
export const MAX_RETRY_AFTER_MS = 5000; // clamp a hostile/huge Retry-After value
export const REQUEST_TIMEOUT_MS = 15000; // no per-request timeout existed anywhere before this
export const DEFAULT_RETRY_BUDGET_MS = 8000;

/**
 * A scan-scoped, mutable budget shared across every retried request in one
 * `listTemplateFiles` walk. Bounded concurrency (batches of folder fetches)
 * means per-request retries can otherwise stack into a much longer stall
 * than any single request's own backoff suggests — once cumulative sleep
 * across the whole walk exceeds `limitMs`, no further request in that walk
 * retries, it just surfaces its outcome immediately. Keeps a throttled scan
 * from silently exceeding the frontend's 30s preview/check-conflicts
 * timeout.
 */
export interface RetryBudget {
  spentMs: number;
  readonly limitMs: number;
}

export function createRetryBudget(limitMs: number = DEFAULT_RETRY_BUDGET_MS): RetryBudget {
  return { spentMs: 0, limitMs };
}

/**
 * Parses a `Retry-After` header value — either delta-seconds ("120") or an
 * HTTP-date — into a millisecond delay, clamped to `MAX_RETRY_AFTER_MS` so
 * a misbehaving/hostile server can't stall a request indefinitely. Returns
 * null when the header is absent or unparseable (caller falls back to
 * exponential backoff).
 */
export function parseRetryAfterMs(headerValue?: string): number | null {
  if (!headerValue) return null;

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const deltaMs = dateMs - Date.now();
    return Math.min(Math.max(deltaMs, 0), MAX_RETRY_AFTER_MS);
  }

  return null;
}

/** Prefers a server-supplied `Retry-After` over exponential backoff. */
export function backoffDelayMs(attempt: number, retryAfterHeader?: string): number {
  const fromHeader = parseRetryAfterMs(retryAfterHeader);
  if (fromHeader !== null) return fromHeader;
  return BASE_BACKOFF_MS * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ThrottleClassification {
  retryable: boolean;
  retryAfter?: string;
}

export interface WithThrottleRetryOptions {
  budget?: RetryBudget;
  label?: string;
}

/**
 * Runs `fn`, retrying with backoff when `classify` marks the outcome
 * retryable — up to `MAX_RETRY_ATTEMPTS` more times, or fewer if `opts.budget`
 * runs out first. `classify` receives the raw outcome (`value` on success,
 * `error` on rejection) rather than a normalized shape, because the two
 * SharePoint transports disagree on where a non-2xx status lives:
 * on-prem's NTLM request resolves normally even on 429/503 (status lives on
 * `outcome.value`), while Graph's OAuth request throws (status lives on
 * `outcome.error.response`). Each call site's `classify` reads whichever
 * side applies to it.
 */
export async function withThrottleRetry<T>(
  fn: () => Promise<T>,
  classify: (outcome: { value?: T; error?: any }) => ThrottleClassification,
  opts: WithThrottleRetryOptions = {}
): Promise<T> {
  const { budget, label } = opts;
  let attempt = 0;

  for (;;) {
    let outcome: { value?: T; error?: any };
    let result: T | undefined;
    let thrown: any;

    try {
      result = await fn();
      outcome = { value: result };
    } catch (err) {
      thrown = err;
      outcome = { error: err };
    }

    const { retryable, retryAfter } = classify(outcome);
    const budgetExhausted = !!budget && budget.spentMs >= budget.limitMs;

    if (!retryable || attempt >= MAX_RETRY_ATTEMPTS || budgetExhausted) {
      if (thrown) throw thrown;
      return result as T;
    }

    const delay = backoffDelayMs(attempt, retryAfter);
    if (budget) budget.spentMs += delay;
    logger.warn(
      `SharePoint request throttled${label ? ` (${label})` : ''} — retrying in ${delay}ms (attempt ${
        attempt + 1
      }/${MAX_RETRY_ATTEMPTS})`
    );
    await sleep(delay);
    attempt += 1;
  }
}
