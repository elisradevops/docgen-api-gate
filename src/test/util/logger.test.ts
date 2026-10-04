import * as winston from 'winston';
import Transport from 'winston-transport';
import { redact, DiagnosticsTransport, isSensitiveKey, skipUncaptured } from '../../util/logger';
import { installLogSink, LogSink, DiagnosticEvent } from '../../util/logSink';
import { runContextStore } from '../../util/runContext';

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

describe('DiagnosticsTransport (Phase 6a)', () => {
  // Same shape as makeTestLogger() but with DiagnosticsTransport added, so this exercises the
  // transport through the real pipeline (post-redact info) without depending on the real
  // singleton logger's env-gated json()/textFormat branch.
  function makeDiagnosticsLogger() {
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
      transports: [capture, new DiagnosticsTransport()],
    });
    return { logger, capture };
  }

  test('pushes warn/error records to whatever sink is installed', () => {
    const events: DiagnosticEvent[] = [];
    const sink: LogSink = { push: (e) => events.push(e) };
    installLogSink(sink);
    const { logger } = makeDiagnosticsLogger();
    logger.warn('a stable warning');
    logger.error('a stable error', Object.assign(new Error('boom'), { code: 'ECONN' }));
    expect(events).toHaveLength(2);
    expect(events[0].level).toBe('warn');
    expect(events[1].err?.code).toBe('ECONN');
    expect(events[1].err?.stack).toEqual(expect.any(String));
  });

  test('does not push info/debug records', () => {
    const events: DiagnosticEvent[] = [];
    installLogSink({ push: (e) => events.push(e) });
    const { logger } = makeDiagnosticsLogger();
    logger.info('not interesting to the dashboard');
    expect(events).toHaveLength(0);
  });

  test('a throwing sink cannot break the log call', () => {
    installLogSink({
      push: () => {
        throw new Error('sink is down');
      },
    });
    const { logger } = makeDiagnosticsLogger();
    expect(() => logger.error('still must not throw')).not.toThrow();
  });

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
  ])('logger.error(%s) with a sink installed does not throw', (_label, value) => {
    installLogSink({ push: () => undefined });
    const { logger } = makeDiagnosticsLogger();
    expect(() => logger.error(value as any)).not.toThrow();
  });
});

describe('textFormat safety (regression)', () => {
  // The hostile-input matrix above exercises makeTestLogger()'s json() pipeline — it never
  // touched the real singleton logger's text-format branch (LOG_FORMAT's default), which is
  // where a Symbol message crashed: a template literal's implicit ToString throws on a Symbol,
  // and this formatter sits with no try/catch around it.
  test('logger.error(Symbol) does not throw through the real default-exported logger', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const logger = require('../../util/logger').default;
    expect(() => logger.error(Symbol('x'))).not.toThrow();
  });
});

describe('DiagnosticsTransport capture policy (Phase 6b)', () => {
  function makeDiagnosticsLogger() {
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
      transports: [capture, new DiagnosticsTransport()],
    });
    return { logger, capture };
  }

  test('normal mode (no captureMode) does not persist debug/info', () => {
    const events: DiagnosticEvent[] = [];
    installLogSink({ push: (e) => events.push(e) });
    const { logger } = makeDiagnosticsLogger();
    runContextStore.run({ runId: 'run-1' }, () => {
      logger.debug('a debug line');
      logger.info('an info line');
    });
    expect(events).toHaveLength(0);
  });

  test('verbose mode persists debug and info', () => {
    const events: DiagnosticEvent[] = [];
    installLogSink({ push: (e) => events.push(e) });
    const { logger } = makeDiagnosticsLogger();
    runContextStore.run({ runId: 'run-2', captureMode: 'verbose' }, () => {
      logger.debug('a debug line');
      logger.info('an info line');
    });
    expect(events).toHaveLength(2);
    expect(events[0].retainPending).toBeUndefined();
  });

  test('warn/error persist regardless of capture mode', () => {
    const events: DiagnosticEvent[] = [];
    installLogSink({ push: (e) => events.push(e) });
    const { logger } = makeDiagnosticsLogger();
    runContextStore.run({ runId: 'run-3' }, () => {
      logger.warn('a warning');
      logger.error('an error');
    });
    expect(events).toHaveLength(2);
  });

  test('retain-on-failure persists debug/info tagged retainPending: true', () => {
    const events: DiagnosticEvent[] = [];
    installLogSink({ push: (e) => events.push(e) });
    const { logger } = makeDiagnosticsLogger();
    runContextStore.run({ runId: 'run-4', captureMode: 'retain-on-failure' }, () => {
      logger.debug('a debug line');
    });
    expect(events).toHaveLength(1);
    expect(events[0].retainPending).toBe(true);
  });

  test('retain-on-failure does not tag warn/error as retainPending', () => {
    const events: DiagnosticEvent[] = [];
    installLogSink({ push: (e) => events.push(e) });
    const { logger } = makeDiagnosticsLogger();
    runContextStore.run({ runId: 'run-5', captureMode: 'retain-on-failure' }, () => {
      logger.error('an error');
    });
    expect(events).toHaveLength(1);
    expect(events[0].retainPending).toBeUndefined();
  });

  test('a concurrent normal-mode run is unaffected by a sibling verbose run', () => {
    // makeDiagnosticsLogger's pipeline doesn't include withRunContext() (that's covered
    // separately, in runContext.test.ts), so info.runId isn't set here — the message text is
    // what distinguishes which run's debug call actually got through.
    const events: DiagnosticEvent[] = [];
    installLogSink({ push: (e) => events.push(e) });
    const { logger } = makeDiagnosticsLogger();
    runContextStore.run({ runId: 'verbose-run', captureMode: 'verbose' }, () => {
      logger.debug('verbose debug');
    });
    runContextStore.run({ runId: 'normal-run' }, () => {
      logger.debug('normal debug');
    });
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('verbose debug');
  });
});

describe('isSensitiveKey', () => {
  it.each(['token', 'accessToken', 'x-docgen-ingest-token', 'PAT', 'password', 'Authorization', 'minioSecretKey', 'apiKey'])(
    'redacts %s',
    (key) => expect(isSensitiveKey(key)).toBe(true)
  );
  it.each(['areaPath', 'IterationPath', 'path', 'patch', 'dispatch', 'tokenCount'])('keeps %s', (key) =>
    expect(isSensitiveKey(key)).toBe(false)
  );
  it('redact() leaves areaPath visible but scrubs a token', () => {
    const out = applyRedact({ message: 'm', areaPath: 'P', accessToken: 'abc' });
    expect(out.areaPath).toBe('P');
    expect(out.accessToken).toBe('[REDACTED]');
  });
});

describe('skipUncaptured', () => {
  const run = (level: string) => (skipUncaptured() as any).transform({ level, message: 'm' });
  it('keeps warn/error/info and drops debug in normal mode', () => {
    expect(run('error')).toBeTruthy();
    expect(run('info')).toBeTruthy();
    expect(run('debug')).toBe(false);
  });
  it('keeps debug inside a verbose run', () => {
    runContextStore.run({ runId: 'r1', captureMode: 'verbose' } as any, () => {
      expect(run('debug')).toBeTruthy();
    });
  });
});
