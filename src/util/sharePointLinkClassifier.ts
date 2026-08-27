// Classifies a saved SharePointConfig.siteUrl for the relink-migration UX.
//
// Deliberately optimistic, not the source of truth: Graph's /shares
// endpoint, under a Files.Read.All-only token, resolves both a "Copy Link"
// sharing URL and a plain browsed-folder address-bar URL, so this trusts
// almost any Online-host URL by default. `requiresRelink` is only ever
// authoritatively set by an actual failed /shares resolution at use-time
// (see SharePointController), never by this static heuristic alone.
export type SharePointLinkClassification = 'onprem' | 'online-sharing-link' | 'online-legacy-site-path';

// GraphSharePointService's Copy-Link URL shape, e.g.
// https://tenant.sharepoint.com/:f:/r/...
const SHARING_LINK_MARKERS = ['/:f:/', '/:w:/', '/:b:/', '/:u:/', '/:x:/', '/:p:/'];

function isOnedriveShortLink(hostname: string): boolean {
  return hostname.toLowerCase().includes('1drv.ms');
}

function isSharePointOnlineHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower.endsWith('.sharepoint.com') || lower.endsWith('.sharepoint.us') || lower === 'sharepoint.com';
}

export interface ClassifyInput {
  siteUrl: string;
  library?: string;
  folder?: string;
}

export function classifySharePointUrl({ siteUrl, library, folder }: ClassifyInput): SharePointLinkClassification {
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    // Unparsable — can't possibly resolve via /shares either. Conservative
    // by necessity here, not by assumption.
    return 'online-legacy-site-path';
  }

  if (isOnedriveShortLink(parsed.hostname)) return 'online-sharing-link';
  if (!isSharePointOnlineHost(parsed.hostname)) return 'onprem';

  const hasSharingMarker = SHARING_LINK_MARKERS.some((marker) => parsed.pathname.includes(marker));
  if (hasSharingMarker) return 'online-sharing-link';

  // SharePointConnectDialog's Online mode only ever has a single shareLink
  // field — a populated library/folder on an Online row can only come from
  // an old save shape and can't be resolved from a single pasted URL alone.
  const hasSeparateLibraryFolder = !!(library && library.trim()) || !!(folder && folder.trim());
  if (hasSeparateLibraryFolder) return 'online-legacy-site-path';

  // A bare site/library URL with no id= param, no sharing token, and no
  // library/folder split has nothing for /shares to redeem.
  const idParam = parsed.searchParams.get('id');
  const hasContentAddressing = (!!idParam && idParam.startsWith('/')) || parsed.pathname.split('/').filter(Boolean).length > 2;
  if (!hasContentAddressing) return 'online-legacy-site-path';

  // Anything else on an Online host, including the address-bar
  // `?id=%2Fsites%2F...` shape, is trusted optimistically — /shares
  // resolves it.
  return 'online-sharing-link';
}
