import * as opentracing from 'opentracing';

jest.mock('jaeger-client', () => {
  const span = { setTag: jest.fn(), finish: jest.fn() };
  const tracer = {
    startSpan: jest.fn(() => span),
    inject: jest.fn(),
    extract: jest.fn(),
  };
  return {
    initTracer: jest.fn(() => tracer),
    __tracer: tracer,
    __span: span,
  };
});

jest.mock('../../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('tracer-middleware', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.JAEGER_ENDPOINT = 'jaeger-host';
  });

  test('initializes tracer with service name and Jaeger endpoint', () => {
    const jaeger = require('jaeger-client');
    const { tracer } = require('../../../helpers/openTracing/tracer-middleware');

    expect(jaeger.initTracer).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'dg-api-gate',
        reporter: expect.objectContaining({ agentHost: 'jaeger-host' }),
        sampler: expect.any(Object),
      }),
      expect.any(Object)
    );

    expect(tracer).toBe(jaeger.__tracer);
  });

  test('injectRootSpan starts a root span and injects headers', () => {
    const jaeger = require('jaeger-client');
    const { tracer, injectRootSpan } = require('../../../helpers/openTracing/tracer-middleware');

    const req: any = { originalUrl: '/path' };
    const res: any = {};
    const next = jest.fn();

    injectRootSpan(req, res, next);

    expect(tracer.startSpan).toHaveBeenCalledWith('/path');
    const span = (tracer.startSpan as jest.Mock).mock.results[0].value;
    expect(req.rootSpan).toBe(span);
    expect(tracer.inject).toHaveBeenCalledWith(span, opentracing.FORMAT_HTTP_HEADERS, req);
    expect(next).toHaveBeenCalled();
  });

  test('createControllerSpan creates child span with correct tags', () => {
    const jaeger = require('jaeger-client');
    const { tracer, createControllerSpan } = require('../../../helpers/openTracing/tracer-middleware');

    (tracer.extract as jest.Mock).mockReturnValueOnce('parentCtx');

    const headers = { 'x-trace-id': 'abc' };
    const span = createControllerSpan('DatabaseController', 'createFavorite', headers);

    expect(tracer.extract).toHaveBeenCalledWith(opentracing.FORMAT_HTTP_HEADERS, headers);
    expect(tracer.startSpan).toHaveBeenCalledWith('createFavorite', {
      childOf: 'parentCtx',
      tags: {
        [opentracing.Tags.SPAN_KIND]: opentracing.Tags.SPAN_KIND_RPC_SERVER,
        [opentracing.Tags.COMPONENT]: 'DatabaseController',
      },
    });
    expect(span).toBe(jaeger.__span);
  });

  test('tracedSubAction creates child span under parent', () => {
    const jaeger = require('jaeger-client');
    const { tracer, tracedSubAction } = require('../../../helpers/openTracing/tracer-middleware');

    const parentSpan: any = { id: 'parent' };
    const span = tracedSubAction(parentSpan, 'sub-op');

    const lastCall = (tracer.startSpan as jest.Mock).mock.calls.at(-1);
    expect(lastCall).toEqual([
      'sub-op',
      {
        childOf: parentSpan,
        tags: { [opentracing.Tags.SPAN_KIND]: opentracing.Tags.SPAN_KIND_RPC_SERVER },
      },
    ]);
    expect(span).toBe(jaeger.__span);
  });

  test('finishSpanWithResult sets status and optional error tag then finishes', () => {
    const { finishSpanWithResult } = require('../../../helpers/openTracing/tracer-middleware');

    const span: any = { setTag: jest.fn(), finish: jest.fn() };

    finishSpanWithResult(span, 200, false);
    expect(span.setTag).toHaveBeenCalledWith(opentracing.Tags.HTTP_STATUS_CODE, 200);
    expect(span.setTag).not.toHaveBeenCalledWith(opentracing.Tags.ERROR, true);
    expect(span.finish).toHaveBeenCalledTimes(1);

    span.setTag.mockClear();
    span.finish.mockClear();

    finishSpanWithResult(span, 500, true);
    expect(span.setTag).toHaveBeenCalledWith(opentracing.Tags.HTTP_STATUS_CODE, 500);
    expect(span.setTag).toHaveBeenCalledWith(opentracing.Tags.ERROR, true);
    expect(span.finish).toHaveBeenCalledTimes(1);
  });
});
