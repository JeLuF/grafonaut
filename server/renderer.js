import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { extractedRoot } from './thumbnails.js';

export const rendererRoute = '/render/:token';
export const framePath = '/render/frame';
export const assetRoute = '/render/assets/:versionId/*file';
const rendererScript = fs.readFileSync(new URL('./renderer-client/renderer.js', import.meta.url), 'utf8');
const frameScript = fs.readFileSync(new URL('./renderer-client/frame.js', import.meta.url), 'utf8');

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

// Graphic frames run in an opaque origin unless the renderer has its own host (RENDERER_HOST): only then may
// graphics share an origin with their package files (needed by graphics that script their own nested HTML pages).
export const graphicSandbox = (isolated) => isolated ? 'allow-scripts allow-same-origin' : 'allow-scripts';

const escapeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

export function rendererDocument(request, token, isolated) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const origin = `${request.protocol}://${request.host}`;
  const config = { socketPath: `/render/${encodeURIComponent(token)}/ws`, framePath, sandbox: graphicSandbox(isolated) };
  return {
    headers: { ...rendererHeaders, 'Content-Security-Policy': [
      "default-src 'none'", `script-src 'nonce-${nonce}'`, "style-src 'unsafe-inline'",
      `connect-src ${origin.replace(/^http/, 'ws')}`, `frame-src ${origin}`
    ].join('; ') },
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OGraf renderer</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
#stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent}
#status{position:absolute;inset:0;display:grid;place-items:center;margin:0;font:14px Arial,sans-serif;color:#87948a}
#status[hidden]{display:none}</style>
</head><body><div id="stage"></div><p id="status" hidden></p>
<script type="application/json" id="renderer-config">${escapeJson(config)}</script>
<script nonce="${nonce}">${rendererScript}</script></body></html>`
  };
}

export function frameDocument(isolated) {
  return {
    headers: { 'Content-Security-Policy': `sandbox ${graphicSandbox(isolated)}`, 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cache-Control': 'public, max-age=300' },
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OGraf graphic</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}</style>
</head><body><script>${frameScript}</script></body></html>`
  };
}

const assetTypes = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.apng': 'image/apng', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm'
};

// Serves the extracted package files of graphic versions to graphic frames. Documents (HTML/SVG) are sandboxed by CSP,
// so opening one directly never runs package code in the app's origin.
export function createAssetHandler({ findVersion, storageRoot, isolated, cacheMs = 60000 }) {
  const versions = new Map();
  async function lookup(versionId) {
    const cached = versions.get(versionId);
    if (cached && cached.expires > Date.now()) return cached.version;
    const version = await findVersion(versionId);
    versions.set(versionId, { version, expires: Date.now() + cacheMs });
    return version;
  }
  return async (request, response) => {
    try {
      const file = [].concat(request.params.file ?? []).join('/');
      const type = assetTypes[path.extname(file).toLowerCase()];
      if (!type || file.includes('\\') || file.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return response.sendStatus(404);
      const version = await lookup(request.params.versionId);
      const root = version && extractedRoot(version, storageRoot);
      if (!root) return response.sendStatus(404);
      const target = path.resolve(root, file);
      if (!target.startsWith(`${root}${path.sep}`)) return response.sendStatus(404);
      let realTarget;
      try {
        const [realRoot, resolved] = await Promise.all([fsp.realpath(root), fsp.realpath(target)]);
        if (!resolved.startsWith(`${realRoot}${path.sep}`) || !(await fsp.stat(resolved)).isFile()) return response.sendStatus(404);
        realTarget = resolved;
      } catch { return response.sendStatus(404); }
      response.sendFile(realTarget, { headers: {
        'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `sandbox ${graphicSandbox(isolated)}`,
        'Referrer-Policy': 'no-referrer', 'Cache-Control': 'public, max-age=300'
      } }, (error) => { if (error && !response.headersSent) response.sendStatus(error.statusCode ?? 500); });
    } catch { if (!response.headersSent) response.sendStatus(503); }
  };
}

export const rendererPage = (message) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OGraf renderer</title>
<style>html,body{margin:0;height:100%;background:transparent}body{display:grid;place-items:center;font:14px Arial,sans-serif;color:#87948a}</style>
</head><body><p>${message}</p></body></html>`;
