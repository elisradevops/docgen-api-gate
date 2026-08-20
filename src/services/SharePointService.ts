import axios, { AxiosRequestConfig } from 'axios';
import https from 'https';
import logger from '../util/logger';
import { GraphSharePointService } from './GraphSharePointService';
import { isTemplateFileName, isWithinMaxTemplateSize, hasZipSignature } from './sharePointFileValidation';

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
  docType?: string; // Detected from parent folder name
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
    return [cleanSitePath, config.library, config.folder].filter(Boolean).join('/');
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
   * method support needed in makeNTLMRequest) does the same job. Both are
   * reached through the same `_api` request-routing layer, which resolves
   * the "nearest web" for any URL under the site, not just a site's own
   * root URL — see "Navigate the SharePoint data structure represented in
   * the REST service" on Microsoft Learn.
   */
  async resolveSiteFromUrl(
    pastedUrl: string,
    credentials: SharePointCredentials
  ): Promise<{ siteUrl: string; library: string; folder: string }> {
    try {
      const parsedUrl = new URL(pastedUrl);
      // Use the URL's own path only — a pasted AllItems.aspx link carries a
      // query string (?web=1&RootFolder=...&FolderCTID=...), and appending
      // /_api/web onto that unstripped would glue our API path onto the end
      // of whatever query param happens to be last, never actually reaching
      // _api/web. The page path alone is enough for _api/web's "nearest
      // site" routing to resolve the site boundary. Strip the query string
      // by taking only the base URL (scheme + origin + path), preserving
      // the exact encoding of the pasted URL.
      const baseUrlString = pastedUrl.split('?')[0];
      const baseUrl = baseUrlString.replace(/\/+$/, '');
      const apiUrl = `${baseUrl}/_api/web?$select=ServerRelativeUrl`;

      logger.info(`Resolving SharePoint site from pasted URL: ${baseUrl}`);

      const response = await this.makeNTLMRequest(apiUrl, credentials, 'GET');
      const serverRelativeUrl = response?.data?.d?.ServerRelativeUrl;

      if (typeof serverRelativeUrl !== 'string') {
        const contentType = response?.headers?.['content-type'] || 'unknown';
        const bodyPreview =
          typeof response?.data === 'string'
            ? response.data.slice(0, 200)
            : JSON.stringify(response?.data).slice(0, 200);
        throw new Error(
          `Could not resolve a SharePoint site from this URL (content-type: ${contentType}). Body preview: ${bodyPreview}`
        );
      }

      // A browsed AllItems.aspx URL (on-prem's equivalent of Online's
      // ?id=... shape) carries the real target folder in ?RootFolder=...,
      // not in the page's own path — the page path is just the library's
      // Forms view. Prefer it when present; fall back to the URL's own path
      // for a direct folder link that has no RootFolder param.
      const rootFolderParam = parsedUrl.searchParams.get('RootFolder');
      const fullPath = rootFolderParam ?? decodeURIComponent(parsedUrl.pathname);
      // fullPath includes the site's own path prefix (serverRelativeUrl) —
      // strip it so `folder` is relative to the site, not duplicated when
      // constructFolderPath re-prepends the site path.
      const folder = fullPath.startsWith(serverRelativeUrl)
        ? fullPath.slice(serverRelativeUrl.length).replace(/^\/+/, '')
        : fullPath.replace(/^\/+/, '');

      return {
        siteUrl: `${parsedUrl.origin}${serverRelativeUrl}`,
        library: '',
        folder,
      };
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
    const contentType = response?.headers?.['content-type'] || 'unknown';
    const bodyPreview =
      typeof response?.data === 'string' ? response.data.slice(0, 200) : JSON.stringify(response?.data).slice(0, 200);
    throw new Error(
      `Unexpected response fetching ${context} (content-type: ${contentType}). Body preview: ${bodyPreview}`
    );
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

      const response = await this.makeNTLMRequest(apiUrl, credentials, 'GET');

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
   * Lists all Word template files (.docx, .dotx) from a SharePoint folder and its subfolders
   * Automatically detects docType from subfolder names
   * Supports both NTLM (on-premise) and OAuth (SharePoint Online)
   */
  async listTemplateFiles(
    config: SharePointConfig,
    credentials: SharePointCredentials | SharePointOAuthToken
  ): Promise<SharePointFile[]> {
    try {
      const isOnline = this.isSharePointOnline(config.siteUrl);
      const isOAuth = 'accessToken' in credentials;

      if (isOnline && isOAuth) {
        // config.siteUrl doubles as the pasted SharePoint/OneDrive sharing
        // link for the Online/Graph path — library/folder are unused here.
        return await this.graphService.listTemplateFiles(config.siteUrl, credentials);
      }

      const folderPath = this.constructFolderPath(config);

      // First, get list of subfolders
      const foldersApiUrl = `${config.siteUrl}/_api/web/GetFolderByServerRelativeUrl('${this.toServerRelativeUrlLiteral(folderPath)}')/Folders`;
      
      logger.info(`Fetching subfolders from SharePoint: ${foldersApiUrl} (${isOAuth ? 'OAuth' : 'NTLM'})`);
      
      const foldersResponse = await this.makeSharePointRequest(foldersApiUrl, credentials, 'GET');
      this.assertJsonListResponse(foldersResponse, 'subfolders');

      const allTemplateFiles: SharePointFile[] = [];
      const subfolders = foldersResponse.data.d.results;

      logger.info(`Found ${subfolders.length} subfolders in ${folderPath}`);

      // For each subfolder, get the files
      for (const subfolder of subfolders) {
        const subfolderName = subfolder.Name;
        const subfolderPath = subfolder.ServerRelativeUrl;

        // Skip system folders
        if (subfolderName.startsWith('_') || subfolderName.startsWith('.')) {
          continue;
        }

        const filesApiUrl = `${config.siteUrl}/_api/web/GetFolderByServerRelativeUrl('${this.toServerRelativeUrlLiteral(subfolderPath)}')/Files`;

        logger.info(`Fetching files from subfolder: ${subfolderName}`);

        const filesResponse = await this.makeSharePointRequest(filesApiUrl, credentials, 'GET');
        this.assertJsonListResponse(filesResponse, `files in subfolder "${subfolderName}"`);

        const files = filesResponse.data.d.results;

        // Filter for Word template files (excludes ~$ Office lock files and oversized files)
        const templateFiles = files.filter((file: any) => {
          if (!isTemplateFileName(file.Name)) return false;
          if (!isWithinMaxTemplateSize(Number(file.Length))) {
            logger.warn(`Skipping SharePoint file "${file.Name}" — size ${file.Length} bytes exceeds the sync limit`);
            return false;
          }
          return true;
        });

        // Add files with docType from subfolder name
        templateFiles.forEach((file: any) => {
          allTemplateFiles.push({
            name: file.Name,
            serverRelativeUrl: file.ServerRelativeUrl,
            timeCreated: file.TimeCreated,
            timeLastModified: file.TimeLastModified,
            length: file.Length,
            docType: subfolderName, // Subfolder name becomes the docType
          });
        });

        logger.info(`Found ${templateFiles.length} template files in ${subfolderName}`);
      }

      logger.info(`Total template files found: ${allTemplateFiles.length}`);

      return allTemplateFiles;
    } catch (error: any) {
      logger.error(`Failed to list SharePoint files: ${error.message}`);
      throw new Error(`Failed to list SharePoint files: ${error.message}`);
    }
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
   * Makes a SharePoint API request (supports both NTLM and OAuth)
   */
  private async makeSharePointRequest(
    url: string,
    auth: SharePointCredentials | SharePointOAuthToken,
    method: string = 'GET',
    additionalConfig: any = {}
  ): Promise<any> {
    const isOAuth = 'accessToken' in auth;
    
    if (isOAuth) {
      return this.makeOAuthRequest(url, auth as SharePointOAuthToken, method, additionalConfig);
    } else {
      return this.makeNTLMRequest(url, auth as SharePointCredentials, method, additionalConfig);
    }
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
