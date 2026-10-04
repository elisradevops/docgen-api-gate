import { requireIngestToken } from '../../../helpers/auth/requireIngestToken';
import { buildRes } from '../../utils/testResponse';

describe('requireIngestToken', () => {
  const ORIGINAL_ENV = process.env.DIAGNOSTICS_INGEST_TOKEN;

  afterEach(() => {
    process.env.DIAGNOSTICS_INGEST_TOKEN = ORIGINAL_ENV;
  });

  test('fails closed with 503 when the secret is not configured', () => {
    delete process.env.DIAGNOSTICS_INGEST_TOKEN;
    const req: any = { header: () => undefined };
    const res = buildRes();
    const next = jest.fn();

    requireIngestToken(req, res, next);

    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects with 401 when no token header is supplied', () => {
    process.env.DIAGNOSTICS_INGEST_TOKEN = 'the-secret';
    const req: any = { header: () => undefined };
    const res = buildRes();
    const next = jest.fn();

    requireIngestToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects with 401 when the token does not match', () => {
    process.env.DIAGNOSTICS_INGEST_TOKEN = 'the-secret';
    const req: any = { header: () => 'wrong-token' };
    const res = buildRes();
    const next = jest.fn();

    requireIngestToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects with 401 when the token is a different length than the secret', () => {
    process.env.DIAGNOSTICS_INGEST_TOKEN = 'the-secret';
    const req: any = { header: () => 'short' };
    const res = buildRes();
    const next = jest.fn();

    requireIngestToken(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() when the token matches', () => {
    process.env.DIAGNOSTICS_INGEST_TOKEN = 'the-secret';
    const req: any = { header: () => 'the-secret' };
    const res = buildRes();
    const next = jest.fn();

    requireIngestToken(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
