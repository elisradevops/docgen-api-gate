import { buildCallbackPage } from '../../util/authCallbackPage';

describe('buildCallbackPage', () => {
  test('embeds the exact validated target origin, not a wildcard', () => {
    const { html } = buildCallbackPage({
      targetOrigin: 'https://docgen.example.com',
      payload: { type: 'docgen:sp-auth', ok: true, handleCode: 'abc123' },
    });
    expect(html).toContain('"https://docgen.example.com"');
    expect(html).not.toMatch(/postMessage\([^)]*['"]\*['"]\)/);
  });

  test('never embeds the word "token" or "accessToken" in the page (no token in the postMessage payload)', () => {
    const { html } = buildCallbackPage({
      targetOrigin: 'https://docgen.example.com',
      payload: { type: 'docgen:sp-auth', ok: true, handleCode: 'one-time-handle' },
    });
    expect(html.toLowerCase()).not.toContain('accesstoken');
    expect(html.toLowerCase()).not.toContain('refreshtoken');
  });

  test('carries the discriminator type and ok flag through to the payload', () => {
    const { html } = buildCallbackPage({
      targetOrigin: 'https://docgen.example.com',
      payload: { type: 'docgen:sp-auth', ok: false, error: 'access_denied' },
    });
    expect(html).toContain('docgen:sp-auth');
    expect(html).toContain('access_denied');
  });

  test('sets a restrictive CSP with a nonce and X-Frame-Options: DENY', () => {
    const { headers } = buildCallbackPage({
      targetOrigin: 'https://docgen.example.com',
      payload: { type: 'docgen:sp-auth', ok: true },
    });
    expect(headers['Content-Security-Policy']).toMatch(/default-src 'none'/);
    expect(headers['Content-Security-Policy']).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  test('produces a different nonce on each call', () => {
    const first = buildCallbackPage({ targetOrigin: 'https://a.example.com', payload: { type: 'docgen:sp-auth', ok: true } });
    const second = buildCallbackPage({ targetOrigin: 'https://a.example.com', payload: { type: 'docgen:sp-auth', ok: true } });
    expect(first.headers['Content-Security-Policy']).not.toBe(second.headers['Content-Security-Policy']);
  });

  test('escapes a "</script>" sequence in an error string so it cannot break out of the inline script', () => {
    const { html } = buildCallbackPage({
      targetOrigin: 'https://docgen.example.com',
      payload: { type: 'docgen:sp-auth', ok: false, error: '</script><script>alert(1)</script>' },
    });
    expect(html).not.toContain('</script><script>alert(1)</script>');
  });
});
