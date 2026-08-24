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

    test('resolveShareRoot rejects a non-Microsoft URL before any network call too', async () => {
      const service = new GraphSharePointService();

      await expect(service.resolveShareRoot('https://evil.example.com/x', token)).rejects.toThrow(
        'SharePoint or OneDrive link'
      );
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });

  // Regression: a live spike this session proved /shares resolves BOTH a
  // "Copy Link" sharing URL and a plain browsed-folder address-bar URL
  // (the .../shared?id=%2Fsites%2F... shape) under Files.Read.All alone.
  // GraphSharePointService no longer has a separate /sites/{hostname}:/{path}
  // + /sites/{siteId}/drive/root:/{path}: resolution path — every Online
  // URL shape goes through /shares only, which needs no Sites.Read.All.
  describe('no /sites/* resolution path exists anymore', () => {
    const addressBarUrl =
      'https://tenant-my.sharepoint.com/shared?id=%2Fsites%2FDocgen%2FShared%20Documents%2Fshared&listurl=https%3A%2F%2Ftenant.sharepoint.com%2Fsites%2FDocgen%2FShared%20Documents';

    test('an address-bar-style URL (with an id= query param) resolves via /shares, never /sites/', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { id: 'item1' } });

      const service = new GraphSharePointService();
      const result = await service.testShareAccess(addressBarUrl, token);

      expect(result.success).toBe(true);
      const calledUrl = mockedAxios.get.mock.calls[0][0];
      expect(calledUrl).toContain('/shares/');
      expect(calledUrl).not.toContain('/sites/');
    });

    test('GraphSharePointService has no resolveFolderByPath/parseAllItemsFolderPath methods left', () => {
      const service: any = new GraphSharePointService();
      expect(service.resolveFolderByPath).toBeUndefined();
      expect(service.parseAllItemsFolderPath).toBeUndefined();
    });
  });

  describe('resolveShareRoot', () => {
    test('returns driveId/itemId/name from the resolved driveItem', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { id: 'item-1', name: 'DocGen Templates', parentReference: { driveId: 'drive-1' } },
      });

      const service = new GraphSharePointService();
      const result = await service.resolveShareRoot(shareUrl, token);

      expect(result).toEqual({ driveId: 'drive-1', itemId: 'item-1', name: 'DocGen Templates' });
      const calledUrl = mockedAxios.get.mock.calls[0][0];
      expect(calledUrl).toMatch(/\/shares\/u![^/]+\/driveItem$/);
    });

    test('throws a clear error when the response has no driveId/itemId', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { name: 'incomplete' } });

      const service = new GraphSharePointService();

      await expect(service.resolveShareRoot(shareUrl, token)).rejects.toThrow(
        'Could not resolve a drive/item reference from this SharePoint link'
      );
    });
  });

  describe('no redemption side effects (Prefer header)', () => {
    test('testShareAccess sends no Prefer header at all — redeeming a link is a permission-granting side effect this read-only app must not cause', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { id: 'item1' } });
      const service = new GraphSharePointService();

      await service.testShareAccess(shareUrl, token);

      const [, requestConfig] = mockedAxios.get.mock.calls[0];
      expect(requestConfig.headers.Prefer).toBeUndefined();
      expect(requestConfig.headers).toEqual({ Authorization: `Bearer ${token.accessToken}` });
    });

    test('resolveShareRoot sends no Prefer header', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { id: 'item1', parentReference: { driveId: 'd1' } } });
      const service = new GraphSharePointService();

      await service.resolveShareRoot(shareUrl, token);

      const [, requestConfig] = mockedAxios.get.mock.calls[0];
      expect(requestConfig.headers.Prefer).toBeUndefined();
    });

    test('listTemplateFiles sends no Prefer header on any request in the walk', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { value: [] } });
      const service = new GraphSharePointService();

      await service.listTemplateFiles(shareUrl, token);

      for (const call of mockedAxios.get.mock.calls) {
        expect(call[1].headers.Prefer).toBeUndefined();
      }
    });
  });

  describe('testShareAccess', () => {
    test('returns success when /shares/{id}/driveItem/children resolves', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { value: [] } });

      const service = new GraphSharePointService();
      const result = await service.testShareAccess(shareUrl, token);

      expect(result).toEqual({
        success: true,
        message: 'Successfully connected to SharePoint via Microsoft Graph',
      });
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/graph\.microsoft\.com\/v1\.0\/shares\/u!.*\/driveItem\/children$/),
        {
          timeout: 15000,
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
          },
        }
      );
    });

    test('accepts a GraphTokenProvider function in place of a plain token object, and calls it to get the access token', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { value: [] } });
      const tokenProvider = jest.fn().mockResolvedValue('provider-issued-token');

      const service = new GraphSharePointService();
      await service.testShareAccess(shareUrl, tokenProvider);

      expect(tokenProvider).toHaveBeenCalled();
      const [, requestConfig] = mockedAxios.get.mock.calls[0];
      expect(requestConfig.headers.Authorization).toBe('Bearer provider-issued-token');
    });

    test('maps a 401 to a re-authentication message (no longer paste-specific wording)', async () => {
      mockedAxios.get.mockRejectedValueOnce({ response: { status: 401 } });

      const service = new GraphSharePointService();
      const result = await service.testShareAccess(shareUrl, token);

      expect(result.success).toBe(false);
      expect(result.message).toContain('expired or invalid');
      expect(result.message).not.toContain('paste');
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

  describe('get() throttle retry', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    // Drives fake timers forward while withThrottleRetry is awaiting sleep().
    // Needs a few more ticks than a bare axios call would, since get() now
    // awaits the token provider before each request — an extra microtask
    // hop per attempt.
    async function flushRetries() {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        jest.runAllTimers();
      }
    }

    const constantTokenProvider = async () => 'tok';

    test('retries a thrown 429 and succeeds on the next attempt', async () => {
      const throttled: any = new Error('Too Many Requests');
      throttled.response = { status: 429, headers: { 'retry-after': '1' } };
      mockedAxios.get.mockRejectedValueOnce(throttled).mockResolvedValueOnce({ data: { id: 'item1' } });

      const service = new GraphSharePointService();
      const promise = (service as any).get('https://graph.microsoft.com/v1.0/x', constantTokenProvider);
      await flushRetries();
      const result = await promise;

      expect(result).toEqual({ data: { id: 'item1' } });
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    test('does not retry a 403 (a real permission error, not throttling) — maps it immediately', async () => {
      const denied: any = new Error('Forbidden');
      denied.response = { status: 403, headers: {} };
      mockedAxios.get.mockRejectedValue(denied);

      const service = new GraphSharePointService();
      await expect((service as any).get('https://graph.microsoft.com/v1.0/x', constantTokenProvider)).rejects.toThrow(
        'This account does not have permission to read this SharePoint folder'
      );
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    test('gives up after retries are exhausted and still maps to the documented error message', async () => {
      const throttled: any = new Error('Server Too Busy');
      throttled.response = { status: 503, headers: {} };
      mockedAxios.get.mockRejectedValue(throttled);

      const service = new GraphSharePointService();
      const promise = (service as any).get('https://graph.microsoft.com/v1.0/x', constantTokenProvider);
      await flushRetries();

      await expect(promise).rejects.toThrow('Microsoft Graph error: 503');
      expect(mockedAxios.get.mock.calls.length).toBeGreaterThan(1);
    });

    test('defaults a request timeout when calling axios', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: {} });

      const service = new GraphSharePointService();
      await (service as any).get('https://graph.microsoft.com/v1.0/x', constantTokenProvider);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://graph.microsoft.com/v1.0/x',
        expect.objectContaining({ timeout: 15000 })
      );
    });

    // The whole reason createTokenProvider re-acquires on every call: a
    // provider function is invoked once per retry attempt too, not cached
    // by this layer — so a token that just expired mid-retry-loop can be
    // refreshed by the caller's own provider on the next attempt.
    test('calls the token provider again on each retry attempt, not just once', async () => {
      const throttled: any = new Error('Too Many Requests');
      throttled.response = { status: 429, headers: { 'retry-after': '1' } };
      mockedAxios.get.mockRejectedValueOnce(throttled).mockResolvedValueOnce({ data: {} });
      const tokenProvider = jest.fn().mockResolvedValue('tok');

      const service = new GraphSharePointService();
      const promise = (service as any).get('https://graph.microsoft.com/v1.0/x', tokenProvider);
      await flushRetries();
      await promise;

      expect(tokenProvider).toHaveBeenCalledTimes(2);
    });
  });

  describe('SSRF guard on @odata.nextLink', () => {
    test('follows a legitimate graph.microsoft.com nextLink', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({ data: { value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page' } })
        .mockResolvedValueOnce({ data: { value: [] } });

      const service = new GraphSharePointService();
      await service.listTemplateFiles(shareUrl, token);

      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
      expect(mockedAxios.get).toHaveBeenNthCalledWith(2, 'https://graph.microsoft.com/v1.0/next-page', expect.anything());
    });

    test.each([
      ['a different host entirely', 'https://evil.example.com/steal-the-token'],
      ['a lookalike subdomain suffix', 'https://graph.microsoft.com.evil.com/x'],
      ['plain http', 'http://graph.microsoft.com/v1.0/x'],
      ['userinfo smuggling', 'https://graph.microsoft.com@evil.com/x'],
    ])('refuses to follow a malicious @odata.nextLink (%s) and never fetches it', async (_label, maliciousNextLink) => {
      mockedAxios.get.mockResolvedValueOnce({ data: { value: [], '@odata.nextLink': maliciousNextLink } });

      const service = new GraphSharePointService();

      await expect(service.listTemplateFiles(shareUrl, token)).rejects.toThrow();
      // Only the first (legitimate) call happened — the malicious nextLink
      // was never requested.
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
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
      const { files, truncated } = await service.listTemplateFiles(shareUrl, token);

      expect(truncated).toBe(false);
      expect(files).toEqual([
        {
          name: 'SVD-template.docx',
          serverRelativeUrl: 'https://download.example/1',
          timeCreated: '2023-12-01T00:00:00Z',
          timeLastModified: '2024-01-01T00:00:00Z',
          length: 1234,
          docType: 'SVD',
          relativePath: 'SVD/SVD-template.docx',
        },
      ]);
      // Only 2 calls: root children + SVD's children. _hidden, the plain
      // file at the root, and the driveId-less nested subfolder must not
      // trigger extra requests.
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
      const { files } = await service.listTemplateFiles(shareUrl, token);

      expect(files).toHaveLength(1);
      expect(files[0].docType).toBe('STD');
      expect(mockedAxios.get).toHaveBeenNthCalledWith(
        2,
        'https://graph.microsoft.com/v1.0/next-page',
        expect.anything()
      );
    });

    // A3: the BFS walk now fetches CONCURRENT_FOLDER_FETCHES folders at a
    // time instead of one at a time. Uses mockImplementation keyed on the
    // actual URL requested (not a fixed mockResolvedValueOnce queue) so the
    // assertions hold regardless of which order the concurrent fetches
    // actually settle in.
    test('processes a wide batch of subfolders concurrently with deterministic, correctly-associated output', async () => {
      const subfolderNames = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5']; // 6 — spans 2 batches at CONCURRENT_FOLDER_FETCHES=4

      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.includes('/shares/')) {
          return {
            data: {
              value: subfolderNames.map((name) => ({
                id: `folder-${name}`,
                name,
                folder: {},
                parentReference: { driveId: 'drive1' },
              })),
            },
          };
        }
        for (const name of subfolderNames) {
          if (url === `https://graph.microsoft.com/v1.0/drives/drive1/items/folder-${name}/children`) {
            return {
              data: {
                value: [
                  {
                    id: `item-${name}`,
                    name: `${name}-template.docx`,
                    file: {},
                    size: 10,
                    lastModifiedDateTime: '2024-01-01T00:00:00Z',
                    '@microsoft.graph.downloadUrl': `https://download.example/${name}`,
                  },
                ],
              },
            };
          }
        }
        throw new Error(`Unexpected URL in test: ${url}`);
      });

      const service = new GraphSharePointService();
      const { files, truncated } = await service.listTemplateFiles(shareUrl, token);

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
      const { files } = await service.listTemplateFiles(shareUrl, token);

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
      const { files } = await service.listTemplateFiles(shareUrl, token);

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
      const { files } = await service.listTemplateFiles(shareUrl, token);

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
      const { files } = await service.listTemplateFiles(shareUrl, token);

      expect(files).toEqual([]);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    test('skips a permission-denied subfolder (403) and keeps files already found elsewhere', async () => {
      mockedAxios.get
        // root children -> two subfolders
        .mockResolvedValueOnce({
          data: {
            value: [
              { id: 'folder-svd', name: 'SVD', folder: {}, parentReference: { driveId: 'drive1' } },
              { id: 'folder-denied', name: 'Denied', folder: {}, parentReference: { driveId: 'drive1' } },
            ],
          },
        })
        // SVD's children -> one valid file
        .mockResolvedValueOnce({
          data: {
            value: [
              {
                id: 'item1',
                name: 'SVD-template.docx',
                file: {},
                size: 10,
                lastModifiedDateTime: '2024-01-01T00:00:00Z',
                '@microsoft.graph.downloadUrl': 'https://download.example/1',
              },
            ],
          },
        })
        // Denied's children -> 403
        .mockRejectedValueOnce({ response: { status: 403, headers: {} } });

      const service = new GraphSharePointService();
      const { files, skippedFolders } = await service.listTemplateFiles(shareUrl, token);

      expect(files).toHaveLength(1);
      expect(files[0].docType).toBe('SVD');
      expect(skippedFolders).toEqual([
        { relativePath: 'Denied', reason: 'This account does not have permission to read this SharePoint folder' },
      ]);
    });

    test('a 401 is never tolerated — stays fatal even on a subfolder', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({
          data: { value: [{ id: 'folder-svd', name: 'SVD', folder: {}, parentReference: { driveId: 'drive1' } }] },
        })
        .mockRejectedValueOnce({ response: { status: 401, headers: {} } });

      const service = new GraphSharePointService();
      await expect(service.listTemplateFiles(shareUrl, token)).rejects.toThrow(
        'Graph access token expired or invalid — please sign in again'
      );
    });

    test('a denied shared-folder root (depth 0) always aborts, never skips', async () => {
      mockedAxios.get.mockRejectedValueOnce({ response: { status: 403, headers: {} } });

      const service = new GraphSharePointService();
      await expect(service.listTemplateFiles(shareUrl, token)).rejects.toThrow(
        'This account does not have permission to read this SharePoint folder'
      );
    });

    // The core fix behind createTokenProvider: a long-running walk that
    // spans multiple batches must re-invoke the token provider on every
    // request, not reuse one token/credentials object captured at the
    // start — otherwise a walk outliving a 60-90 min access token would
    // fail partway through instead of silently refreshing.
    test('invokes a GraphTokenProvider once per HTTP request across a multi-batch walk, not once per walk', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({
          data: { value: [{ id: 'folder-svd', name: 'SVD', folder: {}, parentReference: { driveId: 'drive1' } }] },
        })
        .mockResolvedValueOnce({ data: { value: [] } });
      const tokenProvider = jest.fn().mockResolvedValue('graph-token');

      const service = new GraphSharePointService();
      await service.listTemplateFiles(shareUrl, tokenProvider);

      expect(tokenProvider).toHaveBeenCalledTimes(2);
    });
  });

  describe('downloadFile', () => {
    test('fetches the pre-signed download URL with no Authorization header', async () => {
      const payload = Buffer.from('file-bytes');
      mockedAxios.get.mockResolvedValueOnce({ data: payload });

      const service = new GraphSharePointService();
      const result = await service.downloadFile('https://contoso.sharepoint.com/download/precise-url');

      expect(mockedAxios.get).toHaveBeenCalledWith('https://contoso.sharepoint.com/download/precise-url', {
        responseType: 'arraybuffer',
      });
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe('file-bytes');
    });

    test('refuses a non-https download URL', async () => {
      const service = new GraphSharePointService();

      await expect(service.downloadFile('http://contoso.sharepoint.com/download/precise-url')).rejects.toThrow(
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

    test('refuses a download URL from an unrecognized (non-Microsoft) host', async () => {
      const service = new GraphSharePointService();

      await expect(service.downloadFile('https://evil.example.com/precise-url')).rejects.toThrow(
        'Refusing to fetch a download URL from an unrecognized host'
      );
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });
});
