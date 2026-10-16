import crypto from 'node:crypto';
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import * as db from './db.js';
import { configuredProviders, providers } from './auth.js';
import { sameOriginWrites } from './request-guards.js';
import { generateToken, hashToken, tokenPattern } from './tokens.js';

// OAuth 2.1 authorization server for the MCP interface (MCP.md). The SDK's router implements the endpoints
// (/authorize, /token, /register, /revoke and the metadata documents, with PKCE and rate limits); this module stores
// clients and grants, shows the consent page and issues opaque tokens bound to the MCP endpoint's URL.
//
// Grafonaut is its own authorization server: the user signs in with Twitch or Google as usual, and the MCP client gets
// a Grafonaut token. Tokens of the sign-in providers never reach MCP clients.
export const scopes = {
  'rundowns:read': 'Read your rundowns, the public catalog, your private catalog and your media library',
  'rundowns:write': 'Prepare rundowns: create and rename rundowns, add, change, reorder and remove entries and group actions'
};
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 1000;
const MAX_REDIRECT_URIS = 10;
// Schemes a redirect URI may not use. Besides https and loopback http, native clients use private-use schemes
// (RFC 8252 7.1, e.g. cursor://).
const refusedSchemes = new Set(['http:', 'file:', 'about:', 'blob:', 'filesystem:', 'ftp:', 'ws:', 'wss:', 'mailto:', 'tel:',
  'javascript:', 'data:', 'vbscript:']);
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

// MCP_BASE_URL: the public origin of the main host, e.g. https://grafonaut.example.com. Without it the MCP interface is off.
export function parseMcpBaseUrl(value) {
  const setting = value?.trim();
  if (!setting) return null;
  let url;
  try { url = new URL(setting); } catch { throw new Error(`Invalid MCP_BASE_URL: ${setting}`); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error(`Invalid MCP_BASE_URL: ${setting} (use an https origin without a path; http only for localhost)`);
  }
  return url;
}

export function checkRedirectUri(value) {
  if (typeof value !== 'string' || value.length > 2000) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return Boolean(url.hostname);
  if (url.protocol === 'http:') return loopbackHosts.has(url.hostname);
  return /^[a-z][a-z\d+.-]*:$/.test(url.protocol) && !refusedSchemes.has(url.protocol);
}

// What the consent page shows as the place the browser returns to: the host for web URLs, else the scheme.
export function redirectTarget(uri) {
  const url = new URL(uri);
  return ['https:', 'http:'].includes(url.protocol) ? url.host : `${url.protocol}//`;
}

// Scopes for a request: the known ones it asks for, all of them when it asks for none. Writing implies reading.
export function grantedScopes(requested = []) {
  const known = requested.filter((scope) => Object.hasOwn(scopes, scope));
  const result = new Set(known.length ? known : Object.keys(scopes));
  result.add('rundowns:read');
  return Object.keys(scopes).filter((scope) => result.has(scope));
}

const clientName = (client) => {
  const name = typeof client?.client_name === 'string' ? client.client_name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return name ? [...name].slice(0, 100).join('') : 'Unnamed app';
};
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const sameValue = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function page(response, status, title, body) {
  response.status(status).type('html').set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" })
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Grafonaut</title><style>
body{font:16px/1.5 system-ui,sans-serif;background:#070b1e;color:#eef1ff;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{max-width:520px;width:100%;background:#0f1530;border:1px solid #26305a;border-radius:12px;padding:24px 28px}
h1{font-size:22px;margin:0 0 12px}a{color:#4cc9ff}.muted{color:#a8b0d6;font-size:14px}.warn{background:#2a2140;border-radius:8px;padding:10px 12px;font-size:14px}
ul{padding-left:20px}label{display:flex;gap:8px;align-items:flex-start;margin:8px 0}code{background:#1b2347;padding:1px 5px;border-radius:4px}
.actions{display:flex;gap:12px;justify-content:flex-end;margin-top:20px;flex-wrap:wrap}
button,.button{font:inherit;border-radius:8px;padding:8px 18px;border:1px solid #3a4680;background:#1b2347;color:#eef1ff;cursor:pointer;text-decoration:none}
button.primary,.button.primary{background:#4cc9ff;border-color:#4cc9ff;color:#070b1e;font-weight:600}
</style></head><body><main>${body}</main></body></html>`);
}

export function createMcpOAuth({ store = db, baseUrl, mcpUrl, env = process.env, now = () => Date.now() }) {
  const pending = new Map();
  const codes = new Map();
  // Codes already exchanged, until they would have expired: presenting one again revokes the grant it created (RFC 9700 4.4).
  const usedCodes = new Map();
  const resource = mcpUrl.href;

  function prune() {
    const time = now();
    for (const [id, request] of pending) if (time - request.created > PENDING_TTL_MS) pending.delete(id);
    for (const map of [codes, usedCodes]) for (const [hash, code] of map) if (time - code.created > CODE_TTL_MS) map.delete(hash);
  }
  const checkResource = (value) => {
    if (value && value.href.replace(/#.*$/, '') !== resource) throw new InvalidTargetError(`This server only issues tokens for ${resource}`);
  };
  const tokenPair = () => {
    const accessToken = generateToken();
    const refreshToken = generateToken();
    return { accessToken, refreshToken, stored: { accessHash: hashToken(accessToken), accessTtl: ACCESS_TTL_SECONDS,
      refreshHash: hashToken(refreshToken), refreshTtl: REFRESH_TTL_SECONDS } };
  };
  const tokenResponse = (pair, scope) => ({ access_token: pair.accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS,
    refresh_token: pair.refreshToken, scope });

  const clientsStore = {
    getClient: (clientId) => store.findOAuthClient(clientId).then((client) => client ?? undefined),
    async registerClient(client) {
      const uris = client.redirect_uris ?? [];
      if (!uris.length || uris.length > MAX_REDIRECT_URIS || !uris.every(checkRedirectUri)) {
        throw new InvalidClientMetadataError('redirect_uris must list 1 to 10 https URLs, loopback http URLs or private-use scheme URLs, without fragments');
      }
      const method = client.token_endpoint_auth_method ?? 'client_secret_basic';
      if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
        throw new InvalidClientMetadataError('token_endpoint_auth_method must be none, client_secret_post or client_secret_basic');
      }
      // Only what Grafonaut uses is kept; logos, URIs and contacts are never shown, so they are not stored.
      const saved = { client_id: crypto.randomUUID(), client_id_issued_at: client.client_id_issued_at ?? Math.floor(now() / 1000),
        redirect_uris: uris, client_name: clientName(client), token_endpoint_auth_method: method,
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        ...(method === 'none' ? {} : { client_secret: client.client_secret ?? generateToken(), client_secret_expires_at: 0 }),
        ...(typeof client.software_id === 'string' ? { software_id: client.software_id.slice(0, 200) } : {}),
        ...(typeof client.software_version === 'string' ? { software_version: client.software_version.slice(0, 50) } : {}) };
      await store.insertOAuthClient(saved);
      return saved;
    }
  };

  const provider = {
    clientsStore,
    // Called by the SDK after it checked client_id, redirect_uri, response_type and the PKCE challenge (S256).
    async authorize(client, params, response) {
      checkResource(params.resource);
      prune();
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
      const id = generateToken();
      pending.set(id, { clientId: client.client_id, clientName: clientName(client), redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge, state: params.state, scopes: grantedScopes(params.scopes), csrf: generateToken(), created: now() });
      response.redirect(302, `/oauth/consent?request=${id}`);
    },
    async challengeForAuthorizationCode(client, code) {
      prune();
      const hash = hashToken(String(code));
      const used = usedCodes.get(hash);
      if (used) {
        usedCodes.delete(hash);
        await store.deleteMcpGrant(used.accountId, used.grantId);
        throw new InvalidGrantError('This authorization code was already used');
      }
      const entry = codes.get(hash);
      if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
      return entry.codeChallenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
      const hash = hashToken(String(code));
      const entry = codes.get(hash);
      codes.delete(hash);
      if (!entry || entry.clientId !== client.client_id || now() - entry.created > CODE_TTL_MS) throw new InvalidGrantError('Invalid or expired authorization code');
      if (redirectUri !== undefined && redirectUri !== entry.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
      checkResource(requestedResource);
      const pair = tokenPair();
      const scope = entry.scopes.join(' ');
      const grantId = await store.createMcpGrant(entry.accountId, { clientId: client.client_id, scope, resource, tokens: pair.stored });
      usedCodes.set(hash, { accountId: entry.accountId, grantId, created: entry.created });
      return tokenResponse(pair, scope);
    },
    async exchangeRefreshToken(client, refreshToken, _scopes, requestedResource) {
      checkResource(requestedResource);
      if (!tokenPattern.test(String(refreshToken))) throw new InvalidGrantError('Invalid refresh token');
      const pair = tokenPair();
      const grant = await store.rotateMcpGrant(client.client_id, hashToken(refreshToken), pair.stored);
      if (!grant) throw new InvalidGrantError('Invalid or expired refresh token');
      return tokenResponse(pair, grant.scope);
    },
    async verifyAccessToken(token) {
      const grant = tokenPattern.test(String(token)) ? await store.findMcpGrantByAccessToken(hashToken(token)) : null;
      if (!grant || grant.resource !== resource) throw new InvalidTokenError('Invalid or expired access token');
      return { token, clientId: grant.clientId, scopes: grant.scope.split(' '), resource: new URL(grant.resource),
        expiresAt: Math.floor(now() / 1000) + Number(grant.accessExpiresIn),
        extra: { accountId: grant.accountId, grantId: grant.id, clientName: clientName(grant.clientMetadata) } };
    },
    async revokeToken(client, { token }) {
      if (tokenPattern.test(String(token))) await store.revokeMcpGrantByToken(client.client_id, hashToken(token));
    }
  };

  const router = express.Router();
  // RFC 6749 2.3.1: confidential clients may authenticate with HTTP Basic; the SDK reads the credentials from the body.
  const basicClientAuth = (request, _response, next) => {
    const [type, value] = String(request.get('authorization') ?? '').split(' ');
    if (type?.toLowerCase() === 'basic' && value && request.body && typeof request.body === 'object' && !request.body.client_id) {
      const [id, secret] = Buffer.from(value, 'base64').toString('utf8').split(':');
      try { Object.assign(request.body, { client_id: decodeURIComponent(id ?? ''), client_secret: decodeURIComponent(secret ?? '') }); }
      catch { /* malformed credentials: the SDK answers invalid_client */ }
    }
    next();
  };
  router.use(['/token', '/revoke'], express.urlencoded({ extended: false }), basicClientAuth);
  router.use(mcpAuthRouter({ provider, issuerUrl: baseUrl, resourceServerUrl: mcpUrl, scopesSupported: Object.keys(scopes),
    resourceName: 'Grafonaut', clientRegistrationOptions: { clientSecretExpirySeconds: 0 } }));

  const findPending = (id) => {
    prune();
    return typeof id === 'string' ? pending.get(id) ?? null : null;
  };
  const expired = (response) => page(response, 400, 'Link expired', `<h1>This link has expired</h1>
<p>The connection request is no longer valid. Start connecting again from your app.</p>`);
  function redirectBack(response, request, params) {
    const target = new URL(request.redirectUri);
    for (const [key, value] of Object.entries({ ...params, state: request.state, iss: baseUrl.href })) {
      if (value !== undefined) target.searchParams.set(key, value);
    }
    response.redirect(302, target.href);
  }

  router.get('/oauth/consent', async (request, response) => {
    const authorization = findPending(request.query.request);
    if (!authorization) return expired(response);
    const account = request.session?.accountId ? await store.findAccountById(request.session.accountId).catch(() => null) : null;
    if (!account) {
      const returnTo = `/oauth/consent?request=${request.query.request}`;
      const available = Object.entries(configuredProviders(env)).filter(([, configured]) => configured);
      return page(response, 200, 'Sign in', `<h1>Sign in to Grafonaut</h1>
<p><strong>${escapeHtml(authorization.clientName)}</strong> asks to connect to your Grafonaut account. Sign in first.</p>
<div class="actions">${available.length ? available.map(([name]) => `<a class="button primary" href="/api/auth/${name}?returnTo=${encodeURIComponent(returnTo)}">Sign in with ${escapeHtml(providers[name].label)}</a>`).join('')
  : '<p class="muted">No sign-in provider is configured on this server.</p>'}</div>`);
    }
    const write = authorization.scopes.includes('rundowns:write');
    page(response, 200, 'Connect an app', `<h1>Connect an app to Grafonaut</h1>
<p>An app that calls itself <strong>${escapeHtml(authorization.clientName)}</strong> asks for access to your account
<strong>${escapeHtml(account.display_name)}</strong> (${escapeHtml(providers[account.provider]?.label ?? account.provider)}).</p>
<p class="warn">Grafonaut cannot check the app's name. Only allow access if you started this connection yourself.
After you decide, your browser returns to <code>${escapeHtml(redirectTarget(authorization.redirectUri))}</code>.</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="request" value="${escapeHtml(request.query.request)}"><input type="hidden" name="csrf" value="${escapeHtml(authorization.csrf)}">
<p>The app may:</p>
<label><input type="checkbox" checked disabled> <span>${escapeHtml(scopes['rundowns:read'])}</span></label>
${write ? `<label><input type="checkbox" name="write" value="1" checked> <span>${escapeHtml(scopes['rundowns:write'])}</span></label>` : ''}
<p class="muted">It cannot control graphics on air, delete rundowns, upload packages or media, or see your renderer and API URLs.
You can disconnect it at any time on the AI assistants page.</p>
<div class="actions"><button type="submit" name="decision" value="deny">Deny</button>
<button class="primary" type="submit" name="decision" value="allow">Allow access</button></div></form>`);
  });

  router.post('/oauth/consent', express.urlencoded({ extended: false, limit: '4kb' }), sameOriginWrites, (request, response) => {
    const id = request.body?.request;
    const authorization = findPending(id);
    if (!authorization || !sameValue(request.body?.csrf, authorization.csrf)) return expired(response);
    const accountId = request.session?.accountId;
    if (!accountId) return expired(response);
    pending.delete(id);
    if (request.body.decision !== 'allow') {
      return redirectBack(response, authorization, { error: 'access_denied', error_description: 'The user denied access' });
    }
    const granted = authorization.scopes.filter((scope) => scope !== 'rundowns:write' || request.body.write === '1');
    const code = generateToken();
    codes.set(hashToken(code), { clientId: authorization.clientId, accountId: String(accountId), scopes: granted,
      redirectUri: authorization.redirectUri, codeChallenge: authorization.codeChallenge, created: now() });
    redirectBack(response, authorization, { code });
  });

  return { router, verifier: provider, provider };
}

// App API for the AI assistants page: the MCP URL, the connected apps (grants) and recent MCP activity.
export function createMcpSettings({ store = db, mcpUrl }) {
  const router = express.Router();
  router.use((request, response, next) => {
    if (!request.session?.accountId) return response.status(401).json({ error: 'Sign-in required' });
    next();
  });
  router.get('/', async (request, response) => {
    if (!mcpUrl) return response.json({ enabled: false });
    try {
      const [grants, activity] = await Promise.all([store.listMcpGrants(request.session.accountId), store.listMcpActivity(request.session.accountId)]);
      response.set('Cache-Control', 'private, no-store').json({ enabled: true, url: mcpUrl.href, activity,
        apps: grants.map((grant) => ({ id: grant.id, name: clientName(grant.clientMetadata), scopes: grant.scope.split(' '),
          createdAt: grant.createdAt, lastUsedAt: grant.lastUsedAt })) });
    } catch { response.status(503).json({ error: 'Connected apps unavailable' }); }
  });
  router.delete('/apps/:grantId', async (request, response) => {
    if (!/^[1-9]\d{0,19}$/.test(request.params.grantId)) return response.status(404).json({ error: 'App not found' });
    try {
      if (!await store.deleteMcpGrant(request.session.accountId, request.params.grantId)) return response.status(404).json({ error: 'App not found' });
      response.json({ ok: true });
    } catch { response.status(503).json({ error: 'Unable to disconnect the app' }); }
  });
  return router;
}
