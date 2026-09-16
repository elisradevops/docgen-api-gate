jest.mock('../../../util/mongodb', () => ({
  __esModule: true,
  ensureMongoConnection: jest.fn(),
}));

import { ensureMongoConnection } from '../../../util/mongodb';
import { requireMongo } from '../../../helpers/db/requireMongo';
import { buildRes } from '../../utils/testResponse';

const mockEnsureMongoConnection = ensureMongoConnection as jest.Mock;

describe('requireMongo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('calls next() when Mongo is (or becomes) available', async () => {
    mockEnsureMongoConnection.mockResolvedValueOnce(true);
    const req: any = {};
    const res = buildRes();
    const next = jest.fn();

    await requireMongo(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200); // untouched
  });

  test('responds 503 with a Retry-After hint when Mongo stays unavailable', async () => {
    mockEnsureMongoConnection.mockResolvedValueOnce(false);
    const req: any = {};
    const res = buildRes();
    const next = jest.fn();

    await requireMongo(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({ error: 'db_unavailable' }));
    expect(res.headers['Retry-After']).toBe('5');
  });
});
