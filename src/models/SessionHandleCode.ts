import mongoose, { Schema, Document } from 'mongoose';

// The one-time code that crosses postMessage from the auth popup back to
// the ADO-embedded iframe app (bearer-transport only). A separate model
// from OAuthTransaction so their very different TTLs (~10min pre-auth vs.
// ~60s post-auth) stay independent.
//
// AuthSession stores only a session token's hash, never the raw value, so
// a handle code can't merely reference a session by ID — it carries the
// raw token itself, encrypted at rest (AES-256-GCM via tokenCacheCipher,
// reused here as a generic string cipher). Consumed exactly once via
// findOneAndDelete at POST /auth/session/exchange; after that the raw token
// exists only in the caller's memory, never storage (see authTransport.js).
export interface ISessionHandleCode extends Document {
  codeHash: string;
  sessionTokenCiphertext: string; // base64
  sessionTokenIv: string; // base64
  sessionTokenAuthTag: string; // base64
  sessionTokenKeyVersion: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SessionHandleCodeSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    sessionTokenCiphertext: { type: String, required: true },
    sessionTokenIv: { type: String, required: true },
    sessionTokenAuthTag: { type: String, required: true },
    sessionTokenKeyVersion: { type: Number, required: true, default: 1 },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

SessionHandleCodeSchema.index({ codeHash: 1 }, { unique: true });
SessionHandleCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionHandleCode = mongoose.model<ISessionHandleCode>('SessionHandleCode', SessionHandleCodeSchema);
