import axios from 'axios';
import logger from '../util/logger';
import { SharePointFile, SharePointOAuthToken } from './SharePointService';
import { isTemplateFileName, isWithinMaxTemplateSize } from './sharePointFileValidation';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

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

  private async get(url: string, accessToken: string): Promise<any> {
    try {
      return await axios.get(url, {
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
      });
    } catch (error: any) {
      if (error.response) {
        // Never log the token; the URL itself carries no secret (Graph
        // resource paths, not signed download URLs) so it's safe to log for
        // diagnosing exactly which resolution step failed and why.
        logger.warn(`Graph request failed (${error.response.status}): ${url}`);
        throw this.errorForStatus(error.response.status);
      }
      throw new Error(`Could not reach Microsoft Graph: ${error.message}`);
    }
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
  private async listChildren(url: string, accessToken: string): Promise<any[]> {
    const items: any[] = [];
    let nextUrl: string | undefined = url;
    while (nextUrl) {
      const response = await this.get(nextUrl, accessToken);
      items.push(...(response.data.value || []));
      nextUrl = response.data['@odata.nextLink'];
    }
    return items;
  }

  /**
   * Lists all Word template files one level below the shared folder's
   * subfolders. Same docType convention as the on-prem path: each
   * subfolder's name becomes the docType, and only .docx/.dotx files are
   * returned. Emits the same SharePointFile shape the on-prem path uses —
   * `serverRelativeUrl` carries Graph's pre-signed download URL instead of a
   * server-relative path, which is exactly what downloadFile() expects back.
   */
  async listTemplateFiles(shareUrl: string, token: SharePointOAuthToken): Promise<SharePointFile[]> {
    const rootChildrenUrl = await this.resolveRootChildrenUrl(shareUrl, token.accessToken);
    const subfolders = await this.listChildren(rootChildrenUrl, token.accessToken);

    const allTemplateFiles: SharePointFile[] = [];

    for (const subfolder of subfolders) {
      if (!subfolder.folder) continue; // only folders are docType buckets

      const subfolderName = subfolder.name;
      if (subfolderName.startsWith('_') || subfolderName.startsWith('.')) continue;

      const driveId = subfolder.parentReference?.driveId;
      const itemId = subfolder.id;
      if (!driveId || !itemId) {
        logger.warn(`Skipping SharePoint subfolder "${subfolderName}" — missing driveId/itemId in Graph response`);
        continue;
      }

      const children = await this.listChildren(`${GRAPH_BASE_URL}/drives/${driveId}/items/${itemId}/children`, token.accessToken);

      const templateFiles = children.filter((file: any) => {
        if (file.folder) return false;
        if (!isTemplateFileName(file.name)) return false;
        if (!isWithinMaxTemplateSize(Number(file.size))) {
          logger.warn(`Skipping SharePoint file "${file.name}" — size ${file.size} bytes exceeds the sync limit`);
          return false;
        }
        return true;
      });

      for (const file of templateFiles) {
        const downloadUrl = file['@microsoft.graph.downloadUrl'];
        if (!downloadUrl) {
          logger.warn(`Skipping SharePoint file "${file.name}" — Graph did not return a download URL`);
          continue;
        }
        allTemplateFiles.push({
          name: file.name,
          serverRelativeUrl: downloadUrl,
          timeCreated: file.createdDateTime,
          timeLastModified: file.lastModifiedDateTime,
          length: file.size,
          docType: subfolderName,
        });
      }

      logger.info(`Found ${templateFiles.length} template files in "${subfolderName}" (Graph)`);
    }

    logger.info(`Total template files found via Graph: ${allTemplateFiles.length}`);

    return allTemplateFiles;
  }
}
