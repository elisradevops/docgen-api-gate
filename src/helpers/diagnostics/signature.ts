// Normalizes a log message into a stable fingerprint so `Could not fetch query results: …`
// collapses into one group across thousands of occurrences, instead of one distinct
// signature per interpolated id — what makes "top errors" (Phase 6b's Issue collection,
// Phase 7's dashboard) meaningful rather than a wall of near-duplicates. Computed once here,
// server-side at ingest, rather than in each of the four loggers/transports, so tuning the
// rules never requires republishing docgen-data-provider-package or docgen-dg-skins-package.
const MAX_SIGNATURE_LEN = 300;

const GUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const URL_PATTERN = /https?:\/\/\S+/gi;
const HEX_PATTERN = /\b[0-9a-f]{16,}\b/gi;
const QUOTED_PATTERN = /"[^"]*"|'[^']*'/g;
const NUMBER_PATTERN = /\d+/g;

export function computeSignature(message: string): string {
  let s = (message || '').toLowerCase().trim().replace(/\s+/g, ' ');
  s = s.replace(GUID_PATTERN, '<guid>');
  s = s.replace(URL_PATTERN, '<url>');
  s = s.replace(HEX_PATTERN, '<hex>');
  s = s.replace(QUOTED_PATTERN, '<str>');
  s = s.replace(NUMBER_PATTERN, '<n>');
  return s.length > MAX_SIGNATURE_LEN ? s.slice(0, MAX_SIGNATURE_LEN) : s;
}
