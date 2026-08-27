import mongoose, { Schema, Document } from 'mongoose';

// Designed to bind a resolved {driveId, itemId} to the session that
// resolved it, so Files.Read.All's effective blast radius stays limited to
// libraries the user explicitly linked, not everything the scope could
// technically reach. NOT currently wired into any controller/service —
// GraphSharePointService re-resolves the pasted URL fresh on every call
// instead, so no code path accepts a client-supplied driveId/itemId today.
// This model is unused; keep or wire it in deliberately, don't assume it's
// an active control.
export interface ISharePointResolvedRoot extends Document {
  homeAccountId: string;
  shareUrlHash: string; // hash, not the raw URL — a "Copy Link" URL carries a capability token
  driveId: string;
  itemId: string;
  name?: string;
  resolvedAt: Date;
  expiresAt: Date; // 24h TTL — re-resolved on next use past that, cheap since it's one Graph call
  createdAt: Date;
  updatedAt: Date;
}

const SharePointResolvedRootSchema = new Schema(
  {
    homeAccountId: { type: String, required: true },
    shareUrlHash: { type: String, required: true },
    driveId: { type: String, required: true },
    itemId: { type: String, required: true },
    name: { type: String, required: false },
    resolvedAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

SharePointResolvedRootSchema.index({ homeAccountId: 1, shareUrlHash: 1 }, { unique: true });
SharePointResolvedRootSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SharePointResolvedRoot = mongoose.model<ISharePointResolvedRoot>(
  'SharePointResolvedRoot',
  SharePointResolvedRootSchema
);
