// Builds the tiny HTML page the OAuth popup lands on after /auth/callback
// finishes. Its only job is to postMessage the result back to the window
// that opened it, to a validated target origin, then close itself. A popup
// is required because Entra's login page refuses to be iframed; the target
// origin must never be caller-supplied.
//
// Kept as a pure string builder (no Express Response touched here) so the
// security-critical origin-pinning and payload shape are directly
// unit-testable without spinning up HTTP.
import { randomBytes } from 'crypto';

export interface AuthCallbackPagePayload {
  type: 'docgen:sp-auth';
  ok: boolean;
  handleCode?: string;
  error?: string;
  errorDescription?: string;
}

export interface BuildCallbackPageInput {
  targetOrigin: string;
  payload: AuthCallbackPagePayload;
}

export interface BuildCallbackPageResult {
  html: string;
  headers: Record<string, string>;
}

function escapeForInlineScript(value: string): string {
  // JSON.stringify already escapes quotes/backslashes/control chars; the
  // remaining risk is a literal "</script>" sequence breaking out of the
  // inline <script> block, so that's escaped separately.
  return JSON.stringify(value).replace(/</g, '\\u003C');
}

const SCRIPT_NONCE_BYTES = 16;

export function buildCallbackPage({ targetOrigin, payload }: BuildCallbackPageInput): BuildCallbackPageResult {
  const nonce = randomBytes(SCRIPT_NONCE_BYTES).toString('base64');

  // The payload never carries a Graph token, refresh token, or session
  // cookie value — only a boolean, an optional one-time handle code, and
  // optional error strings. This is deliberate: postMessage payloads are
  // observable by any script running in the popup's origin.
  const serializedPayload = escapeForInlineScript(JSON.stringify(payload));
  const serializedTargetOrigin = escapeForInlineScript(targetOrigin);

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Signing in…</title></head>
<body>
<script nonce="${nonce}">
  (function () {
    var targetOrigin = ${serializedTargetOrigin};
    var payload = JSON.parse(${serializedPayload});
    if (window.opener) {
      window.opener.postMessage(payload, targetOrigin);
    }
    window.close();
  })();
</script>
</body>
</html>`;

  return {
    html,
    headers: {
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'`,
      'X-Frame-Options': 'DENY',
      'Content-Type': 'text/html; charset=utf-8',
    },
  };
}
