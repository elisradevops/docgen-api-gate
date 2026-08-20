import axios from 'axios';
import https from 'https';
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
    test('rejects username/password credentials for a SharePoint Online site without calling NTLM', async () => {
      const service = new SharePointService();
      const onlineConfig: SharePointConfig = {
        ...baseConfig,
        siteUrl: 'https://tenant.sharepoint.com/sites/project',
      };

      const ntlmSpy = (jest as any).spyOn(service as any, 'makeNTLMRequest');

      const result = await service.testConnection(onlineConfig, creds);

      expect(result.success).toBe(false);
      expect(result.message).toContain('requires a Microsoft Graph access token');
      expect(ntlmSpy).not.toHaveBeenCalled();
    });

    test('rejects a Graph access token for an on-premise site without calling NTLM', async () => {
      const service = new SharePointService();
      const ntlmSpy = (jest as any).spyOn(service as any, 'makeNTLMRequest');
      const token: SharePointOAuthToken = { accessToken: 'abc' };

      const result = await service.testConnection(baseConfig, token);

      expect(result.success).toBe(false);
      expect(result.message).toContain('requires a username/password');
      expect(ntlmSpy).not.toHaveBeenCalled();
    });

    test('delegates to GraphSharePointService.testShareAccess for a SharePoint Online site with a token', async () => {
      const service = new SharePointService();
      const onlineConfig: SharePointConfig = {
        ...baseConfig,
        siteUrl: 'https://tenant.sharepoint.com/:f:/s/site/shareToken',
      };
      const token: SharePointOAuthToken = { accessToken: 'abc' };
      const graphSpy = (jest as any)
        .spyOn((service as any).graphService, 'testShareAccess')
        .mockResolvedValueOnce({ success: true, message: 'ok via graph' });

      const result = await service.testConnection(onlineConfig, token);

      expect(graphSpy).toHaveBeenCalledWith(onlineConfig.siteUrl, token);
      expect(result).toEqual({ success: true, message: 'ok via graph' });
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
    test('throws instead of silently returning [] when subfolders response is not the expected JSON shape', async () => {
      const service = new SharePointService();
      (jest as any).spyOn(service as any, 'makeSharePointRequest').mockResolvedValueOnce({
        data: '<feed xmlns="http://www.w3.org/2005/Atom">...</feed>',
        headers: { 'content-type': 'application/atom+xml' },
      });

      await expect(service.listTemplateFiles(baseConfig, creds)).rejects.toThrow(
        /Unexpected response fetching subfolders/
      );
    });

    test('throws instead of silently returning [] when a subfolder files response is not the expected JSON shape', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        })
        .mockResolvedValueOnce({
          data: '<feed xmlns="http://www.w3.org/2005/Atom">...</feed>',
          headers: { 'content-type': 'application/atom+xml' },
        });

      await expect(service.listTemplateFiles(baseConfig, creds)).rejects.toThrow(
        /Unexpected response fetching files in subfolder "SVD"/
      );
    });

    // Regression: a pasted templates folder that doesn't exist on the
    // SharePoint server returns SharePoint's own REST error body (a 404
    // with an OData error object), not a list. That specific, human-
    // readable message ("File Not Found.") must reach the user instead of
    // the generic "Unexpected response... Body preview: {...}" dump.
    test('surfaces SharePoint\'s own error message when the templates folder does not exist', async () => {
      const service = new SharePointService();
      (jest as any).spyOn(service as any, 'makeSharePointRequest').mockResolvedValueOnce({
        status: 404,
        data: {
          error: {
            code: '-2130575338, Microsoft.SharePoint.SPException',
            message: { lang: 'en-US', value: 'File Not Found.' },
          },
        },
        headers: { 'content-type': 'application/json;odata=verbose' },
      });

      await expect(service.listTemplateFiles(baseConfig, creds)).rejects.toThrow(
        /SharePoint returned an error while fetching subfolders: File Not Found\./
      );
    });

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
                  TimeCreated: '2023-12-01T00:00:00Z',
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
          timeCreated: '2023-12-01T00:00:00Z',
          timeLastModified: '2024-01-01T00:00:00Z',
          length: 1234,
          docType: 'SVD',
        },
      ]);
    });

    test('excludes Office lock/temp files (~$...) even though they end in .docx/.dotx', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        })
        .mockResolvedValueOnce({
          data: {
            d: {
              results: [
                // Matches the real seed asset in this repo:
                // s3-initializer/assets/templates/shared/SVD/~$ftware Version Description.dotx
                {
                  Name: '~$ftware Version Description.dotx',
                  ServerRelativeUrl: '/sites/project/Templates/SVD/~$ftware Version Description.dotx',
                  TimeLastModified: '2024-01-01T00:00:00Z',
                  Length: 162,
                },
              ],
            },
          },
        });

      const files = await service.listTemplateFiles(baseConfig, creds);

      expect(files).toEqual([]);
    });

    test('excludes a file over the max template size and logs why', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        })
        .mockResolvedValueOnce({
          data: {
            d: {
              results: [
                {
                  Name: 'huge-template.docx',
                  ServerRelativeUrl: '/sites/project/Templates/SVD/huge-template.docx',
                  TimeLastModified: '2024-01-01T00:00:00Z',
                  Length: 51 * 1024 * 1024,
                },
              ],
            },
          },
        });

      const files = await service.listTemplateFiles(baseConfig, creds);

      expect(files).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds the sync limit'));
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

    test('delegates to GraphSharePointService for a SharePoint Online site with a token, bypassing the REST/NTLM path', async () => {
      const service = new SharePointService();
      const onlineConfig: SharePointConfig = {
        ...baseConfig,
        siteUrl: 'https://tenant.sharepoint.com/:f:/s/site/shareToken',
      };
      const token: SharePointOAuthToken = { accessToken: 'abc' };
      const graphFiles = [
        {
          name: 'SVD-template.docx',
          serverRelativeUrl: 'https://graph-download.example/precise-url',
          timeLastModified: '2024-01-01T00:00:00Z',
          length: 1234,
          docType: 'SVD',
        },
      ];
      const graphSpy = (jest as any)
        .spyOn((service as any).graphService, 'listTemplateFiles')
        .mockResolvedValueOnce(graphFiles);
      const restSpy = (jest as any).spyOn(service as any, 'makeSharePointRequest');

      const files = await service.listTemplateFiles(onlineConfig, token);

      expect(graphSpy).toHaveBeenCalledWith(onlineConfig.siteUrl, token);
      expect(restSpy).not.toHaveBeenCalled();
      expect(files).toEqual(graphFiles);
    });
  });

  describe('downloadFile', () => {
    test('returns buffer from makeSharePointRequest data', async () => {
      const service = new SharePointService();
      // Real .docx/.dotx files are ZIP archives — downloadFile now rejects
      // anything that doesn't start with the ZIP signature, so the fixture
      // must include it to exercise the "valid file" path.
      const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('hello')]);
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
      expect(result.equals(payload)).toBe(true);
    });

    test('rejects a downloaded file that is not a valid ZIP/OOXML package', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: Buffer.from('not a real docx') });

      await expect(
        service.downloadFile(baseConfig.siteUrl, '/sites/project/Templates/SVD/fake.docx', creds)
      ).rejects.toThrow('not a valid Office document — failed content check');
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

    test('delegates to GraphSharePointService for a SharePoint Online site with a token, bypassing the REST/NTLM path', async () => {
      const service = new SharePointService();
      const token: SharePointOAuthToken = { accessToken: 'abc' };
      const graphBuffer = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('graph-file-bytes')]);
      const graphSpy = (jest as any)
        .spyOn((service as any).graphService, 'downloadFile')
        .mockResolvedValueOnce(graphBuffer);
      const restSpy = (jest as any).spyOn(service as any, 'makeSharePointRequest');

      const result = await service.downloadFile(
        'https://tenant.sharepoint.com/:f:/s/site/shareToken',
        'https://graph-download.example/precise-url',
        token
      );

      expect(graphSpy).toHaveBeenCalledWith('https://graph-download.example/precise-url');
      expect(restSpy).not.toHaveBeenCalled();
      expect(result).toBe(graphBuffer);
    });
  });

  describe('resolveSiteFromUrl', () => {
    test('resolves siteUrl/folder from a pasted deep folder URL, stripping the site prefix out of folder', async () => {
      const service = new SharePointService();
      const ntlmSpy = (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValueOnce({ data: { d: { ServerRelativeUrl: '/sites/project' } } });

      const result = await service.resolveSiteFromUrl(
        'http://sp-server/sites/project/Shared Documents/02 Engineering/Templates',
        creds
      );

      expect(ntlmSpy).toHaveBeenCalledWith(
        'http://sp-server/sites/project/Shared Documents/02 Engineering/Templates/_api/web?$select=ServerRelativeUrl',
        creds,
        'GET'
      );
      expect(result).toEqual({
        siteUrl: 'http://sp-server/sites/project',
        library: '',
        folder: 'Shared Documents/02 Engineering/Templates',
      });
    });

    test('strips a trailing slash from the pasted URL before appending _api/web', async () => {
      const service = new SharePointService();
      const ntlmSpy = (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValueOnce({ data: { d: { ServerRelativeUrl: '/sites/project' } } });

      await service.resolveSiteFromUrl('http://sp-server/sites/project/Templates/', creds);

      expect(ntlmSpy).toHaveBeenCalledWith(
        'http://sp-server/sites/project/Templates/_api/web?$select=ServerRelativeUrl',
        creds,
        'GET'
      );
    });

    test('strips the query string before appending _api/web, for a pasted AllItems.aspx URL', async () => {
      const service = new SharePointService();
      const ntlmSpy = (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValueOnce({ data: { d: { ServerRelativeUrl: '/DevOPs' } } });

      await service.resolveSiteFromUrl(
        'http://elissp/DevOPs/Shared Documents/Forms/AllItems.aspx?web=1&RootFolder=%2fDevOPs%2fShared%20Documents%2fTraining%20and%20Templates%2fDocGen%20Templates&FolderCTID=0x012000B3FA09F870FEDE4A8F7582FA6AB1AE75',
        creds
      );

      expect(ntlmSpy).toHaveBeenCalledWith(
        'http://elissp/DevOPs/Shared Documents/Forms/AllItems.aspx/_api/web?$select=ServerRelativeUrl',
        creds,
        'GET'
      );
    });

    test('prefers the RootFolder= query param over the page path for the resolved folder — on-prem\'s equivalent of Online\'s ?id= shape', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValueOnce({ data: { d: { ServerRelativeUrl: '/DevOPs' } } });

      const result = await service.resolveSiteFromUrl(
        'http://elissp/DevOPs/Shared Documents/Forms/AllItems.aspx?web=1&RootFolder=%2fDevOPs%2fShared%20Documents%2fTraining%20and%20Templates%2fDocGen%20Templates&FolderCTID=0x012000B3FA09F870FEDE4A8F7582FA6AB1AE75',
        creds
      );

      // Must resolve to the real target folder (from RootFolder=), NOT
      // "Shared Documents/Forms/AllItems.aspx" (the page's own path).
      expect(result).toEqual({
        siteUrl: 'http://elissp/DevOPs',
        library: '',
        folder: 'Shared Documents/Training and Templates/DocGen Templates',
      });
    });

    test('resolved folder is usable by constructFolderPath without a doubled/duplicated site path', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValueOnce({ data: { d: { ServerRelativeUrl: '/sites/project' } } });

      const resolved = await service.resolveSiteFromUrl(
        'http://sp-server/sites/project/Shared Documents/Templates',
        creds
      );

      const rebuilt = (service as any).constructFolderPath({
        siteUrl: resolved.siteUrl,
        library: resolved.library,
        folder: resolved.folder,
      });

      expect(rebuilt).toBe('/sites/project/Shared Documents/Templates');
    });

    test('throws a descriptive error when the response has no ServerRelativeUrl', async () => {
      const service = new SharePointService();
      (jest as any).spyOn(service as any, 'makeNTLMRequest').mockResolvedValueOnce({
        data: '<feed xmlns="http://www.w3.org/2005/Atom">...</feed>',
        headers: { 'content-type': 'application/atom+xml' },
      });

      await expect(
        service.resolveSiteFromUrl('http://sp-server/sites/project/Templates', creds)
      ).rejects.toThrow(/Could not resolve a SharePoint site from this URL/);
    });

    test('propagates a rejected request as a descriptive error', async () => {
      const service = new SharePointService();
      (jest as any).spyOn(service as any, 'makeNTLMRequest').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(
        service.resolveSiteFromUrl('http://sp-server/sites/project/Templates', creds)
      ).rejects.toThrow('Failed to resolve SharePoint site from URL: ECONNREFUSED');
    });

    test('does not double-decode RootFolder= — a folder name containing a literal % character resolves correctly', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValueOnce({ data: { d: { ServerRelativeUrl: '/DevOPs' } } });

      const result = await service.resolveSiteFromUrl(
        'http://elissp/DevOPs/Shared Documents/Forms/AllItems.aspx?RootFolder=%2fDevOPs%2f100%2525%20Done',
        creds
      );

      // The raw query value %2fDevOPs%2f100%2525%20Done is percent-decoded
      // ONCE by URLSearchParams.get() (which resolveSiteFromUrl must use
      // as-is, not decode again): %2f -> "/", %25 -> "%", the following
      // literal "25" stays as-is, and %20 -> " ". That yields
      // "/DevOPs/100%25 Done" — a folder literally named "100%25 Done".
      // A second decodeURIComponent() call (the bug) would re-decode the
      // "%25" substring into a bare "%", silently corrupting the result to
      // "100% Done" instead of throwing here — still wrong, just not a
      // thrown error for this particular input (a folder name with an
      // unencoded literal % immediately followed by a non-hex character,
      // e.g. "100% Done", throws "URI malformed" instead — see the
      // 'prefers the RootFolder=' test above for the non-doubled case).
      expect(result).toEqual({
        siteUrl: 'http://elissp/DevOPs',
        library: '',
        folder: '100%25 Done',
      });
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

  describe('toServerRelativeUrlLiteral', () => {
    test('percent-encodes spaces within a segment but leaves "/" as a literal separator', () => {
      const service = new SharePointService();
      const result = (service as any).toServerRelativeUrlLiteral(
        '/sites/project/Shared Documents/02 Engineering/Templates'
      );

      // '/' must never be percent-encoded (would produce %2F, which IIS's
      // request filtering rejects by default with 404.11 "URL Double Escaped")
      expect(result).not.toContain('%2F');
      expect(result).not.toContain('%2f');
      expect(result).toBe('/sites/project/Shared%20Documents/02%20Engineering/Templates');
    });

    test('escapes a literal single quote by doubling it (OData string literal syntax)', () => {
      const service = new SharePointService();
      const result = (service as any).toServerRelativeUrlLiteral("/sites/project/Client's Templates");

      // The doubled quote is the literal OData escape and must survive
      // percent-encoding unencoded (encodeURIComponent does not touch ').
      expect(result).toBe("/sites/project/Client''s%20Templates");
    });

    test('handles a path with neither spaces nor quotes unchanged (aside from the leading slash)', () => {
      const service = new SharePointService();
      const result = (service as any).toServerRelativeUrlLiteral('/sites/project/SVD');

      expect(result).toBe('/sites/project/SVD');
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

    test('makeOAuthRequest sets an httpsAgent with rejectUnauthorized:false only when SHAREPOINT_ALLOW_SELF_SIGNED=true', async () => {
      jest.resetModules();
      process.env.SHAREPOINT_ALLOW_SELF_SIGNED = 'true';
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { SharePointService: ReloadedService } = require('../../services/SharePointService');
        const reloadedAxios = require('axios') as jest.MockedFunction<any>;
        reloadedAxios.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });

        const service = new ReloadedService();
        const token: SharePointOAuthToken = { accessToken: 'abc' };
        await (service as any).makeOAuthRequest('http://url', token, 'GET', {});

        const sentConfig = reloadedAxios.mock.calls[0][0];
        expect(sentConfig.httpsAgent).toBeInstanceOf(https.Agent);
        expect(sentConfig.httpsAgent.options.rejectUnauthorized).toBe(false);
      } finally {
        delete process.env.SHAREPOINT_ALLOW_SELF_SIGNED;
        jest.resetModules();
      }
    });

    test('makeOAuthRequest omits httpsAgent by default', async () => {
      const service = new SharePointService();
      mockedAxios.mockResolvedValueOnce({ status: 200, data: {}, headers: {} } as any);

      const token: SharePointOAuthToken = { accessToken: 'abc' };
      await (service as any).makeOAuthRequest('http://url', token, 'GET', {});

      expect(mockedAxios.mock.calls[0][0]).not.toHaveProperty('httpsAgent');
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

    test('makeNTLMRequest always sends an Accept: application/json header (on-prem SharePoint defaults to Atom XML otherwise)', async () => {
      const service = new SharePointService();
      const httpntlm = require('httpntlm');
      const getMock = httpntlm.get as jest.Mock;

      getMock.mockImplementationOnce((_opts: any, cb: Function) => {
        cb(null, { statusCode: 200, headers: {}, body: '{}' });
      });

      await (service as any).makeNTLMRequest('http://sp', creds, 'GET', {});

      expect(getMock).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: 'application/json;odata=verbose' }),
        }),
        expect.any(Function)
      );
    });

    test('makeNTLMRequest merges caller-supplied headers with the default Accept header', async () => {
      const service = new SharePointService();
      const httpntlm = require('httpntlm');
      const getMock = httpntlm.get as jest.Mock;

      getMock.mockImplementationOnce((_opts: any, cb: Function) => {
        cb(null, { statusCode: 200, headers: {}, body: '{}' });
      });

      await (service as any).makeNTLMRequest('http://sp', creds, 'GET', { headers: { 'X-Test': '1' } });

      expect(getMock).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: 'application/json;odata=verbose', 'X-Test': '1' }),
        }),
        expect.any(Function)
      );
    });

    test('makeNTLMRequest translates responseType:"arraybuffer" into binary:true so downloaded files are not utf8-stringified', async () => {
      const service = new SharePointService();
      const httpntlm = require('httpntlm');
      const getMock = httpntlm.get as jest.Mock;

      getMock.mockImplementationOnce((_opts: any, cb: Function) => {
        cb(null, { statusCode: 200, headers: {}, body: Buffer.from('binary-data') });
      });

      await (service as any).makeNTLMRequest('http://sp', creds, 'GET', { responseType: 'arraybuffer' });

      expect(getMock).toHaveBeenCalledWith(
        expect.objectContaining({ binary: true }),
        expect.any(Function)
      );
      // responseType itself is an axios-only key and must not leak into the httpntlm options
      expect(getMock.mock.calls[0][0]).not.toHaveProperty('responseType');
    });

    test('makeNTLMRequest does not set binary when no arraybuffer responseType was requested', async () => {
      const service = new SharePointService();
      const httpntlm = require('httpntlm');
      const getMock = httpntlm.get as jest.Mock;

      getMock.mockImplementationOnce((_opts: any, cb: Function) => {
        cb(null, { statusCode: 200, headers: {}, body: '{}' });
      });

      await (service as any).makeNTLMRequest('http://sp', creds, 'GET', {});

      expect(getMock.mock.calls[0][0]).not.toHaveProperty('binary');
    });

    test('makeNTLMRequest never forwards a caller-supplied agent (would break NTLM connection affinity)', async () => {
      const service = new SharePointService();
      const httpntlm = require('httpntlm');
      const getMock = httpntlm.get as jest.Mock;

      getMock.mockImplementationOnce((_opts: any, cb: Function) => {
        cb(null, { statusCode: 200, headers: {}, body: '{}' });
      });

      const bogusAgent = {};
      await (service as any).makeNTLMRequest('http://sp', creds, 'GET', { agent: bogusAgent });

      expect(getMock.mock.calls[0][0].agent).not.toBe(bogusAgent);
      expect(getMock.mock.calls[0][0]).not.toHaveProperty('agent');
    });

    test('makeNTLMRequest sets rejectUnauthorized:false only when SHAREPOINT_ALLOW_SELF_SIGNED=true', async () => {
      jest.resetModules();
      process.env.SHAREPOINT_ALLOW_SELF_SIGNED = 'true';
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { SharePointService: ReloadedService } = require('../../services/SharePointService');
        const httpntlm = require('httpntlm');
        const getMock = httpntlm.get as jest.Mock;

        getMock.mockImplementationOnce((_opts: any, cb: Function) => {
          cb(null, { statusCode: 200, headers: {}, body: '{}' });
        });

        const service = new ReloadedService();
        await (service as any).makeNTLMRequest('http://sp', creds, 'GET', {});

        expect(getMock).toHaveBeenCalledWith(
          expect.objectContaining({ rejectUnauthorized: false }),
          expect.any(Function)
        );
      } finally {
        delete process.env.SHAREPOINT_ALLOW_SELF_SIGNED;
        jest.resetModules();
      }
    });

    test('makeNTLMRequest omits rejectUnauthorized by default', async () => {
      const service = new SharePointService();
      const httpntlm = require('httpntlm');
      const getMock = httpntlm.get as jest.Mock;

      getMock.mockImplementationOnce((_opts: any, cb: Function) => {
        cb(null, { statusCode: 200, headers: {}, body: '{}' });
      });

      await (service as any).makeNTLMRequest('http://sp', creds, 'GET', {});

      expect(getMock.mock.calls[0][0]).not.toHaveProperty('rejectUnauthorized');
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
