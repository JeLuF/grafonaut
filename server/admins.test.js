import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { after, beforeEach, test } from 'node:test';
import { adminMatcher, createAdmin, normalizeTags, parseAdminUsers } from './admins.js';

test('ADMIN_USERS names accounts by provider and login or user ID', () => {
  assert.deepEqual(parseAdminUsers(' twitch:JeLuF , google:1122 '), [{ provider: 'twitch', key: 'JeLuF' }, { provider: 'google', key: '1122' }]);
  assert.deepEqual(parseAdminUsers(''), []);
  assert.throws(() => parseAdminUsers('jeluf'), /ADMIN_USERS/);
  assert.throws(() => parseAdminUsers('github:jeluf'), /ADMIN_USERS/);
  const isAdmin = adminMatcher('twitch:jeluf, google:1122');
  assert.equal(isAdmin({ provider: 'twitch', providerUserId: '99', login: 'JeLuF' }), true);
  assert.equal(isAdmin({ provider: 'twitch', providerUserId: '99', login: 'someone' }), false);
  assert.equal(isAdmin({ provider: 'google', providerUserId: '1122', login: null }), true);
  assert.equal(isAdmin({ provider: 'google', providerUserId: '3344', login: null }), false);
  // A Twitch login does not make the Google account with that name an admin.
  assert.equal(isAdmin({ provider: 'google', providerUserId: 'x', login: 'jeluf' }), false);
  assert.equal(adminMatcher(undefined)({ provider: 'twitch', providerUserId: '1', login: 'a' }), false);
});

test('tags are trimmed, de-duplicated case-insensitively and limited', () => {
  assert.deepEqual(normalizeTags(['  Lower   third ', 'lower third', 'Sports']), ['Lower third', 'Sports']);
  assert.deepEqual(normalizeTags([]), []);
  assert.equal(normalizeTags('lower third'), null);
  assert.equal(normalizeTags([' ']), null);
  assert.equal(normalizeTags(['x'.repeat(41)]), null);
  assert.equal(normalizeTags([1]), null);
  assert.equal(normalizeTags(Array.from({ length: 21 }, (_, index) => `tag ${index}`)), null);
});

let accounts;
let saved;
const store = {
  findAccountById: async (id) => accounts.find((account) => account.id === id) ?? null,
  listAccounts: async () => [{ id: '1', displayName: 'Admin', isAdmin: true }, { id: '2', displayName: 'User', isAdmin: false }],
  setCatalogTags: async (versionId, tags) => { saved.push([versionId, tags]); return versionId === 'published' ? [...tags].sort() : null; }
};
const app = express();
app.use(express.json());
app.use((request, _response, next) => { request.session = request.headers['x-account'] ? { accountId: request.headers['x-account'] } : null; next(); });
app.use('/api/admin', createAdmin({ store, build: { version: '0.7.0', commit: 'abc', committedAt: null, imageBuiltAt: null, modified: false, node: 'v26.12.1', startedAt: 'now' } }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api/admin`;
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { accounts = [{ id: '1', is_approver: 1 }, { id: '2', is_approver: 0 }]; saved = []; });
const call = async (method, path, account, body) => {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(account ? { 'x-account': account } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

test('only admins see the user list and set tags', async () => {
  assert.equal((await call('GET', '/users')).status, 401);
  assert.equal((await call('GET', '/users', '2')).status, 403);
  const list = await call('GET', '/users', '1');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.users.map((user) => user.displayName), ['Admin', 'User']);
  assert.equal((await call('PUT', '/catalog/published/tags', '2', { tags: ['x'] })).status, 403);
  assert.deepEqual(saved, []);
  // The role is read from the database for every request.
  accounts[0].is_approver = 0;
  assert.equal((await call('GET', '/users', '1')).status, 403);
});

test('admins replace the tags of a catalog animation', async () => {
  const done = await call('PUT', '/catalog/published/tags', '1', { tags: ['Sports', ' lower  third ', 'SPORTS'] });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.tags, ['Sports', 'lower third']);
  assert.deepEqual(saved, [['published', ['Sports', 'lower third']]]);
  assert.equal((await call('PUT', '/catalog/private/tags', '1', { tags: ['x'] })).status, 404);
  assert.equal((await call('PUT', '/catalog/published/tags', '1', { tags: 'x' })).status, 400);
});

test('only admins get the build information', async () => {
  assert.equal((await call('GET', '/build', '2')).status, 403);
  assert.deepEqual((await call('GET', '/build', '1')).body, { version: '0.7.0', commit: 'abc', committedAt: null, imageBuiltAt: null, modified: false, node: 'v26.12.1', startedAt: 'now' });
});

test('build information comes from the image (build arguments, build time file), else from git and package.json', async () => {
  const { buildInfo } = await import('./build-info.js');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-build-'));
  after(() => fs.rm(directory, { recursive: true, force: true }));
  const imageFile = path.join(directory, '.image-built-at');
  await fs.writeFile(imageFile, '2026-11-03T10:12:00Z\n');
  const fromImage = buildInfo({ GRAFONAUT_VERSION: '0.8.0', GRAFONAUT_COMMIT: 'f'.repeat(40), GRAFONAUT_COMMITTED_AT: '2026-11-02T21:38:13+01:00' },
    { imageFile, readGit: () => { throw new Error('no git'); } });
  assert.deepEqual([fromImage.version, fromImage.commit, fromImage.committedAt, fromImage.imageBuiltAt, fromImage.modified],
    ['0.8.0', 'f'.repeat(40), '2026-11-02T21:38:13+01:00', '2026-11-03T10:12:00Z', false]);
  // A local image build without build arguments still knows when it was built.
  const localImage = buildInfo({}, { imageFile, readGit: () => null });
  assert.deepEqual([localImage.commit, localImage.committedAt, localImage.imageBuiltAt], [null, null, '2026-11-03T10:12:00Z']);
  const answers = { 'rev-parse HEAD': 'a'.repeat(40), 'log -1 --format=%cI': '2026-11-02T21:38:13+01:00', 'status --porcelain --untracked-files=no': ' M x.js' };
  const fromGit = buildInfo({}, { imageFile: path.join(directory, 'missing'), readGit: (args) => answers[args.join(' ')] ?? null });
  assert.deepEqual([fromGit.commit, fromGit.committedAt, fromGit.imageBuiltAt, fromGit.modified], ['a'.repeat(40), '2026-11-02T21:38:13+01:00', null, true]);
  assert.match(fromGit.version, /^\d+\.\d+\.\d+/);
});
