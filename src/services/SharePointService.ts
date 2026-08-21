import axios, { AxiosRequestConfig } from 'axios';
import https from 'https';
import logger from '../util/logger';
import { GraphSharePointService } from './GraphSharePointService';
import { isTemplateFileName, isWithinMaxTemplateSize, hasZipSignature } from './sharePointFileValidation';
import {
  withThrottleRetry,
  createRetryBudget,
  RetryBudget,
  RETRYABLE_STATUSES,
  REQUEST_TIMEOUT_MS,
} from './sharePointRetry';

// On-prem SharePoint often sits behind a self-signed / internal-CA certificate.
// Prefer NODE_EXTRA_CA_CERTS (trusts the internal CA at the Node level, covers
// axios and httpntlm alike) for production. This flag is a dev-only escape
// hatch — never enable it in production, it disables TLS verification.
const ALLOW_SELF_SIGNED = process.env.SHAREPOINT_ALLOW_SELF_SIGNED === 'true';
if (ALLOW_SELF_SIGNED) {
  logger.warn(
    'SHAREPOINT_ALLOW_SELF_SIGNED=true — SharePoint TLS certificate validation is disabled. Do not use in production.'
  );
}

// SharePoint credentials interface (for NTLM - on-premise)
export interface SharePointCredentials {
  username: string;
  password: string;
  domain?: string;
}

// OAuth token interface (for SharePoint Online)
export interface SharePointOAuthToken {
  accessToken: string;
  expiresOn?: Date;
  refreshToken?: string;
}

// SharePoint file interface
export interface SharePointFile {
  name: string;
  serverRelativeUrl: string;
  timeCreated?: string;
  timeLastModified: string;
  length: number;
  docType?: string; // Detected from immediate parent folder name — only set when the file has a parent (not at the connected root)
  relativePath: string; // Path relative to the connected root, e.g. "STD/File.dotx" or just "File.dotx" at the root — the stable per-file identity (recursion permits duplicate basenames)
}

// A folder the walk couldn't read (permission-denied) and skipped rather
// than aborting the whole listing over. `relativePath` matches the identity
// used everywhere else in this feature; `reason` is the human-readable
// cause (SharePoint's own OData message, or Graph's mapped error message).
export interface SkippedFolder {
  relativePath: string;
  reason: string;
}

// Result of a recursive template-file listing — `truncated` is set when a
// safety cap (depth or total file count) was hit before every file could be
// walked, so callers can surface that honestly instead of silently
// under-reporting. `skippedFolders` lists folders that were denied and
// skipped (never the connected root itself — a denied root always aborts
// the whole listing, since silently reporting "0 files found" there would
// be indistinguishable from a genuinely empty folder).
export interface SharePointFileListing {
  files: SharePointFile[];
  truncated: boolean;
  skippedFolders: SkippedFolder[];
}

// Safety nets against a pathological tree (not real-world limits — a
// genuine templates folder is rarely more than a couple of levels deep or a
// few dozen files). Exported so GraphSharePointService's recursive walk
// applies the identical caps.
export const MAX_RECURSION_DEPTH = 6;
export const MAX_RECURSION_FILES = 500;
// Cap what's serialized into every list/check/sync response — a poorly
// permissioned library could otherwise have hundreds of denied folders.
export const MAX_SKIPPED_FOLDERS_RECORDED = 25;

// How many folders' Files+Folders fetches run concurrently during the BFS
// walk, instead of strictly one at a time. Comfortably under both
// Microsoft's tested ~60 req/sec/on-prem-web-server ceiling and Graph's
// ~10 req/sec/user sustained limit — on-prem costs 2 sequential requests
// per folder, so steady-state in-flight is 4, not 8. Don't raise this
// without also raising sharePointRetry's DEFAULT_RETRY_BUDGET_MS.
export const CONCURRENT_FOLDER_FETCHES = 4;

// One BFS queue entry — a folder still to walk. `relativePath` is that
// folder's own path relative to the connected root ('' at the root
// itself); `parentName` is undefined only at the root, so files found
// there correctly get no docType.
type FolderQueueItem = { folderPath: string; relativePath: string; depth: number; parentName?: string };

// Result of fetching one folder's Files + Folders. `files` is populated
// even when `skipped` is also set — a folder denied only on its `/Folders`
// call keeps the files it already found from `/Files`, it just doesn't
// descend further.
interface FetchFolderResult {
  files: SharePointFile[];
  subfoldersToEnqueue: FolderQueueItem[];
  skipped?: { relativePath: string; reason: string };
  depthCapped?: boolean;
}

// SharePoint configuration interface
export interface SharePointConfig {
  siteUrl: string;
  library: string;
  folder: string;
}

export class SharePointService {
  private graphService = new GraphSharePointService();

  /**
   * Detects if the SharePoint URL is SharePoint Online or On-Premise
   */
  private isSharePointOnline(siteUrl: string): boolean {
    return siteUrl.toLowerCase().includes('.sharepoint.com');
  }

  /**
   * Extracts the site path from the SharePoint URL
   * e.g., http://elis-prd-spapp/sites/elisradevops-project -> /sites/elisradevops-project
   */
  private extractSitePath(siteUrl: string): string {
    try {
      const url = new URL(siteUrl);
      return url.pathname || '/';
    } catch (error) {
      logger.warn(`Failed to parse SharePoint URL: ${siteUrl}, using root path`);
      return '/';
    }
  }

  /**
   * Constructs the full folder path for SharePoint REST API.
   *
   * `library`/`folder` are joined with `.filter(Boolean)` rather than a bare
   * template string: a config resolved via `resolveSiteFromUrl()` stores the
   * whole remaining path in `folder` and leaves `library` empty (there's no
   * longer a separate library field once the user pastes one full folder
   * URL), and a bare `${library}/${folder}` would produce a doubled slash
   * (an empty path segment) whenever `library` is blank.
   */
  private constructFolderPath(config: SharePointConfig): string {
    const sitePath = this.extractSitePath(config.siteUrl);
    // Remove trailing slash from site path
    const cleanSitePath = sitePath.endsWith('/') ? sitePath.slice(0, -1) : sitePath;
    const joined = [cleanSitePath, config.library, config.folder].filter(Boolean).join('/');
    // A root-web site (siteUrl has no path at all, so cleanSitePath is '')
    // would otherwise produce a path with no leading slash here —
    // GetFolderByServerRelativeUrl(...) expects a server-relative path,
    // which always starts with '/'.
    return joined.startsWith('/') ? joined : `/${joined}`;
  }

  /**
   * Resolves a pasted on-prem templates-folder URL (copied straight from
   * the browser's address bar) into a `SharePointConfig`-ready site root +
   * folder path, so the user never has to split it into Site URL / Library
   * / Folder by hand. The whole remaining path below the resolved site
   * lands in `folder` (`library` is left empty) — `constructFolderPath`
   * already tolerates an empty `library` (see its own doc comment) so this
   * plugs straight into the existing sync flow unchanged.
   *
   * Uses `GET {url}/_api/web?$select=ServerRelativeUrl` rather than the
   * more commonly-documented `/_api/contextinfo` operator: contextinfo is
   * POST-only specifically because it also hands back a write-capable form
   * digest that needs CSRF protection — we only need to *read* where the
   * URL sits, so the plain `web` entry point (a normal GET, no new HTTP
   * method support needed in makeNTLMRequest) does the same job.
   *
   * `_api`'s "nearest web" routing IS reliable when `_api` sits immediately
   * after a real web's own URL (e.g. a `/sites/x` site), but is NOT reliable
   * at arbitrary depth past several document-library/folder segments —
   * confirmed against a real production 500 for exactly that shape (a
   * root-web site with a deep folder path and no `/sites/...` prefix at
   * all). Rather than assume the pasted URL's full depth IS the site
   * boundary, try `_api/web` at the full path first, then walk to
   * progressively shallower prefixes until one resolves. The bare origin
   * (a root web, which always exists) is always the last, guaranteed-valid
   * candidate. This costs nothing extra for the common `/sites/x` case — it
   * still resolves on the very first, deepest attempt exactly as before.
   */
  async resolveSiteFromUrl(
    pastedUrl: string,
    credentials: SharePointCredentials
  ): Promise<{ siteUrl: string; library: string; folder: string }> {
    try {
      const parsedUrl = new URL(pastedUrl);
      const origin = parsedUrl.origin;
      // Use the URL's own path only — a pasted AllItems.aspx link carries a
      // query string (?web=1&RootFolder=...&FolderCTID=...), and appending
      // /_api/web onto that unstripped would glue our API path onto the end
      // of whatever query param happens to be last, never actually reaching
      // _api/web. Derived from the raw pasted string (not `parsedUrl.pathname`,
      // which the WHATWG URL parser re-percent-encodes — e.g. turning a
      // literal space into %20) so every candidate preserves the pasted
      // URL's exact original encoding, unchanged from before this fix.
      const baseUrlString = pastedUrl.split('?')[0];
      const baseUrl = baseUrlString.replace(/\/+$/, '');
      const pathOnly = baseUrl.startsWith(origin) ? baseUrl.slice(origin.length) : baseUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+/, '');
      const segments = pathOnly.split('/').filter(Boolean);
      // Runaway-safety cap on how many candidates we'll try — not a
      // real-world limit; a genuine folder path is rarely more than a
      // handful of segments deep.
      const MAX_CANDIDATE_SEGMENTS = 15;
      const cappedSegments = segments.slice(0, MAX_CANDIDATE_SEGMENTS);

      let lastResponse: any = null;
      let lastRequestError: any = null;

      for (let depth = cappedSegments.length; depth >= 0; depth--) {
        const candidatePath = cappedSegments.slice(0, depth).join('/');
        const candidateBaseUrl = candidatePath ? `${origin}/${candidatePath}` : origin;
        const apiUrl = `${candidateBaseUrl}/_api/web?$select=ServerRelativeUrl`;

        logger.info(`Resolving SharePoint site from pasted URL — trying: ${candidateBaseUrl}`);

        let response: any;
        try {
          // Deliberately not routed through makeSharePointRequest (no
          // retry) — up to 15 candidates are tried, and expected-to-fail
          // probes must stay fast. Still needs its own timeout though: with
          // no retry wrapper providing one, an untimed candidate here could
          // stall the whole walk far longer than before this cap existed.
          response = await this.makeNTLMRequest(apiUrl, credentials, 'GET', { timeout: REQUEST_TIMEOUT_MS });
        } catch (err) {
          lastRequestError = err;
          continue;
        }
        lastResponse = response;

        const serverRelativeUrl = response?.data?.d?.ServerRelativeUrl;
        if (typeof serverRelativeUrl !== 'string') {
          continue;
        }

        logger.info(`Resolved SharePoint site at: ${candidateBaseUrl}`);

        // A browsed AllItems.aspx URL (on-prem's equivalent of Online's
        // ?id=... shape) carries the real target folder in ?RootFolder=...,
        // not in the page's own path — the page path is just the library's
        // Forms view. Prefer it when present; fall back to the URL's own
        // path for a direct folder link that has no RootFolder param. This
        // operates on the pasted URL and the REAL resolved
        // serverRelativeUrl — unaffected by which candidate matched.
        const rootFolderParam = parsedUrl.searchParams.get('RootFolder');
        const fullPath = rootFolderParam ?? decodeURIComponent(parsedUrl.pathname);
        const folder = fullPath.startsWith(serverRelativeUrl)
          ? fullPath.slice(serverRelativeUrl.length).replace(/^\/+/, '')
          : fullPath.replace(/^\/+/, '');

        // A root-web site resolves serverRelativeUrl to "/" — strip any
        // trailing slash so every downstream `${siteUrl}/_api/...` call
        // doesn't end up with a doubled slash (which IIS commonly rejects).
        // Falls back to the bare origin, never an empty string.
        const siteUrl = `${origin}${serverRelativeUrl}`.replace(/\/+$/, '') || origin;

        return { siteUrl, library: '', folder };
      }

      if (lastRequestError) {
        throw lastRequestError;
      }
      throw new Error(this.describeUnexpectedResponse(lastResponse, 'a SharePoint site for this URL'));
    } catch (error: any) {
      logger.error(`Failed to resolve SharePoint site from URL: ${error.message}`);
      throw new Error(`Failed to resolve SharePoint site from URL: ${error.message}`);
    }
  }

  /**
   * Builds the server-relative-URL literal used inside
   * GetFolderByServerRelativeUrl('...') / GetFileByServerRelativeUrl('...').
   * Two encoding rules apply, per the SharePoint REST/OData conventions:
   *  - a literal single quote inside an OData string literal must be escaped
   *    by doubling it ('' ), otherwise the request 400s with a syntax error.
   *  - each path SEGMENT is percent-encoded individually, never the whole
   *    path — percent-encoding a '/' produces %2F, and IIS's request
   *    filtering module rejects that by default (404.11 "URL Double
   *    Escaped"; allowDoubleEscaping defaults to false — see
   *    learn.microsoft.com/iis/configuration/system.webserver/security/requestfiltering).
   *    encodeURIComponent() on the full path previously did exactly this.
   */
  private toServerRelativeUrlLiteral(path: string): string {
    return path
      .split('/')
      .map((segment) => encodeURIComponent(segment.replace(/'/g, "''")))
      .join('/');
  }

  /**
   * Builds a diagnostic message for a response that didn't carry what the
   * caller expected and doesn't match SharePoint's own OData error shape
   * either (e.g. a redirect to a login/error page, a bare re-challenge, an
   * HTML error page). Includes `status` and, when present, `location`/
   * `www-authenticate` — the previous content-type-and-body-only version
   * couldn't distinguish a redirect from an auth challenge from a genuine
   * 404/500, since a body-less response leaves both blank regardless of
   * which actually happened.
   */
  private describeUnexpectedResponse(response: any, context: string): string {
    const status = response?.status ?? 'unknown';
    const headers = response?.headers || {};
    const contentType = headers['content-type'] || 'unknown';
    const location = headers['location'];
    const wwwAuthenticate = headers['www-authenticate'];
    const bodyPreview =
      typeof response?.data === 'string' ? response.data.slice(0, 200) : JSON.stringify(response?.data).slice(0, 200);

    const details = [`status: ${status}`, `content-type: ${contentType}`];
    if (location) details.push(`location: ${location}`);
    if (wwwAuthenticate) details.push(`www-authenticate: ${wwwAuthenticate}`);

    return `Unexpected response fetching ${context} (${details.join(', ')}). Body preview: ${bodyPreview}`;
  }

  /**
   * True when `response` represents a permission-denied folder — worth
   * skipping and continuing the walk rather than aborting the whole
   * listing. Deliberately excludes 401: a 401 means the credentials/token
   * themselves are invalid, not that this one folder is restricted — every
   * remaining folder would also 401, so tolerating it would silently turn a
   * clean auth failure into "0 files found, N folders skipped". Callers
   * must additionally gate on `depth > 0` — a denied connected root must
   * always abort (see SharePointFileListing's doc comment).
   */
  private accessDeniedReason(response: any): string | null {
    if (!response) return null;
    const status = response.status;
    if (status === 401) return null;
    if (status === 403) {
      return response?.data?.error?.message?.value || 'Access is denied.';
    }
    const odataMessage = response?.data?.error?.message?.value;
    if (typeof odataMessage === 'string' && /access\s+(is\s+)?denied|do not have permission|unauthorized/i.test(odataMessage)) {
      return odataMessage;
    }
    return null;
  }

  /**
   * Guards against a response that isn't the expected SharePoint REST JSON
   * list shape ({ d: { results: [...] } }). Previously an unrecognised
   * response (e.g. Atom XML returned when the NTLM request didn't send an
   * Accept: application/json header) was silently treated as "no items",
   * so a broken request reported a successful sync of zero files. Throws
   * instead, logging enough to diagnose without leaking credentials.
   */
  private assertJsonListResponse(response: any, context: string): void {
    if (response?.data?.d?.results) {
      return;
    }

    // A path that doesn't exist (e.g. the pasted templates folder itself,
    // or a subfolder deleted mid-sync) comes back as SharePoint's own REST
    // error body, not a list — it already carries a specific,
    // human-readable message ("File Not Found.", "Access is denied.", etc).
    // Surface that directly instead of falling through to the generic
    // body-preview dump below, which reads as a raw technical error rather
    // than something a user can act on.
    const odataMessage = response?.data?.error?.message?.value;
    if (typeof odataMessage === 'string' && odataMessage.trim()) {
      throw new Error(`SharePoint returned an error while fetching ${context}: ${odataMessage.trim()}`);
    }

    throw new Error(this.describeUnexpectedResponse(response, context));
  }

  /**
   * Tests SharePoint connection with provided credentials
   */
  async testConnection(
    config: SharePointConfig,
    credentials: SharePointCredentials | SharePointOAuthToken
  ): Promise<{ success: boolean; message: string }> {
    try {
      const isOnline = this.isSharePointOnline(config.siteUrl);

      if (isOnline) {
        if (!('accessToken' in credentials)) {
          return {
            success: false,
            message: 'SharePoint Online requires a Microsoft Graph access token, not a username/password.',
          };
        }
        // config.siteUrl doubles as the pasted SharePoint/OneDrive sharing
        // link for the Online/Graph path — library/folder are unused here.
        return this.graphService.testShareAccess(config.siteUrl, credentials);
      }

      if ('accessToken' in credentials) {
        return {
          success: false,
          message: 'On-premise SharePoint requires a username/password, not a Microsoft Graph token.',
        };
      }

      // Test connection to on-premise SharePoint
      const folderPath = this.constructFolderPath(config);
      const apiUrl = `${config.siteUrl}/_api/web/GetFolderByServerRelativeUrl('${this.toServerRelativeUrlLiteral(folderPath)}')/Files`;

      logger.info(`Testing SharePoint connection to: ${apiUrl}`);

      // Not routed through makeSharePointRequest (a single user-initiated
      // probe shouldn't retry), but still needs its own timeout.
      const response = await this.makeNTLMRequest(apiUrl, credentials, 'GET', { timeout: REQUEST_TIMEOUT_MS });

      if (response.status === 200) {
        return {
          success: true,
          message: 'Successfully connected to SharePoint',
        };
      } else {
        return {
          success: false,
          message: `Connection failed with status ${response.status}`,
        };
      }
    } catch (error: any) {
      logger.error(`SharePoint connection test failed: ${error.message}`);
      return {
        success: false,
        message: error.message || 'Connection failed',
      };
    }
  }

  /**
   * Lists all Word template files (.docx, .dotx) from a SharePoint folder,
   * recursively — including files sitting directly at the connected root
   * (a genuinely flat folder, no per-doc-type subfolders at all) and files
   * nested more than one level deep. SharePoint REST's `/Folders` and
   * `/Files` are both strictly one-level (there's no native recursive-list
   * GET endpoint — the recursive CAML `GetItems` option is POST-only and
   * needs a form digest, out of reach of the current NTLM GET-only
   * transport), so this walks the tree itself, reusing the same pair of
   * one-level calls at every folder. `docType` is only populated when a
   * file's immediate parent folder is not the connected root — same
   * auto-detection convention as before, just no longer limited to depth 1.
   * `truncated` is set if the depth or file-count safety cap was hit before
   * the whole tree could be walked, so a pathological folder tree degrades
   * to "list what we found, flagged incomplete" rather than either hanging
   * or silently dropping files.
   * Supports both NTLM (on-premise) and OAuth (SharePoint Online).
   */
  async listTemplateFiles(
    config: SharePointConfig,
    credentials: SharePointCredentials | SharePointOAuthToken
  ): Promise<SharePointFileListing> {
    try {
      const isOnline = this.isSharePointOnline(config.siteUrl);
      const isOAuth = 'accessToken' in credentials;

      if (isOnline && isOAuth) {
        // config.siteUrl doubles as the pasted SharePoint/OneDrive sharing
        // link for the Online/Graph path — library/folder are unused here.
        return await this.graphService.listTemplateFiles(config.siteUrl, credentials);
      }

      const rootFolderPath = this.constructFolderPath(config);
      const allTemplateFiles: SharePointFile[] = [];
      let truncated = false;
      // Shared across every request this walk makes — see sharePointRetry.ts.
      const retryBudget = createRetryBudget();
      const skippedFolders: SkippedFolder[] = [];
      let totalSkippedFolders = 0;

      const queue: FolderQueueItem[] = [{ folderPath: rootFolderPath, relativePath: '', depth: 0 }];

      // Records a denied folder and decides whether the walk should keep
      // going (skip-and-continue) or abort entirely. `depth > 0` gates
      // tolerance — a denied connected root always aborts, since silently
      // returning "0 files found" there is indistinguishable from a
      // genuinely empty folder rather than a permissions problem.
      const recordSkippedFolder = (relPath: string, reason: string) => {
        totalSkippedFolders += 1;
        if (skippedFolders.length < MAX_SKIPPED_FOLDERS_RECORDED) {
          skippedFolders.push({ relativePath: relPath, reason });
        }
      };

      // Batch fetches (I/O only — CONCURRENT_FOLDER_FETCHES at a time), but
      // accumulate results strictly in queue order, exactly as the fully
      // sequential walk used to. This keeps `relativePath`/`docType`
      // derivation and the truncation cutoff bit-identical to before —
      // both are derived per-entry from the queue item, never from
      // wall-clock timing, and accumulation only ever reads already-
      // resolved results in order. One accepted cost: a folder's `/Folders`
      // is now always fetched even in the folder where the 500-file cap
      // gets hit (the old code could sometimes skip it — see
      // fetchFolder's doc comment).
      while (queue.length > 0 && !truncated) {
        const batch = queue.splice(0, CONCURRENT_FOLDER_FETCHES);
        const results = await Promise.all(
          batch.map((item) => this.fetchFolder(config, credentials, isOAuth, item, retryBudget))
        );

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

      // If capped, note the true total rather than silently under-reporting
      // how many folders were actually denied.
      if (totalSkippedFolders > skippedFolders.length) {
        skippedFolders.push({
          relativePath: '',
          reason: `…and ${totalSkippedFolders - skippedFolders.length} more folder(s) were also skipped`,
        });
      }

      logger.info(
        `Total template files found: ${allTemplateFiles.length}${truncated ? ' (truncated)' : ''}${
          totalSkippedFolders ? `, ${totalSkippedFolders} folder(s) skipped (access denied)` : ''
        }`
      );

      return { files: allTemplateFiles, truncated, skippedFolders };
    } catch (error: any) {
      logger.error(`Failed to list SharePoint files: ${error.message}`);
      throw new Error(`Failed to list SharePoint files: ${error.message}`);
    }
  }

  /**
   * Fetches one folder's Files then Folders — the I/O unit `listTemplateFiles`
   * runs CONCURRENT_FOLDER_FETCHES of at a time. Pure I/O: no shared state is
   * read or written here (the running file count, truncation flag, and
   * skippedFolders list all live in the caller and are updated only once
   * every promise in a batch has resolved, in queue order) — that's what
   * keeps concurrent fetching from changing which files end up in the
   * result or where the truncation cutoff falls.
   *
   * Always fetches `/Folders` even when depth/skip logic will discard the
   * result — unlike the old strictly-sequential walk, which could skip that
   * call once the file-count cap was already hit inside this same folder's
   * `/Files` response. That short-circuit isn't available per-item inside a
   * concurrent batch (the running total isn't known until every promise in
   * the batch settles), so a folder that happens to be the one where the
   * cap is hit costs one extra, unused request. Accepted — see the plan
   * this was implemented from.
   */
  private async fetchFolder(
    config: SharePointConfig,
    credentials: SharePointCredentials | SharePointOAuthToken,
    isOAuth: boolean,
    item: FolderQueueItem,
    retryBudget: RetryBudget
  ): Promise<FetchFolderResult> {
    const { folderPath, relativePath, depth, parentName } = item;

    const filesApiUrl = `${config.siteUrl}/_api/web/GetFolderByServerRelativeUrl('${this.toServerRelativeUrlLiteral(folderPath)}')/Files`;
    logger.info(`Fetching files from SharePoint folder: ${folderPath} (${isOAuth ? 'OAuth' : 'NTLM'})`);

    let filesResponse: any;
    try {
      filesResponse = await this.makeSharePointRequest(filesApiUrl, credentials, 'GET', {}, retryBudget);
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      if (status === 403 && depth > 0) {
        logger.warn(`Skipping inaccessible folder "${folderPath}": ${err.message}`);
        return {
          files: [],
          subfoldersToEnqueue: [],
          skipped: { relativePath, reason: err.message || 'Access is denied.' },
        };
      }
      throw err;
    }

    const filesDeniedReason = this.accessDeniedReason(filesResponse);
    if (filesDeniedReason && depth > 0) {
      logger.warn(`Skipping inaccessible folder "${folderPath}": ${filesDeniedReason}`);
      return { files: [], subfoldersToEnqueue: [], skipped: { relativePath, reason: filesDeniedReason } };
    }

    this.assertJsonListResponse(filesResponse, `files in "${folderPath}"`);
    const rawFiles = filesResponse.data.d.results;

    // Filter for Word template files (excludes ~$ Office lock files and oversized files)
    const templateFiles = rawFiles.filter((file: any) => {
      if (!isTemplateFileName(file.Name)) return false;
      if (!isWithinMaxTemplateSize(Number(file.Length))) {
        logger.warn(`Skipping SharePoint file "${file.Name}" — size ${file.Length} bytes exceeds the sync limit`);
        return false;
      }
      return true;
    });

    const files: SharePointFile[] = templateFiles.map((file: any) => ({
      name: file.Name,
      serverRelativeUrl: file.ServerRelativeUrl,
      timeCreated: file.TimeCreated,
      timeLastModified: file.TimeLastModified,
      length: file.Length,
      docType: parentName,
      relativePath: relativePath ? `${relativePath}/${file.Name}` : file.Name,
    }));

    logger.info(`Found ${templateFiles.length} template files in "${folderPath || '(root)'}"`);

    // Descend into subfolders, unless the depth cap is already reached.
    const foldersApiUrl = `${config.siteUrl}/_api/web/GetFolderByServerRelativeUrl('${this.toServerRelativeUrlLiteral(folderPath)}')/Folders`;

    let foldersResponse: any;
    try {
      foldersResponse = await this.makeSharePointRequest(foldersApiUrl, credentials, 'GET', {}, retryBudget);
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      if (status === 403 && depth > 0) {
        // The files already found in this folder are kept — only
        // descending further is blocked.
        logger.warn(`Skipping subfolders of inaccessible folder "${folderPath}": ${err.message}`);
        return { files, subfoldersToEnqueue: [], skipped: { relativePath, reason: err.message || 'Access is denied.' } };
      }
      throw err;
    }

    const foldersDeniedReason = this.accessDeniedReason(foldersResponse);
    if (foldersDeniedReason && depth > 0) {
      logger.warn(`Skipping subfolders of inaccessible folder "${folderPath}": ${foldersDeniedReason}`);
      return { files, subfoldersToEnqueue: [], skipped: { relativePath, reason: foldersDeniedReason } };
    }

    this.assertJsonListResponse(foldersResponse, `subfolders in "${folderPath}"`);
    const subfolders = foldersResponse.data.d.results.filter(
      (sf: any) => !sf.Name.startsWith('_') && !sf.Name.startsWith('.')
    );

    if (depth >= MAX_RECURSION_DEPTH) {
      if (subfolders.length > 0) {
        logger.warn(`Hit max recursion depth (${MAX_RECURSION_DEPTH}) at "${folderPath}" with ${subfolders.length} unexplored subfolder(s)`);
        return { files, subfoldersToEnqueue: [], depthCapped: true };
      }
      return { files, subfoldersToEnqueue: [] };
    }

    const subfoldersToEnqueue: FolderQueueItem[] = subfolders.map((subfolder: any) => ({
      folderPath: subfolder.ServerRelativeUrl,
      relativePath: relativePath ? `${relativePath}/${subfolder.Name}` : subfolder.Name,
      depth: depth + 1,
      parentName: subfolder.Name,
    }));

    return { files, subfoldersToEnqueue };
  }

  /**
   * Downloads a file from SharePoint
   * Supports both NTLM and OAuth
   */
  async downloadFile(
    siteUrl: string,
    serverRelativeUrl: string,
    auth: SharePointCredentials | SharePointOAuthToken
  ): Promise<Buffer> {
    try {
      const isOAuth = 'accessToken' in auth;
      let buffer: Buffer;

      if (this.isSharePointOnline(siteUrl) && isOAuth) {
        // serverRelativeUrl carries Graph's pre-signed download URL for the
        // Online/Graph path (see GraphSharePointService.listTemplateFiles) —
        // it's fetched directly, no site/library/folder context needed.
        logger.info(`Downloading file from SharePoint via Graph: ${serverRelativeUrl.slice(0, 80)}...`);
        buffer = await this.graphService.downloadFile(serverRelativeUrl);
      } else {
        const fileUrl = `${siteUrl}/_api/web/GetFileByServerRelativeUrl('${this.toServerRelativeUrlLiteral(serverRelativeUrl)}')/$value`;

        logger.info(`Downloading file from SharePoint: ${serverRelativeUrl} (${isOAuth ? 'OAuth' : 'NTLM'})`);

        const response = await this.makeSharePointRequest(fileUrl, auth, 'GET', {
          responseType: 'arraybuffer',
        });

        buffer = Buffer.from(response.data);
      }

      // .docx/.dotx are ZIP (OPC) packages regardless of source — a file
      // that isn't a real ZIP archive is not a valid Office document, no
      // matter what its extension or SharePoint's reported mimetype claim.
      if (!hasZipSignature(buffer)) {
        throw new Error('not a valid Office document — failed content check');
      }

      return buffer;
    } catch (error: any) {
      logger.error(`Failed to download file ${serverRelativeUrl}: ${error.message}`);
      throw new Error(`Failed to download file: ${error.message}`);
    }
  }

  /**
   * Makes a SharePoint API request (supports both NTLM and OAuth). This is
   * the single choke point both `listTemplateFiles` and `downloadFile` go
   * through, so it's where throttle-aware retry and a request timeout are
   * applied — not inside `makeNTLMRequest`/`makeOAuthRequest` individually.
   * Deliberately NOT used by `testConnection`/`resolveSiteFromUrl`, which
   * call `makeNTLMRequest` directly: those issue candidate requests they
   * expect to fail (resolveSiteFromUrl tries up to 15 URL depths) and must
   * stay fast-fail rather than retrying each expected failure.
   *
   * `retryBudget`, when passed, is shared across every request in one
   * `listTemplateFiles` walk — see sharePointRetry.ts's doc comment for why
   * that matters once folder fetches run concurrently.
   */
  private async makeSharePointRequest(
    url: string,
    auth: SharePointCredentials | SharePointOAuthToken,
    method: string = 'GET',
    additionalConfig: any = {},
    retryBudget?: RetryBudget
  ): Promise<any> {
    const isOAuth = 'accessToken' in auth;
    const configWithTimeout = { timeout: REQUEST_TIMEOUT_MS, ...additionalConfig };

    return withThrottleRetry(
      () =>
        isOAuth
          ? this.makeOAuthRequest(url, auth as SharePointOAuthToken, method, configWithTimeout)
          : this.makeNTLMRequest(url, auth as SharePointCredentials, method, configWithTimeout),
      (outcome) => {
        // NTLM resolves normally even on non-2xx (status lives on the
        // resolved value); OAuth/axios throws on non-2xx (status lives on
        // the thrown error's `.response`). Check both shapes.
        const status = outcome.value?.status ?? outcome.error?.response?.status;
        const headers = outcome.value?.headers ?? outcome.error?.response?.headers;
        return {
          retryable: RETRYABLE_STATUSES.includes(status),
          retryAfter: headers?.['retry-after'],
        };
      },
      { budget: retryBudget, label: url }
    );
  }

  /**
   * Makes an HTTP request with OAuth bearer token
   */
  private async makeOAuthRequest(
    url: string,
    token: SharePointOAuthToken,
    method: string = 'GET',
    additionalConfig: any = {}
  ): Promise<any> {
    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers: {
          'Authorization': `Bearer ${token.accessToken}`,
          'Accept': 'application/json;odata=verbose',
          ...additionalConfig.headers,
        },
        ...additionalConfig,
      };

      if (ALLOW_SELF_SIGNED) {
        config.httpsAgent = new https.Agent({ rejectUnauthorized: false });
      }

      const response = await axios(config);
      
      return {
        status: response.status,
        data: response.data,
        headers: response.headers,
      };
    } catch (error: any) {
      logger.error(`OAuth request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Makes an HTTP request with NTLM authentication
   */
  private async makeNTLMRequest(
    url: string,
    credentials: SharePointCredentials,
    method: string = 'GET',
    additionalConfig: any = {}
  ): Promise<any> {
    const ntlm = require('httpntlm');

    // additionalConfig may carry axios-only options (e.g. responseType from
    // downloadFile) that httpntlm/httpreq don't understand — httpreq needs
    // `binary: true` to return a raw Buffer instead of utf8-stringifying the
    // response body, otherwise downloaded .docx files come out corrupted.
    // Never forward `agent`: httpntlm pins its own keep-alive agent across
    // the NTLM handshake's two round-trips, and a caller-supplied agent
    // breaks that connection affinity.
    const { responseType, agent: _ignoredAgent, headers: callerHeaders, ...restConfig } = additionalConfig;

    return new Promise((resolve, reject) => {
      const options: Record<string, any> = {
        url: url,
        username: credentials.username,
        password: credentials.password,
        workstation: credentials.domain || '',
        domain: credentials.domain || '',
        headers: {
          // On-prem SharePoint returns Atom XML by default; without this,
          // JSON parsing below silently no-ops and callers see an empty
          // result set instead of an error.
          Accept: 'application/json;odata=verbose',
          ...callerHeaders,
        },
        ...restConfig,
      };

      if (responseType === 'arraybuffer') {
        options.binary = true;
      }

      if (ALLOW_SELF_SIGNED) {
        options.rejectUnauthorized = false;
      }

      if (method === 'GET') {
        ntlm.get(options, (err: any, res: any) => {
          if (err) {
            reject(err);
          } else {
            // Parse JSON response if content type is JSON
            let data = res.body;
            const contentType = res.headers['content-type'] || '';
            if (contentType.includes('application/json') && typeof data === 'string') {
              try {
                data = JSON.parse(data);
              } catch (e) {
                // Keep as string if parsing fails
              }
            }
            
            resolve({
              status: res.statusCode,
              data: data,
              headers: res.headers,
            });
          }
        });
      } else {
        reject(new Error(`HTTP method ${method} not implemented`));
      }
    });
  }
}
