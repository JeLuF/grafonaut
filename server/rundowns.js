import express from 'express';
import { createRundown, deleteRundown, listRundowns, renameRundown, RundownError, switchRundown } from './db.js';

const router = express.Router();
router.use((request, response, next) => {
  if (!request.session?.accountId) return response.status(401).json({ error: 'Sign-in required' });
  next();
});
router.param('rundownId', (request, response, next, rundownId) => {
  if (!/^[1-9]\d{0,19}$/.test(rundownId)) return response.status(400).json({ error: 'Invalid rundown ID' });
  next();
});

function validName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && [...name].length <= 100 ? name : null;
}
function rundownError(response, error, fallback) {
  if (error instanceof RundownError) {
    const status = { NOT_FOUND: 404, DUPLICATE_NAME: 409, ON_AIR: 409, CURRENT: 409 }[error.code] ?? 400;
    return response.status(status).json({ error: error.message, code: error.code, ...(error.onAir ? { onAir: error.onAir } : {}) });
  }
  response.status(503).json({ error: fallback });
}

router.get('/', async (request, response) => {
  try { response.json(await listRundowns(request.session.accountId)); }
  catch (error) { rundownError(response, error, 'Rundowns unavailable'); }
});
router.post('/', async (request, response) => {
  const name = validName(request.body?.name);
  if (!name) return response.status(400).json({ error: 'Name must be 1 to 100 characters' });
  try { response.status(201).json({ rundown: await createRundown(request.session.accountId, name) }); }
  catch (error) { rundownError(response, error, 'Unable to create the rundown'); }
});
router.patch('/:rundownId', async (request, response) => {
  const name = validName(request.body?.name);
  if (!name) return response.status(400).json({ error: 'Name must be 1 to 100 characters' });
  try {
    await renameRundown(request.session.accountId, request.params.rundownId, name);
    response.json({ ok: true });
  } catch (error) { rundownError(response, error, 'Unable to rename the rundown'); }
});
router.delete('/:rundownId', async (request, response) => {
  try {
    await deleteRundown(request.session.accountId, request.params.rundownId);
    response.json({ ok: true });
  } catch (error) { rundownError(response, error, 'Unable to delete the rundown'); }
});
// Switching makes another rundown the one My Graphics, the renderer and the OGraf API work with.
router.put('/current', async (request, response) => {
  const rundownId = String(request.body?.rundownId ?? '');
  if (!/^[1-9]\d{0,19}$/.test(rundownId)) return response.status(400).json({ error: 'Invalid rundown ID' });
  try {
    const { changed } = await switchRundown(request.session.accountId, rundownId, { force: request.body?.force === true });
    if (changed) request.app.locals.onEntriesChanged?.(request.session.accountId);
    response.json({ currentRundownId: rundownId });
  } catch (error) { rundownError(response, error, 'Unable to switch the rundown'); }
});

export default router;
