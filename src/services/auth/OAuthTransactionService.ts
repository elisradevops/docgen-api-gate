// Creates and consumes the short-lived PKCE/state transaction record.
// consumeTransaction's findOneAndDelete makes state replay structurally
// impossible, not just check-then-delete racy.
import { OAuthTransaction } from '../../models/OAuthTransaction';
import { newOpaqueToken } from '../../util/randomTokens';

const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export type Transport = 'cookie' | 'bearer';

export interface CreateTransactionInput {
  openerOrigin: string;
  transport: Transport;
}

export interface TransactionRecord {
  state: string;
  codeVerifier: string;
  nonce: string;
  openerOrigin: string;
  transport: Transport;
}

export async function createTransaction(input: CreateTransactionInput): Promise<TransactionRecord> {
  const state = newOpaqueToken();
  const codeVerifier = newOpaqueToken(); // 32 bytes -> 43 chars, within RFC 7636's PKCE verifier range
  const nonce = newOpaqueToken();

  await OAuthTransaction.create({
    state,
    codeVerifier,
    nonce,
    openerOrigin: input.openerOrigin,
    transport: input.transport,
    expiresAt: new Date(Date.now() + TRANSACTION_TTL_MS),
  });

  return { state, codeVerifier, nonce, openerOrigin: input.openerOrigin, transport: input.transport };
}

// findOneAndDelete is atomic at the database level, so this is single-use
// even under concurrent calls with the same `state`.
export async function consumeTransaction(state: string): Promise<TransactionRecord | null> {
  const doc = await OAuthTransaction.findOneAndDelete({
    state,
    expiresAt: { $gt: new Date() },
  });
  if (!doc) return null;

  return {
    state: doc.state,
    codeVerifier: doc.codeVerifier,
    nonce: doc.nonce,
    openerOrigin: doc.openerOrigin,
    transport: doc.transport as Transport,
  };
}
