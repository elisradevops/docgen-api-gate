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
import { assertGraphApiUrl, assertDownloadUrl } from '../util/graphUrlGuard';
import { GraphTokenProvider } from './auth/MsalClientService';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

// Accepts a plain { accessToken } object or a GraphTokenProvider closure
// (which re-acquires per call — see MsalClientService.createTokenProvider
// for why that matters on a long-running sync). Normalized to a provider
// internally so the rest of this class deals with one shape.
export type TokenSource = SharePointOAuthToken | GraphTokenProvider;

function toTokenProvider(source: TokenSource): GraphTokenProvider {
  if (typeof source === 'function') return source;
  return async () => source.accessToken;
}

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
 * Reads a SharePoint/OneDrive folder from a user-pasted URL via Microsoft
 * Graph's /shares endpoint — the single resolution path for both URL shapes
 * a user might paste ("Copy Link" sharing URLs and plain browsed-folder
 * address-bar URLs), both resolvable under delegated Files.Read.All alone.
 * There is deliberately no /sites/{hostname}:/{path} fallback, since that
 * path requires Sites.Read.All, which this app does not request.
 */
export class GraphSharePointService {
  /**
   * Encodes a sharing URL into the opaque "shareId" Graph's /shares endpoint
   * expects: "u!" + unpadded base64url(url). See:
   * https://learn.microsoft.com/graph/api/shares-get
   *
   * Single choke point for every public method below — validates the URL is
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
      401: 'Graph access token expired or invalid — please sign in again',
      403: 'This account does not have permission to read this SharePoint folder',
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
   * `listTemplateFiles` walk (see sharePointRetry.ts for why that matters
   * once folder fetches run concurrently). Callers that don't pass one
   * still get up to 2 retries per call, just not budget-capped across calls.
   *
   * `tokenProvider` is invoked on every call, not cached here — lets a
   * MsalClientService.createTokenProvider-backed caller silently refresh
   * mid-walk instead of reusing one token across a download loop that can
   * outlive its 60-90 minute lifetime.
   *
   * No `Prefer: redeemSharingLinkIfNecessary` header is sent — redeeming a
   * sharing link is a permission-granting side effect, and this app must
   * stay read-only in effect, not just in the scopes it holds.
   * Files.Read.All alone resolves /shares without it.
   */
  private async get(url: string, tokenProvider: GraphTokenProvider, retryBudget?: RetryBudget): Promise<any> {
    return withThrottleRetry(
      async () => {
        const accessToken = await tokenProvider();
        return axios.get(url, {
          timeout: REQUEST_TIMEOUT_MS,
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      },
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

  /**
   * Resolves whichever URL shape was pasted down to the Graph "list
   * children of this folder" URL — the one piece every listing/testing
   * method here actually needs. Purely a string transform (encodeShareId
   * validates and encodes; no network call), which is why this isn't async.
   */
  private resolveRootChildrenUrl(url: string): string {
    const shareId = this.encodeShareId(url);
    return `${GRAPH_BASE_URL}/shares/${shareId}/driveItem/children`;
  }

  /**
   * Resolves a pasted SharePoint/OneDrive URL to a concrete {driveId,
   * itemId}. Not currently called by any controller/service — listing and
   * downloading both resolve fresh from the pasted URL on every call
   * instead (see resolveRootChildrenUrl). Exists for SharePointResolvedRoot
   * (also unused today) if that binding is wired in later.
   */
  async resolveShareRoot(url: string, tokenSource: TokenSource): Promise<{ driveId: string; itemId: string; name?: string }> {
    const tokenProvider = toTokenProvider(tokenSource);
    const shareId = this.encodeShareId(url);
    const response = await this.get(`${GRAPH_BASE_URL}/shares/${shareId}/driveItem`, tokenProvider);
    const driveId = response.data?.parentReference?.driveId;
    const itemId = response.data?.id;
    if (!driveId || !itemId) {
      throw new Error('Could not resolve a drive/item reference from this SharePoint link');
    }
    return { driveId, itemId, name: response.data?.name };
  }

  /**
   * Downloads Graph's own pre-signed @microsoft.graph.downloadUrl. No
   * Authorization header is sent — Graph already scoped and signed it to
   * the specific item. Still validated against an explicit host allowlist
   * (graphUrlGuard) rather than followed blindly, in case a compromised or
   * malformed response points it at an internal address.
   */
  async downloadFile(downloadUrl: string): Promise<Buffer> {
    assertDownloadUrl(downloadUrl);
    const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }

  /**
   * Cheapest possible check that a pasted folder link + credential actually
   * resolves — one call, no recursive listing.
   */
  async testShareAccess(shareUrl: string, tokenSource: TokenSource): Promise<{ success: boolean; message: string }> {
    try {
      const tokenProvider = toTokenProvider(tokenSource);
      const childrenUrl = this.resolveRootChildrenUrl(shareUrl);
      await this.get(childrenUrl, tokenProvider);
      return { success: true, message: 'Successfully connected to SharePoint via Microsoft Graph' };
    } catch (error: any) {
      return { success: false, message: error.message || 'Connection failed' };
    }
  }

  /**
   * Follows @odata.nextLink so libraries over the 200-item Graph page size
   * are still fully listed. Every URL, including the first, is
   * host-validated via assertGraphApiUrl first — an off-host nextLink would
   * otherwise replay this app's Graph access token to an attacker's server.
   */
  private async listChildren(url: string, tokenProvider: GraphTokenProvider, retryBudget?: RetryBudget): Promise<any[]> {
    const items: any[] = [];
    let nextUrl: string | undefined = url;
    while (nextUrl) {
      assertGraphApiUrl(nextUrl);
      const response = await this.get(nextUrl, tokenProvider, retryBudget);
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
  async listTemplateFiles(shareUrl: string, tokenSource: TokenSource): Promise<SharePointFileListing> {
    const tokenProvider = toTokenProvider(tokenSource);
    const rootChildrenUrl = this.resolveRootChildrenUrl(shareUrl);

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
      const results = await Promise.all(batch.map((item) => this.fetchFolder(tokenProvider, item, retryBudget)));

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
    tokenProvider: GraphTokenProvider,
    item: GraphFolderQueueItem,
    retryBudget: RetryBudget
  ): Promise<GraphFetchFolderResult> {
    const { childrenUrl, relativePath, depth, parentName } = item;

    let children: any[];
    try {
      children = await this.listChildren(childrenUrl, tokenProvider, retryBudget);
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
