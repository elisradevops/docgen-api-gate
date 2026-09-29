import { DocumentRequest } from '../models/DocumentRequest';

const MAX_LENGTH = 40;

// Prefers the frontend's explicit docType. Falls back to templateFile's doc-type path
// segment for callers that don't set it (the external SVD pipeline template) — templateFile
// is a URL of the form /templates/{project|shared}/{DOCTYPE}/{file}.dotx, a convention
// enforced on both the upload path and the doc-type-prefixed template listing, unlike a
// filename-basename guess. Returns undefined rather than throwing for template-less requests
// (Test-Reporter/Excel flows) or an unparseable URL.
export function resolveDocType(documentRequest: DocumentRequest): string | undefined {
  const explicit = normalize(documentRequest?.docType);
  if (explicit) return explicit;
  return normalize(docTypeFromTemplateUrl(documentRequest?.templateFile));
}

function docTypeFromTemplateUrl(templateFile?: string): string | undefined {
  if (!templateFile) return undefined;
  try {
    const path = new URL(templateFile).pathname;
    const segments = path.split('/').filter(Boolean);
    // .../templates/{scope}/{DOCTYPE}/{file} — the doc type is the second-to-last segment.
    if (segments.length < 2) return undefined;
    return decodeURIComponent(segments[segments.length - 2]);
  } catch (err) {
    return undefined;
  }
}

function normalize(value?: string): string | undefined {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  return trimmed.toUpperCase().slice(0, MAX_LENGTH);
}
