jest.mock('../../../models/OAuthTransaction', () => ({
  __esModule: true,
  OAuthTransaction: {
    create: jest.fn(),
    findOneAndDelete: jest.fn(),
  },
}));

import { OAuthTransaction } from '../../../models/OAuthTransaction';
import { createTransaction, consumeTransaction } from '../../../services/auth/OAuthTransactionService';

const mockCreate = OAuthTransaction.create as jest.Mock;
const mockFindOneAndDelete = OAuthTransaction.findOneAndDelete as jest.Mock;

describe('OAuthTransactionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createTransaction', () => {
    test('persists a transaction with the requested openerOrigin and transport', async () => {
      mockCreate.mockResolvedValueOnce({});

      const result = await createTransaction({ openerOrigin: 'https://docgen.example.com', transport: 'cookie' });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          openerOrigin: 'https://docgen.example.com',
          transport: 'cookie',
          state: expect.any(String),
          codeVerifier: expect.any(String),
          nonce: expect.any(String),
          expiresAt: expect.any(Date),
        })
      );
      expect(result.openerOrigin).toBe('https://docgen.example.com');
      expect(result.transport).toBe('cookie');
    });

    test('generates a different state/codeVerifier/nonce on each call', async () => {
      mockCreate.mockResolvedValue({});

      const first = await createTransaction({ openerOrigin: 'https://a.example.com', transport: 'bearer' });
      const second = await createTransaction({ openerOrigin: 'https://a.example.com', transport: 'bearer' });

      expect(first.state).not.toBe(second.state);
      expect(first.codeVerifier).not.toBe(second.codeVerifier);
      expect(first.nonce).not.toBe(second.nonce);
    });

    test('sets an expiresAt roughly 10 minutes in the future', async () => {
      mockCreate.mockResolvedValueOnce({});
      const before = Date.now();

      await createTransaction({ openerOrigin: 'https://a.example.com', transport: 'cookie' });

      const [[callArgs]] = mockCreate.mock.calls;
      const expiresAtMs = (callArgs.expiresAt as Date).getTime();
      expect(expiresAtMs).toBeGreaterThan(before + 9 * 60 * 1000);
      expect(expiresAtMs).toBeLessThan(before + 11 * 60 * 1000);
    });
  });

  describe('consumeTransaction', () => {
    test('returns the transaction fields when found', async () => {
      mockFindOneAndDelete.mockResolvedValueOnce({
        state: 'state-1',
        codeVerifier: 'verifier-1',
        nonce: 'nonce-1',
        openerOrigin: 'https://docgen.example.com',
        transport: 'cookie',
      });

      const result = await consumeTransaction('state-1');

      expect(mockFindOneAndDelete).toHaveBeenCalledWith({ state: 'state-1', expiresAt: { $gt: expect.any(Date) } });
      expect(result).toEqual({
        state: 'state-1',
        codeVerifier: 'verifier-1',
        nonce: 'nonce-1',
        openerOrigin: 'https://docgen.example.com',
        transport: 'cookie',
      });
    });

    test('returns null when no matching, unexpired transaction exists', async () => {
      mockFindOneAndDelete.mockResolvedValueOnce(null);

      const result = await consumeTransaction('unknown-state');

      expect(result).toBeNull();
    });

    // Regression: a second consume of the same state must find nothing —
    // findOneAndDelete already removed the row on the first call, so replay
    // is impossible by construction, not by an application-level check.
    test('a second consume of the same state (simulating replay) finds nothing', async () => {
      mockFindOneAndDelete.mockResolvedValueOnce({
        state: 'state-2',
        codeVerifier: 'v',
        nonce: 'n',
        openerOrigin: 'https://docgen.example.com',
        transport: 'cookie',
      });
      mockFindOneAndDelete.mockResolvedValueOnce(null);

      const first = await consumeTransaction('state-2');
      const second = await consumeTransaction('state-2');

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(mockFindOneAndDelete).toHaveBeenCalledTimes(2);
    });
  });
});
