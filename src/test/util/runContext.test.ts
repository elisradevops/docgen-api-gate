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

describe('attachRunContext request ids', () => {
  const fakeReq = (headers: Record<string, string>, path: string) =>
    ({ header: (name: string) => headers[name.toLowerCase()], path } as any);
  const fakeRes = () => ({ setHeader: () => undefined } as any);
  const runIdFor = (headers: Record<string, string>, path: string): string => {
    let id = '';
    attachRunContext(fakeReq(headers, path), fakeRes(), () => {
      id = runContextStore.getStore()!.runId;
    });
    return id;
  };

  test('a non-generation request without an id is minted as req-<uuid>', () => {
    expect(runIdFor({}, '/azure/tests/plans')).toMatch(/^req-[0-9a-f-]{36}$/);
  });

  test('a generation request without an id (a pipeline caller) keeps a plain uuid run id', () => {
    expect(runIdFor({}, '/jsonDocument/create')).toMatch(/^[0-9a-f-]{36}$/);
    expect(runIdFor({}, '/jsonDocument/create/')).toMatch(/^[0-9a-f-]{36}$/);
    expect(runIdFor({}, '/JSONDOCUMENT/create')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a valid client-supplied id is never re-prefixed, on any path', () => {
    expect(runIdFor({ 'x-docgen-run-id': 'abc-123' }, '/azure/projects')).toBe('abc-123');
  });

  test('a malformed supplied id on a non-generation path is replaced by a req- id', () => {
    expect(runIdFor({ 'x-docgen-run-id': 'bad id!' }, '/azure/projects')).toMatch(/^req-/);
  });

  test('the prefixed id still satisfies the run id pattern', () => {
    expect(runIdFor({}, '/azure/projects')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('attachRunContext middleware', () => {
  const fakeReq = (headers: Record<string, string>, path?: string) =>
    ({ header: (name: string) => headers[name.toLowerCase()], path } as any);
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

  test.each(['verbose', 'retain-on-failure'] as const)(
    'records a valid x-docgen-capture-mode (%s) as a request only — it is not active until authorized',
    (mode) => {
      let seenInsideNext: unknown;
      attachRunContext(fakeReq({ 'x-docgen-capture-mode': mode }), fakeRes(), () => {
        seenInsideNext = runContextStore.getStore();
      });
      expect((seenInsideNext as any).requestedCaptureMode).toBe(mode);
      expect((seenInsideNext as any).captureMode).toBeUndefined();
    }
  );

  test('defaults to no requested capture mode (normal) when the header is absent', () => {
    let seenInsideNext: unknown;
    attachRunContext(fakeReq({}), fakeRes(), () => {
      seenInsideNext = runContextStore.getStore();
    });
    expect((seenInsideNext as any).requestedCaptureMode).toBeUndefined();
    expect((seenInsideNext as any).captureMode).toBeUndefined();
  });

  test('drops a malformed x-docgen-capture-mode rather than trusting it', () => {
    let seenInsideNext: unknown;
    attachRunContext(fakeReq({ 'x-docgen-capture-mode': 'DROP TABLE runs' }), fakeRes(), () => {
      seenInsideNext = runContextStore.getStore();
    });
    expect((seenInsideNext as any).requestedCaptureMode).toBeUndefined();
  });
});

describe('installRunIdForwarding', () => {
  const ENV = { cc: process.env.dgContentControlUrl, jw: process.env.jsonToWordPostUrl };
  beforeEach(() => {
    process.env.dgContentControlUrl = 'http://cc.internal:3000';
    process.env.jsonToWordPostUrl = 'http://jw.internal:5000/api/json2word';
  });
  afterAll(() => {
    process.env.dgContentControlUrl = ENV.cc;
    process.env.jsonToWordPostUrl = ENV.jw;
  });
  const CC = 'http://cc.internal:3000/azure/projects';

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
      outConfig = run({ url: CC, headers: {} });
    });

    expect(outConfig.headers['x-docgen-run-id']).toBe('run-xyz');
  });

  test('is a no-op outside a run — no header added', () => {
    const { instance, run } = makeFakeAxiosInstance();
    installRunIdForwarding(instance);

    const outConfig = run({ url: CC, headers: {} });

    expect(outConfig.headers['x-docgen-run-id']).toBeUndefined();
  });

  test('forwards the ambient captureMode alongside runId when present', () => {
    const { instance, run } = makeFakeAxiosInstance();
    installRunIdForwarding(instance);

    let outConfig: any;
    runContextStore.run({ runId: 'run-xyz', captureMode: 'verbose' }, () => {
      outConfig = run({ url: CC, headers: {} });
    });

    expect(outConfig.headers['x-docgen-capture-mode']).toBe('verbose');
  });

  test('does not add a capture-mode header when the run is normal (no captureMode set)', () => {
    const { instance, run } = makeFakeAxiosInstance();
    installRunIdForwarding(instance);

    let outConfig: any;
    runContextStore.run({ runId: 'run-xyz' }, () => {
      outConfig = run({ url: CC, headers: {} });
    });

    expect(outConfig.headers['x-docgen-capture-mode']).toBeUndefined();
  });

  test('also forwards to json-to-word, and resolves a relative url against baseURL', () => {
    const { instance, run } = makeFakeAxiosInstance();
    installRunIdForwarding(instance);
    let toJw: any;
    let viaBase: any;
    runContextStore.run({ runId: 'run-xyz', project: 'P', docType: 'STD' }, () => {
      toJw = run({ url: 'http://jw.internal:5000/api/json2word', headers: {} });
      viaBase = run({ url: '/azure/projects', baseURL: 'http://cc.internal:3000', headers: {} });
    });
    expect(toJw.headers['x-docgen-run-id']).toBe('run-xyz');
    expect(viaBase.headers['x-docgen-project']).toBe('P');
  });

  test.each([
    'https://graph.microsoft.com/v1.0/sites',
    'https://contoso.sharepoint.com/_api/web',
    'https://minio.example/presigned?X-Amz-Signature=abc',
  ])('adds no x-docgen-* header to an external host: %s', (url) => {
    const { instance, run } = makeFakeAxiosInstance();
    installRunIdForwarding(instance);
    let outConfig: any;
    runContextStore.run({ runId: 'run-xyz', captureMode: 'verbose', project: 'Secret', docType: 'STD' }, () => {
      outConfig = run({ url, headers: {} });
    });
    expect(Object.keys(outConfig.headers).filter((h) => h.startsWith('x-docgen-'))).toEqual([]);
  });

  test('adds nothing when the target cannot be resolved', () => {
    const { instance, run } = makeFakeAxiosInstance();
    installRunIdForwarding(instance);
    let outConfig: any;
    runContextStore.run({ runId: 'run-xyz' }, () => {
      outConfig = run({ headers: {} });
    });
    expect(outConfig.headers['x-docgen-run-id']).toBeUndefined();
  });
});

