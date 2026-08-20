import { SharePointConfig } from '../../models/SharePointConfig';

describe('SharePointConfig schema', () => {
  // Regression: Mongoose's built-in `required` validator on a String path
  // rejects an explicit empty string as "missing" (a `default` only ever
  // fills in `undefined`, never ''). library/folder previously had
  // `required: true` — which meant saving an Online config (whole location
  // in siteUrl, library/folder legitimately '') would fail validation with
  // a 500 the very first time a user completed the Connect & Sync flow,
  // even after the controller's own 400 checks were fixed. This is real
  // Mongoose validator behavior, not something the controller's mocked
  // tests can exercise, so it's verified directly against the schema here.
  test('validates with library and folder both empty (Online config)', () => {
    const doc = new SharePointConfig({
      siteUrl: 'https://tenant.sharepoint.com/:f:/r/teams/x/Shared Documents/DocGen Templates',
      library: '',
      folder: '',
    });

    const error = doc.validateSync();

    expect(error).toBeUndefined();
  });

  test('validates with library empty but folder set (on-prem paste-a-URL config)', () => {
    const doc = new SharePointConfig({
      siteUrl: 'http://sp-server/sites/project',
      library: '',
      folder: 'Shared Documents/Templates',
    });

    const error = doc.validateSync();

    expect(error).toBeUndefined();
  });

  test('still fails validation when siteUrl itself is missing', () => {
    const doc = new SharePointConfig({ library: '', folder: '' });

    const error = doc.validateSync();

    expect(error).toBeDefined();
    expect(error?.errors.siteUrl).toBeDefined();
  });
});
