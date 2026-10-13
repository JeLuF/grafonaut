import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { after, beforeEach, test } from 'node:test';
import { createGroupActions, MAX_STEPS, validateSteps } from './group-actions.js';

let groups;
let nextId;
const store = {
  listRenderEntries: async (accountId) => accountId === '7' ? [{ entryId: '1' }, { entryId: '2' }] : [],
  listGroupActions: async (accountId) => groups.filter((group) => group.accountId === accountId).map(({ accountId: _, ...group }) => group),
  createGroupAction: async (accountId, group) => { const saved = { id: String(nextId++), ...group }; groups.push({ ...saved, accountId }); return saved; },
  updateGroupAction: async (accountId, id, changes) => {
    const group = groups.find((candidate) => candidate.id === id && candidate.accountId === accountId);
    if (!group) return false;
    Object.assign(group, changes);
    return true;
  },
  deleteGroupAction: async (accountId, id) => {
    const before = groups.length;
    groups = groups.filter((group) => !(group.id === id && group.accountId === accountId));
    return groups.length < before;
  }
};
const app = express();
app.use(express.json());
app.use((request, _response, next) => { request.session = request.headers['x-account'] ? { accountId: request.headers['x-account'] } : null; next(); });
app.use('/api/group-actions', createGroupActions({ store }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api/group-actions`;
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { groups = []; nextId = 1; });
const call = async (method, path = '', body, account = '7') => {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(account ? { 'x-account': account } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const opener = [{ type: 'stop', entryId: '1' }, { type: 'sleep', ms: 500 }, { type: 'play', entryId: '2' },
  { type: 'custom', entryId: 2, actionId: 'highlight' }];

test('group actions are created, listed, renamed, edited and deleted', async () => {
  const created = await call('POST', '', { name: '  Opener  ', steps: opener });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.group, { id: '1', name: 'Opener', steps: [{ type: 'stop', entryId: '1' }, { type: 'sleep', ms: 500 },
    { type: 'play', entryId: '2' }, { type: 'custom', entryId: '2', actionId: 'highlight', payload: {} }] });
  assert.equal((await call('PATCH', '/1', { name: 'Show opener' })).status, 200);
  assert.equal(groups[0].name, 'Show opener');
  assert.equal(groups[0].steps.length, 4);
  assert.equal((await call('PATCH', '/1', { steps: [{ type: 'update', entryId: '1' }] })).status, 200);
  assert.deepEqual((await call('GET')).body.groups, [{ id: '1', name: 'Show opener', steps: [{ type: 'update', entryId: '1' }] }]);
  assert.deepEqual((await call('GET', '', undefined, '8')).body.groups, []);
  assert.equal((await call('PATCH', '/1', { name: 'Taken over' }, '8')).status, 404);
  assert.equal((await call('DELETE', '/1', undefined, '8')).status, 404);
  assert.equal((await call('DELETE', '/1')).status, 200);
  assert.equal(groups.length, 0);
});

test('names and steps are validated, listing every invalid step', async () => {
  assert.equal((await call('POST', '', { name: '', steps: [] })).status, 400);
  assert.equal((await call('POST', '', { name: 'x'.repeat(101), steps: [] })).status, 400);
  const invalid = await call('POST', '', { name: 'Broken', steps: [{ type: 'play', entryId: '9' }, { type: 'sleep', ms: -1 },
    { type: 'custom', entryId: '1' }, { type: 'explode', entryId: '1' }, null] });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body.details, ['Step 1: the graphic is not in the current rundown', 'Step 2: sleep must be 0 to 600 seconds',
    'Step 3: choose a custom action', 'Step 4: unknown step type', 'Step 5: invalid step']);
  assert.equal((await call('PATCH', '/1', {})).status, 400);
  assert.equal((await call('PATCH', '/abc', { name: 'x' })).status, 400);
  assert.equal((await call('GET', '', undefined, null)).status, 401);
});

test('step limits keep groups and payloads bounded', () => {
  const entries = new Set(['1']);
  assert.match(validateSteps(Array.from({ length: MAX_STEPS + 1 }, () => ({ type: 'play', entryId: '1' })), entries).problems[0], /at most 50 steps/);
  assert.deepEqual(validateSteps([{ type: 'custom', entryId: '1', actionId: 'a', payload: 'x'.repeat(20000) }], entries).problems, ['Step 1: the payload is too large']);
  assert.deepEqual(validateSteps([{ type: 'sleep', ms: 1.5 }], entries).problems, ['Step 1: sleep must be 0 to 600 seconds']);
  assert.deepEqual(validateSteps('nope', entries).problems, ['steps must be a list']);
  assert.deepEqual(validateSteps([{ type: 'sleep', ms: 400000 }, { type: 'sleep', ms: 300000 }], entries).problems, ['Sleep steps may add up to at most 600 seconds']);
  assert.deepEqual(validateSteps([], entries).steps, []);
});
