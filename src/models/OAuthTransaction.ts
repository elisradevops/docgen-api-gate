import mongoose, { Schema, Document } from 'mongoose';

// The short-lived PKCE/state record created at GET /auth/login and consumed
// exactly once at GET /auth/callback via findOneAndDelete — that atomicity
// is what makes state replay structurally impossible rather than merely
// check-then-delete racy. See OAuthTransactionService.
export interface IOAuthTransaction extends Document {
  state: string; // opaque random value returned by Entra on the callback; matched, never a bearer credential itself
  codeVerifier: string; // PKCE code_verifier, kept server-side only
  nonce: string; // validated against the ID token's nonce claim at callback
  openerOrigin: string; // validated against the CORS allowlist at /auth/login time; never reflected unvalidated into the callback page
  transport: 'cookie' | 'bearer';
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OAuthTransactionSchema = new Schema(
  {
    state: { type: String, required: true, unique: true },
    codeVerifier: { type: String, required: true },
    nonce: { type: String, required: true },
    openerOrigin: { type: String, required: true },
    transport: { type: String, required: true, enum: ['cookie', 'bearer'] },
    // TTL index: Mongo's background reaper runs on a ~60s cycle and is a
    // garbage collector only — consumeTransaction() always re-checks
    // expiresAt in its own query predicate rather than trusting the reaper
    // to have removed an expired-but-still-physically-present row.
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

OAuthTransactionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OAuthTransaction = mongoose.model<IOAuthTransaction>('OAuthTransaction', OAuthTransactionSchema);
