// Verbose capture persists debug/info records for a run (up to the per-run cap), so it must not be
// switchable by an unauthenticated caller: x-docgen-capture-mode is an ordinary client header and
// attachRunContext only *records* the request. This turns it on only when the request's own ADO
// credentials check out — verified by content-control's existing /azure/check-org-url, so api-gate
// still never talks to Azure DevOps itself. It runs after the body is parsed, since generation
// carries its PAT in the body, not in headers.
//
// Fails closed and never blocks generation: any problem simply leaves the run in normal mode.
import { createHash } from 'crypto';
import axios from 'axios';
import logger from '../../util/logger';
import type { RunContext } from '../../util/runContext';

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const VALIDATION_TIMEOUT_MS = 10_000;

// sha256(orgUrl, PAT) -> expiry. Hashes only (the PAT is never held), positive results only, and
// bounded with oldest-first eviction. Map iteration order is insertion order.
const validated = new Map<string, number>();

function remember(key: string, now: number): void {
  validated.delete(key);
  if (validated.size >= CACHE_MAX) {
    const oldest = validated.keys().next().value;
    if (oldest !== undefined) validated.delete(oldest);
  }
  validated.set(key, now + CACHE_TTL_MS);
}

export function clearCaptureAuthorizationCache(): void {
  validated.clear();
}

export async function authorizeCaptureMode(
  runContext: RunContext | undefined,
  orgUrl: string | undefined,
  pat: string | undefined
): Promise<void> {
  const requested = runContext?.requestedCaptureMode;
  if (!runContext || !requested) return;
  try {
    if (!orgUrl || !pat) {
      logger.warn('Verbose capture requested without ADO credentials; running in normal mode');
      return;
    }
    const key = createHash('sha256').update(`${orgUrl}\u0000${pat}`).digest('hex');
    const now = Date.now();
    const cachedUntil = validated.get(key);
    if (cachedUntil === undefined || cachedUntil <= now) {
      await axios.post(
        `${process.env.dgContentControlUrl}/azure/check-org-url`,
        { orgUrl, token: pat },
        { timeout: VALIDATION_TIMEOUT_MS }
      );
      remember(key, now);
    }
    runContext.captureMode = requested;
  } catch (err: any) {
    // The message only: the AxiosError carries the request body, which holds the PAT.
    logger.warn(`Verbose capture requested but ADO credentials could not be validated; running in normal mode (${err?.message ?? 'unknown error'})`);
  }
}
