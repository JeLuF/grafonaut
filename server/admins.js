import express from 'express';
import * as db from './db.js';

// ADMIN_USERS lists the accounts with the admin role (stored as accounts.is_approver), comma separated, each as
// provider:login or provider:user-id, e.g. "twitch:jeluf, google:112233445566778899". Twitch logins are matched
// case-insensitively; Google accounts have no login and are given by their user ID (the `sub` of the Google account).
export function parseAdminUsers(value) {
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    const match = /^(twitch|google):(.+)$/i.exec(item);
    if (!match) throw new Error(`Invalid ADMIN_USERS entry "${item}": use provider:login or provider:user-id, e.g. twitch:jeluf`);
    return { provider: match[1].toLowerCase(), key: match[2].trim() };
  });
}

export function adminMatcher(value) {
  const admins = parseAdminUsers(value);
  return ({ provider, providerUserId, login }) => admins.some((admin) => admin.provider === provider &&
    (admin.key === String(providerUserId ?? '') || (login && admin.key.toLowerCase() === String(login).toLowerCase())));
}

const isTagText = (value) => typeof value === 'string';
export const tagLimits = { length: 40, count: 20 };

// Tags as sent by an admin: trimmed, inner whitespace collapsed, case-insensitive duplicates removed (first spelling
// wins). Returns null when the input is not a list of 1 to 40 character texts, or has more than 20 tags.
export function normalizeTags(value) {
  if (!Array.isArray(value) || !value.every(isTagText)) return null;
  const tags = [];
  for (const raw of value) {
    const tag = raw.replace(/\s+/g, ' ').trim();
    if (!tag || [...tag].length > tagLimits.length || /[\u0000-\u001f]/.test(tag)) return null;
    if (!tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  return tags.length > tagLimits.count ? null : tags;
}

// Admin-only endpoints (/api/admin): the user list and the tags of catalog animations. The role is checked against the
// database on every request, so a role taken away by ADMIN_USERS ends at the next restart.
export function createAdmin({ store = db } = {}) {
  const router = express.Router();
  router.use(async (request, response, next) => {
    if (!request.session?.accountId) return response.status(401).json({ error: 'Sign-in required' });
    try {
      const account = await store.findAccountById(request.session.accountId);
      if (!account?.is_approver) return response.status(403).json({ error: 'Admins only' });
      next();
    } catch { response.status(503).json({ error: 'Account unavailable' }); }
  });
  router.get('/users', async (_request, response) => {
    try { response.set('Cache-Control', 'private, no-store').json({ users: await store.listAccounts() }); }
    catch (error) { console.error('Admin user list failed:', error?.message ?? error); response.status(503).json({ error: 'Users unavailable' }); }
  });
  router.put('/catalog/:versionId/tags', async (request, response) => {
    const tags = normalizeTags(request.body?.tags);
    if (!tags) return response.status(400).json({ error: `Send up to ${tagLimits.count} tags of 1 to ${tagLimits.length} characters` });
    try {
      const saved = await store.setCatalogTags(request.params.versionId, tags);
      if (!saved) return response.status(404).json({ error: 'Graphic not found in the public catalog' });
      response.json({ tags: saved });
    } catch (error) { console.error('Saving tags failed:', error?.message ?? error); response.status(503).json({ error: 'Tags could not be saved' }); }
  });
  return router;
}
