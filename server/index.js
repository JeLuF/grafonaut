import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { findAccountById, findPublishedCatalogItem, findPublishedVersion, initializeDatabase, listPublishedCatalog, upsertTwitchAccount } from './db.js';
import { importSeedDirectory } from './seed-import.js';
import { storageRoot } from './storage.js';
import { findThumbnail, findThumbnails } from './thumbnails.js';
import myGraphicsRouter from './my-graphics.js';
import { configureSession } from './session.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const publicDirectory = path.resolve('dist');
app.use(express.json());
configureSession(app);

app.get('/health', (_request, response) => response.json({ ok: true }));
app.get('/api/catalog', async (_request, response) => {
  try { response.json({ items: await listPublishedCatalog() }); }
  catch (error) { response.status(503).json({ error: 'Catalog unavailable', detail: error.message }); }
});
function sendThumbnail(response, thumbnail) {
  if (!thumbnail) return response.sendStatus(404);
  response.sendFile(thumbnail, { headers: {
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'"
  } }, (error) => {
    if (error && !response.headersSent) response.sendStatus(error.statusCode ?? 500);
  });
}
app.get('/api/catalog/:versionId', async (request, response) => {
  try {
    const item = await findPublishedCatalogItem(request.params.versionId);
    if (!item) return response.status(404).json({ error: 'Graphic not found' });
    response.json({ item });
  } catch (error) { response.status(503).json({ error: 'Catalog unavailable', detail: error.message }); }
});
app.get('/api/catalog/:versionId/thumbnail', async (request, response) => {
  try {
    const version = await findPublishedVersion(request.params.versionId);
    sendThumbnail(response, version ? await findThumbnail(version, storageRoot) : null);
  } catch { response.sendStatus(503); }
});
app.get('/api/catalog/:versionId/thumbnails/:index', async (request, response) => {
  try {
    if (!/^\d{1,4}$/.test(request.params.index)) return response.sendStatus(404);
    const index = Number(request.params.index);
    const version = await findPublishedVersion(request.params.versionId);
    const thumbnails = version ? await findThumbnails(version, storageRoot) : [];
    sendThumbnail(response, thumbnails.find((thumbnail) => thumbnail.index === index)?.file);
  } catch { response.sendStatus(503); }
});
app.use('/api/my-graphics', myGraphicsRouter);
app.get('/api/auth/me', async (request, response) => {
  const account = request.session?.accountId ? await findAccountById(request.session.accountId) : null;
  response.json({ account });
});
app.get('/api/auth/twitch', (_request, response) => {
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_REDIRECT_URI) return response.status(503).send('Twitch OAuth is not configured. Set TWITCH_CLIENT_ID and TWITCH_REDIRECT_URI.');
  const params = new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID, redirect_uri: process.env.TWITCH_REDIRECT_URI, response_type: 'code', scope: 'user:read:email' });
  response.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});
app.get('/api/auth/twitch/callback', async (request, response) => {
  try {
    const tokenParams = new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID, client_secret: process.env.TWITCH_CLIENT_SECRET, code: request.query.code, grant_type: 'authorization_code', redirect_uri: process.env.TWITCH_REDIRECT_URI });
    const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: tokenParams });
    const token = await tokenResponse.json();
    const profileResponse = await fetch('https://api.twitch.tv/helix/users', { headers: { Authorization: `Bearer ${token.access_token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID } });
    const profile = (await profileResponse.json()).data?.[0];
    if (!profile) throw new Error('Twitch profile unavailable');
    const account = await upsertTwitchAccount(profile);
    request.session = { accountId: account.id };
    response.redirect('/');
  } catch (error) { response.status(502).send(`Twitch sign-in failed: ${error.message}`); }
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(publicDirectory));
  app.use((_request, response) => response.sendFile(path.join(publicDirectory, 'index.html')));
}

await initializeDatabase();
const seedDirectories = [
  [process.env.SEED_BUILTIN_DIR ?? './seeds/builtin', 'seed_builtin'],
  [process.env.SEED_VOLUME_DIR ?? './seeds/volume', 'seed_volume']
];
for (const [directory, source] of seedDirectories) {
  try { console.log(`Seed scan ${directory}: imported ${await importSeedDirectory(directory, source)} package(s)`); }
  catch (error) { console.error(`Seed scan failed for ${directory}:`, error.message); }
}
app.listen(port, () => console.log(`OGraf MVP listening on http://localhost:${port}`));
