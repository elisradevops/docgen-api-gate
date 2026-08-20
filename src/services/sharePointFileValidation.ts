/**
 * Shared "is this actually a usable template file" checks for both the
 * on-prem (SharePointService) and Online/Graph (GraphSharePointService)
 * listing paths — kept in one place so the two don't drift.
 */

// Nothing today bounded how large a "template" sync would attempt to pull
// down; a mispointed folder (or a large attachment sitting in it) would be
// downloaded in full with no limit. 50MB matches the proven default used by
// a sibling project's Graph-ingestion implementation for the same problem.
export const MAX_TEMPLATE_FILE_SIZE_BYTES = 50 * 1024 * 1024;

// .docx/.dotx (Office Open XML) files are ZIP archives — Open Packaging
// Conventions packages, per ECMA-376 / ISO-IEC 29500-2. A file that doesn't
// start with the ZIP local-file-header signature cannot be a valid Office
// document regardless of its extension or claimed mimetype.
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // 'PK\x03\x04'

/**
 * True if a file name looks like an actual Word template we should sync —
 * i.e. a .docx/.dotx that isn't one of Office's own `~$...` lock/temp files.
 * (Word creates these while a document is open; they end in the same
 * extension as the real file, so a naive extension-only filter picks them
 * up as "templates".)
 */
export function isTemplateFileName(name: string): boolean {
  if (!name || name.startsWith('~$')) return false;
  const lower = name.toLowerCase();
  return lower.endsWith('.docx') || lower.endsWith('.dotx');
}

/** True if `size` (bytes) is within the sync's size ceiling. */
export function isWithinMaxTemplateSize(size: number): boolean {
  return typeof size === 'number' && size > 0 && size <= MAX_TEMPLATE_FILE_SIZE_BYTES;
}

/** True if the first 4 bytes of `buffer` are the ZIP local-file-header signature. */
export function hasZipSignature(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(ZIP_SIGNATURE);
}
