// Host-allowlist validators guarding every outbound URL Graph itself
// supplied (rather than one we constructed) — `@odata.nextLink` pagination
// and `@microsoft.graph.downloadUrl`. A response body is not a trusted
// input; following either blindly is an SSRF gap.
const GRAPH_HOSTNAME = 'graph.microsoft.com';
const DOWNLOAD_HOST_SUFFIXES = ['sharepoint.com', 'sharepointonline.com', 'sharepoint.us', 'onedrive.com', 'onedrive.live.com'];

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '::1' ||
    /^127\./.test(lower) ||
    /^10\./.test(lower) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(lower) ||
    /^192\.168\./.test(lower) ||
    /^169\.254\./.test(lower) // link-local, incl. cloud metadata endpoints
  );
}

// A URL like `https://graph.microsoft.com@evil.com/` parses with
// `hostname === 'evil.com'` and `username === 'graph.microsoft.com'` under
// WHATWG URL semantics — checking `.hostname` alone (never `.href` or a
// substring/regex match on the raw string) already defeats this userinfo-
// smuggling shape. Callers must always go through these asserts rather
// than hand-rolling a check on the raw string.
function parseOrThrow(url: string, label: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`Refusing to follow a malformed ${label}: ${url}`);
  }
}

// Gates every `@odata.nextLink` before it is fetched. Exact-hostname match
// only — no suffix matching — since this is specifically the Graph API
// endpoint, not a wildcard Microsoft domain.
export function assertGraphApiUrl(url: string): void {
  const parsed = parseOrThrow(url, 'Graph URL');
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing to follow a non-https Graph URL: ${url}`);
  }
  if (parsed.hostname.toLowerCase() !== GRAPH_HOSTNAME) {
    throw new Error(`Refusing to follow a Graph URL pointing outside ${GRAPH_HOSTNAME}: ${url}`);
  }
}

// Gates a `@microsoft.graph.downloadUrl` before it is fetched. These are
// pre-signed URLs pointing at SharePoint/OneDrive's own content hosts (not
// graph.microsoft.com), so the allowlist is a suffix match across the known
// content-host families rather than an exact match.
export function assertDownloadUrl(url: string): void {
  const parsed = parseOrThrow(url, 'download URL');
  if (parsed.protocol !== 'https:') {
    throw new Error('Refusing to fetch a non-https download URL');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(hostname)) {
    throw new Error('Refusing to fetch a download URL pointing at a private/internal host');
  }
  const isAllowedHost =
    hostname === GRAPH_HOSTNAME || DOWNLOAD_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  if (!isAllowedHost) {
    throw new Error(`Refusing to fetch a download URL from an unrecognized host: ${hostname}`);
  }
}
