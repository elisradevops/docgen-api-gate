import { Request, Response } from 'express';
import { DocumentsGeneratorController } from '../controllers/DocumentsGeneratorController';
import { MinioController } from '../controllers/MinioController';
import moment from 'moment';
import { DatabaseController } from '../controllers/DatabaseController';

export class Routes {
  public documentsGeneratorController: DocumentsGeneratorController = new DocumentsGeneratorController();
  public minioController: MinioController = new MinioController();
  public dataBaseController: DatabaseController = new DatabaseController();
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
          res.status(500).json({
            message: `Failed to create the document ${err}`,
            //Error not structured correctly
            error: err,
          });
        });
    });
    // Add the file upload route for template uploading
    app
      .route('/minio/templates/uploadTemplate')
      .post(upload.single('file'), async (req: Request, res: Response) => {
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
            res.status(500).json({ message: `File upload failed: ${err}`, error: err });
          });
      });

    app
      .route(`/minio/templates/deleteTemplate/:projectName/:etag`)
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
  }
}
