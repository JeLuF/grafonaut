import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { after, beforeEach, mock, test } from 'node:test';

let queries;
let rows;
let nextId;
let affectedRows;
let transactionEvents;
mock.module('mysql2/promise', { defaultExport: {
  createPool: () => {
    const query = async (sql, parameters) => {
      queries.push({ sql, parameters });
      // The account's current rundown is answered separately from the scripted rows.
      if (sql.startsWith('SELECT current_rundown_id')) return [[{ rundownId: 5 }]];
      return sql.startsWith('SELECT') ? [rows] : [{ insertId: nextId++, affectedRows }];
    };
    return { query, getConnection: async () => ({ query,
      beginTransaction: async () => transactionEvents.push('begin'),
      commit: async () => transactionEvents.push('commit'),
      rollback: async () => transactionEvents.push('rollback'),
      release: () => transactionEvents.push('release') }) };
  }
} });
mock.module('./storage.js', { namedExports: { storageRoot: '/unused' } });
const { manifestCustomActions, listRenderEntries, saveRenderInstance, findCatalogItem, findRenderableVersion, findVisibleVersion, listPrivateCatalog, saveUploadedVersions, addMyGraphic, deleteMyGraphic, findMyGraphic, listMyGraphics, updateMyGraphic } = await import('./db.js');
const { default: router } = await import('./my-graphics.js');
const app = express();
app.use(express.json());
app.use((request, _response, next) => {
  request.session = { accountId: request.headers['x-test-account'] };
  next();
});
app.use('/api/my-graphics', router);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}/api/my-graphics`;
after(() => new Promise((resolve) => server.close(resolve)));

function requestApi(method, route = '', body, accountId = 'account') {
  return fetch(`${baseUrl}${route}`, { method,
    headers: { 'Content-Type': 'application/json', ...(accountId ? { 'x-test-account': accountId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeEach(() => { queries = []; rows = []; nextId = 1; affectedRows = 1; transactionEvents = []; });

const defaultsSchema = { type: 'object', properties: {
  name: { type: 'string', default: 'Host' }, theme: { type: 'string', default: './themes/Default.css' },
  colors: { type: 'object', properties: { text: { type: 'string', default: '#fff' } } }, empty: { type: 'string' }
} };
test('adding the same immutable version creates independent entries with default properties', async () => {
  rows = [{ manifest: { schema: defaultsSchema } }];
  assert.equal(await addMyGraphic('account', 'version'), '1');
  assert.equal(await addMyGraphic('account', 'version'), '2');
  assert.deepEqual(queries[0].parameters, ['version', 'account']);
  assert.match(queries[1].sql, /^SELECT current_rundown_id/);
  const insert = queries[2];
  assert.match(insert.sql, /^INSERT INTO my_graphics_entries \(account_id, rundown_id,/);
  assert.deepEqual(insert.parameters, ['account', '5', JSON.stringify({ name: 'Host', theme: './themes/Default.css', colors: { text: '#fff' } }), 'version', 'account']);
  for (const { sql } of queries.filter((query) => !query.sql.startsWith('SELECT current_rundown_id'))) {
    assert.match(sql, /p.disabled = FALSE/);
    assert.match(sql, /pv.review_state = 'published' OR p.owner_account_id = \?/);
  }
});
test('graphics without a schema start with empty properties', async () => {
  rows = [{ manifest: { id: 'no-schema' } }];
  await addMyGraphic('account', 'version');
  assert.equal(queries[2].parameters[2], '{}');
});
test('adding an unavailable or inaccessible version fails', async () => {
  await assert.rejects(addMyGraphic('account', 'private-version'), /Available graphic version not found/);
  assert.equal(queries.length, 1);
  rows = [{ manifest: {} }];
  affectedRows = 0;
  await assert.rejects(addMyGraphic('account', 'private-version'), /Available graphic version not found/);
});
test('lists account-owned entries pinned to their selected version', async () => {
  rows = [{ entryId: '1', versionId: 'old-version', enabled: 0, packageDisabled: 0,
    schemaData: { name: 'Left' }, manifest: { schema: { type: 'object' } } }];
  const items = await listMyGraphics('account');
  assert.equal(items[0].enabled, false);
  assert.equal(items[0].versionId, 'old-version');
  assert.equal(items[0].thumbnailUrl, null);
  assert.deepEqual(items[0].schemaData, { name: 'Left' });
  assert.deepEqual(items[0].schema, { type: 'object' });
  assert.equal('manifest' in items[0], false);
  assert.match(queries[0].sql, /pv.id = g.package_version_id/);
  assert.match(queries[0].sql, /ORDER BY g.sort_position IS NULL, g.sort_position, g.created_at DESC, g.id DESC/);
  assert.match(queries[0].sql, /cur.current_rundown_id = g.rundown_id/);
  assert.deepEqual(queries[0].parameters, ['account']);
});
test('entry lookup is scoped to the current account', async () => {
  assert.equal(await findMyGraphic('account', '7'), null);
  assert.deepEqual(queries[0].parameters, ['account', '7']);
  assert.match(queries[0].sql, /g.account_id = \? AND g.id = \?/);
});
test('updates only one owned entry without changing its package version', async () => {
  await updateMyGraphic('account', '7', { label: 'Right', enabled: false, schemaData: { name: 'Host' }, versionId: 'new-version' });
  assert.deepEqual(queries[0].parameters, ['Right', false, '{"name":"Host"}', 'account', '7']);
  assert.match(queries[0].sql, /WHERE account_id = \? AND id = \?/);
  assert.doesNotMatch(queries[0].sql, /package_version_id/);
});

test('entry APIs require authentication', async () => {
  for (const [method, route, body] of [['GET', '', undefined], ['POST', '', {}], ['PUT', '/order', { entryIds: [] }], ['PATCH', '/1', { enabled: true }], ['GET', '/1/manifest', undefined], ['DELETE', '/1', undefined]]) {
    assert.equal((await requestApi(method, route, body, null)).status, 401);
  }
  assert.equal(queries.length, 0);
});
test('HTTP updates cannot mutate an entry missing from the current account', async () => {
  assert.equal((await requestApi('PATCH', '/7', { label: 'Other account' })).status, 404);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].parameters, ['account', '7']);
});
test('HTTP updates validate fields and keep the version immutable', async () => {
  for (const body of [{ enabled: 'false' }, { label: 'x'.repeat(101) }, { versionId: 'other' }, {}, []]) {
    assert.equal((await requestApi('PATCH', '/7', body)).status, 400);
  }
  assert.equal((await requestApi('PATCH', '/invalid', { enabled: true })).status, 400);
  assert.equal(queries.length, 0);
});
test('properties are validated against the selected version schema including hidden fields', async () => {
  rows = [{ manifest: { schema: { type: 'object', required: ['name'], properties: {
    name: { type: 'string', minLength: 1 }, hiddenValue: { type: 'integer', hidden: true }
  } } } }];
  assert.equal((await requestApi('PATCH', '/7', { schemaData: { name: '' } })).status, 422);
  assert.equal((await requestApi('PATCH', '/7', { schemaData: { name: 'Host', hiddenValue: 'not a number' } })).status, 422);
  assert.equal((await requestApi('PATCH', '/7', { schemaData: { name: 'Host', hiddenValue: 2 } })).status, 200);
  assert.deepEqual(queries.at(-1).parameters, ['{"name":"Host","hiddenValue":2}', 'account', '7']);
});
test('file list properties only accept paths offered by the package', async () => {
  rows = [{ manifest: { schema: { type: 'object', properties: { theme: { type: 'string', default: './themes/Default.css',
    v_spx: { ftype: 'filelist', extension: 'css', assetfolder: './themes/' } } } } } }];
  assert.equal((await requestApi('PATCH', '/7', { schemaData: { theme: '../../../etc/passwd' } })).status, 422);
  assert.equal((await requestApi('PATCH', '/7', { schemaData: { theme: './themes/Default.css' } })).status, 200);
});
test('repeatable HTTP additions return the new entry ID', async () => {
  const versionId = '11111111-1111-4111-8111-111111111111';
  rows = [{ manifest: {} }];
  const first = await requestApi('POST', '', { versionId });
  const second = await requestApi('POST', '', { versionId });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal((await first.json()).entryId, '1');
  assert.equal((await second.json()).entryId, '2');
});

test('a disabled package cannot be enabled but its entry can be turned off', async () => {
  rows = [{ packageDisabled: true }];
  assert.equal((await requestApi('PATCH', '/7', { enabled: true })).status, 409);
  assert.equal((await requestApi('PATCH', '/7', { enabled: false })).status, 200);
  assert.deepEqual(queries.at(-1).parameters, [false, 'account', '7']);
});

test('deletion removes only one account-owned working-set entry', async () => {
  assert.equal(await deleteMyGraphic('account', '7'), true);
  assert.equal(queries[0].sql, 'DELETE FROM my_graphics_entries WHERE account_id = ? AND id = ?');
  assert.deepEqual(queries[0].parameters, ['account', '7']);
  assert.equal((await requestApi('DELETE', '/7')).status, 200);
  affectedRows = 0;
  assert.equal((await requestApi('DELETE', '/7')).status, 404);
  assert.equal((await requestApi('DELETE', '/invalid')).status, 400);
});

test('manifest lookup returns the selected version only to its entry owner', async () => {
  const manifest = { id: 'lower-third', version: '1.0.0', main: 'main.mjs', schema: { type: 'object' } };
  rows = [{ manifest }];
  const response = await requestApi('GET', '/7/manifest');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { manifest });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(queries[0].parameters, ['account', '7']);
  rows = [];
  assert.equal((await requestApi('GET', '/7/manifest', undefined, 'other-account')).status, 404);
  assert.deepEqual(queries.at(-1).parameters, ['other-account', '7']);
});

test('reordering saves all owned positions atomically', async () => {
  rows = [{ entryId: '1' }, { entryId: '2' }, { entryId: '3' }];
  assert.equal((await requestApi('PUT', '/order', { entryIds: ['3', '1', '2'] })).status, 200);
  assert.deepEqual(queries.at(-1).parameters, ['3', 0, '1', 1, '2', 2, 'account']);
  assert.match(queries.at(-1).sql, /WHERE account_id = \?/);
  assert.deepEqual(transactionEvents, ['begin', 'commit', 'release']);
  assert.ok(queries.some(({ sql }) => /FOR UPDATE/.test(sql) && /cur.current_rundown_id = g.rundown_id/.test(sql)));
});

test('reordering rejects stale and foreign entries without changing positions', async () => {
  rows = [{ entryId: '1' }, { entryId: '2' }];
  for (const entryIds of [['1'], ['1', '99'], ['1', '2', '3']]) {
    assert.equal((await requestApi('PUT', '/order', { entryIds })).status, 409);
  }
  assert.equal(queries.some(({ sql }) => sql.startsWith('UPDATE')), false);
  assert.deepEqual(transactionEvents, ['begin', 'rollback', 'release', 'begin', 'rollback', 'release', 'begin', 'rollback', 'release']);
});

test('reordering validates entry IDs and rejects duplicates', async () => {
  for (const entryIds of [null, '1', ['1', '1'], [1], ['invalid'], ['0']]) {
    assert.equal((await requestApi('PUT', '/order', { entryIds })).status, 400);
  }
  assert.equal(queries.length, 0);
});
test('private versions are visible to their owner only; the renderer serves any enabled version', async () => {
  await findVisibleVersion('v1', 'account');
  assert.match(queries[0].sql, /\(pv.review_state = 'published' OR p.owner_account_id = \?\) AND p.disabled = FALSE/);
  assert.deepEqual(queries[0].parameters, ['v1', 'account']);
  await findVisibleVersion('v1');
  assert.match(queries[1].sql, /pv.review_state = 'published' AND p.disabled = FALSE/);
  assert.deepEqual(queries[1].parameters, ['v1']);
  await findCatalogItem('v1', 'account');
  assert.deepEqual(queries[2].parameters, ['v1', 'account']);
  await findRenderableVersion('v1');
  assert.doesNotMatch(queries[3].sql, /review_state/);
  assert.match(queries[3].sql, /p.disabled = FALSE/);
});

test('uploads are saved as private draft versions and become the package’s latest version', async () => {
  const version = { manifestId: 'l3rd', manifestName: 'Lower third', versionLabel: '1.0.0', archiveId: 'arch-1', description: null,
    manifest: { id: 'l3rd' }, manifestFile: 'l3rd.ograf.json', mainFile: 'graphic.mjs', checksum: 'abc', zipSize: 1, uncompressedSize: 2, fileCount: 3 };
  await saveUploadedVersions('account', [{ ...version, id: 'ver-1', packageId: 'pkg-1', isNewPackage: true },
    { ...version, id: 'ver-2', packageId: 'pkg-0', isNewPackage: false, manifestId: 'clock', manifestName: 'Clock' }]);
  assert.match(queries[0].sql, /^INSERT INTO packages \(id, owner_account_id, manifest_id, display_name\)/);
  assert.deepEqual(queries[0].parameters, ['pkg-1', 'account', 'l3rd', 'Lower third']);
  assert.match(queries[1].sql, /\(id, package_id, archive_id,/);
  assert.match(queries[1].sql, /'user_upload', \?, 'draft'\)/);
  assert.deepEqual(queries[1].parameters.slice(0, 3), ['ver-1', 'pkg-1', 'arch-1']);
  assert.match(queries[2].sql, /^UPDATE packages SET latest_version_id = \?/);
  assert.equal(queries.filter(({ sql }) => sql.startsWith('INSERT INTO packages')).length, 1);
  assert.deepEqual(queries[3].parameters.slice(0, 3), ['ver-2', 'pkg-0', 'arch-1']);
  assert.deepEqual(transactionEvents, ['begin', 'commit', 'release']);
});

test('the private catalog lists the latest version of each owned package', async () => {
  rows = [{ versionId: 'ver-2', display_name: 'Lower third', versionCount: 2, manifest: {} }];
  const [item] = await listPrivateCatalog('account');
  assert.deepEqual([item.versionId, item.versionCount, item.isPrivate, item.thumbnailUrl], ['ver-2', 2, true, null]);
  assert.match(queries[0].sql, /JOIN package_versions pv ON pv.id = p.latest_version_id/);
  assert.match(queries[0].sql, /WHERE p.owner_account_id = \? AND p.disabled = FALSE/);
});

test('render entries carry the manifest stepCount (default 1) without the manifest itself', async () => {
  rows = [{ entryId: '1', enabled: 1, packageDisabled: 0, manifest: { stepCount: 0 } }, { entryId: '2', enabled: 1, packageDisabled: 0, manifest: { id: 'x' } },
    { entryId: '3', enabled: 0, packageDisabled: 0, manifest: { stepCount: 'two' } }];
  const entries = await listRenderEntries('account');
  assert.deepEqual(entries.map((item) => item.stepCount), [0, 1, 1]);
  assert.equal('manifest' in entries[0], false);
  await saveRenderInstance('account', '1', { instanceId: 'gi-1', data: {}, playing: false, ended: true });
  assert.match(queries.at(-1).sql, /playing = VALUES\(playing\), ended = VALUES\(ended\)/);
  assert.deepEqual(queries.at(-1).parameters, ['gi-1', '{}', null, false, true, '1', 'account']);
});

test('custom actions are read from the manifest with names, descriptions and payload schemas', () => {
  assert.deepEqual(manifestCustomActions({ customActions: [
    { id: 'highlight', name: 'Highlight', schema: null },
    { id: 'setColor', description: 'Changes the color', schema: { type: 'object' } },
    { name: 'no id' }, null, { id: '  ' }, { id: 'list', schema: ['bad'] }
  ] }), [
    { id: 'highlight', name: 'Highlight', description: null, schema: null },
    { id: 'setColor', name: 'setColor', description: 'Changes the color', schema: { type: 'object' } },
    { id: 'list', name: 'list', description: null, schema: null }
  ]);
  assert.deepEqual(manifestCustomActions({}), []);
});
