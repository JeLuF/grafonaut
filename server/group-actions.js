import express from 'express';
import * as db from './db.js';

// Group actions (FE-7): named lists of steps on the entries of the current rundown, triggered with one click.
// They are a Control UI convenience: the browser runs the steps through the public OGraf API; the server only
// stores and validates them.
export const MAX_STEPS = 50;
// Groups run synchronously through the OGraf API (POST /x-actions/{id}), so their total sleep time is bounded.
export const MAX_SLEEP_MS = 10 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 10 * 1024;
const entryTypes = new Set(['play', 'stop', 'update', 'custom']);

function validName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && [...name].length <= 100 ? name : null;
}

// Returns { steps } with normalized steps, or { problems } describing every invalid step.
export function validateSteps(steps, entryIds) {
  if (!Array.isArray(steps)) return { problems: ['steps must be a list'] };
  if (steps.length > MAX_STEPS) return { problems: [`A group action can have at most ${MAX_STEPS} steps`] };
  const problems = [];
  const normalized = steps.map((step, index) => {
    const where = `Step ${index + 1}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) { problems.push(`${where}: invalid step`); return null; }
    if (step.type === 'sleep') {
      if (!Number.isInteger(step.ms) || step.ms < 0 || step.ms > MAX_SLEEP_MS) problems.push(`${where}: sleep must be 0 to ${MAX_SLEEP_MS / 1000} seconds`);
      return { type: 'sleep', ms: step.ms };
    }
    if (!entryTypes.has(step.type)) { problems.push(`${where}: unknown step type`); return null; }
    const entryId = typeof step.entryId === 'string' || typeof step.entryId === 'number' ? String(step.entryId) : '';
    if (!entryIds.has(entryId)) problems.push(`${where}: the graphic is not in the current rundown`);
    if (step.type !== 'custom') return { type: step.type, entryId };
    if (typeof step.actionId !== 'string' || !step.actionId || step.actionId.length > 200) problems.push(`${where}: choose a custom action`);
    const payload = step.payload === undefined ? {} : step.payload;
    if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) problems.push(`${where}: the payload is too large`);
    return { type: 'custom', entryId, actionId: step.actionId, payload };
  });
  const sleeping = normalized.reduce((total, step) => total + (step?.type === 'sleep' && Number.isInteger(step.ms) ? step.ms : 0), 0);
  if (sleeping > MAX_SLEEP_MS) problems.push(`Sleep steps may add up to at most ${MAX_SLEEP_MS / 1000} seconds`);
  return problems.length ? { problems } : { steps: normalized };
}

export function createGroupActions({ store = db } = {}) {
  const router = express.Router();
  router.use((request, response, next) => {
    if (!request.session?.accountId) return response.status(401).json({ error: 'Sign-in required' });
    next();
  });
  router.param('groupId', (request, response, next, groupId) => {
    if (!/^[1-9]\d{0,19}$/.test(groupId)) return response.status(400).json({ error: 'Invalid group action ID' });
    next();
  });

  // Validates a create/update body; `partial` allows leaving out name or steps.
  async function readBody(request, response, partial) {
    const body = request.body ?? {};
    const changes = {};
    if (body.name !== undefined || !partial) {
      changes.name = validName(body.name);
      if (!changes.name) { response.status(400).json({ error: 'Name must be 1 to 100 characters' }); return null; }
    }
    if (body.steps !== undefined || !partial) {
      const entries = await store.listRenderEntries(request.session.accountId);
      const { steps, problems } = validateSteps(body.steps, new Set(entries.map((entry) => entry.entryId)));
      if (problems) { response.status(400).json({ error: 'The group action has invalid steps', details: problems }); return null; }
      changes.steps = steps;
    }
    if (!Object.keys(changes).length) { response.status(400).json({ error: 'Provide name and/or steps' }); return null; }
    return changes;
  }

  router.get('/', async (request, response) => {
    try { response.json({ groups: await store.listGroupActions(request.session.accountId) }); }
    catch { response.status(503).json({ error: 'Group actions unavailable' }); }
  });
  router.post('/', async (request, response) => {
    try {
      const changes = await readBody(request, response, false);
      if (changes) response.status(201).json({ group: await store.createGroupAction(request.session.accountId, changes) });
    } catch { response.status(503).json({ error: 'Unable to save the group action' }); }
  });
  router.patch('/:groupId', async (request, response) => {
    try {
      const changes = await readBody(request, response, true);
      if (!changes) return;
      if (!await store.updateGroupAction(request.session.accountId, request.params.groupId, changes)) {
        return response.status(404).json({ error: 'Group action not found' });
      }
      response.json({ ok: true, ...changes });
    } catch { response.status(503).json({ error: 'Unable to save the group action' }); }
  });
  router.delete('/:groupId', async (request, response) => {
    try {
      if (!await store.deleteGroupAction(request.session.accountId, request.params.groupId)) return response.status(404).json({ error: 'Group action not found' });
      response.json({ ok: true });
    } catch { response.status(503).json({ error: 'Unable to delete the group action' }); }
  });
  return router;
}
