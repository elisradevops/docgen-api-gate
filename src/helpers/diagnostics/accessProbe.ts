// Who the credential of a generation request is (its identity class, and its display name: recorded on the run
// and shown in Monitoring and in exported reports on purpose, since a build service versus a named user is the
// usual explanation; log lines name only a build service), and what it can actually see in the project, on
// the run. The usual reason one run (a pipeline's build service) returns less than another with the same
// request (a person's account) is access: the two see different repositories, releases and work items,
// and Azure DevOps often answers a reader without access with a shorter list rather than a 403.
//
// api-gate never talks to Azure DevOps itself, so this asks content-control (`/azure/access-probe`), as
// the capture authorization does. Started alongside the generation and awaited only at the end, so it adds
// no latency; fails open (a probe problem never touches the run); cached per credential and project.
import { createHash } from 'crypto';
import axios from 'axios';
import logger from '../../util/logger';
import { identityKindFromConnectionData } from './captureAuthorization';

export type AccessStatus = 'ok' | 'denied' | 'notFound' | 'error';
export interface AccessArea {
  status: AccessStatus;
  httpStatus?: number;
  count?: number;
}
export const ACCESS_AREAS = ['project', 'repositories', 'workItems', 'builds', 'releases', 'testPlans'] as const;
export type AccessAreaName = (typeof ACCESS_AREAS)[number];
export type ProjectAccess = Partial<Record<AccessAreaName, AccessArea>>;

export interface AccessProbeResult {
  identity?: { name?: string; class: 'build-service' | 'user' | 'unknown' };
  access: ProjectAccess;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const PROBE_TIMEOUT_MS = 12_000;
const NAME_MAX = 120;

const cache = new Map<string, { until: number; result: AccessProbeResult }>();

export function clearAccessProbeCache(): void {
  cache.clear();
}

/** ACCESS_PROBE=off switches the probe off; anything else leaves it on. Read at call time. */
export function accessProbeEnabled(raw: string | undefined = process.env.ACCESS_PROBE): boolean {
  return String(raw ?? '').trim().toLowerCase() !== 'off';
}

// A display name is shown in screens and exported reports: drop control characters (log and document
// injection), trim and bound it.
export function sanitizeIdentityName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  return name || undefined;
}

function shape(data: any): AccessProbeResult | undefined {
  if (!data || typeof data !== 'object' || !data.access || typeof data.access !== 'object') return undefined;
  const identity = data.identity && typeof data.identity === 'object' ? data.identity : undefined;
  return {
    identity: identity
      ? {
          name: sanitizeIdentityName(identity.customDisplayName) ?? sanitizeIdentityName(identity.providerDisplayName),
          class: identityKindFromConnectionData({ authenticatedUser: identity }),
        }
      : undefined,
    access: data.access as ProjectAccess,
  };
}

export async function startAccessProbe(
  orgUrl: string | undefined,
  pat: string | undefined,
  project: string | undefined
): Promise<AccessProbeResult | undefined> {
  if (!accessProbeEnabled() || !orgUrl || !pat || !project) return undefined;
  const key = createHash('sha256').update(`${orgUrl}\u0000${pat}\u0000${project}`).digest('hex');
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.until > now) return cached.result;
  try {
    const response = await axios.post(
      `${process.env.dgContentControlUrl}/azure/access-probe`,
      { orgUrl, token: pat, projectName: project },
      { timeout: PROBE_TIMEOUT_MS }
    );
    const result = shape(response?.data);
    if (!result) return undefined;
    cache.delete(key);
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { until: now + CACHE_TTL_MS, result });
    return result;
  } catch (err: any) {
    // The message only: the AxiosError carries the request body, which holds the PAT. Not a warning: the
    // probe is diagnostic and must not add noise to a run it could not affect.
    logger.debug(`Access probe unavailable: ${err?.message ?? 'unknown error'}`);
    return undefined;
  }
}

const AREA_LABEL: Record<AccessAreaName, string> = {
  project: 'the project',
  repositories: 'repositories',
  workItems: 'work items',
  builds: 'build definitions',
  releases: 'release definitions',
  testPlans: 'test plans',
};

/**
 * One sentence when the credential cannot read something the run is likely to need, so the cause of an
 * otherwise "successful but empty" run is visible without opening anything. Empty builds, releases and
 * test plans are normal for many projects and are not reported; denials, an invisible project, and no
 * repositories or work items at all are.
 */
export function describeAccessProblems(result: AccessProbeResult, project: string): string | undefined {
  // Log lines are persisted and searchable by everyone with access to Monitoring: a build service's name
  // (a service account) is named, a person's is not.
  const who =
    result.identity?.class === 'build-service'
      ? result.identity.name || 'a build service identity'
      : result.identity?.class === 'user'
        ? 'the user'
        : 'the credential';
  const problems: string[] = [];
  for (const area of ACCESS_AREAS) {
    const outcome = result.access[area];
    if (!outcome) continue;
    if (outcome.status === 'denied') problems.push(`cannot read ${AREA_LABEL[area]} (${outcome.httpStatus ?? 'denied'})`);
    else if (area === 'project' && outcome.status === 'notFound') problems.push('does not see the project in its project list');
    else if ((area === 'repositories' || area === 'workItems') && outcome.status === 'ok' && outcome.count === 0) {
      problems.push(`sees no ${AREA_LABEL[area]}`);
    }
  }
  if (problems.length === 0) return undefined;
  return `${who} ${problems.join(', ')} in project ${sanitizeIdentityName(project) ?? 'unknown'}; a document generated with it can be empty or incomplete.`;
}
