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

type IdentityKind = NonNullable<RunContext['identityKind']>;

// sha256(orgUrl, PAT) -> expiry and the identity class. Hashes only (the PAT is never held), positive
// results only, and bounded with oldest-first eviction. Map iteration order is insertion order.
const validated = new Map<string, { until: number; identityKind: IdentityKind }>();

function remember(key: string, now: number, identityKind: IdentityKind): void {
  validated.delete(key);
  if (validated.size >= CACHE_MAX) {
    const oldest = validated.keys().next().value;
    if (oldest !== undefined) validated.delete(oldest);
  }
  validated.set(key, { until: now + CACHE_TTL_MS, identityKind });
}

// The class of identity behind a credential, from Azure DevOps' connectionData (the response of the
// check this module already makes). Only the class: a name could identify a person, and the class is
// what explains "the pipeline sees nothing the user sees" (a build service identity has its own, usually
// narrower, permissions).
export function identityKindFromConnectionData(connectionData: any): IdentityKind {
  const user = connectionData?.authenticatedUser;
  if (!user || typeof user !== 'object') return 'unknown';
  const descriptor = String(user.descriptor || '');
  const names = [user.providerDisplayName, user.customDisplayName].map((n) => String(n || ''));
  if (/ServiceIdentity/i.test(descriptor) || names.some((n) => /build service/i.test(n))) return 'build-service';
  return 'user';
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
    const cached = validated.get(key);
    if (cached === undefined || cached.until <= now) {
      const response = await axios.post(
        `${process.env.dgContentControlUrl}/azure/check-org-url`,
        { orgUrl, token: pat },
        { timeout: VALIDATION_TIMEOUT_MS }
      );
      const identityKind = identityKindFromConnectionData(response?.data?.data);
      remember(key, now, identityKind);
      runContext.identityKind = identityKind;
    } else {
      runContext.identityKind = cached.identityKind;
    }
    runContext.captureMode = requested;
  } catch (err: any) {
    // The message only: the AxiosError carries the request body, which holds the PAT.
    logger.warn(`Verbose capture requested but ADO credentials could not be validated; running in normal mode (${err?.message ?? 'unknown error'})`);
  }
}
