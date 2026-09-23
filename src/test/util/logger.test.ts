import * as winston from 'winston';
import Transport from 'winston-transport';
import { redact } from '../../util/logger';

const applyRedact = (info: Record<string, unknown>) => (redact() as any).transform({ ...info });

describe('logger redact format', () => {
  test('scrubs a top-level token/password/secret regardless of key casing', () => {
    const out = applyRedact({ level: 'info', message: 'x', token: 'abc', Password: 'p', SECRET: 's' });
    expect(out.token).toBe('[REDACTED]');
    expect(out.Password).toBe('[REDACTED]');
    expect(out.SECRET).toBe('[REDACTED]');
  });

  test('scrubs minioAccessKey/minioSecretKey', () => {
    const out = applyRedact({ level: 'info', message: 'x', minioAccessKey: 'AKIA', minioSecretKey: 'shh' });
    expect(out.minioAccessKey).toBe('[REDACTED]');
    expect(out.minioSecretKey).toBe('[REDACTED]');
  });

  test('scrubs nested config.auth.password and config.headers.Authorization — the AxiosError.toJSON() leak', () => {
    const axiosLikeError = {
      message: 'Request failed',
      config: {
        auth: { username: '', password: 'super-secret-pat' },
        headers: { Authorization: 'Bearer abc.def.ghi' },
      },
    };
    const out: any = applyRedact({ level: 'error', message: 'upstream failed', err: axiosLikeError });
    expect(out.err.config.auth.password).toBe('[REDACTED]');
    expect(out.err.config.headers.Authorization).toBe('[REDACTED]');
    // Non-sensitive sibling data survives.
    expect(out.err.message).toBe('Request failed');
  });

  test('leaves non-sensitive fields untouched', () => {
    const out = applyRedact({ level: 'info', message: 'ok', project: 'Cube-ADCS', docType: 'SVD' });
    expect(out.project).toBe('Cube-ADCS');
    expect(out.docType).toBe('SVD');
  });

  test('never throws on a circular object', () => {
    const circular: any = { name: 'x' };
    circular.self = circular;
    expect(() => applyRedact({ level: 'info', message: 'x', circular })).not.toThrow();
  });

  test('never throws and passes info through on null/undefined meta', () => {
    expect(() => applyRedact({ level: 'info', message: 'x', meta: null })).not.toThrow();
    expect(() => applyRedact({ level: 'info', message: 'x', meta: undefined })).not.toThrow();
  });
});

// A capturing transport + the exact JSON format chain logger.ts uses (errors -> timestamp ->
// redact -> splat -> json), so these tests exercise the real pipeline, not just redact() alone.
class CaptureTransport extends Transport {
  lines: Record<string, unknown>[] = [];
  log(info: Record<string, unknown>, callback: () => void) {
    this.lines.push(JSON.parse((info as any)[Symbol.for('message')] ?? JSON.stringify(info)));
    callback();
  }
}
function makeTestLogger() {
  const capture = new CaptureTransport();
  const logger = winston.createLogger({
    level: 'silly',
    format: winston.format.combine(
      winston.format.errors({ stack: true }),
      winston.format.timestamp(),
      redact(),
      winston.format.splat(),
      winston.format.json()
    ),
    transports: [capture],
  });
  return { logger, capture };
}

describe('logger pipeline — errors({stack:true})', () => {
  test('logger.error(err) (single-arg Error) still produces a non-empty message and a stack', () => {
    // This is the regression errors({stack:true}) exists to prevent: without it, winston's
    // single-arg path makes `info` *be* the Error, and message/stack are non-enumerable, so
    // json() would emit {"level":"error","timestamp":"…"} — content-free.
    const { logger, capture } = makeTestLogger();
    logger.error(new Error('boom'));
    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0].message).toBe('boom');
    expect(typeof capture.lines[0].stack).toBe('string');
    expect((capture.lines[0].stack as string).length).toBeGreaterThan(0);
  });
});

describe('logger pipeline — hostile inputs never throw', () => {
  test.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
    ['a circular object', (() => { const c: any = { a: 1 }; c.self = c; return c; })()],
    ['an object with a throwing getter', { get boom() { throw new Error('nope'); } }],
    ['a BigInt', BigInt(9007199254740993)],
    ['a Symbol', Symbol('x')],
    ['an Error with no message', new Error()],
    ['a 10MB string', 'x'.repeat(10 * 1024 * 1024)],
  ])('logger.error(%s) does not throw', (_label, value) => {
    const { logger } = makeTestLogger();
    expect(() => logger.error(value as any)).not.toThrow();
  });
});
