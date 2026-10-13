import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { deleteRenderInstances, findAccountById, findAccountByToken, findAccountGraphic, findAccountToken, findCatalogItem, findRenderableVersion, findVisibleVersion,
  initializeDatabase, listPublishedCatalog, listRenderEntries, listRenderInstances, rotateAccountToken, saveRenderInstance, upsertTwitchAccount } from './db.js';
import { importSeedDirectory } from './seed-import.js';
import { storageRoot } from './storage.js';
import { findThumbnail, findThumbnails } from './thumbnails.js';
import myGraphicsRouter from './my-graphics.js';
import rundownsRouter from './rundowns.js';
import { createPrivateCatalog } from './private-catalog.js';
import { configureSession } from './session.js';
import { assetRoute, createAssetHandler, frameDocument, framePath, parseRendererHost, rendererDocument, rendererHeaders, rendererPage, rendererRoute, rendererUrl } from './renderer.js';
import { createRenderHub } from './render-hub.js';
import { tokenKey } from './tokens.js';
import { apiMountPath, apiUrl, createOgrafApi } from './ograf-api.js';
import { createApiDocs } from './api-docs.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const publicDirectory = path.resolve('dist');
const rendererHost = parseRendererHost(process.env.RENDERER_HOST);
// Graphics may only share an origin with their package files when the renderer runs on its own host.
const rendererIsolated = rendererHost !== null;
tokenKey();
const renderStore = { listRenderEntries, listRenderInstances, saveRenderInstance, deleteRenderInstances, findAccountGraphic };
const renderHub = createRenderHub(renderStore);
app.locals.onEntriesChanged = (accountId) => renderHub.syncEntries(accountId)
  .catch((error) => console.error('Renderer sync failed:', error.message));
// Mounted before the app's JSON parser so the API answers malformed bodies with its own problem details.
app.use(apiMountPath, createOgrafApi({ hub: renderHub, store: renderStore, findAccountByToken }));
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
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'"
  } }, (error) => {
    if (error && !response.headersSent) response.sendStatus(error.statusCode ?? 500);
  });
}
app.get('/api/catalog/:versionId', async (request, response) => {
  try {
    const item = await findCatalogItem(request.params.versionId, request.session?.accountId ?? null);
    if (!item) return response.status(404).json({ error: 'Graphic not found' });
    response.json({ item });
  } catch (error) { response.status(503).json({ error: 'Catalog unavailable', detail: error.message }); }
});
app.get('/api/catalog/:versionId/manifest', async (request, response) => {
  try {
    const version = await findVisibleVersion(request.params.versionId, request.session?.accountId ?? null);
    if (!version) return response.status(404).json({ error: 'Graphic not found' });
    response.json({ manifest: version.manifest });
  } catch { response.status(503).json({ error: 'Unable to load graphic manifest' }); }
});
app.get('/api/catalog/:versionId/thumbnail', async (request, response) => {
  try {
    const version = await findVisibleVersion(request.params.versionId, request.session?.accountId ?? null);
    sendThumbnail(response, version ? await findThumbnail(version, storageRoot) : null);
  } catch { response.sendStatus(503); }
});
app.get('/api/catalog/:versionId/thumbnails/:index', async (request, response) => {
  try {
    if (!/^\d{1,4}$/.test(request.params.index)) return response.sendStatus(404);
    const index = Number(request.params.index);
    const version = await findVisibleVersion(request.params.versionId, request.session?.accountId ?? null);
    const thumbnails = version ? await findThumbnails(version, storageRoot) : [];
    sendThumbnail(response, thumbnails.find((thumbnail) => thumbnail.index === index)?.file);
  } catch { response.sendStatus(503); }
});
app.use('/api/my-graphics', myGraphicsRouter);
app.use('/api/rundowns', rundownsRouter);
app.use('/api/private', createPrivateCatalog());
app.use('/api-docs', createApiDocs({ apiUrlFor: async (request) => request.session?.accountId
  ? apiUrl(request, await findAccountToken(request.session.accountId, 'api')) : undefined }));
// Account token URLs: GET shows the current one, POST replaces the token (the old URL stops working).
const tokenUrls = { renderer: (request, token) => rendererUrl(request, rendererHost, token), api: apiUrl };
app.get('/api/tokens/:kind', async (request, response) => {
  if (!request.session?.accountId) return response.status(401).json({ error: 'Sign-in required' });
  if (!Object.hasOwn(tokenUrls, request.params.kind)) return response.status(404).json({ error: 'Unknown token' });
  try {
    const token = await findAccountToken(request.session.accountId, request.params.kind);
    response.set('Cache-Control', 'private, no-store').json({ url: tokenUrls[request.params.kind](request, token),
      ...(request.params.kind === 'renderer' ? { isolated: rendererIsolated } : {}) });
  } catch (error) {
    if (error.code === 'TOKEN_UNREADABLE') return response.status(409).json({ error: error.message });
    response.status(503).json({ error: 'URL unavailable' });
  }
});
app.post('/api/tokens/:kind', async (request, response) => {
  if (!request.session?.accountId) return response.status(401).json({ error: 'Sign-in required' });
  if (!Object.hasOwn(tokenUrls, request.params.kind)) return response.status(404).json({ error: 'Unknown token' });
  try {
    const token = await rotateAccountToken(request.session.accountId, request.params.kind);
    if (request.params.kind === 'renderer') renderHub.disconnect(request.session.accountId);
    response.set('Cache-Control', 'private, no-store').json({ url: tokenUrls[request.params.kind](request, token),
      ...(request.params.kind === 'renderer' ? { isolated: rendererIsolated } : {}) });
  } catch { response.status(503).json({ error: 'Unable to create a new token' }); }
});
// Renderer: the page connects to /render/<token>/ws (see render-hub.js) and hosts each graphic in a frame page.
const frame = frameDocument(rendererIsolated);
app.get(framePath, (_request, response) => response.set(frame.headers).type('html').send(frame.html));
app.get(assetRoute, createAssetHandler({ findVersion: findRenderableVersion, storageRoot, isolated: rendererIsolated }));
app.get(rendererRoute, async (request, response) => {
  try {
    if (!await findAccountByToken(request.params.token, 'renderer')) {
      return response.status(404).set(rendererHeaders).type('html').send(rendererPage('Unknown renderer URL.'));
    }
    const page = rendererDocument(request, request.params.token, rendererIsolated);
    response.set(page.headers).type('html').send(page.html);
  } catch { response.status(503).set(rendererHeaders).type('html').send(rendererPage('Renderer unavailable.')); }
});
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
const server = app.listen(port, () => console.log(`OGraf MVP listening on http://localhost:${port}`));
renderHub.attachServer(server, findAccountByToken);
