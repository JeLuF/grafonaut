// Hotlink protection for files served to graphics (package assets, media): only requests whose Referer host is one
// of this instance's hosts are served. Renderer pages send their origin as referrer (Referrer-Policy: strict-origin),
// never the path with the token.
//   strict  the Referer header is required (default with an own renderer host, RENDERER_HOST)
//   lenient requests without Referer are allowed, foreign referers are blocked (default without an own renderer host:
//           graphic frames then run in an opaque origin, and browsers send no Referer for their images and nested pages)
//   off     no check
export const refererModes = ['strict', 'lenient', 'off'];

// "a.example.com, https://b.example.com:8443" -> ['a.example.com', 'b.example.com:8443']
export function parseHosts(value) {
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    try { return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(item) ? item : `https://${item}`).host.toLowerCase(); }
    catch { throw new Error(`Invalid host name: ${item}`); }
  });
}

export function refererMode(value) {
  const mode = String(value ?? '').trim().toLowerCase() || 'strict';
  if (!refererModes.includes(mode)) throw new Error(`ASSET_REFERER_CHECK must be one of ${refererModes.join(', ')}`);
  return mode;
}

// The request's own host is always allowed: renderer pages and graphic frames load files from their own host.
export function createRefererCheck({ hosts = [], mode = 'strict' }) {
  const allowed = new Set(hosts.map((host) => host.toLowerCase()));
  return (request, response, next) => {
    if (mode === 'off') return next();
    const referer = request.get('referer');
    if (!referer) return mode === 'lenient' ? next() : response.sendStatus(403);
    let host;
    try { host = new URL(referer).host.toLowerCase(); } catch { return response.sendStatus(403); }
    if (host === String(request.host ?? '').toLowerCase() || allowed.has(host)) return next();
    response.sendStatus(403);
  };
}
