// CSRF protection for the session-authenticated API. SameSite=Lax cookies are still sent with requests from sibling
// subdomains (e.g. graphics on render.example.com posting to grafonaut.example.com), so changing requests must come
// from the app's own origin: Sec-Fetch-Site "same-origin", or an Origin header naming the requested host. Requests
// without either header do not come from a browser (and a CSRF attack needs one) and pass.
const readOnly = new Set(['GET', 'HEAD', 'OPTIONS']);

export function sameOriginWrites(request, response, next) {
  if (readOnly.has(request.method)) return next();
  const site = request.get('sec-fetch-site');
  if (site === 'same-origin') return next();
  const origin = request.get('origin');
  if (!origin && !site) return next();
  let host = null;
  try { host = origin && origin !== 'null' ? new URL(origin).host.toLowerCase() : null; } catch { /* refused below */ }
  if (host && host === String(request.host ?? '').toLowerCase()) return next();
  response.status(403).json({ error: 'Cross-site request refused' });
}
