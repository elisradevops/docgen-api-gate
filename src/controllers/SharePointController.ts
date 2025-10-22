import { Request, Response } from 'express';
import {
  SharePointService,
  SharePointCredentials,
  SharePointOAuthToken,
  SharePointConfig,
  SharePointFile,
} from '../services/SharePointService';
import { SharePointConfig as ConfigModel } from '../models/SharePointConfig';
import logger from '../util/logger';
import { MinioController } from './MinioController';
import { Readable } from 'stream';

export class SharePointController {
  private sharePointService: SharePointService;
  private minioController: MinioController;

  constructor() {
    this.sharePointService = new SharePointService();
    this.minioController = new MinioController();
  }

  /**
   * Test SharePoint connection
   * POST /sharepoint/test-connection
   * Body: { siteUrl, library, folder, credentials?: { username, password, domain? }, oauthToken?: { accessToken } }
   */
  public async testConnection(req: Request, res: Response): Promise<void> {
    try {
      const { siteUrl, library, folder, credentials, oauthToken } = req.body;

      if (!siteUrl || !library || !folder || (!credentials && !oauthToken)) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      const config: SharePointConfig = { siteUrl, library, folder };
      const auth = oauthToken || credentials;
      const result = await this.sharePointService.testConnection(config, auth);

      res.status(200).json(result);
    } catch (error: any) {
      logger.error(`Test connection error: ${error.message}`);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * List template files from SharePoint folder
   * POST /sharepoint/list-files
   * Body: { siteUrl, library, folder, credentials?, oauthToken? }
   */
  public async listFiles(req: Request, res: Response): Promise<void> {
    try {
      const { siteUrl, library, folder, credentials, oauthToken } = req.body;

      if (!siteUrl || !library || !folder || (!credentials && !oauthToken)) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      const config: SharePointConfig = { siteUrl, library, folder };
      const auth = oauthToken || credentials;
      const files = await this.sharePointService.listTemplateFiles(config, auth);

      res.status(200).json({ success: true, files });
    } catch (error: any) {
      logger.error(`List files error: ${error.message}`);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Check for file conflicts before syncing
   * POST /sharepoint/check-conflicts
   * Body: { siteUrl, library, folder, credentials?, oauthToken?, bucketName, projectName, docType }
   */
  public async checkConflicts(req: Request, res: Response): Promise<void> {
    try {
      const { siteUrl, library, folder, credentials, oauthToken, bucketName, projectName, docType } =
        req.body;

      if (!siteUrl || !library || !folder || (!credentials && !oauthToken) || !bucketName || !projectName) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      const config: SharePointConfig = { siteUrl, library, folder };
      const auth = oauthToken || credentials;

      // Get files from SharePoint (includes docType from subfolder names)
      const spFiles = await this.sharePointService.listTemplateFiles(config, auth);

      // Group files by docType for conflict checking
      const conflicts: any[] = [];
      const newFiles: any[] = [];
      const invalidFiles: any[] = [];
      const VALID_DOC_TYPES = ['STD', 'STR', 'SVD', 'SRS'];

      for (const spFile of spFiles) {
        const targetDocType = spFile.docType || docType || '';
        
        // Skip files with invalid docType
        if (!targetDocType || !VALID_DOC_TYPES.includes(targetDocType.toUpperCase())) {
          invalidFiles.push({
            name: spFile.name,
            size: spFile.length,
            docType: targetDocType || 'none',
            error: `Invalid docType "${targetDocType}". Valid types are: ${VALID_DOC_TYPES.join(', ')}`,
          });
          continue;
        }
        
        let existingFiles: string[] = [];

        try {
          // Check MinIO for existing files in this docType folder
          const mockReq: any = {
            params: { bucketName },
            query: { docType: targetDocType, projectName, isExternalUrl: false, recurse: false },
          };
          const mockRes: any = {
            status: (code: number) => ({
              json: (data: any) => {
                if (code === 200 && data.bucketFileList) {
                  existingFiles = data.bucketFileList.map((f: any) => f.name);
                }
              },
            }),
          };

          await this.minioController.getBucketFileList(mockReq, mockRes);
        } catch (error) {
          logger.warn(`Could not fetch existing files from MinIO for ${targetDocType}: ${error}`);
        }

        // Check if this file conflicts
        const fileExists = existingFiles.some((existingFile) => existingFile.endsWith(spFile.name));

        if (fileExists) {
          conflicts.push({
            name: spFile.name,
            size: spFile.length,
            docType: targetDocType,
          });
        } else {
          newFiles.push({
            name: spFile.name,
            size: spFile.length,
            docType: targetDocType,
          });
        }
      }

      res.status(200).json({
        success: true,
        totalFiles: spFiles.length,
        conflicts,
        newFiles,
        invalidFiles,
      });
    } catch (error: any) {
      logger.error(`Check conflicts error: ${error.message}`);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Sync templates from SharePoint to MinIO
   * POST /sharepoint/sync-templates
   * Body: { siteUrl, library, folder, credentials?, oauthToken?, bucketName, projectName, docType, skipFiles? }
   */
  public async syncTemplates(req: Request, res: Response): Promise<void> {
    try {
      const {
        siteUrl,
        library,
        folder,
        credentials,
        oauthToken,
        bucketName,
        projectName,
        docType,
        skipFiles,
      } = req.body;

      if (!siteUrl || !library || !folder || (!credentials && !oauthToken) || !bucketName || !projectName) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      const config: SharePointConfig = { siteUrl, library, folder };
      const auth = oauthToken || credentials;

      // Get all template files from SharePoint
      const allFiles = await this.sharePointService.listTemplateFiles(config, auth);

      // Filter out files user wants to skip
      const filesToSync = allFiles.filter((f) => !skipFiles.includes(f.name));

      logger.info(
        `Syncing ${filesToSync.length} files from SharePoint to MinIO (skipping ${skipFiles.length})`
      );

      const syncResults = {
        success: true,
        totalFiles: allFiles.length,
        syncedFiles: [] as string[],
        skippedFiles: skipFiles || [],
        failedFiles: [] as { name: string; error: string }[],
      };

      // Sync each file
      for (const file of filesToSync) {
        try {
          // Download file from SharePoint
          const fileBuffer = await this.sharePointService.downloadFile(siteUrl, file.serverRelativeUrl, auth);

          // Use docType from file (subfolder name) or fallback to request docType
          const targetDocType = file.docType || docType || '';

          logger.info(
            `File: ${file.name}, docType from file: ${file.docType}, final docType: ${targetDocType}`
          );

          // Skip files without docType
          if (!targetDocType) {
            logger.warn(`Skipping ${file.name} - no docType available`);
            syncResults.failedFiles.push({
              name: file.name,
              error: 'No docType available. File must be in a subfolder.',
            });
            continue;
          }

          // Validate docType against allowed values
          const VALID_DOC_TYPES = ['STD', 'STR', 'SVD', 'SRS'];
          if (!VALID_DOC_TYPES.includes(targetDocType.toUpperCase())) {
            logger.warn(`Skipping ${file.name} - invalid docType: ${targetDocType}. Valid types are: ${VALID_DOC_TYPES.join(', ')}`);
            syncResults.failedFiles.push({
              name: file.name,
              error: `Invalid docType "${targetDocType}". Valid types are: ${VALID_DOC_TYPES.join(', ')}`,
            });
            continue;
          }

          // Save buffer to temporary file for MinioController
          const fs = require('fs');
          const path = require('path');
          const os = require('os');
          
          const tempDir = os.tmpdir();
          const tempFilePath = path.join(tempDir, `${Date.now()}-${file.name}`);
          fs.writeFileSync(tempFilePath, fileBuffer);

          logger.info(`Uploading to MinIO: bucketName=${bucketName}, projectName=${projectName}, docType=${targetDocType}`);

          // Create a file object compatible with multer
          const fileObject: any = {
            path: tempFilePath,
            originalname: file.name,
            mimetype: file.name.endsWith('.dotx')
              ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.template'
              : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: file.length,
          };

          // Upload to MinIO using MinioController
          const mockReq: any = {
            file: fileObject,
            body: {
              bucketName,
              teamProjectName: projectName,
              docType: targetDocType,
              isExternal: false,
            },
          };

          const mockRes: any = {}; // Not used by MinioController

          // MinioController.uploadFile returns a Promise
          await this.minioController.uploadFile(mockReq, mockRes);
          
          // If we get here, upload succeeded
          syncResults.syncedFiles.push(file.name);
          logger.info(`Successfully synced: ${file.name}`);
        } catch (error: any) {
          logger.error(`Error syncing file ${file.name}: ${error.message}`);
          syncResults.failedFiles.push({
            name: file.name,
            error: error.message,
          });
        }
      }

      res.status(200).json(syncResults);
    } catch (error: any) {
      logger.error(`Sync templates error: ${error.message}`);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Save SharePoint configuration
   * POST /sharepoint/config
   */
  public async saveConfig(req: Request, res: Response): Promise<void> {
    try {
      const { userId, projectName, siteUrl, library, folder, displayName } = req.body;

      if (!siteUrl || !library || !folder) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      // Find existing config or create new
      let config = await ConfigModel.findOne({ userId, projectName });

      if (config) {
        // Update existing
        config.siteUrl = siteUrl;
        config.library = library;
        config.folder = folder;
        config.displayName = displayName;
        config.lastUsed = new Date();
        await config.save();
      } else {
        // Create new
        config = new ConfigModel({
          userId,
          projectName,
          siteUrl,
          library,
          folder,
          displayName,
        });
        await config.save();
      }

      res.status(200).json({ success: true, config });
    } catch (error: any) {
      logger.error(`Save config error: ${error.message}`);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Get SharePoint configuration
   * GET /sharepoint/config?projectName=xxx
   * Headers: X-User-Id
   */
  public async getConfig(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.headers['x-user-id'] as string;
      const { projectName } = req.query;

      const query: any = {};
      if (userId) query.userId = userId;
      if (projectName) query.projectName = projectName;

      const config = await ConfigModel.findOne(query).sort({ lastUsed: -1 });

      if (config) {
        // Update last used
        config.lastUsed = new Date();
        await config.save();
        res.status(200).json({ success: true, config });
      } else {
        res.status(404).json({ success: false, message: 'No configuration found' });
      }
    } catch (error: any) {
      logger.error(`Get config error: ${error.message}`);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Get all SharePoint configurations for a user
   * GET /sharepoint/configs
   * Headers: X-User-Id
   */
  public async getConfigs(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.headers['x-user-id'] as string;

      if (!userId) {
        res.status(400).json({ success: false, message: 'userId is required in headers' });
        return;
      }

      const configs = await ConfigModel.find({ userId }).sort({ lastUsed: -1 }).limit(10);

      res.status(200).json({ success: true, configs });
    } catch (error: any) {
      logger.error(`Get configs error: ${error.message}`);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Get ALL SharePoint configurations for a user (no limit, for management UI)
   * GET /sharepoint/configs/all
   * Headers: X-User-Id
   */
  public async getAllConfigs(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.headers['x-user-id'] as string;

      if (!userId) {
        res.status(400).json({ success: false, message: 'userId is required in headers' });
        return;
      }

      const configs = await ConfigModel.find({ userId }).sort({ projectName: 1 });

      res.status(200).json({ success: true, configs });
    } catch (error: any) {
      logger.error(`Get all configs error: ${error.message}`);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Delete SharePoint configuration for a project
   * DELETE /sharepoint/config?projectName=xxx
   * Headers: X-User-Id
   */
  public async deleteConfig(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.headers['x-user-id'] as string;
      const { projectName } = req.query;

      if (!userId || !projectName) {
        res.status(400).json({ success: false, message: 'userId and projectName are required' });
        return;
      }

      const result = await ConfigModel.deleteOne({ userId, projectName: projectName as string });

      if (result.deletedCount === 0) {
        res.status(404).json({ success: false, message: 'Configuration not found' });
        return;
      }

      logger.info(`Deleted SharePoint config for user ${userId}, project ${projectName}`);
      res.status(200).json({ success: true, message: 'Configuration deleted successfully' });
    } catch (error: any) {
      logger.error(`Delete config error: ${error.message}`);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}
