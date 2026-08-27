import { assertGraphApiUrl, assertDownloadUrl } from '../../util/graphUrlGuard';

describe('graphUrlGuard', () => {
  describe('assertGraphApiUrl (gates @odata.nextLink)', () => {
    test('accepts a genuine graph.microsoft.com https URL', () => {
      expect(() => assertGraphApiUrl('https://graph.microsoft.com/v1.0/drives/abc/items/def/children')).not.toThrow();
    });

    test.each([
      ['plain http', 'http://graph.microsoft.com/v1.0/drives/abc/children'],
      ['non-https scheme', 'ftp://graph.microsoft.com/v1.0/drives/abc/children'],
      ['lookalike subdomain suffix', 'https://graph.microsoft.com.evil.com/v1.0/x'],
      ['path-embedded lookalike', 'https://evil.com/graph.microsoft.com/v1.0/x'],
      ['userinfo smuggling', 'https://graph.microsoft.com@evil.com/v1.0/x'],
      ['completely different host', 'https://attacker.example.com/v1.0/x'],
      ['malformed URL', 'not a url at all'],
    ])('rejects %s', (_label, url) => {
      expect(() => assertGraphApiUrl(url)).toThrow();
    });
  });

  describe('assertDownloadUrl (gates @microsoft.graph.downloadUrl)', () => {
    test.each([
      ['graph.microsoft.com', 'https://graph.microsoft.com/download/abc'],
      ['a sharepoint.com subdomain', 'https://contoso.sharepoint.com/download/abc'],
      ['a sharepoint.us subdomain', 'https://contoso.sharepoint.us/download/abc'],
      ['a onedrive.com subdomain', 'https://contoso-my.onedrive.com/download/abc'],
      ['onedrive.live.com', 'https://onedrive.live.com/download/abc'],
    ])('accepts %s', (_label, url) => {
      expect(() => assertDownloadUrl(url)).not.toThrow();
    });

    test.each([
      ['plain http', 'http://contoso.sharepoint.com/download/abc'],
      ['localhost', 'https://localhost/download/abc'],
      ['loopback IPv4', 'https://127.0.0.1/download/abc'],
      ['loopback IPv6', 'https://[::1]/download/abc'],
      ['private 10.x', 'https://10.0.0.5/download/abc'],
      ['private 172.16-31.x', 'https://172.20.0.5/download/abc'],
      ['private 192.168.x', 'https://192.168.1.5/download/abc'],
      ['link-local / cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
      ['userinfo smuggling', 'https://graph.microsoft.com@evil.com/download/abc'],
      ['unrecognized host', 'https://attacker.example.com/download/abc'],
      ['malformed URL', 'not a url at all'],
    ])('rejects %s', (_label, url) => {
      expect(() => assertDownloadUrl(url)).toThrow();
    });

    test('does not treat a suffix-lookalike host as a sharepoint.com subdomain', () => {
      expect(() => assertDownloadUrl('https://evilsharepoint.com/download/abc')).toThrow();
    });
  });
});
