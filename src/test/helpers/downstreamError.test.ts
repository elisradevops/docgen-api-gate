import { describeDownstreamFailure } from '../../helpers/downstreamError';

const axiosError = (response: any, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error('Request failed with status code 500'), { response, ...extra });

describe('describeDownstreamFailure', () => {
  test('appends the service explanation to the transport message', () => {
    const result = describeDownstreamFailure(
      axiosError({ status: 500, data: { message: 'The specified bucket does not exist', code: 'NoSuchBucket' } })
    );
    expect(result).toMatchObject({
      status: 500,
      code: 'NoSuchBucket',
      downstreamMessage: 'The specified bucket does not exist',
      message: 'Request failed with status code 500: The specified bucket does not exist',
    });
  });

  test('says so when the service answered an error without a message', () => {
    const result = describeDownstreamFailure(axiosError({ status: 500, data: {} }));
    expect(result.message).toBe('Request failed with status code 500 (service sent no error message)');
    expect(result.downstreamMessage).toBeUndefined();
  });

  test('adds a bounded, tag-free excerpt of a body that is not a structured error', () => {
    const html = '<html><body><pre>TypeError: x is not a function\n   at route (/app/dist/routes.js:1:1)</pre></body></html>';
    const result = describeDownstreamFailure(axiosError({ status: 500, data: html }));

    expect(result.downstreamMessage).toBeUndefined();
    expect(result.message).toBe(
      'Request failed with status code 500 (service sent no error message; body: TypeError: x is not a function at route (/app/dist/routes.js:1:1))'
    );
    expect(result.message).not.toContain('<');

    const long = describeDownstreamFailure(axiosError({ status: 500, data: 'y'.repeat(5000) }));
    expect(long.message.length).toBeLessThan(300);
  });

  test('an empty or null body adds no excerpt', () => {
    expect(describeDownstreamFailure(axiosError({ status: 500, data: '' })).message).toBe(
      'Request failed with status code 500 (service sent no error message)'
    );
    expect(describeDownstreamFailure(axiosError({ status: 500, data: null })).downstreamMessage).toBeUndefined();
  });

  test('a transport failure with no response is left as it was', () => {
    expect(describeDownstreamFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).message).toBe(
      'connect ECONNREFUSED'
    );
  });

  test('ignores a blank or non-string message', () => {
    expect(describeDownstreamFailure(axiosError({ status: 500, data: { message: '   ' } })).downstreamMessage).toBeUndefined();
    expect(describeDownstreamFailure(axiosError({ status: 500, data: { message: { a: 1 } } })).downstreamMessage).toBeUndefined();
  });

  test('bounds a very long downstream message', () => {
    const result = describeDownstreamFailure(axiosError({ status: 500, data: { message: 'x'.repeat(5000) } }));
    expect(result.downstreamMessage).toHaveLength(500);
  });

  test('falls back to the error code when the body has none, and handles a plain Error', () => {
    expect(describeDownstreamFailure(axiosError(undefined, { code: 'ECONNREFUSED' })).code).toBe('ECONNREFUSED');
    expect(describeDownstreamFailure(new Error('boom'))).toMatchObject({
      status: undefined,
      code: undefined,
      downstreamMessage: undefined,
      message: 'boom',
    });
  });

  test('copes with a non-Error rejection', () => {
    expect(describeDownstreamFailure('plain string').message).toBe('plain string');
    expect(describeDownstreamFailure(undefined).message).toBe('undefined');
  });

  describe('stack', () => {
    const frames = '    at generateContentControl (/usr/src/app/dist/controllers/index.js:10:5)\n    at async route (/usr/src/app/dist/routes/index.js:20:3)';

    test('leads with the service frames and keeps api-gate\'s own after a separator', () => {
      const err: any = axiosError({ status: 500, data: { message: 'boom', stack: frames } });
      err.stack = 'Error: Request failed with status code 500\n    at createError (axios/lib/core/createError.js:16:15)';

      const result = describeDownstreamFailure(err);

      expect(result.downstreamStack).toBe(frames);
      expect(result.stack).toBe(
        `docgen-content-control (top frames):\n${frames}\n--- api-gate ---\n${err.stack}`
      );
      expect(result.stack!.indexOf('generateContentControl')).toBeLessThan(result.stack!.indexOf('createError'));
    });

    test('without service frames the stack is the error\'s own, unchanged', () => {
      const err: any = axiosError({ status: 500, data: { message: 'boom' } });

      const result = describeDownstreamFailure(err);

      expect(result.downstreamStack).toBeUndefined();
      expect(result.stack).toBe(err.stack);
    });

    test('ignores a stack that is not a string, and bounds an oversized one', () => {
      expect(describeDownstreamFailure(axiosError({ status: 500, data: { message: 'x', stack: { a: 1 } } })).downstreamStack).toBeUndefined();
      expect(describeDownstreamFailure(axiosError({ status: 500, data: { message: 'x', stack: '   ' } })).downstreamStack).toBeUndefined();
      expect(describeDownstreamFailure(axiosError({ status: 500, data: { message: 'x', stack: 'a'.repeat(9000) } })).downstreamStack).toHaveLength(2000);
    });

    test('a stack sent without a message is still used', () => {
      const result = describeDownstreamFailure(axiosError({ status: 500, data: { stack: frames } }));

      expect(result.downstreamMessage).toBeUndefined();
      expect(result.downstreamStack).toBe(frames);
    });
  });
});
