// The host names of an instance and what each one serves.
//
//   main host (APP_HOST)          the app, its API and the OGraf Server API
//   renderer host (RENDERER_HOST) the renderer page /render/<token>/ and its WebSocket; optional, else the main host
//   graphics host (GRAPHICS_HOST) graphic frames, package files and media: /render/frame, /render/assets/…, /render/media/…
//
// Graphics are uploaded code. Only with a graphics host do they keep the origin of their package files (needed by
// graphics that script their own nested HTML pages, e.g. SPX templates); that origin is then shared with nothing
// else: not with the app (session, API), and not with the renderer page (its URL carries the renderer token).
// Without a graphics host, graphics run in an opaque origin (sandbox without allow-same-origin).

// A host setting is a host ("render.example.com", "render.example.com:8443") or an origin ("https://render.example.com").
export function parseHostSetting(value, name) {
  const setting = value?.trim();
  if (!setting) return null;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(setting);
  let url;
  try { url = new URL(hasScheme ? setting : `http://${setting}`); }
  catch { throw new Error(`Invalid ${name}: ${setting}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    url.pathname !== '/' || (!hasScheme && url.host !== setting.toLowerCase())) {
    throw new Error(`Invalid ${name}: ${setting} (use a host name or an http(s) origin without a path)`);
  }
  return hasScheme ? { origin: url.origin } : { host: url.host };
}

export const hostName = (setting) => setting ? (setting.host ?? new URL(setting.origin).host).toLowerCase() : null;
export const originFor = (request, setting) => setting?.origin ?? `${request.protocol}://${setting?.host ?? request.host}`;

// Paths served to graphics; everything else under /render/ is the renderer page and its WebSocket.
export const isGraphicsPath = (pathname) => pathname === '/render/frame' || pathname.startsWith('/render/assets/') || pathname.startsWith('/render/media/');

export function createHosts({ appHosts = [], rendererHost = null, graphicsHost = null }) {
  const renderer = hostName(rendererHost);
  const graphics = hostName(graphicsHost);
  if (graphics && (graphics === renderer || appHosts.includes(graphics))) {
    throw new Error('GRAPHICS_HOST must be a host name of its own, different from RENDERER_HOST and APP_HOST');
  }

  // Which host may answer a request: the graphics host only serves graphics paths, and graphics paths are only served
  // there; the renderer page only on the renderer host (if set). null = allowed, else the reason for a 404.
  function refusal(host, pathname) {
    const requestHost = String(host ?? '').toLowerCase();
    const graphicsPath = isGraphicsPath(pathname);
    if (graphics) {
      if (requestHost === graphics) return graphicsPath || pathname === '/health' ? null : 'graphics host';
      if (graphicsPath) return 'graphics files are served on GRAPHICS_HOST';
    }
    if (pathname.startsWith('/render/') && !graphicsPath && renderer && requestHost !== renderer) return 'renderer pages are served on RENDERER_HOST';
    return null;
  }

  return {
    // Graphics may share an origin with their package files only on their own host.
    isolated: graphics !== null,
    hosts: [...appHosts, ...(renderer ? [renderer] : []), ...(graphics ? [graphics] : [])],
    rendererOrigin: (request) => originFor(request, rendererHost),
    // Origin of graphic frames and their files (the graphics host, else the renderer host, else the request's host).
    graphicsOrigin: (request) => originFor(request, graphicsHost ?? rendererHost),
    routing: (request, response, next) => (refusal(request.host, request.path) ? response.sendStatus(404) : next()),
    // WebSocket upgrades (not seen by Express): the Host header as sent by the proxy.
    allowsUpgrade: (request) => !refusal(request.headers.host, new URL(request.url ?? '/', 'http://upgrade').pathname)
  };
}
