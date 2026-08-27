import mongoose, { Schema, Document } from 'mongoose';

// The session record both transports (cookie and bearer-handle) resolve
// to. Only the SHA-256 hash of the session token is ever stored — a
// database dump yields no usable credential, matching SessionHandleCode's
// and OAuthTransaction's posture on `state`.
export interface IAuthSession extends Document {
  sessionTokenHash: string;
  homeAccountId: string; // MSAL cache partition key — see MsalTokenCache
  transport: 'cookie' | 'bearer';
  csrfTokenHash: string;
  displayName?: string; // from the ID token — this is why User.Read is not requested
  userPrincipalName?: string;
  tenantId?: string;
  lastSeenAt: Date; // slid on each authorized request, drives idle expiry
  idleExpiresAt: Date; // rolling window
  absoluteExpiresAt: Date; // hard cap regardless of activity; TTL index
  createdAt: Date;
  updatedAt: Date;
}

const AuthSessionSchema = new Schema(
  {
    sessionTokenHash: { type: String, required: true, unique: true },
    homeAccountId: { type: String, required: true },
    transport: { type: String, required: true, enum: ['cookie', 'bearer'] },
    csrfTokenHash: { type: String, required: true },
    displayName: { type: String, required: false },
    userPrincipalName: { type: String, required: false },
    tenantId: { type: String, required: false },
    lastSeenAt: { type: Date, required: true, default: Date.now },
    idleExpiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

AuthSessionSchema.index({ sessionTokenHash: 1 }, { unique: true });
AuthSessionSchema.index({ homeAccountId: 1 });
AuthSessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthSession = mongoose.model<IAuthSession>('AuthSession', AuthSessionSchema);
