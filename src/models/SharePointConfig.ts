import mongoose, { Schema, Document } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

// SharePoint Configuration interface
export interface ISharePointConfig extends Document {
  id: string;
  userId?: string; // Optional: per-user configuration
  projectName?: string; // Optional: per-project configuration
  siteUrl: string; // Full SharePoint site URL
  library?: string; // Document library name — on-prem only; blank for Online configs and paste-a-URL on-prem configs
  folder?: string; // Folder path within library — blank for Online configs (the whole location is siteUrl)
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
    // Not required: an Online config's siteUrl is itself the pasted
    // sharing/folder link, and even on-prem paste-a-URL configs
    // (resolveSiteFromUrl) leave library blank. Mongoose's built-in
    // `required` validator on a String path rejects an explicit empty
    // string as "missing", so these must stay optional rather than
    // required-with-a-default — a default only ever fills in `undefined`.
    library: { type: String, required: false },
    folder: { type: String, required: false },
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
