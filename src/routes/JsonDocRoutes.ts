import { Request, Response } from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { DocumentsGeneratorController } from '../controllers/DocumentsGeneratorController';
import { MinioController } from '../controllers/MinioController';
import moment from 'moment';
import { DatabaseController } from '../controllers/DatabaseController';
import { DataProviderController } from '../controllers/DataProviderController';
import { SharePointController } from '../controllers/SharePointController';
const Minio = require('minio');

export class Routes {
  public documentsGeneratorController: DocumentsGeneratorController = new DocumentsGeneratorController();
  public minioController: MinioController = new MinioController();
  public dataBaseController: DatabaseController = new DatabaseController();
  public dataProviderController: DataProviderController = new DataProviderController();
  public sharePointController: SharePointController = new SharePointController();

  public routes(app: any, upload: any): void {
    app.route('/health').get(async (_req: Request, res: Response) => {
      const readLocalPackageJson = (): any => {
        const candidates = [
          path.resolve(__dirname, '../package.json'),
          path.resolve(__dirname, '../../package.json'),
          path.resolve(process.cwd(), 'package.json'),
        ];
        for (const packageJsonPath of candidates) {
          try {
            if (!fs.existsSync(packageJsonPath)) continue;
            return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          } catch {
            // try next candidate
          }
        }
        return {};
      };

      const apiPackage = readLocalPackageJson();
      const checkedAt = new Date().toISOString();
      type HealthErrorOptions = {
        endpoint?: string;
        hint?: string;
        configKeys?: string[];
        errorCode?: string;
      };

      const selfStatus = {
        key: 'api-gate',
        displayName: 'API Gate',
        status: 'up',
        connectionStatus: 'connected',
        version: String(apiPackage?.version || 'unknown'),
        checkedAt,
      };

      const createDisconnectedStatus = (
        key: string,
        displayName: string,
        error: string,
        endpoint = '',
        options: HealthErrorOptions = {},
      ) => ({
        key,
        displayName,
        status: 'down',
        connectionStatus: 'disconnected',
        version: 'n/a',
        checkedAt,
        endpoint: options.endpoint || endpoint,
        error,
        hint: options.hint,
        configKeys: options.configKeys,
        errorCode: options.errorCode,
      });

      /**
       * Converts low-level connectivity errors (DNS, refused, timeout, network) into
       * explicit health diagnostics for the dashboard.
       */
      const normalizeProbeError = (
        error: any,
        displayName: string,
        endpoint: string,
      ): { message: string; hint?: string; errorCode?: string } => {
        const code = String(error?.code || '').trim().toUpperCase();
        const message = String(error?.message || '').trim();
        const composed = `${code} ${message}`.trim();

        const extractDnsHost = (...sources: string[]): string => {
          for (const source of sources) {
            const value = String(source || '').trim();
            if (!value) continue;

            const fromGetaddrinfo = value.match(/getaddrinfo\s+ENOTFOUND\s+([^\s:]+)/i)?.[1];
            if (fromGetaddrinfo) {
              return fromGetaddrinfo;
            }

            const enotfoundMatches = [...value.matchAll(/ENOTFOUND\s+([^\s:]+)/gi)]
              .map((match) => String(match?.[1] || '').trim())
              .filter((candidate) => candidate && candidate.toLowerCase() !== 'getaddrinfo');
            if (enotfoundMatches.length > 0) {
              return enotfoundMatches[enotfoundMatches.length - 1];
            }
          }
          return '';
        };

        const fallbackHost = (() => {
          try {
            const parsed = new URL(endpoint);
            return parsed.hostname;
          } catch {
            return '';
          }
        })();

        if (/\bENOTFOUND\b/i.test(composed)) {
          const unresolvedHost = extractDnsHost(message, composed) || fallbackHost || 'unknown-host';
          return {
            message: `DNS lookup failed for host "${unresolvedHost}" while reaching ${displayName}.`,
            hint: 'Host/service name may be wrong or not reachable on the Docker network. Verify the configured URL and container name.',
            errorCode: 'ENOTFOUND',
          };
        }

        const refusedMatch = composed.match(/ECONNREFUSED\s+([^\s]+)/i);
        if (refusedMatch) {
          return {
            message: `Connection refused by ${refusedMatch[1]}`,
            hint: `Verify the service is running and reachable at ${endpoint}.`,
            errorCode: 'ECONNREFUSED',
          };
        }

        if (composed.includes('ETIMEDOUT') || composed.includes('ECONNABORTED')) {
          return {
            message: `Connection timed out while reaching ${displayName}`,
            hint: `Verify the service is reachable at ${endpoint} and responds within timeout.`,
            errorCode: composed.includes('ETIMEDOUT') ? 'ETIMEDOUT' : 'ECONNABORTED',
          };
        }

        const networkMatch = composed.match(/(EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)/i);
        if (networkMatch) {
          return {
            message: `Network is unreachable while reaching ${displayName}`,
            hint: `Verify container networking and DNS resolution for ${endpoint}.`,
            errorCode: networkMatch[1],
          };
        }

        return {
          message: message || code || 'Health check failed',
          errorCode: code || undefined,
        };
      };

      /**
       * HTTP-based health probe with multi-path fallback, used for downstream services.
       */
      const probeHttpService = async (
        key: string,
        displayName: string,
        baseUrl: string,
        probePaths: string[] = ['/health', '/'],
        configKeys: string[] = [],
      ) => {
        const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '');
        if (!normalizedBase) {
          return createDisconnectedStatus(key, displayName, 'Service URL is not configured', '', {
            hint: configKeys.length > 0 ? `Set one of: ${configKeys.join(', ')}` : undefined,
            configKeys,
            errorCode: 'MISSING_SERVICE_URL',
          });
        }

        let lastError = 'No successful probe response';
        let lastHint = '';
        let lastErrorCode = '';
        for (const probePath of probePaths) {
          const endpoint = `${normalizedBase}${probePath}`;
          const startedAt = Date.now();
          try {
            const response = await axios.get(endpoint, {
              timeout: 4000,
              validateStatus: () => true,
            });
            const responseTimeMs = Date.now() - startedAt;
            const reachable = response.status > 0 && response.status < 500;
            if (reachable) {
              return {
                key,
                displayName,
                status: 'up',
                connectionStatus: 'connected',
                version: 'n/a',
                checkedAt,
                endpoint,
                responseTimeMs,
                httpStatus: response.status,
              };
            }
            lastError = `HTTP ${response.status}`;
          } catch (error: any) {
            const normalizedError = normalizeProbeError(error, displayName, endpoint);
            lastError = normalizedError.message;
            lastHint = normalizedError.hint || '';
            lastErrorCode = normalizedError.errorCode || '';
          }
        }

        return createDisconnectedStatus(key, displayName, lastError, normalizedBase, {
          hint: lastHint || undefined,
          configKeys,
          errorCode: lastErrorCode || undefined,
        });
      };

      const checkMongoDb = () => {
        const state = Number(mongoose?.connection?.readyState ?? 0);
        const stateLabelMap: Record<number, string> = {
          0: 'disconnected',
          1: 'connected',
          2: 'connecting',
          3: 'disconnecting',
        };
        const stateLabel = stateLabelMap[state] || 'unknown';

        if (state === 1) {
          return {
            key: 'mongodb',
            displayName: 'MongoDB',
            status: 'up',
            connectionStatus: 'connected',
            version: 'n/a',
            checkedAt,
            details: { state, stateLabel },
          };
        }

        if (state === 2) {
          return {
            key: 'mongodb',
            displayName: 'MongoDB',
            status: 'degraded',
            connectionStatus: 'degraded',
            version: 'n/a',
            checkedAt,
            details: { state, stateLabel },
            error: `MongoDB is ${stateLabel}`,
          };
        }

        return {
          ...createDisconnectedStatus('mongodb', 'MongoDB', `MongoDB is ${stateLabel}`),
          details: { state, stateLabel },
        };
      };

      const checkMinio = async () => {
        const endpointRaw = String(process.env.MINIO_ENDPOINT || process.env.MINIOSERVER || '').trim();
        const accessKey = String(process.env.MINIO_ROOT_USER || '').trim();
        const secretKey = String(process.env.MINIO_ROOT_PASSWORD || '').trim();

        if (!endpointRaw) {
          return createDisconnectedStatus('minio', 'MinIO', 'MINIO endpoint is not configured', '', {
            hint: 'Set one of: MINIO_ENDPOINT, MINIOSERVER',
            configKeys: ['MINIO_ENDPOINT', 'MINIOSERVER'],
            errorCode: 'MISSING_SERVICE_URL',
          });
        }
        if (!accessKey || !secretKey) {
          return createDisconnectedStatus('minio', 'MinIO', 'MINIO credentials are not configured', '', {
            hint: 'Set MINIO_ROOT_USER and MINIO_ROOT_PASSWORD.',
            configKeys: ['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD'],
            errorCode: 'MISSING_CREDENTIALS',
          });
        }

        let endPoint = endpointRaw;
        let port = 9000;
        let useSSL = false;
        try {
          if (/^https?:\/\//i.test(endpointRaw)) {
            const parsed = new URL(endpointRaw);
            endPoint = parsed.hostname;
            useSSL = parsed.protocol === 'https:';
            port = Number(parsed.port) || (useSSL ? 443 : 80);
          } else {
            const withoutPath = endpointRaw.split('/')[0];
            const parts = withoutPath.split(':');
            endPoint = parts[0];
            port = Number(parts[1] || 9000);
          }

          const startedAt = Date.now();
          const client = new Minio.Client({
            endPoint,
            port,
            useSSL,
            accessKey,
            secretKey,
          });

          await new Promise((resolve, reject) => {
            client.listBuckets((err: any) => (err ? reject(err) : resolve(true)));
          });

          return {
            key: 'minio',
            displayName: 'MinIO',
            status: 'up',
            connectionStatus: 'connected',
            version: 'n/a',
            checkedAt,
            endpoint: `${useSSL ? 'https' : 'http'}://${endPoint}:${port}`,
            responseTimeMs: Date.now() - startedAt,
          };
        } catch (error: any) {
          const endpoint = `${useSSL ? 'https' : 'http'}://${endPoint}:${port}`;
          const normalizedError = normalizeProbeError(error, 'MinIO', endpoint);
          return createDisconnectedStatus(
            'minio',
            'MinIO',
            normalizedError.message || 'MinIO health check failed',
            endpoint,
            {
              hint: normalizedError.hint,
              configKeys: ['MINIO_ENDPOINT', 'MINIOSERVER'],
              errorCode: normalizedError.errorCode,
            },
          );
        }
      };

      const downloadManagerUrl =
        String(process.env.downloadManagerUrl || '').trim() ||
        String(process.env.DOWNLOAD_MANAGER_URL || '').trim() ||
        String(process.env.MINIO_CLIENT_URL || '').trim();

      const targets = [
        {
          key: 'content-control',
          displayName: 'Content Control',
          baseUrl: String(process.env.dgContentControlUrl || '').trim(),
          path: '/health',
          configKeys: ['dgContentControlUrl'],
        },
        {
          key: 'json-to-word',
          displayName: 'JSON to Word',
          baseUrl: String(process.env.jsonToWordPostUrl || '').trim(),
          path: '/health',
          configKeys: ['jsonToWordPostUrl'],
        },
      ];

      const downstreamServices = await Promise.all(
        targets.map(async (target) => {
          if (!target.baseUrl) {
            return {
              key: target.key,
              displayName: target.displayName,
              status: 'down',
              connectionStatus: 'disconnected',
              version: 'unknown',
              checkedAt,
              endpoint: '',
              error: 'Service URL is not configured',
              hint: `Set ${target.configKeys.join(' or ')}`,
              configKeys: target.configKeys,
              errorCode: 'MISSING_SERVICE_URL',
            };
          }

          const endpoint = `${target.baseUrl.replace(/\/+$/, '')}${target.path}`;
          const startedAt = Date.now();

          try {
            const response = await axios.get(endpoint, {
              timeout: 5000,
              validateStatus: () => true,
            });
            const responseTimeMs = Date.now() - startedAt;
            const payload = response?.data || {};
            const upstreamStatus = String(payload?.status || '');
            const isUpstreamConnected =
              response.status >= 200 &&
              response.status < 300 &&
              upstreamStatus.toLowerCase() !== 'down' &&
              upstreamStatus.toLowerCase() !== 'error';

            return {
              key: target.key,
              displayName: target.displayName,
              status: isUpstreamConnected ? upstreamStatus || 'up' : 'down',
              connectionStatus: isUpstreamConnected ? 'connected' : 'disconnected',
              version: String(payload?.version || 'unknown'),
              checkedAt: String(payload?.timestamp || payload?.checkedAt || checkedAt),
              endpoint,
              responseTimeMs,
              packages: payload?.packages,
              error: isUpstreamConnected ? undefined : payload?.error || `HTTP ${response.status}`,
              hint: isUpstreamConnected ? undefined : payload?.hint,
              configKeys: target.configKeys,
              errorCode: isUpstreamConnected ? undefined : payload?.errorCode,
            };
          } catch (error: any) {
            const normalizedError = normalizeProbeError(error, target.displayName, endpoint);
            return {
              key: target.key,
              displayName: target.displayName,
              status: 'down',
              connectionStatus: 'disconnected',
              version: 'unknown',
              checkedAt,
              endpoint,
              responseTimeMs: Date.now() - startedAt,
              error: normalizedError.message || 'Health check failed',
              hint: normalizedError.hint,
              configKeys: target.configKeys,
              errorCode: normalizedError.errorCode,
            };
          }
        }),
      );

      const getServiceDependencies = (service: any) =>
        Array.isArray(service?.dependencies) ? service.dependencies : [];

      const downloadManagerDependency = await probeHttpService('download-manager', 'Download Manager', downloadManagerUrl, [
        '/health',
        '/',
        '/uploadAttachment',
      ], ['downloadManagerUrl', 'DOWNLOAD_MANAGER_URL', 'MINIO_CLIENT_URL']);

      const downstreamServicesWithDependencies = downstreamServices.map((service) => {
        if (service?.key !== 'content-control') {
          return service;
        }

        const existingDependencies = getServiceDependencies(service);
        const mergedDependencies = [
          ...existingDependencies.filter((dependency: any) => dependency?.key !== 'download-manager'),
          downloadManagerDependency,
        ];
        const hasDisconnectedDependency = mergedDependencies.some(
          (dependency: any) => String(dependency?.connectionStatus || '').toLowerCase() !== 'connected',
        );
        const isServiceUpAndConnected =
          String(service?.status || '').toLowerCase() === 'up' &&
          String(service?.connectionStatus || '').toLowerCase() === 'connected';

        return {
          ...service,
          status: hasDisconnectedDependency && isServiceUpAndConnected ? 'degraded' : service.status,
          connectionStatus:
            hasDisconnectedDependency && isServiceUpAndConnected
              ? 'degraded'
              : service.connectionStatus,
          dependencies: mergedDependencies,
        };
      });

      const apiGateDependencies = await Promise.all([
        checkMinio(),
        Promise.resolve(checkMongoDb()),
      ]);

      const monitoredDependencies = downstreamServicesWithDependencies.flatMap((service) =>
        getServiceDependencies(service),
      );

      const hasDisconnectedService = [...downstreamServicesWithDependencies, ...apiGateDependencies, ...monitoredDependencies].some(
        (service) => String(service?.connectionStatus || '').toLowerCase() !== 'connected',
      );

      const apiGateService = {
        ...selfStatus,
        dependencies: apiGateDependencies,
      };

      res.status(200).json({
        service: 'dg-api-gate',
        status: hasDisconnectedService ? 'degraded' : 'up',
        connectionStatus: hasDisconnectedService ? 'degraded' : 'connected',
        version: selfStatus.version,
        checkedAt,
        services: [apiGateService, ...downstreamServicesWithDependencies],
      });
    });

    app.route('/jsonDocument').get((req: Request, res: Response) => {
      res.status(200).json({ status: 'online - ' + moment().format() });
    });
    app.route('/jsonDocument/create').post(async (req: Request, res: Response) => {
      this.documentsGeneratorController
        .createJSONDoc(req, res)
        .then((documentUrl) => {
          res.status(200).json({ documentUrl });
        })
        .catch((err) => {
          const statusCode = Number(err?.statusCode || 500);
          res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
            message: `Failed to create the document ${err?.message || err}`,
            //Error not structured correctly
            error: err,
          });
        });
    });
    app.route('/jsonDocument/create-test-reporter-flat').post(async (req: Request, res: Response) => {
      this.documentsGeneratorController
        .createFlatTestReporterDoc(req, res)
        .then((documentUrl) => {
          res.status(200).json({ documentUrl });
        })
        .catch((err) => {
          const statusCode = Number(err?.statusCode || 500);
          res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
            message: `Failed to create the flat test reporter document ${err?.message || err}`,
            error: err,
          });
        });
    });

    app.route('/jsonDocument/validate-mewp-external-files').post(async (req: Request, res: Response) => {
      this.documentsGeneratorController
        .validateMewpExternalFiles(req, res)
        .then((result) => {
          res.status(200).json(result);
        })
        .catch((err) => {
          const statusCode = Number(err?.statusCode || 500);
          res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
            message: err?.message || 'Failed validating MEWP external files',
            code: err?.code,
            details: err?.details,
          });
        });
    });
    // Add the file upload route for template uploading
    app.route('/minio/files/uploadFile').post(upload.single('file'), async (req: Request, res: Response) => {
      // Call the uploadFile method from MinioController
      if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
      }
      this.minioController
        .uploadFile(req, res)
        .then((response: any) => {
          const { fileItem } = response;
          res.status(200).json({ message: 'File uploaded successfully', fileItem });
        })
        .catch((err) => {
          const statusCode = Number(err?.statusCode || 500);
          res
            .status(statusCode >= 400 && statusCode < 600 ? statusCode : 500)
            .json({ message: `File upload failed: ${err?.message || err}`, code: err?.code, error: err });
        });
    });

    app
      .route(`/minio/files/deleteFile/:bucketName/:projectName/:etag`)
      .delete(async (req: Request, res: Response) => {
        this.minioController
          .deleteFile(req, res)
          .then((response) => {
            res.status(200).json({ response });
          })
          .catch((err) => {
            res.status(500).json({ message: `Failed to delete the file: ${err}`, error: err });
          });
      });

    app.route('/minio/bucketFileList/:bucketName').get(async (req: Request, res: Response) => {
      this.minioController
        .getBucketFileList(req, res)
        .then((bucketFileList) => {
          res.status(200).json({ bucketFileList });
        })
        .catch((err) => {
          res
            .status(500)
            .json({ message: `Error Occurred while fetching files from bucket: ${err}`, error: err });
        });
    });
    app
      .route('/minio/contentFromFile/:bucketName/:folderName/:fileName')
      .get(async (req: Request, res: Response) => {
        this.minioController
          .getJSONContentFromFile(req, res)
          .then((contentFromFile) => {
            res.status(200).json({ contentFromFile });
          })
          .catch((err) => {
            res.status(404).json({ status: 404, message: err });
          });
      });
    app
      .route('/minio/contentFromObject/:bucketName/:objectName(*)')
      .get(async (req: Request, res: Response) => {
        this.minioController
          .getJSONContentFromObject(req, res)
          .then((contentFromObject) => {
            res.status(200).json({ contentFromObject });
          })
          .catch((err) => {
            res.status(404).json({ status: 404, message: err });
          });
      });
    app.route('/minio/download/:bucketName/:objectName(*)').get(async (req: Request, res: Response) => {
      this.minioController
        .downloadFile(req, res)
        .then(() => {
          // downloadFile streams the response directly
        })
        .catch((err) => {
          res.status(404).json({ status: 404, message: err });
        });
    });
    app.route('/minio/createBucket').post(async (req: Request, res: Response) => {
      this.minioController
        .createBucketIfDoesentExsist(req, res)
        .then((response) => {
          res.status(200).json({ response });
        })
        .catch((err) => {
          res.status(404).json({ status: 404, message: err });
        });
    });

    // Create or update a favorite
    app.route('/dataBase/createFavorite').post(async (req: Request, res: Response) => {
      this.dataBaseController.createFavorite(req, res).catch((err) => {
        res.status(500).json({
          message: `Failed to create/update favorite: ${err}`,
          error: err,
        });
      });
    });

    // Get favorites by userId and docType
    app.route('/dataBase/getFavorites').get(async (req: Request, res: Response) => {
      this.dataBaseController.getFavorites(req, res).catch((err) => {
        res.status(500).json({
          message: `Failed to retrieve favorites: ${err}`,
          error: err,
        });
      });
    });

    // Delete a favorite by ID
    app.route('/dataBase/deleteFavorite/:id').delete(async (req: Request, res: Response) => {
      this.dataBaseController.deleteFavorite(req, res).catch((err) => {
        res.status(500).json({
          message: `Failed to delete favorite: ${err}`,
          error: err,
        });
      });
    });

    // Azure data provider proxy routes -> content-control
    app
      .route('/azure/check-org-url')
      .get((req: Request, res: Response) => this.dataProviderController.checkOrgUrl(req, res));
    app
      .route('/azure/projects')
      .get((req: Request, res: Response) => this.dataProviderController.getTeamProjects(req, res));
    app
      .route('/azure/user/profile')
      .get((req: Request, res: Response) => this.dataProviderController.getUserProfile(req, res));
    app
      .route('/azure/link-types')
      .get((req: Request, res: Response) => this.dataProviderController.getCollectionLinkTypes(req, res));

    app
      .route('/azure/queries')
      .get((req: Request, res: Response) => this.dataProviderController.getSharedQueries(req, res));
    app
      .route('/azure/fields')
      .get((req: Request, res: Response) => this.dataProviderController.getFieldsByType(req, res));
    app
      .route('/azure/queries/:queryId/results')
      .get((req: Request, res: Response) => this.dataProviderController.getQueryResults(req, res));

    app
      .route('/azure/tests/plans')
      .get((req: Request, res: Response) => this.dataProviderController.getTestPlansList(req, res));
    app
      .route('/azure/tests/plans/:testPlanId/suites')
      .get((req: Request, res: Response) => this.dataProviderController.getTestSuitesByPlan(req, res));

    app
      .route('/azure/git/repos')
      .get((req: Request, res: Response) => this.dataProviderController.getGitRepoList(req, res));
    app
      .route('/azure/git/repos/:repoId/branches')
      .get((req: Request, res: Response) => this.dataProviderController.getGitRepoBranches(req, res));
    app
      .route('/azure/git/repos/:repoId/commits')
      .get((req: Request, res: Response) => this.dataProviderController.getGitRepoCommits(req, res));
    app
      .route('/azure/git/repos/:repoId/pull-requests')
      .get((req: Request, res: Response) => this.dataProviderController.getRepoPullRequests(req, res));
    app
      .route('/azure/git/repos/:repoId/refs')
      .get((req: Request, res: Response) => this.dataProviderController.getRepoRefs(req, res));

    app
      .route('/azure/pipelines')
      .get((req: Request, res: Response) => this.dataProviderController.getPipelineList(req, res));
    app
      .route('/azure/pipelines/:pipelineId/runs')
      .get((req: Request, res: Response) => this.dataProviderController.getPipelineRuns(req, res));
    app
      .route('/azure/pipelines/releases/definitions')
      .get((req: Request, res: Response) => this.dataProviderController.getReleaseDefinitionList(req, res));
    app
      .route('/azure/pipelines/releases/definitions/:definitionId/history')
      .get((req: Request, res: Response) =>
        this.dataProviderController.getReleaseDefinitionHistory(req, res),
      );
    app
      .route('/azure/work-item-types')
      .get((req: Request, res: Response) => this.dataProviderController.getWorkItemTypeList(req, res));

    // SharePoint integration routes
    app
      .route('/sharepoint/test-connection')
      .post((req: Request, res: Response) => this.sharePointController.testConnection(req, res));

    app
      .route('/sharepoint/list-files')
      .post((req: Request, res: Response) => this.sharePointController.listFiles(req, res));

    app
      .route('/sharepoint/check-conflicts')
      .post((req: Request, res: Response) => this.sharePointController.checkConflicts(req, res));

    app
      .route('/sharepoint/sync-templates')
      .post((req: Request, res: Response) => this.sharePointController.syncTemplates(req, res));

    app
      .route('/sharepoint/config')
      .post((req: Request, res: Response) => this.sharePointController.saveConfig(req, res))
      .get((req: Request, res: Response) => this.sharePointController.getConfig(req, res))
      .delete((req: Request, res: Response) => this.sharePointController.deleteConfig(req, res));

    app
      .route('/sharepoint/configs')
      .get((req: Request, res: Response) => this.sharePointController.getConfigs(req, res));

    app
      .route('/sharepoint/configs/all')
      .get((req: Request, res: Response) => this.sharePointController.getAllConfigs(req, res));

    // Note: OAuth is now handled by frontend (SPA flow with PKCE)
    // Backend only provides SharePoint REST API access with OAuth tokens from frontend
  }
}
