import axios from 'axios';
import { GraphSharePointService } from '../../services/GraphSharePointService';
import { SharePointOAuthToken } from '../../services/SharePointService';

jest.mock('axios', () => ({ get: jest.fn() }));

jest.mock('../../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockedAxios = axios as unknown as { get: jest.Mock };

describe('GraphSharePointService', () => {
  const shareUrl = 'https://tenant.sharepoint.com/:f:/s/site/shareToken?e=abc123';
  const token: SharePointOAuthToken = { accessToken: 'graph-token' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('origin allowlist (encodeShareId)', () => {
    test.each([
      'https://tenant.sharepoint.com/:f:/s/site/token',
      'https://tenant-my.sharepoint.com/personal/user/token',
      'https://onedrive.live.com/redir?resid=abc',
      'https://company.sharepoint.us/:f:/s/site/token',
      'https://1drv.ms/f/s!abc123',
    ])('accepts a real Microsoft sharing link: %s', async (url) => {
      mockedAxios.get.mockResolvedValueOnce({ data: { id: 'item1' } });
      const service = new GraphSharePointService();

      const result = await service.testShareAccess(url, token);

      expect(result.success).toBe(true);
    });

    test.each([
      'https://evil.example.com/steal-my-token',
      'https://not-sharepoint.com/:f:/s/site/token',
      'not-a-url-at-all',
      '',
    ])('rejects a non-Microsoft URL before any network call: %s', async (url) => {
      const service = new GraphSharePointService();

      const result = await service.testShareAccess(url, token);

      expect(result.success).toBe(false);
      expect(result.message).toContain('SharePoint or OneDrive link');
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    test('listTemplateFiles rejects a non-Microsoft URL before any network call too', async () => {
      const service = new GraphSharePointService();

      await expect(service.listTemplateFiles('https://evil.example.com/x', token)).rejects.toThrow(
        'SharePoint or OneDrive link'
      );
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });

  describe('browsed AllItems.aspx folder URLs (path-based resolution, not /shares)', () => {
    // Real production example: navigating into a folder and copying the
    // address bar, rather than using "Copy Link", produces this shape — the
    // real folder path lives in the `id=` query param, not the page path.
    const allItemsUrl =
      'https://tenant.sharepoint.com/teams/TeamName/Shared%20Documents/Forms/AllItems.aspx' +
      '?csf=1&web=1&e=sess123&CID=abc-def&FolderCTID=0x012001' +
      '&id=%2Fteams%2FTeamName%2FShared%20Documents%2FTraining%20and%20Templates%2FDocGen%20Templates';

    test('walks the path from longest to shortest prefix to find the site, then resolves the folder within its drive', async () => {
      mockedAxios.get
        // segments: ['teams','TeamName','Shared Documents','Training and Templates','DocGen Templates']
        // Longest candidate (all 5 segments) fails
        .mockRejectedValueOnce({ response: { status: 404 } })
        // 4 segments (.../Training and Templates) fails
        .mockRejectedValueOnce({ response: { status: 404 } })
        // 3 segments (.../Shared Documents) fails — a library isn't a site
        .mockRejectedValueOnce({ response: { status: 404 } })
        // 2 segments (.../teams/TeamName) resolves as the site
        .mockResolvedValueOnce({ data: { id: 'site-id-1' } })
        // remaining path resolved against that site's default drive
        .mockResolvedValueOnce({
          data: { id: 'folder-item-1', parentReference: { driveId: 'drive-1' } },
        })
        // root children of the resolved folder
        .mockResolvedValueOnce({
          data: {
            value: [{ id: 'folder-svd', name: 'SVD', folder: {}, parentReference: { driveId: 'drive-1' } }],
          },
        })
        // SVD's children
        .mockResolvedValueOnce({
          data: {
            value: [
              {
                id: 'item1',
                name: 'SVD-template.docx',
                file: {},
                size: 1234,
                createdDateTime: '2023-12-01T00:00:00Z',
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
                '@microsoft.graph.downloadUrl': 'https://download.example/1',
              },
            ],
          },
        });

      const service = new GraphSharePointService();
      const files = await service.listTemplateFiles(allItemsUrl, token);

      expect(files).toEqual([
        {
          name: 'SVD-template.docx',
          serverRelativeUrl: 'https://download.example/1',
          timeCreated: '2023-12-01T00:00:00Z',
          timeLastModified: '2024-01-01T00:00:00Z',
          length: 1234,
          docType: 'SVD',
        },
      ]);

      // First call must have tried the site-by-path candidates before ever
      // hitting /shares — confirms the AllItems.aspx shape never goes near
      // the /shares endpoint at all.
      const calledUrls = mockedAxios.get.mock.calls.map((call) => call[0]);
      expect(calledUrls.every((url) => !url.includes('/shares/'))).toBe(true);
      expect(calledUrls[3]).toContain('/sites/tenant.sharepoint.com:/teams/TeamName');
      expect(calledUrls[4]).toContain('/sites/site-id-1/drive/root:/');
      expect(calledUrls[4]).toContain('Shared%20Documents');
    });

    test('throws a clear error when no site is found anywhere along the path', async () => {
      mockedAxios.get.mockRejectedValue({ response: { status: 404 } });

      const service = new GraphSharePointService();

      await expect(service.listTemplateFiles(allItemsUrl, token)).rejects.toThrow(
        'Could not resolve a SharePoint site from this folder link'
      );
    });

    test('throws a clear error when the whole path is the site itself (no folder remains)', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { id: 'site-id-1' } });

      const service = new GraphSharePointService();
      const siteOnlyUrl =
        'https://tenant.sharepoint.com/teams/TeamName/Forms/AllItems.aspx?id=%2Fteams%2FTeamName';

      await expect(service.listTemplateFiles(siteOnlyUrl, token)).rejects.toThrow(
        'This link points to a site, not a folder inside a document library'
      );
    });

    test('a 401/403 during the path walk surfaces immediately rather than being treated as "keep walking"', async () => {
      mockedAxios.get.mockRejectedValueOnce({ response: { status: 401 } });

      const service = new GraphSharePointService();

      await expect(service.listTemplateFiles(allItemsUrl, token)).rejects.toThrow(
        'Graph access token expired or invalid'
      );
      // Only one call — must not have continued walking after a real auth error.
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    // The thrown error must carry the real HTTP status so callers can
    // respond 401 (an expired token is expected, not a server error)
    // instead of an unconditional 500.
    test('a 401 during the path walk carries status 401 on the thrown error', async () => {
      mockedAxios.get.mockRejectedValueOnce({ response: { status: 401 } });

      const service = new GraphSharePointService();

      let caught: any;
      try {
        await service.listTemplateFiles(allItemsUrl, token);
      } catch (err) {
        caught = err;
      }
      expect(caught.status).toBe(401);
    });

    test('rejects a non-Microsoft hostname even in AllItems.aspx shape before any network call', async () => {
      const service = new GraphSharePointService();
      const evilUrl = 'https://evil.example.com/Shared%20Documents/Forms/AllItems.aspx?id=%2FShared%20Documents%2FX';

      await expect(service.listTemplateFiles(evilUrl, token)).rejects.toThrow('SharePoint or OneDrive link');
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });

  describe('testShareAccess', () => {
    test('returns success when /shares/{id}/driveItem resolves', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { id: 'item1' } });

      const service = new GraphSharePointService();
      const result = await service.testShareAccess(shareUrl, token);

      expect(result).toEqual({
        success: true,
        message: 'Successfully connected to SharePoint via Microsoft Graph',
      });
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/graph\.microsoft\.com\/v1\.0\/shares\/u!/),
        {
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            Prefer: 'redeemSharingLinkIfNecessary',
          },
        }
      );
    });

    test('sends Prefer: redeemSharingLinkIfNecessary — /shares needs this to fully resolve a link the caller has not "opened" before, even with sufficient token scope', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { id: 'item1' } });
      const service = new GraphSharePointService();

      await service.testShareAccess(shareUrl, token);

      expect(mockedAxios.get.mock.calls[0][1].headers.Prefer).toBe('redeemSharingLinkIfNecessary');
    });

    test('maps a 401 to a token-expired message', async () => {
      mockedAxios.get.mockRejectedValueOnce({ response: { status: 401 } });

      const service = new GraphSharePointService();
      const result = await service.testShareAccess(shareUrl, token);

      expect(result.success).toBe(false);
      expect(result.message).toContain('expired or invalid');
    });

    test('maps a 403 to a permission message', async () => {
      mockedAxios.get.mockRejectedValueOnce({ response: { status: 403 } });

      const service = new GraphSharePointService();
      const result = await service.testShareAccess(shareUrl, token);

      expect(result.success).toBe(false);
      expect(result.message).toContain('permission');
    });

    // A 403/401 alone doesn't say which resolution step failed or what URL
    // was tried — this was a real diagnosability gap when triaging a live
    // failure. The URL (never the token) is logged so it's visible which
    // Graph call actually failed.
    test('logs the failing URL (not the token) on a Graph error response', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const logger = require('../../util/logger');
      mockedAxios.get.mockRejectedValueOnce({ response: { status: 403 } });

      const service = new GraphSharePointService();
      await service.testShareAccess(shareUrl, token);

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Graph request failed (403)'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('/shares/'));
      const loggedMessage = logger.warn.mock.calls.find((c: any) => c[0].includes('Graph request failed'))[0];
      expect(loggedMessage).not.toContain(token.accessToken);
    });

    test('maps a transport-level failure (no response) to a reachability message', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('ECONNRESET'));

      const service = new GraphSharePointService();
      const result = await service.testShareAccess(shareUrl, token);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Could not reach Microsoft Graph');
    });
  });

  describe('listTemplateFiles', () => {
    test('descends into folder children, filters .docx/.dotx, and tags each file with its parent folder as docType', async () => {
      mockedAxios.get
        // /shares/{id}/driveItem/children -> subfolders
        .mockResolvedValueOnce({
          data: {
            value: [
              {
                id: 'folder-svd',
                name: 'SVD',
                folder: {},
                parentReference: { driveId: 'drive1' },
              },
              {
                id: 'folder-hidden',
                name: '_hidden',
                folder: {},
                parentReference: { driveId: 'drive1' },
              },
              {
                id: 'file-not-a-folder',
                name: 'readme.txt',
                file: {},
                parentReference: { driveId: 'drive1' },
              },
            ],
          },
        })
        // /drives/drive1/items/folder-svd/children -> files in SVD
        .mockResolvedValueOnce({
          data: {
            value: [
              {
                id: 'item1',
                name: 'SVD-template.docx',
                file: {},
                size: 1234,
                createdDateTime: '2023-12-01T00:00:00Z',
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
                '@microsoft.graph.downloadUrl': 'https://download.example/1',
              },
              {
                id: 'item2',
                name: 'notes.txt',
                file: {},
                size: 99,
                lastModifiedDateTime: '2024-01-02T00:00:00Z',
                '@microsoft.graph.downloadUrl': 'https://download.example/2',
              },
              {
                id: 'item3',
                name: 'subfolder-in-svd',
                folder: {},
              },
            ],
          },
        });

      const service = new GraphSharePointService();
      const files = await service.listTemplateFiles(shareUrl, token);

      expect(files).toEqual([
        {
          name: 'SVD-template.docx',
          serverRelativeUrl: 'https://download.example/1',
          timeCreated: '2023-12-01T00:00:00Z',
          timeLastModified: '2024-01-01T00:00:00Z',
          length: 1234,
          docType: 'SVD',
        },
      ]);
      // Only 2 calls: root children + SVD's children. _hidden and the plain
      // file at the root must not trigger extra requests.
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    test('follows @odata.nextLink pagination', async () => {
      mockedAxios.get
        // page 1 of root children
        .mockResolvedValueOnce({
          data: {
            value: [],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page',
          },
        })
        // page 2 of root children
        .mockResolvedValueOnce({
          data: {
            value: [
              {
                id: 'folder-std',
                name: 'STD',
                folder: {},
                parentReference: { driveId: 'drive1' },
              },
            ],
          },
        })
        // STD's children
        .mockResolvedValueOnce({
          data: {
            value: [
              {
                id: 'item1',
                name: 'STD-template.dotx',
                file: {},
                size: 42,
                lastModifiedDateTime: '2024-02-01T00:00:00Z',
                '@microsoft.graph.downloadUrl': 'https://download.example/std',
              },
            ],
          },
        });

      const service = new GraphSharePointService();
      const files = await service.listTemplateFiles(shareUrl, token);

      expect(files).toHaveLength(1);
      expect(files[0].docType).toBe('STD');
      expect(mockedAxios.get).toHaveBeenNthCalledWith(
        2,
        'https://graph.microsoft.com/v1.0/next-page',
        expect.anything()
      );
    });

    test('skips a file with no @microsoft.graph.downloadUrl rather than crashing', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({
          data: {
            value: [{ id: 'folder-svd', name: 'SVD', folder: {}, parentReference: { driveId: 'drive1' } }],
          },
        })
        .mockResolvedValueOnce({
          data: {
            value: [{ id: 'item1', name: 'no-url.docx', file: {}, size: 1 }],
          },
        });

      const service = new GraphSharePointService();
      const files = await service.listTemplateFiles(shareUrl, token);

      expect(files).toEqual([]);
    });

    test('excludes an Office lock/temp file (~$...) even though it ends in .docx', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({
          data: {
            value: [{ id: 'folder-svd', name: 'SVD', folder: {}, parentReference: { driveId: 'drive1' } }],
          },
        })
        .mockResolvedValueOnce({
          data: {
            value: [
              {
                id: 'item1',
                name: '~$ftware Version Description.dotx',
                file: {},
                size: 162,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
                '@microsoft.graph.downloadUrl': 'https://download.example/lockfile',
              },
            ],
          },
        });

      const service = new GraphSharePointService();
      const files = await service.listTemplateFiles(shareUrl, token);

      expect(files).toEqual([]);
    });

    test('excludes a file over the max template size and logs why', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({
          data: {
            value: [{ id: 'folder-svd', name: 'SVD', folder: {}, parentReference: { driveId: 'drive1' } }],
          },
        })
        .mockResolvedValueOnce({
          data: {
            value: [
              {
                id: 'item1',
                name: 'huge-template.docx',
                file: {},
                size: 51 * 1024 * 1024,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
                '@microsoft.graph.downloadUrl': 'https://download.example/huge',
              },
            ],
          },
        });

      const service = new GraphSharePointService();
      const files = await service.listTemplateFiles(shareUrl, token);

      expect(files).toEqual([]);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const logger = require('../../util/logger');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds the sync limit'));
    });

    test('skips a subfolder with no driveId/itemId rather than crashing', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { value: [{ id: undefined, name: 'SVD', folder: {}, parentReference: {} }] },
      });

      const service = new GraphSharePointService();
      const files = await service.listTemplateFiles(shareUrl, token);

      expect(files).toEqual([]);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('downloadFile', () => {
    test('fetches the pre-signed download URL with no Authorization header', async () => {
      const payload = Buffer.from('file-bytes');
      mockedAxios.get.mockResolvedValueOnce({ data: payload });

      const service = new GraphSharePointService();
      const result = await service.downloadFile('https://download.example/precise-url');

      expect(mockedAxios.get).toHaveBeenCalledWith('https://download.example/precise-url', {
        responseType: 'arraybuffer',
      });
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe('file-bytes');
    });

    test('refuses a non-https download URL', async () => {
      const service = new GraphSharePointService();

      await expect(service.downloadFile('http://download.example/precise-url')).rejects.toThrow(
        'Refusing to fetch a non-https download URL'
      );
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    test.each(['localhost', '127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.1.1'])(
      'refuses a download URL pointing at the private/internal host %s',
      async (hostname) => {
        const service = new GraphSharePointService();

        await expect(service.downloadFile(`https://${hostname}/precise-url`)).rejects.toThrow(
          'Refusing to fetch a download URL pointing at a private/internal host'
        );
        expect(mockedAxios.get).not.toHaveBeenCalled();
      }
    );
  });
});
