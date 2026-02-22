import { Request, Response } from 'express';
import { DocumentsGeneratorController } from '../controllers/DocumentsGeneratorController';
import { MinioController } from '../controllers/MinioController';
import moment from 'moment';
import { DatabaseController } from '../controllers/DatabaseController';
import { DataProviderController } from '../controllers/DataProviderController';
import { SharePointController } from '../controllers/SharePointController';

export class Routes {
  public documentsGeneratorController: DocumentsGeneratorController = new DocumentsGeneratorController();
  public minioController: MinioController = new MinioController();
  public dataBaseController: DatabaseController = new DatabaseController();
  public dataProviderController: DataProviderController = new DataProviderController();
  public sharePointController: SharePointController = new SharePointController();

  public routes(app: any, upload: any): void {
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
