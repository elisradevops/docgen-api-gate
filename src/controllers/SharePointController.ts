import { Request, Response } from 'express';
import {
  SharePointService,
  SharePointConfig as SharePointConfigType,
  SharePointCredentials,
  isSharePointOnlineUrl,
} from '../services/SharePointService';
import { MinioController } from './MinioController';
import logger from '../util/logger';
import { getMinioFiles } from '../helpers/sharePointHelpers/sharePointHelper';
import { SharePointConfig as ConfigModel } from '../models/SharePointConfig';
import { createTokenProvider, GraphTokenProvider } from '../services/auth/MsalClientService';
import { classifySharePointUrl } from '../util/sharePointLinkClassifier';

type ResolvedAuth = SharePointCredentials | GraphTokenProvider;
type AuthResolution = { auth: ResolvedAuth } | { error: { status: number; message: string } };

// Kept in sync with the toast in TemplatesTab.jsx and docs/wiki/SharePoint_Sync_Guide.txt.
// 'MEETING-SUMMARY' matches MEETING_SUMMARY_DOC_TYPE in meetingSummaryUtils.js — the
// isValidTemplateDocType check below uppercases the subfolder name before comparing,
// but the original subfolder casing ("Meeting-Summary") is preserved as the docType
// used for the MinIO path.
const VALID_TEMPLATE_DOC_TYPES = ['STD', 'STP', 'STR', 'SVD', 'SRS', 'SYSRS', 'MEETING-SUMMARY'] as const;

const isValidTemplateDocType = (docType: string) =>
  VALID_TEMPLATE_DOC_TYPES.includes((docType || '').toUpperCase() as (typeof VALID_TEMPLATE_DOC_TYPES)[number]);

export class SharePointController {
  private sharePointService: SharePointService;
  private minioController: MinioController;

  constructor() {
    this.sharePointService = new SharePointService();
    this.minioController = new MinioController();
  }

  /**
   * Turns a request's body/session into the auth value SharePointService
   * needs. Online authenticates exclusively via the BFF session
   * (attachSessionIfPresent populates req.spSession — see JsonDocRoutes.ts);
   * a client-supplied `oauthToken` is rejected outright, never silently
   * ignored. On-prem NTLM is untouched: `credentials` in the body, no
   * session, since these routes are dual-purpose and on-prem callers never
   * authenticate via /auth/login.
   */
  private resolveAuth(req: Request, siteUrl: string): AuthResolution {
    const { credentials, oauthToken } = req.body;

    if (oauthToken) {
      return { error: { status: 400, message: 'oauth_token_not_accepted' } };
    }

    if (isSharePointOnlineUrl(siteUrl)) {
      const session = (req as any).spSession as { homeAccountId: string } | undefined;
      if (!session) {
        return { error: { status: 401, message: 'reauth_required' } };
      }
      return { auth: createTokenProvider(session.homeAccountId) };
    }

    if (!credentials) {
      return { error: { status: 400, message: 'Missing required fields' } };
    }
    return { auth: credentials };
  }

  /**
   * Test SharePoint connection
   * POST /sharepoint/test-connection
   * Body: { siteUrl, library, folder, credentials?: { username, password, domain? } } — Online authenticates via the BFF session, not a body field.
   */
  public async testConnection(req: Request, res: Response): Promise<void> {
    try {
      const { siteUrl, library, folder } = req.body;

      if (!siteUrl) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      const authResult = this.resolveAuth(req, siteUrl);
      if ('error' in authResult) {
        res.status(authResult.error.status).json({ success: false, message: authResult.error.message });
        return;
      }

      // library/folder are only meaningful for on-prem (NTLM) configs — an
      // Online config's siteUrl is itself the pasted sharing/folder link,
      // so library/folder are legitimately empty there.
      if (!isSharePointOnlineUrl(siteUrl) && !folder) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      const config: SharePointConfigType = { siteUrl, library, folder };
      const result = await this.sharePointService.testConnection(config, authResult.auth);

      res.status(200).json(result);
    } catch (error: any) {
      logger.error(`Test connection error: ${error.message}`);
      res.status(error.status || 500).json({ success: false, message: error.message });
    }
  }

  /**
   * Resolves a pasted on-prem templates-folder URL (copied from the browser
   * address bar) into a ready-to-save { siteUrl, library, folder } — lets
   * the connect dialog take one pasted URL instead of three typed fields.
   * On-prem/NTLM only: Online configs already work off one pasted sharing
   * link with no server-side resolution needed.
   * POST /sharepoint/resolve-url
   * Body: { url, credentials: { username, password, domain? } }
   */
  public async resolveUrl(req: Request, res: Response): Promise<void> {
    try {
      const { url, credentials } = req.body;

      if (!url || !credentials) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      const resolved = await this.sharePointService.resolveSiteFromUrl(url, credentials);

      res.status(200).json({ success: true, ...resolved });
    } catch (error: any) {
      logger.error(`Resolve URL error: ${error.message}`);
      res.status(error.status || 500).json({ success: false, message: error.message });
    }
  }

  /**
   * List template files from SharePoint folder
   * POST /sharepoint/list-files
   * Body: { siteUrl, library, folder, credentials? } — Online authenticates via the BFF session, not a body field.
   */
  public async listFiles(req: Request, res: Response): Promise<void> {
    try {
      const { siteUrl, library, folder } = req.body;

      if (!siteUrl) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      const authResult = this.resolveAuth(req, siteUrl);
      if ('error' in authResult) {
        res.status(authResult.error.status).json({ success: false, message: authResult.error.message });
        return;
      }

      if (!isSharePointOnlineUrl(siteUrl) && !folder) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      const config: SharePointConfigType = { siteUrl, library, folder };
      const { files, truncated, skippedFolders = [] } = await this.sharePointService.listTemplateFiles(
        config,
        authResult.auth
      );
      if (skippedFolders.length > 0) {
        logger.warn(`Skipped ${skippedFolders.length} inaccessible folder(s) while listing files`);
      }

      res.status(200).json({ success: true, files, truncated, skippedFolders });
    } catch (error: any) {
      logger.error(`List files error: ${error.message}`);
      res.status(error.status || 500).json({ success: false, message: error.message });
    }
  }

  /**
   * Check for file conflicts before syncing
   * POST /sharepoint/check-conflicts
   * Body: { siteUrl, library, folder, credentials?, bucketName, projectName, docType } — Online authenticates via the BFF session, not a body field.
   */
  public async checkConflicts(req: Request, res: Response): Promise<void> {
    try {
      const { siteUrl, library, folder, bucketName, projectName, docType, docTypeOverrides } = req.body;

      if (!siteUrl || !bucketName || !projectName) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      const authResult = this.resolveAuth(req, siteUrl);
      if ('error' in authResult) {
        res.status(authResult.error.status).json({ success: false, message: authResult.error.message });
        return;
      }

      if (!isSharePointOnlineUrl(siteUrl) && !folder) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      // Templates only ever sync into a real team project's bucket path —
      // 'shared' (the standard/shared-templates library sentinel) is not a
      // valid sync target, enforced here too, not just in the UI.
      if (projectName === 'shared') {
        res
          .status(400)
          .json({ success: false, message: 'A team project must be selected to sync templates' });
        return;
      }

      const config: SharePointConfigType = { siteUrl, library, folder };

      // Get files from SharePoint, recursively (includes docType from the
      // immediate parent folder name, when there is one)
      const {
        files: spFiles,
        truncated,
        skippedFolders = [],
      } = await this.sharePointService.listTemplateFiles(config, authResult.auth);
      logger.info(`Checking ${spFiles.length} SharePoint files for conflicts${truncated ? ' (listing truncated)' : ''}`);
      if (skippedFolders.length > 0) {
        logger.warn(`Skipped ${skippedFolders.length} inaccessible folder(s) while checking conflicts`);
      }

      // Group files by docType for conflict checking
      const conflicts: any[] = [];
      const newFiles: any[] = [];
      const invalidFiles: any[] = [];

      for (const spFile of spFiles) {
        const targetDocType = docTypeOverrides?.[spFile.relativePath] || spFile.docType || docType || '';

        // A file with no auto-detected (or already-invalid) docType is no
        // longer hard-rejected here — it's surfaced as a reviewable row
        // with an empty docType so the review dialog can let the user
        // manually assign one via a per-row selector. `invalidFiles` is
        // kept for defensive symmetry but should rarely populate now.
        if (!targetDocType || !isValidTemplateDocType(targetDocType)) {
          newFiles.push({
            name: spFile.name,
            relativePath: spFile.relativePath,
            size: spFile.length,
            docType: '',
            timeCreated: spFile.timeCreated,
            timeLastModified: spFile.timeLastModified,
            needsDocType: true,
          });
          continue;
        }

        // Check MinIO for existing files in this docType folder
        const existingFiles = await getMinioFiles(
          this.minioController,
          bucketName,
          projectName,
          targetDocType
        );

        // Check if this file conflicts
        // MinIO path format: projectName/docType/filename.ext
        // We need to match just the filename, not the full path
        const fileName = spFile.name.split('/').pop() || spFile.name;

        const existingFile = existingFiles.find((ef) => {
          const existingFileName = ef.name.split('/').pop() || ef.name;
          return existingFileName === fileName;
        });

        if (existingFile) {
          // File exists - check if content is different by comparing size
          // Convert both to numbers to handle type mismatches (SharePoint may return string)
          const spSize = Number(spFile.length);
          const minioSize = Number(existingFile.size);
          const sizeChanged = minioSize !== spSize;

          if (sizeChanged) {
            // File has changed - show as conflict
            logger.info(`Conflict: ${fileName} (size changed: ${minioSize} → ${spSize})`);

            conflicts.push({
              name: spFile.name,
              relativePath: spFile.relativePath,
              size: spFile.length,
              docType: targetDocType,
              timeCreated: spFile.timeCreated,
              timeLastModified: spFile.timeLastModified,
              existingSize: existingFile.size,
              sizeChanged: true,
            });
          } else {
            // File is identical (same size) - skip it
            logger.debug(`Skipping identical: ${fileName} (size: ${spSize})`);
          }
        } else {
          // New file
          logger.info(`New file: ${fileName}`);

          newFiles.push({
            name: spFile.name,
            relativePath: spFile.relativePath,
            size: spFile.length,
            docType: targetDocType,
            timeCreated: spFile.timeCreated,
            timeLastModified: spFile.timeLastModified,
          });
        }
      }

      logger.info(
        `Conflict check complete: ${newFiles.length} new, ${conflicts.length} conflicts, ${invalidFiles.length} invalid`
      );

      res.status(200).json({
        success: true,
        totalFiles: spFiles.length,
        conflicts,
        newFiles,
        invalidFiles,
        truncated,
        skippedFolders,
      });
    } catch (error: any) {
      logger.error(`Check conflicts error: ${error.message}`);
      res.status(error.status || 500).json({ success: false, message: error.message });
    }
  }

  /**
   * Sync templates from SharePoint to MinIO
   * POST /sharepoint/sync-templates
   * Body: { siteUrl, library, folder, credentials?, bucketName, projectName, docType, skipFiles? } — Online authenticates via the BFF session, not a body field.
   */
  public async syncTemplates(req: Request, res: Response): Promise<void> {
    try {
      const { siteUrl, library, folder, bucketName, projectName, docType, skipFiles, docTypeOverrides } = req.body;

      if (!siteUrl || !bucketName || !projectName) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      const authResult = this.resolveAuth(req, siteUrl);
      if ('error' in authResult) {
        res.status(authResult.error.status).json({ success: false, message: authResult.error.message });
        return;
      }
      const auth = authResult.auth;

      if (!isSharePointOnlineUrl(siteUrl) && !folder) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      // Templates only ever sync into a real team project's bucket path —
      // 'shared' (the standard/shared-templates library sentinel) is not a
      // valid sync target, enforced here too, not just in the UI.
      if (projectName === 'shared') {
        res
          .status(400)
          .json({ success: false, message: 'A team project must be selected to sync templates' });
        return;
      }

      const config: SharePointConfigType = { siteUrl, library, folder };

      // Get all template files from SharePoint, recursively
      const {
        files: allFiles,
        truncated,
        skippedFolders = [],
      } = await this.sharePointService.listTemplateFiles(config, auth);
      if (truncated) {
        logger.warn('SharePoint template listing was truncated (depth/count cap) — syncing only what was listed');
      }
      if (skippedFolders.length > 0) {
        logger.warn(`Skipped ${skippedFolders.length} inaccessible folder(s) while syncing templates`);
      }

      // Filter out files user wants to skip (from conflict dialog). Keyed by
      // relativePath, not name — recursion permits duplicate basenames in
      // different folders, which a name-only key can't tell apart.
      let filesToSync = allFiles.filter((f) => !skipFiles || !skipFiles.includes(f.relativePath));

      // Also skip identical files (same size as existing files in MinIO)
      const identicalFiles: string[] = []; // relativePaths
      for (const file of filesToSync) {
        const targetDocType = docTypeOverrides?.[file.relativePath] || file.docType || docType || '';
        if (!targetDocType) continue;

        try {
          // Check if file exists in MinIO with same size
          const minioFiles = await getMinioFiles(
            this.minioController,
            bucketName,
            projectName,
            targetDocType
          );
          const fileName = file.name.split('/').pop() || file.name;
          const existingFile = minioFiles.find((ef) => {
            const existingFileName = ef.name.split('/').pop() || ef.name;
            return existingFileName === fileName;
          });

          if (existingFile && Number(existingFile.size) === Number(file.length)) {
            // Identical file - skip it
            identicalFiles.push(file.relativePath);
            logger.debug(`Skipping identical: ${file.name} (size: ${file.length})`);
          }
        } catch (error) {
          logger.warn(`Could not check for identical file: ${file.name}`);
        }
      }

      // Remove identical files from sync list
      filesToSync = filesToSync.filter((f) => !identicalFiles.includes(f.relativePath));

      // Recursion permits duplicate basenames living in different
      // SharePoint folders (e.g. "STD-template.dotx" under two different
      // subfolders) — the MinIO destination is only bucket/project/docType/
      // <basename>, not relativePath, so two files manually mapped (or
      // bulk-assigned from the review dialog) to the same docType would
      // silently overwrite each other with no indication anything was
      // lost. Detect this before any download/upload happens: keep the
      // first file for each destination, fail the rest with a clear reason
      // instead of a silent overwrite.
      const destinationKeyOf = (file: (typeof filesToSync)[number]) => {
        const targetDocType = docTypeOverrides?.[file.relativePath] || file.docType || docType || '';
        const baseName = file.name.split('/').pop() || file.name;
        return `${targetDocType}/${baseName}`;
      };
      const seenDestinations = new Map<string, string>(); // destinationKey -> first file's relativePath
      const duplicateDestinationPaths = new Set<string>();
      const duplicateDestinationFiles: { name: string; error: string }[] = [];
      for (const file of filesToSync) {
        const key = destinationKeyOf(file);
        const firstRelativePath = seenDestinations.get(key);
        if (firstRelativePath) {
          duplicateDestinationPaths.add(file.relativePath);
          duplicateDestinationFiles.push({
            name: file.name,
            error: `Skipped — another file ("${firstRelativePath}") also maps to the same destination (${key}); only the first is synced. Map these to different document types, or rename one, to sync both.`,
          });
        } else {
          seenDestinations.set(key, file.relativePath);
        }
      }
      if (duplicateDestinationPaths.size > 0) {
        filesToSync = filesToSync.filter((f) => !duplicateDestinationPaths.has(f.relativePath));
        logger.warn(
          `${duplicateDestinationFiles.length} file(s) skipped — duplicate destination after docType mapping`
        );
      }

      logger.info(
        `Syncing ${filesToSync.length} files from SharePoint to MinIO (user skipped: ${
          skipFiles?.length || 0
        }, identical: ${identicalFiles.length}, duplicate destination: ${duplicateDestinationFiles.length})`
      );

      const syncResults = {
        success: true,
        totalFiles: allFiles.length,
        syncedFiles: [] as string[],
        skippedFiles: [...(skipFiles || []), ...identicalFiles],
        identicalFiles,
        failedFiles: [...duplicateDestinationFiles] as { name: string; error: string }[],
        truncated,
        skippedFolders,
      };

      // Sync each file
      for (const file of filesToSync) {
        try {
          // Download file from SharePoint
          const fileBuffer = await this.sharePointService.downloadFile(siteUrl, file.serverRelativeUrl, auth);

          // Manually-assigned type (from the review dialog's per-row
          // selector) wins over auto-detection from the parent folder name,
          // which in turn wins over the request-level fallback docType.
          const targetDocType = docTypeOverrides?.[file.relativePath] || file.docType || docType || '';

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
          if (!isValidTemplateDocType(targetDocType)) {
            logger.warn(
              `Skipping ${
                file.name
              } - invalid docType: ${targetDocType}. Valid types are: ${VALID_TEMPLATE_DOC_TYPES.join(', ')}`
            );
            syncResults.failedFiles.push({
              name: file.name,
              error: `Invalid docType "${targetDocType}". Valid types are: ${VALID_TEMPLATE_DOC_TYPES.join(', ')}`,
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

          logger.info(
            `Uploading to MinIO: bucketName=${bucketName}, projectName=${projectName}, docType=${targetDocType}`
          );

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
              // Real SharePoint modified date — persisted as object metadata so the
              // Templates tab shows when the template actually changed, not when
              // MinIO happened to store it.
              sourceLastModified: file.timeLastModified,
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
      res.status(error.status || 500).json({ success: false, message: error.message });
    }
  }

  /**
   * Save SharePoint configuration
   * POST /sharepoint/config
   */
  public async saveConfig(req: Request, res: Response): Promise<void> {
    try {
      const { userId, siteUrl, library, folder, displayName } = req.body;

      // library/folder are only meaningful for on-prem configs; an Online
      // config's siteUrl is itself the pasted sharing/folder link, and even
      // the on-prem paste-a-URL flow (resolveSiteFromUrl) leaves library
      // blank (the whole path lands in folder). Neither is reliably
      // required anymore — siteUrl is the only field every config needs.
      if (!siteUrl) {
        res.status(400).json({ success: false, message: 'Missing required fields' });
        return;
      }

      // userId must be a non-empty string, not just truthy — a missing/typed
      // value would otherwise make the findOne below match {} (any user's
      // config), and a JSON body lets userId be an object/query operator.
      if (typeof userId !== 'string' || !userId.trim()) {
        res.status(400).json({ success: false, message: 'userId is required' });
        return;
      }

      // The SharePoint connection is app-level, not per-project: one saved
      // config per user, usable no matter which (if any) team project is
      // selected. Only the eventual sync target is project-scoped.
      let config = await ConfigModel.findOne({ userId });

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
      res.status(error.status || 500).json({ success: false, message: error.message });
    }
  }

  /**
   * Get the app-level SharePoint configuration for a user
   * GET /sharepoint/config
   * Headers: X-User-Id
   */
  public async getConfig(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.headers['x-user-id'];

      // userId must be present, and a single string — a missing/absent
      // header must not degrade into findOne({}), which would return
      // (and touch the lastUsed of) an arbitrary other user's config.
      if (typeof userId !== 'string' || !userId.trim()) {
        res.status(400).json({ success: false, message: 'userId is required in headers' });
        return;
      }

      const config = await ConfigModel.findOne({ userId }).sort({ lastUsed: -1 });

      if (config) {
        // Update last used
        config.lastUsed = new Date();
        await config.save();

        // A row already confirmed (authType + linkResolvedAt persisted, e.g.
        // from a prior successful sync) is trusted as-is; anything else is
        // classified fresh on every read. Optimistic, not authoritative —
        // only testConnection's actual /shares resolution can truly confirm
        // or invalidate it.
        const classification = config.authType && config.linkResolvedAt
          ? 'trusted'
          : classifySharePointUrl({ siteUrl: config.siteUrl, library: config.library, folder: config.folder });
        const requiresRelink = classification === 'online-legacy-site-path';

        res.status(200).json({
          success: true,
          config,
          requiresRelink,
          relinkReason: requiresRelink ? 'legacy-site-path' : null,
        });
      } else {
        res.status(404).json({ success: false, message: 'No configuration found' });
      }
    } catch (error: any) {
      logger.error(`Get config error: ${error.message}`);
      res.status(error.status || 500).json({ success: false, message: error.message });
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
      res.status(error.status || 500).json({ success: false, message: error.message });
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
      res.status(error.status || 500).json({ success: false, message: error.message });
    }
  }

  /**
   * Delete the app-level SharePoint configuration for a user
   * DELETE /sharepoint/config
   * Headers: X-User-Id
   */
  public async deleteConfig(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.headers['x-user-id'] as string;

      if (!userId) {
        res.status(400).json({ success: false, message: 'userId is required' });
        return;
      }

      const result = await ConfigModel.deleteOne({ userId });

      if (result.deletedCount === 0) {
        res.status(404).json({ success: false, message: 'Configuration not found' });
        return;
      }

      logger.info(`Deleted SharePoint config for user ${userId}`);
      res.status(200).json({ success: true, message: 'Configuration deleted successfully' });
    } catch (error: any) {
      logger.error(`Delete config error: ${error.message}`);
      res.status(error.status || 500).json({ success: false, message: error.message });
    }
  }
}
