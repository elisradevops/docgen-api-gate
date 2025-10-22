import mongoose, { Schema, Document } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

// SharePoint Configuration interface
export interface ISharePointConfig extends Document {
  id: string;
  userId?: string; // Optional: per-user configuration
  projectName?: string; // Optional: per-project configuration
  siteUrl: string; // Full SharePoint site URL
  library: string; // Document library name
  folder: string; // Folder path within library
  displayName?: string; // Friendly name for UI
  lastUsed?: Date; // Track when last used
  createdAt: Date;
  updatedAt: Date;
}

// SharePoint Configuration schema
const SharePointConfigSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, default: uuidv4 },
    userId: { type: String, required: false },
    projectName: { type: String, required: false },
    siteUrl: { type: String, required: true },
    library: { type: String, required: true, default: 'Shared Documents' },
    folder: { type: String, required: true, default: 'Templates' },
    displayName: { type: String, required: false },
    lastUsed: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

// Create compound indexes for efficient queries
SharePointConfigSchema.index({ userId: 1, projectName: 1 });
SharePointConfigSchema.index({ projectName: 1 });
SharePointConfigSchema.index({ lastUsed: -1 });

// Create and export the model
export const SharePointConfig = mongoose.model<ISharePointConfig>(
  'SharePointConfig',
  SharePointConfigSchema
);
