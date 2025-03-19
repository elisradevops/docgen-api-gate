import { Request, Response } from 'express';
import mongoose, { Schema, Document } from 'mongoose';
import logger from '../util/logger';
import { v4 as uuidv4 } from 'uuid';
import { createControllerSpan, finishSpanWithResult } from '../helpers/openTracing/tracer-middleware';

// Define the Favorite interface
interface IFavorite extends Document {
  id: string;
  userId: string;
  name: string;
  docType: string;
  dataToSave: any;
}

// Create the Favorite schema
const FavoriteSchema = new Schema({
  id: { type: String, required: true, unique: true, default: uuidv4 },
  userId: { type: String, required: true },
  name: { type: String, required: true },
  docType: { type: String, required: true },
  dataToSave: { type: Schema.Types.Mixed, required: true },
  teamProjectId: { type: String, required: true },
  isShared: { type: Boolean, default: false, required: true },
});

// Create compound index on userId, docType, and name
FavoriteSchema.index({ userId: 1, docType: 1, name: 1 }, { unique: true });

// Create the model
const Favorite = mongoose.model<IFavorite>('Favorite', FavoriteSchema);

export class DatabaseController {
  /**
   * Creates a new favorite or updates an existing one if name already exists
   * for the same userId and docType
   */
  public async createFavorite(req: Request, res: Response): Promise<void> {
    const span = createControllerSpan('DatabaseController', 'createFavorite', req.headers);
    try {
      const { userId, name, docType, dataToSave, teamProjectId, isShared } = req.body;
      if (!userId || !name || !docType || !dataToSave || !teamProjectId) {
        finishSpanWithResult(span, 400, true);
        res.status(400).json({ message: 'Missing required fields' });
        return;
      }

      // Try to find existing favorite with same userId, docType and name
      let favorite = !isShared
        ? await Favorite.findOne({ userId, docType, teamProjectId, name })
        : await Favorite.findOne({ docType, teamProjectId, name });

      if (favorite) {
        // Update existing favorite
        favorite.dataToSave = dataToSave;
        await favorite.save();

        finishSpanWithResult(span, 200);
        res.status(200).json({
          message: 'Favorite updated successfully',
          favorite,
        });
      } else {
        // Create new favorite
        const newFavorite = new Favorite({
          id: uuidv4(), // Auto-generate ID
          userId,
          name,
          docType,
          dataToSave,
          teamProjectId,
          isShared,
        });

        await newFavorite.save();

        finishSpanWithResult(span, 201);
        res.status(201).json({
          message: 'Favorite created successfully',
          favorite: newFavorite,
        });
      }
    } catch (error) {
      logger.error(`Failed to create favorite: ${error.message}`);
      finishSpanWithResult(span, 500, true);
      res.status(500).json({
        message: 'Failed to create favorite',
        error: error.message,
      });
    }
  }

  /**
   * Gets all favorites for a specific userId and docType
   */
  public async getFavorites(req: Request, res: Response): Promise<void> {
    const span = createControllerSpan('DatabaseController', 'getFavorites', req.headers);
    try {
      const { userId, docType, teamProjectId } = req.query;

      if (!userId || !docType || !teamProjectId) {
        finishSpanWithResult(span, 400, true);
        res.status(400).json({ message: 'userId, docType and teamProjectId are required query parameters' });
        return;
      }

      const favorites = await Favorite.find({
        $or: [
          {
            userId: userId.toString(),
            docType: docType.toString(),
            teamProjectId: teamProjectId.toString(),
          },
          {
            isShared: true,
            docType: docType.toString(),
            teamProjectId: teamProjectId.toString(),
          },
        ],
      });

      finishSpanWithResult(span, 200);
      res.status(200).json({ favorites });
    } catch (error) {
      logger.error(`Failed to fetch favorites: ${error.message}`);
      finishSpanWithResult(span, 500, true);
      res.status(500).json({
        message: 'Failed to fetch favorites',
        error: error.message,
      });
    }
  }

  /**
   * Deletes a favorite by its ID
   */
  public async deleteFavorite(req: Request, res: Response): Promise<void> {
    const span = createControllerSpan('DatabaseController', 'deleteFavorite', req.headers);
    try {
      const { id } = req.params;

      if (!id) {
        finishSpanWithResult(span, 400, true);
        res.status(400).json({ message: 'Favorite ID is required' });
        return;
      }

      const favorite = await Favorite.findOneAndDelete({ id });

      if (!favorite) {
        finishSpanWithResult(span, 404, true);
        res.status(404).json({ message: 'Favorite not found' });
        return;
      }

      finishSpanWithResult(span, 200);
      res.status(200).json({
        message: 'Favorite deleted successfully',
        favorite,
      });
    } catch (error) {
      logger.error(`Failed to delete favorite: ${error.message}`);
      finishSpanWithResult(span, 500, true);
      res.status(500).json({
        message: 'Failed to delete favorite',
        error: error.message,
      });
    }
  }
}
