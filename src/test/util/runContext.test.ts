import * as winston from 'winston';
import Transport from 'winston-transport';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import { withRunContext } from '../../util/logger';
import { attachRunContext, installRunIdForwarding, resolveRunId, runContextStore } from '../../util/runContext';

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
    format: winston.format.combine(withRunContext(), winston.format.json()),
    transports: [capture],
  });
  return { logger, capture };
}

describe('withRunContext', () => {
  test('is a no-op when the store was never populated', () => {
    const { logger, capture } = makeTestLogger();
    logger.info('outside any run');
    expect(capture.lines[0].runId).toBeUndefined();
  });

  test('stamps runId onto every log emitted inside store.run(...)', () => {
    const { logger, capture } = makeTestLogger();
    runContextStore.run({ runId: 'run-123' }, () => {
      logger.info('inside the run');
    });
    logger.info('outside again');
    expect(capture.lines[0].runId).toBe('run-123');
    expect(capture.lines[1].runId).toBeUndefined();
  });
});

describe('resolveRunId', () => {
  test('prefers a valid client-supplied header (the frontend-sent documentId)', () => {
    expect(resolveRunId('abc-123_XYZ')).toBe('abc-123_XYZ');
  });

  test('mints a fresh id when the header is absent', () => {
    expect(resolveRunId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('mints a fresh id rather than trusting a malformed header (log injection / unbounded field guard)', () => {
    const minted = resolveRunId('not a valid id; DROP TABLE runs');
    expect(minted).not.toBe('not a valid id; DROP TABLE runs');
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('mints a fresh id rather than trusting an over-length header', () => {
    const minted = resolveRunId('a'.repeat(65));
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('takes the first value when Express hands back an array (repeated header)', () => {
    expect(resolveRunId(['first-id', 'second-id'])).toBe('first-id');
  });
});

describe('attachRunContext middleware', () => {
  const fakeReq = (headers: Record<string, string>) =>
    ({ header: (name: string) => headers[name.toLowerCase()] } as any);
  const fakeRes = () => {
    const headers: Record<string, string> = {};
    return { setHeader: (name: string, value: string) => (headers[name] = value), headers } as any;
  };

  test('runs next() inside a store carrying the resolved runId, tagged as ui', () => {
    let seenInsideNext: unknown;
    attachRunContext(fakeReq({ 'x-docgen-run-id': 'abc-123' }), fakeRes(), () => {
      seenInsideNext = runContextStore.getStore();
    });
    expect((seenInsideNext as any).runId).toBe('abc-123');
    expect((seenInsideNext as any).trigger).toBe('ui');
  });

  test('mints and runs next() inside a store even with no header at all, tagged as pipeline', () => {
    let seenInsideNext: unknown;
    attachRunContext(fakeReq({}), fakeRes(), () => {
      seenInsideNext = runContextStore.getStore();
    });
    expect(typeof (seenInsideNext as any).runId).toBe('string');
    expect(((seenInsideNext as any).runId as string).length).toBeGreaterThan(0);
    expect((seenInsideNext as any).trigger).toBe('pipeline');
  });

  test('echoes the resolved runId back as a response header', () => {
    const res = fakeRes();
    attachRunContext(fakeReq({ 'x-docgen-run-id': 'abc-123' }), res, () => {});
    expect(res.headers['x-docgen-run-id']).toBe('abc-123');
  });
});

describe('installRunIdForwarding', () => {
  function makeFakeAxiosInstance() {
    let handler: ((config: AxiosRequestConfig) => AxiosRequestConfig) | undefined;
    const instance = {
      interceptors: {
        request: {
          use: (fn: typeof handler) => {
            handler = fn;
          },
        },
      },
    } as unknown as AxiosInstance;
    return { instance, run: (config: any) => handler!(config) };
  }

  test('stamps the ambient runId onto outbound request headers', () => {
    const { instance, run } = makeFakeAxiosInstance();
    installRunIdForwarding(instance);

    let outConfig: any;
    runContextStore.run({ runId: 'run-xyz' }, () => {
      outConfig = run({ headers: {} });
    });

    expect(outConfig.headers['x-docgen-run-id']).toBe('run-xyz');
  });

  test('is a no-op outside a run — no header added', () => {
    const { instance, run } = makeFakeAxiosInstance();
    installRunIdForwarding(instance);

    const outConfig = run({ headers: {} });

    expect(outConfig.headers['x-docgen-run-id']).toBeUndefined();
  });
});
