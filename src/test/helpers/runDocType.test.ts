import { resolveDocType } from '../../helpers/runDocType';

function req(overrides: any = {}) {
  return { templateFile: '', docType: undefined, ...overrides } as any;
}

describe('resolveDocType', () => {
  test('prefers an explicit docType, normalized to uppercase', () => {
    expect(resolveDocType(req({ docType: 'svd' }))).toBe('SVD');
  });

  test('trims whitespace from an explicit docType', () => {
    expect(resolveDocType(req({ docType: '  Svd  ' }))).toBe('SVD');
  });

  test('derives from templateFile\'s second-to-last path segment when docType is absent', () => {
    expect(
      resolveDocType(req({ templateFile: 'http://host/templates/shared/SVD/Software Version Description.dotx' }))
    ).toBe('SVD');
  });

  test('decodes an encoded doc-type segment', () => {
    expect(resolveDocType(req({ templateFile: 'http://host/templates/proj/SRS%20DRAFT/file.dotx' }))).toBe(
      'SRS DRAFT'
    );
  });

  test('returns undefined for an empty templateFile and no explicit docType', () => {
    expect(resolveDocType(req({ templateFile: '' }))).toBeUndefined();
  });

  test('returns undefined for a malformed templateFile URL', () => {
    expect(resolveDocType(req({ templateFile: 'not a url' }))).toBeUndefined();
  });

  test('returns undefined when the path has fewer than two segments', () => {
    expect(resolveDocType(req({ templateFile: 'http://host/file.dotx' }))).toBeUndefined();
  });

  test('never throws on an undefined documentRequest field set', () => {
    expect(() => resolveDocType({} as any)).not.toThrow();
  });
});
