import axios from 'axios';
import {
  SharePointService,
  SharePointConfig,
  SharePointCredentials,
  SharePointOAuthToken,
} from '../../services/SharePointService';
import logger from '../../util/logger';

jest.mock('axios', () => jest.fn());

jest.mock('../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('httpntlm', () => ({
  get: jest.fn(),
}));

const mockedAxios = axios as jest.MockedFunction<typeof axios>;

const mockLogger = logger as unknown as {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
};

describe('SharePointService', () => {
  const baseConfig: SharePointConfig = {
    siteUrl: 'http://sp-server/sites/project',
    library: 'Templates',
    folder: 'DocGen',
  };

  const creds: SharePointCredentials = {
    username: 'user',
    password: 'pass',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('testConnection', () => {
    test('returns informative message for SharePoint Online without calling NTLM', async () => {
      const service = new SharePointService();
      const onlineConfig: SharePointConfig = {
        ...baseConfig,
        siteUrl: 'https://tenant.sharepoint.com/sites/project',
      };

      const ntlmSpy = (jest as any).spyOn(service as any, 'makeNTLMRequest');

      const result = await service.testConnection(onlineConfig, creds);

      expect(result.success).toBe(false);
      expect(result.message).toContain('SharePoint Online requires Azure AD app registration');
      expect(ntlmSpy).not.toHaveBeenCalled();
    });

    test('returns success when NTLM request returns 200', async () => {
      const service = new SharePointService();
      const ntlmSpy = (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValueOnce({ status: 200 });

      const result = await service.testConnection(baseConfig, creds);

      expect(ntlmSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true, message: 'Successfully connected to SharePoint' });
    });

    test('returns failure message when NTLM status is not 200', async () => {
      const service = new SharePointService();
      (jest as any).spyOn(service as any, 'makeNTLMRequest').mockResolvedValueOnce({ status: 404 });

      const result = await service.testConnection(baseConfig, creds);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Connection failed with status 404');
    });

    test('logs and returns failure when NTLM request throws', async () => {
      const service = new SharePointService();
      (jest as any).spyOn(service as any, 'makeNTLMRequest').mockRejectedValueOnce(new Error('boom-ntlm'));

      const result = await service.testConnection(baseConfig, creds);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('SharePoint connection test failed: boom-ntlm')
      );
      expect(result.success).toBe(false);
      expect(result.message).toBe('boom-ntlm');
    });
  });

  describe('listTemplateFiles', () => {
    test('aggregates .docx/.dotx files per subfolder as docType', async () => {
      const service = new SharePointService();
      const makeReqSpy = (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        // First call: subfolders list
        .mockResolvedValueOnce({
          data: {
            d: {
              results: [
                { Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' },
                { Name: '_hidden', ServerRelativeUrl: '/sites/project/Templates/_hidden' },
              ],
            },
          },
        })
        // Second call: files in SVD subfolder
        .mockResolvedValueOnce({
          data: {
            d: {
              results: [
                {
                  Name: 'SVD-template.docx',
                  ServerRelativeUrl: '/sites/project/Templates/SVD/SVD-template.docx',
                  TimeLastModified: '2024-01-01T00:00:00Z',
                  Length: 1234,
                },
                {
                  Name: 'notes.txt',
                  ServerRelativeUrl: '/sites/project/Templates/SVD/notes.txt',
                  TimeLastModified: '2024-01-02T00:00:00Z',
                  Length: 99,
                },
              ],
            },
          },
        });

      const files = await service.listTemplateFiles(baseConfig, creds);

      expect(makeReqSpy).toHaveBeenCalledTimes(2);
      expect(files).toEqual([
        {
          name: 'SVD-template.docx',
          serverRelativeUrl: '/sites/project/Templates/SVD/SVD-template.docx',
          timeLastModified: '2024-01-01T00:00:00Z',
          length: 1234,
          docType: 'SVD',
        },
      ]);
    });

    test('throws descriptive error when makeSharePointRequest fails', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockRejectedValueOnce(new Error('list failed'));

      await expect(service.listTemplateFiles(baseConfig, creds)).rejects.toThrow(
        'Failed to list SharePoint files: list failed'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to list SharePoint files: list failed')
      );
    });
  });

  describe('downloadFile', () => {
    test('returns buffer from makeSharePointRequest data', async () => {
      const service = new SharePointService();
      const payload = Buffer.from('hello');
      const spy = (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: payload });

      const result = await service.downloadFile(
        baseConfig.siteUrl,
        '/sites/project/Templates/SVD/SVD-template.docx',
        creds
      );

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('/_api/web/GetFileByServerRelativeUrl'),
        creds,
        'GET',
        { responseType: 'arraybuffer' }
      );
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe('hello');
    });

    test('throws descriptive error when makeSharePointRequest fails', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockRejectedValueOnce(new Error('download failed'));

      await expect(service.downloadFile(baseConfig.siteUrl, '/some/file.docx', creds)).rejects.toThrow(
        'Failed to download file: download failed'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to download file /some/file.docx: download failed')
      );
    });
  });

  describe('makeSharePointRequest routing', () => {
    test('uses OAuth flow when auth has accessToken', async () => {
      const service = new SharePointService();
      const makeOAuthSpy = (jest as any)
        .spyOn(service as any, 'makeOAuthRequest')
        .mockResolvedValueOnce({ status: 200, data: {}, headers: {} });
      const makeNtlmSpy = (jest as any).spyOn(service as any, 'makeNTLMRequest');

      const token: SharePointOAuthToken = { accessToken: 'token' };
      const result = await (service as any).makeSharePointRequest('http://url', token, 'GET', {});

      expect(makeOAuthSpy).toHaveBeenCalledTimes(1);
      expect(makeNtlmSpy).not.toHaveBeenCalled();
      expect(result.status).toBe(200);
    });

    test('uses NTLM flow when auth does not have accessToken', async () => {
      const service = new SharePointService();
      const makeOAuthSpy = (jest as any).spyOn(service as any, 'makeOAuthRequest');
      const makeNtlmSpy = (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValueOnce({ status: 200, data: {}, headers: {} });

      const result = await (service as any).makeSharePointRequest('http://url', creds, 'GET', {});

      expect(makeNtlmSpy).toHaveBeenCalledTimes(1);
      expect(makeOAuthSpy).not.toHaveBeenCalled();
      expect(result.status).toBe(200);
    });
  });

  describe('internal helpers', () => {
    test('extractSitePath logs and falls back to root on invalid URL', () => {
      const service = new SharePointService();
      const path = (service as any).extractSitePath('not-a-url');

      expect(path).toBe('/');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to parse SharePoint URL: not-a-url, using root path'
      );
    });

    test('makeOAuthRequest sends bearer token and merges headers', async () => {
      const service = new SharePointService();
      mockedAxios.mockResolvedValueOnce({
        status: 201,
        data: { ok: true },
        headers: { 'x-header': 'v' },
      } as any);

      const token: SharePointOAuthToken = { accessToken: 'abc' };
      const result = await (service as any).makeOAuthRequest('http://url', token, 'POST', {
        headers: { 'X-Test': '1' },
      });

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: 'http://url',
          headers: expect.objectContaining({
            'X-Test': '1',
          }),
        })
      );
      expect(result).toEqual({ status: 201, data: { ok: true }, headers: { 'x-header': 'v' } });
    });

    test('makeOAuthRequest logs and rethrows on error', async () => {
      const service = new SharePointService();
      mockedAxios.mockRejectedValueOnce(new Error('oauth-fail'));

      const token: SharePointOAuthToken = { accessToken: 'abc' };
      await expect((service as any).makeOAuthRequest('http://url', token, 'GET', {})).rejects.toThrow(
        'oauth-fail'
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('OAuth request failed: oauth-fail')
      );
    });

    test('makeNTLMRequest returns parsed JSON body on success', async () => {
      const service = new SharePointService();
      const httpntlm = require('httpntlm');
      const getMock = httpntlm.get as jest.Mock;

      getMock.mockImplementationOnce((_opts: any, cb: Function) => {
        cb(null, {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"a":1}',
        });
      });

      const result = await (service as any).makeNTLMRequest(
        'http://sp',
        { username: 'u', password: 'p', domain: 'd' },
        'GET',
        { timeout: 100 }
      );

      expect(getMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://sp',
          username: 'u',
          password: 'p',
          workstation: 'd',
          domain: 'd',
          timeout: 100,
        }),
        expect.any(Function)
      );
      expect(result).toEqual({
        status: 200,
        data: { a: 1 },
        headers: { 'content-type': 'application/json' },
      });
    });

    test('makeNTLMRequest rejects when httpntlm returns error', async () => {
      const service = new SharePointService();
      const httpntlm = require('httpntlm');
      const getMock = httpntlm.get as jest.Mock;

      getMock.mockImplementationOnce((_opts: any, cb: Function) => {
        cb(new Error('ntlm-fail'));
      });

      await expect((service as any).makeNTLMRequest('http://sp', creds, 'GET', {})).rejects.toThrow(
        'ntlm-fail'
      );
    });

    test('makeNTLMRequest rejects for unsupported HTTP method', async () => {
      const service = new SharePointService();

      await expect((service as any).makeNTLMRequest('http://sp', creds, 'POST', {})).rejects.toThrow(
        'HTTP method POST not implemented'
      );
    });
  });
});
