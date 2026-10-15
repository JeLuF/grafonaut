import fs from 'node:fs';
import express from 'express';
import { runGroupAction } from './group-run.js';
import { RENDERER_ID, RendererError } from './render-hub.js';
import { ControlError, createRenderControl, customActionError } from './render-control.js';

// Grafonaut's implementation of the OGraf Server API (https://ograf.ebu.io), scoped to one account by the API token in the path:
// /<api-token>/ograf/v1/... The token is the only credential, so no cookies are involved and any origin may call it.
// The account has one renderer ("main"); its RenderTargets are the My Graphics entries ({ entryId }), each holding
// at most one GraphicInstance of the entry's pinned graphic version.
export const apiMountPath = '/:token/ograf/v1';
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

// Kept here for existing importers; the implementation lives in render-control.js.
export { payloadProblems } from './render-control.js';

export function apiUrl(request, token) {
  return `${request.protocol}://${request.host}/${encodeURIComponent(token)}/ograf/v1/`;
}

export const renderTargetSchema = {
  type: 'object',
  properties: { entryId: { type: 'string', title: 'My Graphics entry', description: 'ID of the My Graphics entry to render into' } },
  required: ['entryId']
};

// RFC 7807 problem details, as used by the OGraf Server API's ErrorResponse. The instance omits the token prefix.
function problem(request, response, status, title, detail) {
  response.status(status).json({ title, status, detail, instance: request.path });
}

function rendererProblem(request, response, error) {
  if (error instanceof ControlError) {
    return response.status(error.status).json({ title: error.title, status: error.status, detail: error.detail, instance: request.path, ...error.extra });
  }
  if (!(error instanceof RendererError)) return problem(request, response, 500, 'Internal Server Error', 'The request could not be completed.');
  if (error.kind === 'no-renderer') return problem(request, response, 503, 'Service Unavailable', error.message);
  if (error.kind === 'graphic') return problem(request, response, 550, 'Graphic Error', error.message);
  return problem(request, response, 500, 'Internal Server Error', error.message);
}

function parseTarget(value) {
  let target = value;
  if (typeof value === 'string') {
    try { target = JSON.parse(value); } catch { return null; }
  }
  if (!isObject(target) || !['string', 'number'].includes(typeof target.entryId)) return null;
  return String(target.entryId);
}

function targetInfo(entry, instance) {
  return {
    renderTarget: { entryId: entry.entryId },
    name: entry.label || entry.display_name,
    description: `${entry.display_name} v${entry.versionLabel}${entry.enabled && !entry.packageDisabled ? '' : ' (disabled)'}`,
    graphicInstances: instance ? [{
      graphicInstanceId: instance.instanceId,
      graphic: { id: entry.versionId, name: entry.display_name },
      playing: instance.playing,
      ended: instance.ended === true,
      ...(typeof instance.currentStep === 'number' ? { currentStep: instance.currentStep } : {})
    }] : []
  };
}

export function createOgrafApi({ hub, store, findAccountByToken }) {
  const control = createRenderControl({ hub, store });
  const runningGroups = new Set();
  const router = express.Router({ mergeParams: true });
  router.use((request, response, next) => {
    response.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex'
    });
    if (request.method === 'OPTIONS') return response.sendStatus(204);
    next();
  });
  router.use(async (request, response, next) => {
    try {
      const account = await findAccountByToken(request.params.token, 'api');
      if (!account) return problem(request, response, 401, 'Unauthorized', 'Unknown or replaced API token.');
      request.apiAccount = account;
      next();
    } catch { problem(request, response, 500, 'Internal Server Error', 'The API is temporarily unavailable.'); }
  });
  router.use(express.json({ limit: '1mb' }));

  // Wraps a handler: catches errors and resolves the renderer from the path.
  const handle = (handler, { renderer = false } = {}) => async (request, response) => {
    if (renderer && request.params.rendererId !== RENDERER_ID) return problem(request, response, 404, 'Not Found', 'No Renderer found.');
    try { await handler(request, response, request.apiAccount.id); }
    catch (error) { rendererProblem(request, response, error); }
  };
  const { targetState } = control;

  router.get('/', (request, response) => {
    response.json({
      name: 'Grafonaut',
      description: `Grafonaut OGraf Server API for ${request.apiAccount.display_name ?? request.apiAccount.login}`,
      author: { name: 'Grafonaut' },
      version
    });
  });

  router.get('/graphics', handle(async (_request, response, accountId) => {
    const entries = await store.listRenderEntries(accountId);
    const graphics = new Map();
    for (const entry of entries) {
      if (!graphics.has(entry.versionId)) graphics.set(entry.versionId, { id: entry.versionId, name: entry.display_name, ...(entry.description ? { description: entry.description } : {}) });
    }
    response.json({ graphics: [...graphics.values()] });
  }));
  router.get('/graphics/:graphicId', handle(async (request, response, accountId) => {
    const graphic = await store.findAccountGraphic(accountId, request.params.graphicId);
    if (!graphic) return problem(request, response, 404, 'Not Found', 'No Graphic found with the given ID.');
    response.json({ graphic: graphic.manifest, metadata: { createdAt: new Date(graphic.createdAt).toISOString() } });
  }));

  router.get('/renderers', (_request, response) => {
    response.json({ renderers: [{ id: RENDERER_ID, name: 'Browser renderer', description: 'All renderer pages opened with your renderer URL' }] });
  });
  router.get('/renderers/:rendererId', handle(async (_request, response, accountId) => {
    const [entries, instances] = await Promise.all([store.listRenderEntries(accountId), store.listRenderInstances(accountId)]);
    const connections = hub.connections(accountId).length;
    response.json({ renderer: {
      id: RENDERER_ID,
      name: 'Browser renderer',
      description: 'All renderer pages opened with your renderer URL',
      customActions: [],
      renderCharacteristics: { resolution: { width: 1920, height: 1080 }, accessToPublicInternet: true },
      renderTargetSchema,
      status: connections
        ? { status: 'OK', message: `${connections} renderer connection${connections === 1 ? '' : 's'}`, connections }
        : { status: 'WARNING', message: 'No renderer is connected', connections },
      renderTargets: entries.map((entry) => targetInfo(entry, instances.find((instance) => instance.entryId === entry.entryId)))
    } });
  }, { renderer: true }));
  router.get('/renderers/:rendererId/target', handle(async (request, response, accountId) => {
    const entryId = parseTarget(request.query.renderTarget);
    const { entry, instance } = entryId ? await targetState(accountId, entryId) : {};
    if (!entry) return problem(request, response, 404, 'Not Found', 'No RenderTarget found.');
    response.json(targetInfo(entry, instance));
  }, { renderer: true }));
  router.post('/renderers/:rendererId/customActions/:customActionId', handle(async (request, response) => {
    problem(request, response, 404, 'Not Found', 'This renderer has no custom actions.');
  }, { renderer: true }));

  router.put('/renderers/:rendererId/target/graphicInstance/clear', handle(async (request, response, accountId) => {
    const filters = request.body?.filters;
    if (!Array.isArray(filters) || !filters.every(isObject)) return problem(request, response, 400, 'Bad Request', 'filters must be an array of objects.');
    const [entries, instances] = await Promise.all([store.listRenderEntries(accountId), store.listRenderInstances(accountId)]);
    const matches = (filter, instance) => (filter.renderTarget === undefined || parseTarget(filter.renderTarget) === instance.entryId) &&
      (filter.graphicId === undefined || filter.graphicId === instance.versionId) &&
      (filter.graphicInstanceId === undefined || filter.graphicInstanceId === instance.instanceId);
    const cleared = instances.filter((instance) => entries.some((entry) => entry.entryId === instance.entryId) &&
      (!filters.length || filters.some((filter) => matches(filter, instance))));
    await control.clear(accountId, cleared);
    response.json({ graphicInstances: cleared.map((instance) => ({ renderTarget: { entryId: instance.entryId }, graphicInstanceId: instance.instanceId })) });
  }, { renderer: true }));

  router.post('/renderers/:rendererId/target/graphicInstance/load', handle(async (request, response, accountId) => {
    const body = request.body ?? {};
    const entryId = parseTarget(body.renderTarget);
    const { entry } = entryId ? await targetState(accountId, entryId) : {};
    if (!entry) return problem(request, response, 404, 'Not Found', 'No RenderTarget found.');
    if (body.graphicId !== entry.versionId) return problem(request, response, 404, 'Not Found', `RenderTarget ${entryId} holds Graphic ${entry.versionId}.`);
    if (!entry.enabled || entry.packageDisabled) return problem(request, response, 409, 'Conflict', 'This rundown entry is disabled.');
    if (!isObject(body.params)) return problem(request, response, 400, 'Bad Request', 'params must be an object.');
    response.json((await control.load(accountId, entry, body.params.data)).result);
  }, { renderer: true }));

  // Resolves target and instance of an action request, then runs it; `check(entry)` may reject it before anything
  // is sent to the renderers.
  async function instanceAction(request, response, accountId, action, params, check = () => null) {
    const body = request.body ?? {};
    const entryId = parseTarget(body.renderTarget);
    const { entry, instance } = entryId ? await targetState(accountId, entryId) : {};
    if (!entry) return problem(request, response, 404, 'Not Found', 'No RenderTarget found.');
    const rejection = await check(entry);
    if (rejection) throw rejection;
    if (!instance || instance.instanceId !== body.graphicInstanceId) return problem(request, response, 404, 'Not Found', 'No GraphicInstance found.');
    response.json(await control.act(accountId, entry, instance, action, params));
  }
  const paramsOf = (request) => isObject(request.body?.params) ? request.body.params : null;
  const pick = (params, keys) => Object.fromEntries(keys.filter((key) => params[key] !== undefined).map((key) => [key, params[key]]));

  router.post('/renderers/:rendererId/target/graphicInstance/playAction', handle(async (request, response, accountId) => {
    await instanceAction(request, response, accountId, 'playAction', pick(paramsOf(request) ?? {}, ['delta', 'goto', 'skipAnimation']));
  }, { renderer: true }));
  router.post('/renderers/:rendererId/target/graphicInstance/stopAction', handle(async (request, response, accountId) => {
    await instanceAction(request, response, accountId, 'stopAction', pick(paramsOf(request) ?? {}, ['skipAnimation']));
  }, { renderer: true }));
  router.post('/renderers/:rendererId/target/graphicInstance/updateAction', handle(async (request, response, accountId) => {
    const params = paramsOf(request);
    if (!params || params.data === undefined) return problem(request, response, 400, 'Bad Request', 'params.data is required.');
    await instanceAction(request, response, accountId, 'updateAction', pick(params, ['data', 'skipAnimation']));
  }, { renderer: true }));
  router.post('/renderers/:rendererId/target/graphicInstance/customActions/:customActionId', handle(async (request, response, accountId) => {
    const params = paramsOf(request);
    if (!params || !('payload' in params)) return problem(request, response, 400, 'Bad Request', 'params.payload is required.');
    const actionId = request.params.customActionId;
    await instanceAction(request, response, accountId, 'customAction', { id: actionId, ...pick(params, ['payload', 'skipAnimation']) },
      (entry) => customActionError(entry, actionId, params.payload));
  }, { renderer: true }));

  // ---- Vendor extensions (x-): group actions of the current rundown (FE-7) ----
  const describeStep = (step, entries) => {
    const entry = entries.find((candidate) => candidate.entryId === step.entryId);
    return { ...step, ...(step.entryId !== undefined ? { entryName: entry ? entry.label || entry.display_name : null } : {}) };
  };
  router.get('/x-actions', handle(async (_request, response, accountId) => {
    const [groups, entries] = await Promise.all([store.listGroupActions(accountId), store.listRenderEntries(accountId)]);
    response.json({ actions: groups.map((group) => ({ id: group.id, name: group.name, steps: group.steps.map((step) => describeStep(step, entries)) })) });
  }));
  // Runs a group action and answers when all its steps are done: steps between sleep steps start together.
  router.post('/x-actions/:actionId', handle(async (request, response, accountId) => {
    const [groups, entries] = await Promise.all([store.listGroupActions(accountId), store.listRenderEntries(accountId)]);
    const group = groups.find((candidate) => candidate.id === request.params.actionId);
    if (!group) return problem(request, response, 404, 'Not Found', 'No action found with the given ID in the current rundown.');
    if (!hub.connections(accountId).length) throw new RendererError('no-renderer', 'No renderer is connected.');
    const key = `${accountId}:${group.id}`;
    if (runningGroups.has(key)) return problem(request, response, 409, 'Conflict', 'This action is already running.');
    runningGroups.add(key);
    try {
      const { ran, failures } = await runGroupAction(group, { entries, execute: (_entry, step) => control.runStep(accountId, step) });
      response.json({ id: group.id, name: group.name, ran, failures: failures.map(({ step, entry, message }) => ({
        step: group.steps.indexOf(step) + 1, type: step.type, entryId: step.entryId,
        entryName: entry ? entry.label || entry.display_name : null, message
      })) });
    } finally { runningGroups.delete(key); }
  }));

  router.use((error, request, response, next) => {
    if (error?.type === 'entity.parse.failed') return problem(request, response, 400, 'Bad Request', 'The request body is not valid JSON.');
    if (error?.type === 'entity.too.large') return problem(request, response, 413, 'Payload Too Large', 'The request body is too large.');
    next(error);
  });
  router.use((request, response) => problem(request, response, 501, 'Not Implemented', 'This endpoint is not available yet.'));
  return router;
}
