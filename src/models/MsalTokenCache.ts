import mongoose, { Schema, Document } from 'mongoose';

// The homeAccountId-partitioned, AES-256-GCM-encrypted MSAL token cache
// (see tokenCacheCipher.ts + MongoTokenCachePlugin.ts). One document per
// signed-in user; MSAL's own cache serialization format lives inside
// `ciphertext`, never in plaintext at rest.
export interface IMsalTokenCache extends Document {
  homeAccountId: string;
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  keyVersion: number; // enables key rotation without orphaning existing rows
  expiresAt: Date; // rolling ~90-day TTL, matching Entra's refresh-token inactivity window
  createdAt: Date;
  updatedAt: Date;
}

const MsalTokenCacheSchema = new Schema(
  {
    homeAccountId: { type: String, required: true, unique: true },
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    keyVersion: { type: Number, required: true, default: 1 },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

MsalTokenCacheSchema.index({ homeAccountId: 1 }, { unique: true });
MsalTokenCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const MsalTokenCache = mongoose.model<IMsalTokenCache>('MsalTokenCache', MsalTokenCacheSchema);
