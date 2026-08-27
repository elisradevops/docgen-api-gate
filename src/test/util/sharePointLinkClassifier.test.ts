import { classifySharePointUrl } from '../../util/sharePointLinkClassifier';

describe('classifySharePointUrl', () => {
  test('classifies a non-SharePoint-Online host as onprem', () => {
    expect(classifySharePointUrl({ siteUrl: 'http://sp-server.internal/sites/projectx' })).toBe('onprem');
  });

  test('classifies a "Copy Link" sharing URL as online-sharing-link', () => {
    expect(
      classifySharePointUrl({
        siteUrl: 'https://contoso.sharepoint.com/:f:/r/teams/x/Shared%20Documents/y?d=abc123',
      })
    ).toBe('online-sharing-link');
  });

  test('classifies a 1drv.ms short link as online-sharing-link', () => {
    expect(classifySharePointUrl({ siteUrl: 'https://1drv.ms/f/s!abc123' })).toBe('online-sharing-link');
  });

  test('classifies the empirically-validated address-bar id= shape as online-sharing-link, not legacy', () => {
    // This exact shape (from the live spike this session) resolved
    // successfully via /shares under Files.Read.All alone — it must NOT be
    // flagged for relink.
    const siteUrl =
      'https://korentec-my.sharepoint.com/shared?id=%2Fsites%2FDocgen%2FShared%20Documents%2Fshared&listurl=https%3A%2F%2Fkorentec.sharepoint.com%2Fsites%2FDocgen%2FShared%20Documents';
    expect(classifySharePointUrl({ siteUrl })).toBe('online-sharing-link');
  });

  test('classifies an Online row with a populated library/folder split as online-legacy-site-path', () => {
    expect(
      classifySharePointUrl({
        siteUrl: 'https://contoso.sharepoint.com/sites/projectx',
        library: 'Shared Documents',
        folder: 'Templates/STD',
      })
    ).toBe('online-legacy-site-path');
  });

  test('classifies a bare Online site URL with no addressing at all as online-legacy-site-path', () => {
    expect(classifySharePointUrl({ siteUrl: 'https://contoso.sharepoint.com/sites/projectx' })).toBe('online-legacy-site-path');
  });

  test('classifies an unparsable URL as online-legacy-site-path (conservative default)', () => {
    expect(classifySharePointUrl({ siteUrl: 'not a url' })).toBe('online-legacy-site-path');
  });

  test('classifies a deep Online path with no id param as online-sharing-link (has content addressing)', () => {
    expect(
      classifySharePointUrl({
        siteUrl: 'https://contoso.sharepoint.com/sites/projectx/Shared%20Documents/Forms/AllItems.aspx',
      })
    ).toBe('online-sharing-link');
  });
});
