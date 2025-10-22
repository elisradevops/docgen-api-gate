import axios, { AxiosRequestConfig } from 'axios';
import logger from '../util/logger';
import { ConfidentialClientApplication } from '@azure/msal-node';

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
   * Constructs the full folder path for SharePoint REST API
   */
  private constructFolderPath(config: SharePointConfig): string {
    const sitePath = this.extractSitePath(config.siteUrl);
    // Remove trailing slash from site path
    const cleanSitePath = sitePath.endsWith('/') ? sitePath.slice(0, -1) : sitePath;
    // Construct full path
    return `${cleanSitePath}/${config.library}/${config.folder}`;
  }

  /**
   * Tests SharePoint connection with provided credentials
   */
  async testConnection(
    config: SharePointConfig,
    credentials: SharePointCredentials
  ): Promise<{ success: boolean; message: string }> {
    try {
      const isOnline = this.isSharePointOnline(config.siteUrl);
      
      if (isOnline) {
        return {
          success: false,
          message: 'SharePoint Online requires Azure AD app registration. Please use manual upload or contact IT for app credentials.',
        };
      }

      // Test connection to on-premise SharePoint
      const folderPath = this.constructFolderPath(config);
      const apiUrl = `${config.siteUrl}/_api/web/GetFolderByServerRelativeUrl('${encodeURIComponent(folderPath)}')/Files`;

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

      const folderPath = this.constructFolderPath(config);
      
      // First, get list of subfolders
      const foldersApiUrl = `${config.siteUrl}/_api/web/GetFolderByServerRelativeUrl('${encodeURIComponent(folderPath)}')/Folders`;
      
      logger.info(`Fetching subfolders from SharePoint: ${foldersApiUrl} (${isOAuth ? 'OAuth' : 'NTLM'})`);
      
      const foldersResponse = await this.makeSharePointRequest(foldersApiUrl, credentials, 'GET');
      
      const allTemplateFiles: SharePointFile[] = [];
      
      if (foldersResponse.data && foldersResponse.data.d && foldersResponse.data.d.results) {
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
          
          const filesApiUrl = `${config.siteUrl}/_api/web/GetFolderByServerRelativeUrl('${encodeURIComponent(subfolderPath)}')/Files`;
          
          logger.info(`Fetching files from subfolder: ${subfolderName}`);
          
          const filesResponse = await this.makeSharePointRequest(filesApiUrl, credentials, 'GET');
          
          if (filesResponse.data && filesResponse.data.d && filesResponse.data.d.results) {
            const files = filesResponse.data.d.results;
            
            // Filter for Word template files
            const templateFiles = files.filter((file: any) => {
              const fileName = file.Name.toLowerCase();
              return fileName.endsWith('.docx') || fileName.endsWith('.dotx');
            });
            
            // Add files with docType from subfolder name
            templateFiles.forEach((file: any) => {
              allTemplateFiles.push({
                name: file.Name,
                serverRelativeUrl: file.ServerRelativeUrl,
                timeLastModified: file.TimeLastModified,
                length: file.Length,
                docType: subfolderName, // Subfolder name becomes the docType
              });
            });
            
            logger.info(`Found ${templateFiles.length} template files in ${subfolderName}`);
          }
        }
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
      const fileUrl = `${siteUrl}/_api/web/GetFileByServerRelativeUrl('${encodeURIComponent(serverRelativeUrl)}')/$value`;

      logger.info(`Downloading file from SharePoint: ${serverRelativeUrl} (${isOAuth ? 'OAuth' : 'NTLM'})`);

      const response = await this.makeSharePointRequest(fileUrl, auth, 'GET', {
        responseType: 'arraybuffer',
      });

      return Buffer.from(response.data);
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
    
    return new Promise((resolve, reject) => {
      const options = {
        url: url,
        username: credentials.username,
        password: credentials.password,
        workstation: credentials.domain || '',
        domain: credentials.domain || '',
        ...additionalConfig,
      };

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
