import axios from 'axios';
import logger from '../util/logger';
import {
  SharePointFile,
  SharePointFileListing,
  SharePointOAuthToken,
  SkippedFolder,
  MAX_RECURSION_DEPTH,
  MAX_RECURSION_FILES,
  MAX_SKIPPED_FOLDERS_RECORDED,
  CONCURRENT_FOLDER_FETCHES,
} from './SharePointService';
import { withThrottleRetry, createRetryBudget, RetryBudget, RETRYABLE_STATUSES, REQUEST_TIMEOUT_MS } from './sharePointRetry';
import { isTemplateFileName, isWithinMaxTemplateSize } from './sharePointFileValidation';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

// One BFS queue entry — a folder's "list children" URL still to walk.
// `relativePath` is that folder's own path relative to the shared root
// ('' at the root itself); `parentName` is undefined only at the root, so
// files found there correctly get no docType.
type GraphFolderQueueItem = { childrenUrl: string; relativePath: string; depth: number; parentName?: string };

// Result of fetching one folder's children. `files` is populated even when
// `skipped` is also set — mirrors SharePointService's FetchFolderResult.
interface GraphFetchFolderResult {
  files: SharePointFile[];
  subfoldersToEnqueue: GraphFolderQueueItem[];
  skipped?: { relativePath: string; reason: string };
  depthCapped?: boolean;
}

// Hostnames a pasted "share this" link is allowed to point at. Without this,
// pasting a non-Microsoft URL into the Online tab fails deep inside the
// /shares/{id}/driveItem Graph call with a confusing Graph error instead of
// a clear one up front. Matches the allowlist a sibling project's production
// Graph-ingestion implementation uses for this same pattern.
const ALLOWED_SHARE_HOST_SUFFIXES = ['sharepoint.com', 'onedrive.com', 'sharepoint.us', 'onedrive.live.com'];

function isMicrosoftSharingUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.includes('1drv.ms')) return true;
  return ALLOWED_SHARE_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/**
 * Two distinct URL shapes reach this code in practice:
 *
 *  1. A "Copy Link" sharing URL (what SharePoint's Share dialog issues),
 *     e.g. https://tenant.sharepoint.com/:f:/r/teams/x/Shared Documents/y?d=<id>&...
 *     Graph's /shares endpoint is Microsoft's documented mechanism for
 *     resolving exactly this kind of token-bearing sharing URL directly to
 *     a driveItem.
 *
 *  2. A plain browsed-folder address-bar URL — what a user gets by
 *     navigating into the folder and copying the URL, NOT clicking "Copy
 *     Link". This is actually the far more common case in practice. Its
 *     shape is a library view page (.../Forms/AllItems.aspx) with the real
 *     folder identified by a `?...&id=<url-encoded-server-relative-path>`
 *     query parameter that SharePoint's page script reads client-side —
 *     Graph has no built-in understanding of this `id=` convention, and
 *     resolving the *page* URL via /shares would likely resolve to the
 *     library root or the page itself, not the nested folder — a silent
 *     wrong-target risk, worse than an outright error.
 *
 * This distinguishes the two by checking for a path-shaped `id` query
 * parameter, and returns the decoded server-relative folder path for shape
 * 2 so callers can resolve it via site-path walking instead of /shares.
 */
function parseAllItemsFolderPath(url: string): { hostname: string; folderPath: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const idParam = parsed.searchParams.get('id');
  if (!idParam || !idParam.startsWith('/')) return null;
  return { hostname: parsed.hostname, folderPath: decodeURIComponent(idParam) };
}

/**
 * Reads a SharePoint/OneDrive folder from a user-pasted URL, using a bearer
 * token supplied by the caller (e.g. pasted from Graph Explorer). Accepts
 * two distinct URL shapes a user might actually paste — see
 * parseAllItemsFolderPath's doc comment for why they need different
 * resolution paths:
 *  - a "Copy Link" sharing URL, resolved via Graph's /shares endpoint
 *    (mirrors the pattern already proven in req2ado's graph_client.py)
 *  - a plain browsed-folder address-bar URL, resolved by walking the
 *    server-relative path to find its site, then addressing the remaining
 *    path within that site's default drive
 */
export class GraphSharePointService {
  /**
   * Encodes a sharing URL into the opaque "shareId" Graph's /shares endpoint
   * expects: "u!" + unpadded base64url(url). See:
   * https://learn.microsoft.com/graph/api/shares-get
   *
   * Single choke point for both public methods below — validates the URL is
   * actually a Microsoft SharePoint/OneDrive link *before* any network call,
   * rather than letting a mispasted URL fail deep inside the Graph request.
   */
  private encodeShareId(url: string): string {
    if (!isMicrosoftSharingUrl(url)) {
      throw new Error(
        'That doesn’t look like a SharePoint or OneDrive link — expected a sharepoint.com, onedrive.com, or 1drv.ms URL'
      );
    }
    const base64 = Buffer.from(url, 'utf-8').toString('base64');
    const urlSafe = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `u!${urlSafe}`;
  }

  private errorForStatus(status: number): Error {
    const messages: Record<number, string> = {
      401: 'Graph access token expired or invalid — paste a fresh one',
      403: 'This token does not have permission to read this SharePoint folder',
      404: 'SharePoint folder not found for this sharing link',
    };
    // Carry the real status through so callers can respond 4xx (an expired
    // token is an expected client-side condition, not a server error) rather
    // than an unconditional 500.
    const error: any = new Error(messages[status] || `Microsoft Graph error: ${status}`);
    error.status = status >= 400 && status < 500 ? status : 502;
    return error;
  }

  /**
   * `retryBudget`, when passed, is shared across every request in one
   * `listTemplateFiles` walk — see sharePointRetry.ts's doc comment for why
   * that matters once folder fetches run concurrently. Callers that don't
   * pass one (testShareAccess, resolveFolderByPath's candidate-path walk,
   * etc.) still get up to 2 retries per call, just not budget-capped across
   * calls — acceptable since only genuine 429/503 responses are retryable,
   * never the 404s that walk expects from a wrong candidate.
   */
  private async get(url: string, accessToken: string, retryBudget?: RetryBudget): Promise<any> {
    return withThrottleRetry(
      () =>
        axios.get(url, {
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            // Documented specifically for /shares/...: without it, Graph may
            // refuse to fully resolve a sharing link the caller hasn't
            // "redeemed" before (equivalent to a user never having opened the
            // link in a browser under this identity), surfacing as a 403 even
            // with a token that holds sufficient Files.Read.All/Sites.Read.All
            // scope. "IfNecessary" only grants access for this request's
            // duration, matching what a read-only template sync needs. Sent
            // on every call, not just /shares — Prefer is advisory HTTP, and
            // the /sites and /drives endpoints this service also calls simply
            // ignore a Prefer value they don't recognize.
            Prefer: 'redeemSharingLinkIfNecessary',
          },
        }),
      (outcome) => {
        const status = outcome.error?.response?.status;
        return {
          retryable: RETRYABLE_STATUSES.includes(status),
          // Read Retry-After BEFORE errorForStatus() maps the error below —
          // that mapping discards the original response/headers entirely.
          retryAfter: outcome.error?.response?.headers?.['retry-after'],
        };
      },
      { budget: retryBudget, label: url }
    ).catch((error: any) => {
      if (error.response) {
        // Never log the token; the URL itself carries no secret (Graph
        // resource paths, not signed download URLs) so it's safe to log for
        // diagnosing exactly which resolution step failed and why.
        logger.warn(`Graph request failed (${error.response.status}): ${url}`);
        throw this.errorForStatus(error.response.status);
      }
      throw new Error(`Could not reach Microsoft Graph: ${error.message}`);
    });
  }

  private isPrivateHost(hostname: string): boolean {
    return (
      hostname === 'localhost' ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^169\.254\./.test(hostname)
    );
  }

  /**
   * Resolves a browsed folder's server-relative path (extracted from an
   * AllItems.aspx `id=` query param) to a folder driveItem, without ever
   * assuming where the site boundary sits within that path — Graph's
   * `/sites/{hostname}:/{path}` 404s unless `{path}` is exactly a site's own
   * path (no "nearest site" resolution the way on-prem SharePoint REST's
   * `_api/web` provides — see SharePointService.resolveSiteFromUrl for that
   * on-prem equivalent). So this walks the path from longest to shortest
   * prefix, trying each as a candidate site path, until one resolves.
   *
   * Once the site is found, the remaining path suffix (what's left after
   * the matched site path) is resolved against that site's default drive
   * via the documented `/sites/{siteId}/drive/root:/{path}:` addressing.
   */
  private async resolveFolderByPath(
    hostname: string,
    folderPath: string,
    accessToken: string
  ): Promise<{ driveId: string; itemId: string }> {
    const segments = folderPath.split('/').filter(Boolean);

    for (let splitAt = segments.length; splitAt >= 1; splitAt--) {
      const candidateSitePath = segments.slice(0, splitAt).join('/');
      const encodedSitePath = candidateSitePath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');

      let siteResponse: any;
      try {
        siteResponse = await this.get(`${GRAPH_BASE_URL}/sites/${hostname}:/${encodedSitePath}`, accessToken);
      } catch (error: any) {
        // A 404 here just means this prefix isn't the site boundary — keep
        // walking to a shorter prefix. Any other failure (401/403/network)
        // is real and should surface immediately, not be swallowed by the
        // walk loop.
        if (error.message && error.message.includes('not found')) continue;
        throw error;
      }

      const siteId = siteResponse.data.id;
      const remainingSegments = segments.slice(splitAt);
      if (remainingSegments.length === 0) {
        throw new Error('This link points to a site, not a folder inside a document library');
      }
      const remainingPath = remainingSegments.map((segment) => encodeURIComponent(segment)).join('/');

      const folderResponse = await this.get(`${GRAPH_BASE_URL}/sites/${siteId}/drive/root:/${remainingPath}:`, accessToken);
      return { driveId: folderResponse.data.parentReference?.driveId, itemId: folderResponse.data.id };
    }

    throw new Error('Could not resolve a SharePoint site from this folder link');
  }

  /**
   * Downloads Graph's own pre-signed @microsoft.graph.downloadUrl. No
   * Authorization header is sent — Graph already scoped and signed this URL
   * to the specific item, so our bearer token never reaches that host.
   * Still validated (https + not a private/loopback address) rather than
   * followed blindly, since a compromised/mistaken Graph response or
   * redirect chain must not be able to point this at an internal address.
   */
  async downloadFile(downloadUrl: string): Promise<Buffer> {
    const parsed = new URL(downloadUrl);
    if (parsed.protocol !== 'https:') {
      throw new Error('Refusing to fetch a non-https download URL');
    }
    if (this.isPrivateHost(parsed.hostname)) {
      throw new Error('Refusing to fetch a download URL pointing at a private/internal host');
    }
    const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }

  /**
   * Resolves whichever URL shape was pasted (see parseAllItemsFolderPath's
   * doc comment) down to the Graph "list children of this folder" URL — the
   * one piece every public method here actually needs.
   */
  private async resolveRootChildrenUrl(url: string, accessToken: string): Promise<string> {
    if (!isMicrosoftSharingUrl(url)) {
      throw new Error(
        'That doesn’t look like a SharePoint or OneDrive link — expected a sharepoint.com, onedrive.com, or 1drv.ms URL'
      );
    }

    const browsedFolder = parseAllItemsFolderPath(url);
    if (browsedFolder) {
      const { driveId, itemId } = await this.resolveFolderByPath(browsedFolder.hostname, browsedFolder.folderPath, accessToken);
      return `${GRAPH_BASE_URL}/drives/${driveId}/items/${itemId}/children`;
    }

    const shareId = this.encodeShareId(url);
    return `${GRAPH_BASE_URL}/shares/${shareId}/driveItem/children`;
  }

  /**
   * Cheapest possible check that a pasted folder link + token combination
   * actually resolves — one call, no recursive listing.
   */
  async testShareAccess(
    shareUrl: string,
    token: SharePointOAuthToken
  ): Promise<{ success: boolean; message: string }> {
    try {
      const childrenUrl = await this.resolveRootChildrenUrl(shareUrl, token.accessToken);
      await this.get(childrenUrl, token.accessToken);
      return { success: true, message: 'Successfully connected to SharePoint via Microsoft Graph' };
    } catch (error: any) {
      return { success: false, message: error.message || 'Connection failed' };
    }
  }

  /**
   * Follows @odata.nextLink so libraries over the 200-item Graph page size
   * are still fully listed.
   */
  private async listChildren(url: string, accessToken: string, retryBudget?: RetryBudget): Promise<any[]> {
    const items: any[] = [];
    let nextUrl: string | undefined = url;
    while (nextUrl) {
      const response = await this.get(nextUrl, accessToken, retryBudget);
      items.push(...(response.data.value || []));
      nextUrl = response.data['@odata.nextLink'];
    }
    return items;
  }

  /**
   * Lists all Word template files under the shared folder, recursively —
   * including files sitting directly in the shared folder itself (a flat
   * folder, no per-doc-type subfolders) and files nested more than one
   * level deep. Same docType convention as the on-prem path: a file's
   * immediate parent folder name becomes its docType, undefined at the
   * shared-folder root. Mirrors `SharePointService.listTemplateFiles`'s
   * BFS walk and safety caps, built on `listChildren`'s existing
   * `@odata.nextLink` pagination instead of the one-level `/Folders`+`/Files`
   * pair the on-prem path uses. Emits the same SharePointFile shape the
   * on-prem path uses — `serverRelativeUrl` carries Graph's pre-signed
   * download URL instead of a server-relative path, which is exactly what
   * downloadFile() expects back.
   */
  async listTemplateFiles(shareUrl: string, token: SharePointOAuthToken): Promise<SharePointFileListing> {
    const rootChildrenUrl = await this.resolveRootChildrenUrl(shareUrl, token.accessToken);

    const queue: GraphFolderQueueItem[] = [{ childrenUrl: rootChildrenUrl, relativePath: '', depth: 0 }];

    const allTemplateFiles: SharePointFile[] = [];
    let truncated = false;
    // Shared across every request this walk makes — see sharePointRetry.ts.
    const retryBudget = createRetryBudget();
    const skippedFolders: SkippedFolder[] = [];
    let totalSkippedFolders = 0;

    // Mirrors SharePointService.listTemplateFiles's recordSkippedFolder —
    // `depth > 0` gates tolerance, a denied shared-folder root always
    // aborts (see SharePointFileListing's doc comment).
    const recordSkippedFolder = (relPath: string, reason: string) => {
      totalSkippedFolders += 1;
      if (skippedFolders.length < MAX_SKIPPED_FOLDERS_RECORDED) {
        skippedFolders.push({ relativePath: relPath, reason });
      }
    };

    // Batch fetches (I/O only), accumulate strictly in queue order — see
    // SharePointService.listTemplateFiles's identical comment for why this
    // keeps output deterministic under concurrency.
    while (queue.length > 0 && !truncated) {
      const batch = queue.splice(0, CONCURRENT_FOLDER_FETCHES);
      const results = await Promise.all(batch.map((item) => this.fetchFolder(token, item, retryBudget)));

      for (const result of results) {
        if (truncated) break;

        for (const file of result.files) {
          if (allTemplateFiles.length >= MAX_RECURSION_FILES) {
            truncated = true;
            break;
          }
          allTemplateFiles.push(file);
        }
        if (truncated) break;

        if (result.skipped) {
          recordSkippedFolder(result.skipped.relativePath, result.skipped.reason);
          continue;
        }
        if (result.depthCapped) {
          truncated = true;
          continue;
        }
        queue.push(...result.subfoldersToEnqueue);
      }
    }

    if (totalSkippedFolders > skippedFolders.length) {
      skippedFolders.push({
        relativePath: '',
        reason: `…and ${totalSkippedFolders - skippedFolders.length} more folder(s) were also skipped`,
      });
    }

    logger.info(
      `Total template files found via Graph: ${allTemplateFiles.length}${truncated ? ' (truncated)' : ''}${
        totalSkippedFolders ? `, ${totalSkippedFolders} folder(s) skipped (access denied)` : ''
      }`
    );

    return { files: allTemplateFiles, truncated, skippedFolders };
  }

  /**
   * Fetches one folder's children — the I/O unit `listTemplateFiles` runs
   * CONCURRENT_FOLDER_FETCHES of at a time. Pure I/O, mirrors
   * SharePointService.fetchFolder: no shared state is read or written
   * here, so concurrent fetching can't change which files end up in the
   * result or where the truncation cutoff falls (both are resolved by the
   * caller, in queue order, once every promise in a batch has settled).
   */
  private async fetchFolder(
    token: SharePointOAuthToken,
    item: GraphFolderQueueItem,
    retryBudget: RetryBudget
  ): Promise<GraphFetchFolderResult> {
    const { childrenUrl, relativePath, depth, parentName } = item;

    let children: any[];
    try {
      children = await this.listChildren(childrenUrl, token.accessToken, retryBudget);
    } catch (err: any) {
      if (err.status === 403 && depth > 0) {
        logger.warn(`Skipping inaccessible folder "${relativePath}" (Graph): ${err.message}`);
        return { files: [], subfoldersToEnqueue: [], skipped: { relativePath, reason: err.message } };
      }
      throw err;
    }

    const templateFiles = children.filter((file: any) => {
      if (file.folder) return false;
      if (!isTemplateFileName(file.name)) return false;
      if (!isWithinMaxTemplateSize(Number(file.size))) {
        logger.warn(`Skipping SharePoint file "${file.name}" — size ${file.size} bytes exceeds the sync limit`);
        return false;
      }
      return true;
    });

    const files: SharePointFile[] = [];
    for (const file of templateFiles) {
      const downloadUrl = file['@microsoft.graph.downloadUrl'];
      if (!downloadUrl) {
        logger.warn(`Skipping SharePoint file "${file.name}" — Graph did not return a download URL`);
        continue;
      }
      files.push({
        name: file.name,
        serverRelativeUrl: downloadUrl,
        timeCreated: file.createdDateTime,
        timeLastModified: file.lastModifiedDateTime,
        length: file.size,
        docType: parentName,
        relativePath: relativePath ? `${relativePath}/${file.name}` : file.name,
      });
    }

    logger.info(`Found ${templateFiles.length} template files in "${relativePath || '(root)'}" (Graph)`);

    const subfolders = children.filter((c: any) => c.folder && !c.name.startsWith('_') && !c.name.startsWith('.'));

    if (depth >= MAX_RECURSION_DEPTH) {
      if (subfolders.length > 0) {
        logger.warn(
          `Hit max recursion depth (${MAX_RECURSION_DEPTH}) at "${relativePath}" with ${subfolders.length} unexplored subfolder(s) (Graph)`
        );
        return { files, subfoldersToEnqueue: [], depthCapped: true };
      }
      return { files, subfoldersToEnqueue: [] };
    }

    const subfoldersToEnqueue: GraphFolderQueueItem[] = [];
    for (const subfolder of subfolders) {
      const subfolderName = subfolder.name;
      const driveId = subfolder.parentReference?.driveId;
      const itemId = subfolder.id;
      if (!driveId || !itemId) {
        logger.warn(`Skipping SharePoint subfolder "${subfolderName}" — missing driveId/itemId in Graph response`);
        continue;
      }
      subfoldersToEnqueue.push({
        childrenUrl: `${GRAPH_BASE_URL}/drives/${driveId}/items/${itemId}/children`,
        relativePath: relativePath ? `${relativePath}/${subfolderName}` : subfolderName,
        depth: depth + 1,
        parentName: subfolderName,
      });
    }

    return { files, subfoldersToEnqueue };
  }
}
