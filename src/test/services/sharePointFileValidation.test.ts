import {
  isTemplateFileName,
  isWithinMaxTemplateSize,
  hasZipSignature,
  MAX_TEMPLATE_FILE_SIZE_BYTES,
} from '../../services/sharePointFileValidation';

describe('isTemplateFileName', () => {
  test('accepts .docx and .dotx files', () => {
    expect(isTemplateFileName('SVD-template.docx')).toBe(true);
    expect(isTemplateFileName('STD-template.dotx')).toBe(true);
  });

  test('is case-insensitive on the extension', () => {
    expect(isTemplateFileName('Template.DOCX')).toBe(true);
  });

  test('rejects a real Word/Excel lock file even though it ends in .dotx', () => {
    // Matches the actual seed asset found in this repo:
    // s3-initializer/assets/templates/shared/SVD/~$ftware Version Description.dotx
    expect(isTemplateFileName('~$ftware Version Description.dotx')).toBe(false);
  });

  test('rejects non-template extensions', () => {
    expect(isTemplateFileName('notes.txt')).toBe(false);
    expect(isTemplateFileName('image.png')).toBe(false);
  });

  test('rejects empty/undefined names rather than throwing', () => {
    expect(isTemplateFileName('')).toBe(false);
    expect(isTemplateFileName(undefined as unknown as string)).toBe(false);
  });
});

describe('isWithinMaxTemplateSize', () => {
  test('accepts a normal-sized file', () => {
    expect(isWithinMaxTemplateSize(1024)).toBe(true);
  });

  test('accepts exactly the size ceiling', () => {
    expect(isWithinMaxTemplateSize(MAX_TEMPLATE_FILE_SIZE_BYTES)).toBe(true);
  });

  test('rejects a file over the size ceiling', () => {
    expect(isWithinMaxTemplateSize(MAX_TEMPLATE_FILE_SIZE_BYTES + 1)).toBe(false);
  });

  test('rejects a zero-byte file', () => {
    expect(isWithinMaxTemplateSize(0)).toBe(false);
  });

  test('rejects a non-numeric size rather than throwing', () => {
    expect(isWithinMaxTemplateSize(NaN)).toBe(false);
    expect(isWithinMaxTemplateSize(undefined as unknown as number)).toBe(false);
  });
});

describe('hasZipSignature', () => {
  test('accepts a buffer starting with the ZIP local-file-header signature', () => {
    const buffer = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('rest of the file')]);
    expect(hasZipSignature(buffer)).toBe(true);
  });

  test('rejects a plain-text buffer', () => {
    expect(hasZipSignature(Buffer.from('not a real docx'))).toBe(false);
  });

  test('rejects a buffer shorter than 4 bytes rather than throwing', () => {
    expect(hasZipSignature(Buffer.from([0x50, 0x4b]))).toBe(false);
    expect(hasZipSignature(Buffer.alloc(0))).toBe(false);
  });
});
