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
    // The recursive walk fetches Files then Folders at each level, root
    // first — so the first mocked call is always the root folder's Files.
    test('throws instead of silently returning [] when subfolders response is not the expected JSON shape', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: { d: { results: [] } } }) // Files(root)
        .mockResolvedValueOnce({
          data: '<feed xmlns="http://www.w3.org/2005/Atom">...</feed>',
          headers: { 'content-type': 'application/atom+xml' },
        }); // Folders(root) — bad shape

      await expect(service.listTemplateFiles(baseConfig, creds)).rejects.toThrow(
        /Unexpected response fetching subfolders in/
      );
    });

    test('throws instead of silently returning [] when a subfolder files response is not the expected JSON shape', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: { d: { results: [] } } }) // Files(root)
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        }) // Folders(root)
        .mockResolvedValueOnce({
          data: '<feed xmlns="http://www.w3.org/2005/Atom">...</feed>',
          headers: { 'content-type': 'application/atom+xml' },
        }); // Files(SVD) — bad shape

      await expect(service.listTemplateFiles(baseConfig, creds)).rejects.toThrow(
        /Unexpected response fetching files in/
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
        /SharePoint returned an error while fetching files in ".*": File Not Found\./
      );
    });

    test('aggregates .docx/.dotx files per subfolder as docType, tagged with a relativePath', async () => {
      const service = new SharePointService();
      const makeReqSpy = (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        // 1: Files at root — none directly at the connected root
        .mockResolvedValueOnce({ data: { d: { results: [] } } })
        // 2: Folders at root
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
        // 3: Files in SVD subfolder
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
        })
        // 4: Folders in SVD subfolder — no further nesting
        .mockResolvedValueOnce({ data: { d: { results: [] } } });

      const { files, truncated } = await service.listTemplateFiles(baseConfig, creds);

      // Files(root), Folders(root), Files(SVD), Folders(SVD). _hidden must
      // never be queued — no calls issued for it.
      expect(makeReqSpy).toHaveBeenCalledTimes(4);
      expect(truncated).toBe(false);
      expect(files).toEqual([
        {
          name: 'SVD-template.docx',
          serverRelativeUrl: '/sites/project/Templates/SVD/SVD-template.docx',
          timeCreated: '2023-12-01T00:00:00Z',
          timeLastModified: '2024-01-01T00:00:00Z',
          length: 1234,
          docType: 'SVD',
          relativePath: 'SVD/SVD-template.docx',
        },
      ]);
    });

    // A3: the BFS walk now fetches CONCURRENT_FOLDER_FETCHES folders at a
    // time instead of one at a time. This must not change the output —
    // uses mockImplementation keyed on the actual URL requested (not a
    // fixed mockResolvedValueOnce queue) so the assertions hold regardless
    // of which order the concurrent fetches actually settle in.
    test('processes a wide batch of subfolders concurrently with deterministic, correctly-associated output', async () => {
      const service = new SharePointService();
      const subfolderNames = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5']; // 6 — spans 2 batches at CONCURRENT_FOLDER_FETCHES=4

      (jest as any).spyOn(service as any, 'makeSharePointRequest').mockImplementation(async (url: string) => {
        const rootFilesUrl =
          "http://sp-server/sites/project/_api/web/GetFolderByServerRelativeUrl('/sites/project/Templates/DocGen')/Files";
        const rootFoldersUrl =
          "http://sp-server/sites/project/_api/web/GetFolderByServerRelativeUrl('/sites/project/Templates/DocGen')/Folders";

        if (url === rootFilesUrl) return { data: { d: { results: [] } } };
        if (url === rootFoldersUrl) {
          return {
            data: {
              d: {
                results: subfolderNames.map((name) => ({
                  Name: name,
                  ServerRelativeUrl: `/sites/project/Templates/DocGen/${name}`,
                })),
              },
            },
          };
        }

        for (const name of subfolderNames) {
          const filesUrl = `http://sp-server/sites/project/_api/web/GetFolderByServerRelativeUrl('/sites/project/Templates/DocGen/${name}')/Files`;
          const foldersUrl = `http://sp-server/sites/project/_api/web/GetFolderByServerRelativeUrl('/sites/project/Templates/DocGen/${name}')/Folders`;
          if (url === filesUrl) {
            return {
              data: {
                d: {
                  results: [
                    {
                      Name: `${name}-template.docx`,
                      ServerRelativeUrl: `/sites/project/Templates/DocGen/${name}/${name}-template.docx`,
                      TimeLastModified: '2024-01-01T00:00:00Z',
                      Length: 10,
                    },
                  ],
                },
              },
            };
          }
          if (url === foldersUrl) return { data: { d: { results: [] } } };
        }

        throw new Error(`Unexpected URL in test: ${url}`);
      });

      const { files, truncated } = await service.listTemplateFiles(baseConfig, creds);

      expect(truncated).toBe(false);
      expect(files).toHaveLength(6);
      // Deterministic: output must follow original queue (BFS) order, not
      // whatever order the concurrent batch happened to settle in.
      expect(files.map((f) => f.relativePath)).toEqual([
        'F0/F0-template.docx',
        'F1/F1-template.docx',
        'F2/F2-template.docx',
        'F3/F3-template.docx',
        'F4/F4-template.docx',
        'F5/F5-template.docx',
      ]);
      files.forEach((f, i) => expect(f.docType).toBe(subfolderNames[i]));
    });

    test('lists a file sitting directly at the connected root with no docType (flat-folder case)', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        // 1: Files at root — a flat folder's files live here directly
        .mockResolvedValueOnce({
          data: {
            d: {
              results: [
                {
                  Name: 'Some-Template.dotx',
                  ServerRelativeUrl: '/sites/project/Templates/DocGen/Some-Template.dotx',
                  TimeLastModified: '2024-01-01T00:00:00Z',
                  Length: 500,
                },
              ],
            },
          },
        })
        // 2: Folders at root — none
        .mockResolvedValueOnce({ data: { d: { results: [] } } });

      const { files, truncated } = await service.listTemplateFiles(baseConfig, creds);

      expect(truncated).toBe(false);
      expect(files).toEqual([
        {
          name: 'Some-Template.dotx',
          serverRelativeUrl: '/sites/project/Templates/DocGen/Some-Template.dotx',
          timeCreated: undefined,
          timeLastModified: '2024-01-01T00:00:00Z',
          length: 500,
          docType: undefined,
          relativePath: 'Some-Template.dotx',
        },
      ]);
    });

    test('excludes Office lock/temp files (~$...) even though they end in .docx/.dotx', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: { d: { results: [] } } }) // Files(root)
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        }) // Folders(root)
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
        }) // Files(SVD)
        .mockResolvedValueOnce({ data: { d: { results: [] } } }); // Folders(SVD)

      const { files } = await service.listTemplateFiles(baseConfig, creds);

      expect(files).toEqual([]);
    });

    test('excludes a file over the max template size and logs why', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: { d: { results: [] } } }) // Files(root)
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        }) // Folders(root)
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
        }) // Files(SVD)
        .mockResolvedValueOnce({ data: { d: { results: [] } } }); // Folders(SVD)

      const { files } = await service.listTemplateFiles(baseConfig, creds);

      expect(files).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds the sync limit'));
    });

    test('truncates and flags it when the file count cap is hit', async () => {
      const service = new SharePointService();
      // One over the cap — the 501st push is what actually flips
      // `truncated`. Since fetchFolder always fetches /Folders too (the
      // running total across a concurrent batch isn't known per-item, so
      // the old per-item short-circuit isn't available), Folders(root)
      // still needs a mock even though its result is discarded once
      // truncation is detected while accumulating this folder's files.
      const manyFiles = Array.from({ length: 501 }, (_, i) => ({
        Name: `T${i}.docx`,
        ServerRelativeUrl: `/sites/project/Templates/DocGen/T${i}.docx`,
        TimeLastModified: '2024-01-01T00:00:00Z',
        Length: 10,
      }));
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        // Files(root) — over the 500-file cap in one response
        .mockResolvedValueOnce({ data: { d: { results: manyFiles } } })
        // Folders(root) — fetched regardless, result discarded
        .mockResolvedValueOnce({ data: { d: { results: [] } } });

      const { files, truncated } = await service.listTemplateFiles(baseConfig, creds);

      expect(truncated).toBe(true);
      expect(files).toHaveLength(500);
    });

    test('skips a permission-denied subfolder (resolved 403) and keeps files already found', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: { d: { results: [] } } }) // Files(root)
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        }) // Folders(root)
        .mockResolvedValueOnce({
          status: 403,
          data: { error: { message: { value: 'Access is denied.' } } },
        }); // Files(SVD) — denied

      const { files, truncated, skippedFolders } = await service.listTemplateFiles(baseConfig, creds);

      expect(truncated).toBe(false);
      expect(files).toEqual([]);
      expect(skippedFolders).toEqual([{ relativePath: 'SVD', reason: 'Access is denied.' }]);
    });

    test('skips a permission-denied subfolder when the request throws (OAuth-on-onprem 403)', async () => {
      const service = new SharePointService();
      const denied: any = new Error('Forbidden');
      denied.response = { status: 403, headers: {} };
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: { d: { results: [] } } }) // Files(root)
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        }) // Folders(root)
        .mockRejectedValueOnce(denied); // Files(SVD) — thrown 403

      const { skippedFolders } = await service.listTemplateFiles(baseConfig, creds);

      expect(skippedFolders).toEqual([{ relativePath: 'SVD', reason: 'Forbidden' }]);
    });

    test('a subfolder denied only on its Folders fetch keeps its own files but does not descend', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: { d: { results: [] } } }) // Files(root)
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        }) // Folders(root)
        .mockResolvedValueOnce({
          data: {
            d: {
              results: [
                {
                  Name: 'SVD-template.docx',
                  ServerRelativeUrl: '/sites/project/Templates/SVD/SVD-template.docx',
                  TimeLastModified: '2024-01-01T00:00:00Z',
                  Length: 10,
                },
              ],
            },
          },
        }) // Files(SVD) — succeeds
        .mockResolvedValueOnce({ status: 403, data: { error: { message: { value: 'Access is denied.' } } } }); // Folders(SVD) — denied

      const { files, skippedFolders } = await service.listTemplateFiles(baseConfig, creds);

      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('SVD-template.docx');
      expect(skippedFolders).toEqual([{ relativePath: 'SVD', reason: 'Access is denied.' }]);
    });

    test('a denied connected root (depth 0) always aborts the whole listing, never skips', async () => {
      const service = new SharePointService();
      (jest as any).spyOn(service as any, 'makeSharePointRequest').mockResolvedValueOnce({
        status: 403,
        data: { error: { message: { value: 'Access is denied.' } } },
      }); // Files(root) — denied

      await expect(service.listTemplateFiles(baseConfig, creds)).rejects.toThrow(/Access is denied\./);
    });

    test('a 401 is never tolerated — stays fatal even on a subfolder (credentials are the problem, not the folder)', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: { d: { results: [] } } }) // Files(root)
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        }) // Folders(root)
        .mockResolvedValueOnce({
          status: 401,
          data: { error: { message: { value: 'Access is denied.' } } },
        }); // Files(SVD) — 401, must NOT be tolerated despite the "Access is denied." wording

      await expect(service.listTemplateFiles(baseConfig, creds)).rejects.toThrow(/Access is denied\./);
    });

    test('tolerates a non-403 status whose OData message says access is denied', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: { d: { results: [] } } }) // Files(root)
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        }) // Folders(root)
        .mockResolvedValueOnce({
          status: 500,
          data: { error: { message: { value: 'You do not have permission to view this directory.' } } },
        }); // Files(SVD) — non-403 status, denial-shaped message

      const { skippedFolders } = await service.listTemplateFiles(baseConfig, creds);

      expect(skippedFolders).toEqual([
        { relativePath: 'SVD', reason: 'You do not have permission to view this directory.' },
      ]);
    });

    test('a malformed/unrecognized response on a subfolder is still fatal, not skipped (A2 must not weaken this)', async () => {
      const service = new SharePointService();
      (jest as any)
        .spyOn(service as any, 'makeSharePointRequest')
        .mockResolvedValueOnce({ data: { d: { results: [] } } }) // Files(root)
        .mockResolvedValueOnce({
          data: { d: { results: [{ Name: 'SVD', ServerRelativeUrl: '/sites/project/Templates/SVD' }] } },
        }) // Folders(root)
        .mockResolvedValueOnce({
          data: '<feed xmlns="http://www.w3.org/2005/Atom">...</feed>',
          headers: { 'content-type': 'application/atom+xml' },
        }); // Files(SVD) — malformed, not a denial shape at all

      await expect(service.listTemplateFiles(baseConfig, creds)).rejects.toThrow(/Unexpected response fetching/);
    });

    test('caps recorded skippedFolders and notes the true remaining count', async () => {
      const service = new SharePointService();
      const subfolderCount = 27; // over MAX_SKIPPED_FOLDERS_RECORDED (25)
      const subfolders = Array.from({ length: subfolderCount }, (_, i) => ({
        Name: `Denied${i}`,
        ServerRelativeUrl: `/sites/project/Templates/Denied${i}`,
      }));

      const spy = (jest as any).spyOn(service as any, 'makeSharePointRequest');
      spy.mockResolvedValueOnce({ data: { d: { results: [] } } }); // Files(root)
      spy.mockResolvedValueOnce({ data: { d: { results: subfolders } } }); // Folders(root)
      for (let i = 0; i < subfolderCount; i++) {
        spy.mockResolvedValueOnce({ status: 403, data: { error: { message: { value: 'Access is denied.' } } } });
      }

      const { skippedFolders } = await service.listTemplateFiles(baseConfig, creds);

      // 25 recorded entries + 1 summary entry for the remaining 2.
      expect(skippedFolders).toHaveLength(26);
      expect(skippedFolders[25].reason).toContain('2 more folder(s)');
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
        .mockResolvedValueOnce({ files: graphFiles, truncated: false });
      const restSpy = (jest as any).spyOn(service as any, 'makeSharePointRequest');

      const { files, truncated } = await service.listTemplateFiles(onlineConfig, token);

      expect(graphSpy).toHaveBeenCalledWith(onlineConfig.siteUrl, token);
      expect(restSpy).not.toHaveBeenCalled();
      expect(truncated).toBe(false);
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
        'GET',
        { timeout: 15000 }
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
        'GET',
        { timeout: 15000 }
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
        'GET',
        { timeout: 15000 }
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

    test('throws a descriptive error when every candidate depth has no ServerRelativeUrl', async () => {
      const service = new SharePointService();
      // Every candidate (full path down to the bare origin) gets the same
      // non-matching response — none resolve, so the walk must exhaust all
      // of them before throwing.
      const ntlmSpy = (jest as any).spyOn(service as any, 'makeNTLMRequest').mockResolvedValue({
        status: 404,
        data: '<feed xmlns="http://www.w3.org/2005/Atom">...</feed>',
        headers: { 'content-type': 'application/atom+xml' },
      });

      await expect(
        service.resolveSiteFromUrl('http://sp-server/sites/project/Templates', creds)
      ).rejects.toThrow(/Unexpected response fetching a SharePoint site for this URL.*status: 404/);

      // 'sites', 'project', 'Templates' -> depths 3,2,1,0 = 4 attempts.
      expect(ntlmSpy).toHaveBeenCalledTimes(4);
    });

    test('walks to a shallower candidate when the deepest path 500s (root-web site with a deep folder path)', async () => {
      const service = new SharePointService();
      const ntlmSpy = (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        // Deepest candidate (the full pasted path) fails, same as the real
        // production 500 this fix targets.
        .mockResolvedValueOnce({ status: 500, data: '', headers: {} })
        // Bare origin (root web) resolves.
        .mockResolvedValueOnce({ data: { d: { ServerRelativeUrl: '/' } } });

      const result = await service.resolveSiteFromUrl(
        'http://elissp/Project/Shared Documents/Training and Templates/DocGen Templates',
        creds
      );

      expect(ntlmSpy).toHaveBeenCalledTimes(2);
      // No doubled trailing slash from ServerRelativeUrl being "/".
      expect(result.siteUrl).toBe('http://elissp');
      expect(result.folder).toBe('Project/Shared Documents/Training and Templates/DocGen Templates');
    });

    test('propagates a rejected request as a descriptive error when every candidate rejects', async () => {
      const service = new SharePointService();
      (jest as any).spyOn(service as any, 'makeNTLMRequest').mockRejectedValue(new Error('ECONNREFUSED'));

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

  describe('makeSharePointRequest throttle retry', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    // Drives fake timers forward while withThrottleRetry is awaiting sleep().
    async function flushRetries() {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        jest.runAllTimers();
      }
    }

    test('retries an NTLM 429 response (resolved, not thrown) and succeeds on the next attempt', async () => {
      const service = new SharePointService();
      const makeNtlmSpy = (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValueOnce({ status: 429, data: {}, headers: { 'retry-after': '1' } })
        .mockResolvedValueOnce({ status: 200, data: { ok: true }, headers: {} });

      const promise = (service as any).makeSharePointRequest('http://url', creds, 'GET', {});
      await flushRetries();
      const result = await promise;

      expect(result).toEqual({ status: 200, data: { ok: true }, headers: {} });
      expect(makeNtlmSpy).toHaveBeenCalledTimes(2);
    });

    test('retries a thrown OAuth 429 error and succeeds', async () => {
      const service = new SharePointService();
      const err: any = new Error('Too Many Requests');
      err.response = { status: 429, headers: {} };
      const makeOAuthSpy = (jest as any)
        .spyOn(service as any, 'makeOAuthRequest')
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ status: 200, data: {}, headers: {} });
      const token: SharePointOAuthToken = { accessToken: 'token' };

      const promise = (service as any).makeSharePointRequest('http://url', token, 'GET', {});
      await flushRetries();
      const result = await promise;

      expect(result.status).toBe(200);
      expect(makeOAuthSpy).toHaveBeenCalledTimes(2);
    });

    test('does not retry a non-throttling status (e.g. 404 — a real "not found", not overload)', async () => {
      const service = new SharePointService();
      const makeNtlmSpy = (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValue({ status: 404, data: {}, headers: {} });

      const result = await (service as any).makeSharePointRequest('http://url', creds, 'GET', {});

      expect(result.status).toBe(404);
      expect(makeNtlmSpy).toHaveBeenCalledTimes(1);
    });

    test('defaults a request timeout when the caller does not set one', async () => {
      const service = new SharePointService();
      const makeNtlmSpy = (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValueOnce({ status: 200, data: {}, headers: {} });

      await (service as any).makeSharePointRequest('http://url', creds, 'GET', {});

      expect(makeNtlmSpy).toHaveBeenCalledWith(
        'http://url',
        creds,
        'GET',
        expect.objectContaining({ timeout: 15000 })
      );
    });

    test('a caller-supplied timeout wins over the default', async () => {
      const service = new SharePointService();
      const makeNtlmSpy = (jest as any)
        .spyOn(service as any, 'makeNTLMRequest')
        .mockResolvedValueOnce({ status: 200, data: {}, headers: {} });

      await (service as any).makeSharePointRequest('http://url', creds, 'GET', { timeout: 5000 });

      expect(makeNtlmSpy).toHaveBeenCalledWith('http://url', creds, 'GET', expect.objectContaining({ timeout: 5000 }));
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

    test('constructFolderPath adds a leading slash for a root-web site (empty site path)', () => {
      const service = new SharePointService();
      const path = (service as any).constructFolderPath({
        siteUrl: 'http://elissp',
        library: '',
        folder: 'Project/Shared Documents/DocGen Templates',
      });

      expect(path).toBe('/Project/Shared Documents/DocGen Templates');
    });

    test('constructFolderPath is unaffected for a /sites/x site (already has a leading slash)', () => {
      const service = new SharePointService();
      const path = (service as any).constructFolderPath({
        siteUrl: 'http://sp-server/sites/project',
        library: 'Shared Documents',
        folder: 'Templates',
      });

      expect(path).toBe('/sites/project/Shared Documents/Templates');
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
