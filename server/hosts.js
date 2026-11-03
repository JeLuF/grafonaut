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

// A host setting is a host name ("render.example.com"), one per setting: alternate names are redirected outside
// Grafonaut. A port ("render.localhost:3000") only for development without the Compose stack, whose proxy routes the
// hosts by name (proxy/default.conf.template). The scheme is the request's.
export function parseHostSetting(value, name) {
  const setting = value?.trim();
  if (!setting) return null;
  let url;
  try { url = new URL(`http://${setting}`); } catch { url = null; }
  if (!url || url.host !== setting.toLowerCase() || url.username || url.password) {
    throw new Error(`Invalid ${name}: ${setting} (use one host name, e.g. grafonaut.example.com, without scheme or path)`);
  }
  return { host: url.host };
}

export const hostName = (setting) => setting?.host ?? null;
// Links to the instance's own hosts (renderer page, graphic frames, files, API URLs). In production these are always
// https (sign-in requires it), whatever the proxies report: a page on https must not load frames from http (mixed
// content). In development, the request's own scheme.
export const publicProtocol = (request) => (process.env.NODE_ENV === 'production' ? 'https' : request.protocol);
export const originFor = (request, setting) => `${publicProtocol(request)}://${setting?.host ?? request.host}`;

// Paths served to graphics; everything else under /render/ is the renderer page and its WebSocket.
export const isGraphicsPath = (pathname) => pathname === '/render/frame' || pathname.startsWith('/render/assets/') || pathname.startsWith('/render/media/');

export function createHosts({ appHost = null, rendererHost = null, graphicsHost = null }) {
  const app = hostName(appHost);
  const renderer = hostName(rendererHost);
  const graphics = hostName(graphicsHost);
  if (graphics && (graphics === renderer || graphics === app)) {
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
    app,
    hosts: [app, renderer, graphics].filter(Boolean),
    rendererOrigin: (request) => originFor(request, rendererHost),
    // Origin of graphic frames and their files (the graphics host, else the renderer host, else the request's host).
    graphicsOrigin: (request) => originFor(request, graphicsHost ?? rendererHost),
    routing: (request, response, next) => (refusal(request.host, request.path) ? response.sendStatus(404) : next()),
    // WebSocket upgrades (not seen by Express): the Host header as sent by the proxy.
    allowsUpgrade: (request) => !refusal(request.headers.host, new URL(request.url ?? '/', 'http://upgrade').pathname)
  };
}
