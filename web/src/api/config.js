// The deployment's settings (web/config.js): which server this client belongs to, if any.

/** The server address fixed by the deployment, or '' when the sign-in page asks for one. */
export function configuredServer() {
  const c = globalThis.SONUS_CONFIG ?? {};
  const s = String(c.server ?? '').trim();
  if (!s) return '';
  if (s === 'same-origin') return `${location.origin}${String(c.base ?? '').replace(/\/+$/, '')}`;
  return s.replace(/\/+$/, '');
}
