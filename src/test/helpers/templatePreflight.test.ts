jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../../util/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import axios from 'axios';
import logger from '../../util/logger';
import { assertTemplateExists, describeTemplateLocation } from '../../helpers/templatePreflight';

const mockGet = axios.get as jest.Mock;
const URL_OK = 'http://minio:9000/templates/shared/STD/STD.dotx?X-Amz-Signature=secret-sig&X-Amz-Expires=60';
const reply = (status: number) => ({ status, data: { destroy: jest.fn() } });

describe('assertTemplateExists', () => {
  beforeEach(() => jest.clearAllMocks());

  test('passes when storage has the template (200 or a ranged 206), and closes the stream', async () => {
    const r = reply(206);
    mockGet.mockResolvedValue(r);
    await expect(assertTemplateExists(URL_OK)).resolves.toBeUndefined();
    expect(r.data.destroy).toHaveBeenCalled();
    await mockGet.mockResolvedValue(reply(200));
    await expect(assertTemplateExists(URL_OK)).resolves.toBeUndefined();
  });

  test('asks for a single byte with a GET (a presigned url is only valid for its own method)', async () => {
    mockGet.mockResolvedValue(reply(206));
    await assertTemplateExists(URL_OK);
    const [url, opts] = mockGet.mock.calls[0];
    expect(url).toBe(URL_OK);
    expect(opts.headers.Range).toBe('bytes=0-0');
    expect(opts.responseType).toBe('stream');
    expect(opts.timeout).toBeLessThanOrEqual(5000);
    expect(opts.validateStatus()).toBe(true); // any status is inspected, none throws
  });

  test('404 fails fast with a coded error that names the template, and never leaks the signature', async () => {
    mockGet.mockResolvedValue(reply(404));
    const err: any = await assertTemplateExists(URL_OK).catch((e) => e);
    expect(err.message).toBe('Template not found in storage: templates/shared/STD/STD.dotx');
    expect(err).toMatchObject({
      statusCode: 404,
      code: 'TEMPLATE_NOT_FOUND',
      step: 'validate-template',
      dependency: 'minio',
      url: 'http://minio:9000/templates/shared/STD/STD.dotx',
    });
    const everything = JSON.stringify([err.message, err.url, (logger.error as jest.Mock).mock.calls]);
    expect(everything).not.toContain('secret-sig');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('STD.dotx'), { code: 'TEMPLATE_NOT_FOUND' });
  });

  test.each([403, 500, 503])('a %i is "could not verify": warns and lets the run continue', async (status) => {
    mockGet.mockResolvedValue(reply(status));
    await expect(assertTemplateExists(URL_OK)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('a timeout or network error warns and lets the run continue', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }));
    await expect(assertTemplateExists(URL_OK)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timeout of 5000ms exceeded'));
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('secret-sig');
  });

  test('skips an empty or non-http template, with no request at all', async () => {
    await assertTemplateExists(undefined);
    await assertTemplateExists('');
    await assertTemplateExists('templates/shared/STD/STD.dotx');
    await assertTemplateExists('file:///tmp/x.dotx');
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('an unexpected response shape (no status) is "could not verify", not a crash', async () => {
    mockGet.mockResolvedValue(undefined);
    await expect(assertTemplateExists(URL_OK)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('describeTemplateLocation', () => {
  test('bucket/key only: no host, no query, decoded', () => {
    expect(describeTemplateLocation('http://h:9000/templates/shared/STD/My%20File.dotx?sig=1')).toBe(
      'templates/shared/STD/My File.dotx'
    );
    expect(describeTemplateLocation('not a url')).toBe('(unparseable template url)');
  });
});
