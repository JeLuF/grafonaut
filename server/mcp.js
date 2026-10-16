import express from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as db from './db.js';
import { createMcpOAuth } from './mcp-oauth.js';
import { createMcpServer } from './mcp-tools.js';

// The MCP interface (MCP.md): a remote MCP server at <MCP_BASE_URL>/mcp (Streamable HTTP, stateless, JSON responses)
// with its OAuth authorization server. Everything is served on the MCP_BASE_URL host only; other hosts (renderer,
// graphics) answer these paths as before.
export const mcpPath = '/mcp';
const RATE_WINDOW_MS = 60 * 1000;

// MCP_ALLOWED_ORIGINS: origins of browser-based MCP clients allowed to call /mcp (CORS), comma separated.
export function parseAllowedOrigins(value) {
  return new Set(String(value ?? '').split(',').map((origin) => origin.trim()).filter(Boolean).map((origin) => {
    let url;
    try { url = new URL(origin); } catch { throw new Error(`Invalid MCP_ALLOWED_ORIGINS entry: ${origin}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin.replace(/\/$/, '')) throw new Error(`Invalid MCP_ALLOWED_ORIGINS entry: ${origin} (use origins like https://app.example.com)`);
    return url.origin;
  }));
}

// Counts requests per grant in fixed one-minute windows.
export function createRateLimiter({ limit = 120, now = () => Date.now() } = {}) {
  const windows = new Map();
  return (key) => {
    const time = now();
    if (windows.size > 10000) for (const [id, window] of windows) if (time - window.start >= RATE_WINDOW_MS) windows.delete(id);
    const window = windows.get(key);
    if (!window || time - window.start >= RATE_WINDOW_MS) { windows.set(key, { start: time, count: 1 }); return true; }
    window.count += 1;
    return window.count <= limit;
  };
}

// `mediaOrigin(request)`: the origin media files are served from (hosts.graphicsOrigin). `options.tools` is passed to
// createMcpServer (tests).
export function createMcp({ baseUrl, store = db, allowedOrigins = new Set(), mediaOrigin, onEntriesChanged, rateLimit = 120, tools, env }) {
  const mcpUrl = new URL(mcpPath, baseUrl);
  const host = baseUrl.host.toLowerCase();
  const oauth = createMcpOAuth({ store, baseUrl, mcpUrl, env });
  const allow = createRateLimiter({ limit: rateLimit });
  const router = express.Router();
  const endpoint = express.Router();

  // DNS rebinding and cross-site calls: browsers send Origin, and only listed origins may call. Clients outside a
  // browser send none and authenticate with their token alone (cookies are never used here).
  endpoint.use(mcpPath, (request, response, next) => {
    const origin = request.get('origin');
    if (origin) {
      if (!allowedOrigins.has(origin)) return response.status(403).json({ error: 'Origin not allowed' });
      response.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
        'Access-Control-Allow-Methods': 'POST, OPTIONS' });
      if (request.method === 'OPTIONS') return response.sendStatus(204);
    }
    next();
  });
  endpoint.post(mcpPath, requireBearerAuth({ verifier: oauth.verifier, requiredScopes: ['rundowns:read'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) }), async (request, response) => {
    const { accountId, grantId, clientName } = request.auth.extra;
    if (!allow(grantId)) {
      return response.status(429).set('Retry-After', '60').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests, try again in a minute' }, id: null });
    }
    const server = createMcpServer({ accountId, scopes: request.auth.scopes, clientName, mediaOrigin: mediaOrigin(request), onEntriesChanged },
      { store, ...tools });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error('MCP request failed:', error.message);
      if (!response.headersSent) response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  // Stateless server: no server-initiated streams (GET) and no sessions to end (DELETE).
  endpoint.all(mcpPath, (_request, response) => response.status(405).set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));

  router.use((request, response, next) => {
    if (String(request.host ?? '').toLowerCase() !== host) return next();
    endpoint(request, response, (error) => (error ? next(error) : oauth.router(request, response, next)));
  });
  return { router, mcpUrl };
}
