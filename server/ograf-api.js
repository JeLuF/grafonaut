import fs from 'node:fs';
import express from 'express';
import { findAccountByToken } from './db.js';

// OGraf Server API (https://ograf.ebu.io), scoped to one account by the API token in the path:
// /<api-token>/ograf/v1/... The token is the only credential, so no cookies are involved and any origin may call it.
export const apiMountPath = '/:token/ograf/v1';
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export function apiUrl(request, token) {
  return `${request.protocol}://${request.host}/${encodeURIComponent(token)}/ograf/v1/`;
}

// RFC 7807 problem details, as used by the OGraf Server API's ErrorResponse. The instance omits the token prefix.
function problem(request, response, status, title, detail) {
  response.status(status).json({ title, status, detail, instance: request.path });
}

const router = express.Router({ mergeParams: true });
router.use((request, response, next) => {
  response.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex'
  });
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  next();
});
router.use(async (request, response, next) => {
  try {
    const account = await findAccountByToken(request.params.token, 'api');
    if (!account) return problem(request, response, 401, 'Unauthorized', 'Unknown or replaced API token.');
    request.apiAccount = account;
    next();
  } catch { problem(request, response, 500, 'Internal Server Error', 'The API is temporarily unavailable.'); }
});
router.get('/', (request, response) => {
  response.json({
    name: 'OGraf Platform',
    description: `OGraf Server API for ${request.apiAccount.twitch_display_name ?? request.apiAccount.twitch_login}`,
    version
  });
});
router.use((request, response) => problem(request, response, 501, 'Not Implemented', 'This endpoint is not available yet.'));

export default router;
