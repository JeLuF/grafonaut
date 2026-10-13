import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { after, beforeEach, mock, test } from 'node:test';

// A tiny in-memory stand-in for the rundown-related SQL.
let db;
let queries;
let transactions;
function answer(sql, parameters) {
  queries.push({ sql, parameters });
  if (sql.startsWith('SELECT current_rundown_id')) {
    const row = db.accounts.get(String(parameters[0]));
    return [row ? [{ rundownId: row.current }] : []];
  }
  if (sql.startsWith('SELECT id FROM rundowns WHERE account_id = ? ORDER BY id')) return [db.rundowns.filter((r) => r.account === String(parameters[0])).slice(0, 1)];
  if (sql.startsWith('SELECT id FROM rundowns WHERE id = ? AND account_id = ?')) return [db.rundowns.filter((r) => r.id === String(parameters[0]) && r.account === String(parameters[1]))];
  if (sql.startsWith('INSERT INTO rundowns')) {
    if (db.rundowns.some((r) => r.account === String(parameters[0]) && r.name === parameters[1])) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
    const id = String(db.nextId++);
    db.rundowns.push({ id, account: String(parameters[0]), name: parameters[1] });
    return [{ insertId: Number(id), affectedRows: 1 }];
  }
  if (sql.startsWith('UPDATE accounts SET current_rundown_id')) { db.accounts.get(String(parameters[1])).current = Number(parameters[0]); return [{ affectedRows: 1 }]; }
  if (sql.startsWith('UPDATE rundowns SET name')) {
    if (db.rundowns.some((r) => r.account === String(parameters[2]) && r.name === parameters[0] && r.id !== String(parameters[1]))) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
    db.rundowns.find((r) => r.id === String(parameters[1])).name = parameters[0];
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('SELECT COUNT(*) AS onAir')) return [[{ onAir: db.onAir }]];
  if (sql.startsWith('DELETE FROM rundowns')) {
    const before = db.rundowns.length;
    db.rundowns = db.rundowns.filter((r) => !(r.id === String(parameters[0]) && r.account === String(parameters[1])));
    return [{ affectedRows: before - db.rundowns.length }];
  }
  if (sql.startsWith('DELETE FROM render_instances')) { db.onAir = 0; return [{ affectedRows: 1 }]; }
  if (sql.includes('FROM rundowns r LEFT JOIN')) {
    return [db.rundowns.filter((r) => r.account === String(parameters[0])).map((r) => ({ id: r.id, name: r.name, entryCount: r.id === '1' ? 2 : 0 }))];
  }
  throw new Error(`Unexpected query: ${sql}`);
}
mock.module('mysql2/promise', { defaultExport: {
  createPool: () => ({ query: async (sql, parameters) => answer(sql, parameters), getConnection: async () => ({
    query: async (sql, parameters) => answer(sql, parameters),
    beginTransaction: async () => transactions.push('begin'), commit: async () => transactions.push('commit'),
    rollback: async () => transactions.push('rollback'), release: () => {}
  }) })
} });
mock.module('./storage.js', { namedExports: { storageRoot: '/unused' } });
const { defaultRundownName, ensureCurrentRundown, listRundowns } = await import('./db.js');
const { default: router } = await import('./rundowns.js');

const changed = [];
const app = express();
app.use(express.json());
app.locals.onEntriesChanged = (accountId) => changed.push(accountId);
app.use((request, _response, next) => { request.session = request.headers['x-account'] ? { accountId: request.headers['x-account'] } : null; next(); });
app.use('/api/rundowns', router);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api/rundowns`;
after(() => new Promise((resolve) => server.close(resolve)));
const call = async (method, path = '', body, account = '7') => {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(account ? { 'x-account': account } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  db = { accounts: new Map([['7', { current: null }]]), rundowns: [], nextId: 1, onAir: 0 };
  queries = [];
  transactions = [];
  changed.length = 0;
});

test('new accounts get a default rundown that becomes current, exactly once', async () => {
  assert.equal(await ensureCurrentRundown('7'), '1');
  assert.deepEqual(db.rundowns, [{ id: '1', account: '7', name: defaultRundownName }]);
  assert.equal(db.accounts.get('7').current, 1);
  assert.deepEqual(transactions, ['begin', 'commit']);
  assert.ok(queries.some(({ sql }) => /FOR UPDATE/.test(sql)));
  transactions = [];
  assert.equal(await ensureCurrentRundown('7'), '1');
  assert.equal(db.rundowns.length, 1);
  assert.deepEqual(transactions, []);
});

test('the list reports all rundowns with their entry counts and the current one', async () => {
  const listed = await listRundowns('7');
  assert.deepEqual(listed, { currentRundownId: '1', rundowns: [{ id: '1', name: defaultRundownName, entryCount: 2 }] });
  assert.deepEqual((await call('GET')).body, listed);
  assert.equal((await call('GET', '', undefined, null)).status, 401);
});

test('creating and renaming check names and do not switch the current rundown', async () => {
  await ensureCurrentRundown('7');
  const created = await call('POST', '', { name: '  Sunday show  ' });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.rundown, { id: '2', name: 'Sunday show', entryCount: 0 });
  assert.equal(db.accounts.get('7').current, 1);
  assert.equal((await call('POST', '', { name: 'Sunday show' })).status, 409);
  assert.equal((await call('POST', '', { name: '   ' })).status, 400);
  assert.equal((await call('POST', '', { name: 'x'.repeat(101) })).status, 400);
  assert.equal((await call('PATCH', '/2', { name: 'Monday news' })).status, 200);
  assert.equal(db.rundowns[1].name, 'Monday news');
  assert.equal((await call('PATCH', '/2', { name: defaultRundownName })).status, 409);
  assert.equal((await call('PATCH', '/99', { name: 'Other' })).status, 404);
  assert.equal((await call('PATCH', '/2', { name: 'Other' }, '8')).status, 404);
  assert.equal((await call('PATCH', '/abc', { name: 'Other' })).status, 400);
});

test('switching asks for confirmation while graphics are on air and then takes them off air', async () => {
  await ensureCurrentRundown('7');
  await call('POST', '', { name: 'Sunday show' });
  db.onAir = 2;
  const refused = await call('PUT', '/current', { rundownId: '2' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'ON_AIR');
  assert.equal(refused.body.onAir, 2);
  assert.equal(db.accounts.get('7').current, 1);
  assert.deepEqual(changed, []);
  const forced = await call('PUT', '/current', { rundownId: '2', force: true });
  assert.deepEqual(forced, { status: 200, body: { currentRundownId: '2' } });
  assert.equal(db.accounts.get('7').current, 2);
  assert.equal(db.onAir, 0);
  assert.deepEqual(changed, ['7']);
});

test('switching to the current rundown changes nothing; foreign or unknown rundowns are refused', async () => {
  await ensureCurrentRundown('7');
  db.onAir = 1;
  assert.equal((await call('PUT', '/current', { rundownId: '1' })).status, 200);
  assert.equal(db.onAir, 1);
  assert.deepEqual(changed, []);
  db.accounts.set('8', { current: null });
  assert.equal((await call('PUT', '/current', { rundownId: '1' }, '8')).status, 404);
  assert.equal((await call('PUT', '/current', { rundownId: 'x' })).status, 400);
});

test('rundowns other than the current one can be deleted', async () => {
  await ensureCurrentRundown('7');
  await call('POST', '', { name: 'Sunday show' });
  const current = await call('DELETE', '/1');
  assert.equal(current.status, 409);
  assert.equal(current.body.code, 'CURRENT');
  assert.equal(db.rundowns.length, 2);
  db.accounts.set('8', { current: null });
  assert.equal((await call('DELETE', '/2', undefined, '8')).status, 404);
  assert.equal((await call('DELETE', '/2')).status, 200);
  assert.deepEqual(db.rundowns.map((rundown) => rundown.id), ['1']);
  assert.equal((await call('DELETE', '/2')).status, 404);
  assert.equal((await call('DELETE', '/x')).status, 400);
  assert.ok(transactions.includes('rollback'));
  assert.deepEqual(changed, []);
});
