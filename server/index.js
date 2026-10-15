import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { deleteRenderInstances, listGroupActions, findAccountById, findAccountByToken, findAccountGraphic, findAccountToken, findCatalogItem, findRenderableVersion, findVisibleVersion,
  initializeDatabase, listPublishedCatalog, listRenderEntries, listRenderInstances, rotateAccountToken, saveRenderInstance, upsertAccount } from './db.js';
import { importSeedDirectory } from './seed-import.js';
import { storageRoot } from './storage.js';
import { findThumbnail, findThumbnails } from './thumbnails.js';
import myGraphicsRouter from './my-graphics.js';
import rundownsRouter from './rundowns.js';
import { createPrivateCatalog } from './private-catalog.js';
import { createGroupActions } from './group-actions.js';
import { createAuth } from './auth.js';
import { createMedia, createMediaFileHandler, mediaFileRoute } from './media.js';
import { createRefererCheck, parseHosts, refererMode } from './referer.js';
import { configureSession } from './session.js';
import { sameOriginWrites } from './request-guards.js';
import { createHosts, parseHostSetting } from './hosts.js';
import { assetRoute, createAssetHandler, frameDocument, framePath, parseRendererHost, rendererDocument, rendererHeaders, rendererPage, rendererRoute, rendererUrl } from './renderer.js';
import { createRenderHub } from './render-hub.js';
import { tokenKey } from './tokens.js';
import { apiMountPath, apiUrl, createOgrafApi } from './ograf-api.js';
import { createApiDocs } from './api-docs.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const publicDirectory = path.resolve('dist');
const rendererHost = parseRendererHost(process.env.RENDERER_HOST);
// Main, renderer and graphics hosts and what each serves (see hosts.js). APP_HOST may list several, comma separated.
const hosts = createHosts({ appHosts: parseHosts(process.env.APP_HOST), rendererHost,
  graphicsHost: parseHostSetting(process.env.GRAPHICS_HOST, 'GRAPHICS_HOST') });
// Strict (Referer required) with a graphics host. Without one, graphic frames run in an opaque origin and the
// browser sends no Referer for their images and nested pages, so missing referers are allowed (foreign ones are not).
const assetRefererCheck = createRefererCheck({ hosts: hosts.hosts,
  mode: refererMode(process.env.ASSET_REFERER_CHECK || (hosts.isolated ? 'strict' : 'lenient')) });
// Media files may also be fetched without a Referer (direct downloads, players that strip it); foreign referers are refused.
const mediaRefererCheck = createRefererCheck({ hosts: hosts.hosts,
  mode: refererMode(process.env.ASSET_REFERER_CHECK) === 'off' ? 'off' : 'lenient' });
tokenKey();
const renderStore = { listRenderEntries, listRenderInstances, saveRenderInstance, deleteRenderInstances, findAccountGraphic, listGroupActions };
const renderHub = createRenderHub(renderStore);
app.locals.onEntriesChanged = (accountId) => renderHub.syncEntries(accountId)
  .catch((error) => console.error('Renderer sync failed:', error.message));
app.use(hosts.routing);
// Mounted before the app's JSON parser so the API answers malformed bodies with its own problem details.
app.use(apiMountPath, createOgrafApi({ hub: renderHub, store: renderStore, findAccountByToken }));
app.use(express.json());
configureSession(app);
app.use('/api', sameOriginWrites);

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
app.use('/api/group-actions', createGroupActions());
app.use('/api/media', createMedia({ storageRoot, fileOrigin: hosts.graphicsOrigin }));
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
      ...(request.params.kind === 'renderer' ? { isolated: hosts.isolated } : {}) });
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
      ...(request.params.kind === 'renderer' ? { isolated: hosts.isolated } : {}) });
  } catch { response.status(503).json({ error: 'Unable to create a new token' }); }
});
// Renderer: the page connects to /render/<token>/ws (see render-hub.js) and hosts each graphic in a frame page.
const frame = frameDocument(hosts.isolated);
app.get(framePath, (_request, response) => response.set(frame.headers).type('html').send(frame.html));
app.get(assetRoute, assetRefererCheck, createAssetHandler({ findVersion: findRenderableVersion, storageRoot, isolated: hosts.isolated }));
app.get(mediaFileRoute, mediaRefererCheck, createMediaFileHandler({ storageRoot, isolated: hosts.isolated }));
app.get(rendererRoute, async (request, response) => {
  try {
    if (!await findAccountByToken(request.params.token, 'renderer')) {
      return response.status(404).set(rendererHeaders).type('html').send(rendererPage('Unknown renderer URL.'));
    }
    const page = rendererDocument(request, request.params.token, { isolated: hosts.isolated, graphicsOrigin: hosts.graphicsOrigin(request) });
    response.set(page.headers).type('html').send(page.html);
  } catch { response.status(503).set(rendererHeaders).type('html').send(rendererPage('Renderer unavailable.')); }
});
app.get('/api/auth/me', async (request, response) => {
  const account = request.session?.accountId ? await findAccountById(request.session.accountId) : null;
  response.json({ account });
});
app.use('/api/auth', createAuth({ upsertAccount }));

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
const server = app.listen(port, () => console.log(`Grafonaut listening on http://localhost:${port}`));
renderHub.attachServer(server, findAccountByToken, { allowsUpgrade: hosts.allowsUpgrade });
