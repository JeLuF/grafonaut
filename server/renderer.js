export const rendererRoute = '/render/:token';

// RENDERER_HOST accepts a host ("render.example.com", "render.example.com:8443") or an origin
// ("https://render.example.com"). Empty means: the same host as the request.
export function parseRendererHost(value) {
  const setting = value?.trim();
  if (!setting) return null;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(setting);
  let url;
  try { url = new URL(hasScheme ? setting : `http://${setting}`); }
  catch { throw new Error(`Invalid RENDERER_HOST: ${setting}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    url.pathname !== '/' || (!hasScheme && url.host !== setting.toLowerCase())) {
    throw new Error(`Invalid RENDERER_HOST: ${setting} (use a host name or an http(s) origin without a path)`);
  }
  return hasScheme ? { origin: url.origin } : { host: url.host };
}

export function rendererUrl(request, config, token) {
  const origin = config?.origin ?? `${request.protocol}://${config?.host ?? request.host}`;
  return `${origin}/render/${encodeURIComponent(token)}/`;
}

// Renderer pages carry the account token in their URL: never send it on as a referrer or keep it in caches.
export const rendererHeaders = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};

export const rendererPage = (message) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OGraf renderer</title>
<style>html,body{margin:0;height:100%;background:transparent}body{display:grid;place-items:center;font:14px Arial,sans-serif;color:#87948a}</style>
</head><body><p>${message}</p></body></html>`;
