import crypto from 'node:crypto';
import fs from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import express from 'express';
import { moduleUrl, RENDERER_ID, RendererError } from './render-hub.js';

// OGraf Server API (https://ograf.ebu.io), scoped to one account by the API token in the path:
// /<api-token>/ograf/v1/... The token is the only credential, so no cookies are involved and any origin may call it.
// The account has one renderer ("main"); its RenderTargets are the My Graphics entries ({ entryId }), each holding
// at most one GraphicInstance of the entry's pinned graphic version.
export const apiMountPath = '/:token/ograf/v1';
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const payloadValidator = new Ajv({ allErrors: true, strict: false });
addFormats(payloadValidator);

// Validates a custom action payload against the action's schema from the manifest; returns readable problems.
export function payloadProblems(schema, payload) {
  if (!isObject(schema)) return [];
  let validate;
  try { validate = payloadValidator.compile(schema); }
  catch { return ['The custom action declares an invalid payload schema.']; }
  finally { payloadValidator.removeSchema(schema); }
  if (validate(payload)) return [];
  return validate.errors.slice(0, 10).map((error) => `${error.instancePath || 'payload'} ${error.message}`);
}

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
  async function targetState(accountId, entryId) {
    const [entries, instances] = await Promise.all([store.listRenderEntries(accountId), store.listRenderInstances(accountId)]);
    return { entry: entries.find((candidate) => candidate.entryId === entryId), instance: instances.find((candidate) => candidate.entryId === entryId) };
  }

  router.get('/', (request, response) => {
    response.json({
      name: 'OGraf Platform',
      description: `OGraf Server API for ${request.apiAccount.twitch_display_name ?? request.apiAccount.twitch_login}`,
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
    await store.deleteRenderInstances(accountId, cleared.map((instance) => instance.entryId));
    await hub.broadcastState(accountId);
    response.json({ graphicInstances: cleared.map((instance) => ({ renderTarget: { entryId: instance.entryId }, graphicInstanceId: instance.instanceId })) });
  }, { renderer: true }));

  router.post('/renderers/:rendererId/target/graphicInstance/load', handle(async (request, response, accountId) => {
    const body = request.body ?? {};
    const entryId = parseTarget(body.renderTarget);
    const { entry } = entryId ? await targetState(accountId, entryId) : {};
    if (!entry) return problem(request, response, 404, 'Not Found', 'No RenderTarget found.');
    if (body.graphicId !== entry.versionId) return problem(request, response, 404, 'Not Found', `RenderTarget ${entryId} holds Graphic ${entry.versionId}.`);
    if (!entry.enabled || entry.packageDisabled) return problem(request, response, 409, 'Conflict', 'This My Graphics entry is disabled.');
    if (!isObject(body.params)) return problem(request, response, 400, 'Bad Request', 'params must be an object.');
    if (!hub.connections(accountId).length) throw new RendererError('no-renderer', 'No renderer is connected.');
    const instanceId = `gi-${crypto.randomUUID()}`;
    const data = isObject(body.params.data) ? body.params.data : {};
    // Stored before the renderers load it, so a state broadcast in between keeps the new frame.
    await store.saveRenderInstance(accountId, entryId, { instanceId, data });
    try {
      const result = await hub.command(accountId, { action: 'load', instanceId, entryId, module: moduleUrl(entry.versionId, entry.mainFile), data });
      response.json({ graphicInstanceId: instanceId, ...result });
    } catch (error) {
      await store.deleteRenderInstances(accountId, [entryId]);
      await hub.broadcastState(accountId).catch(() => {});
      throw error;
    }
  }, { renderer: true }));

  // `check(entry)` may reject the request before anything is sent to the renderers: return [status, title, detail, extra].
  async function instanceAction(request, response, accountId, action, params, nextState, check = () => null) {
    const body = request.body ?? {};
    const entryId = parseTarget(body.renderTarget);
    const { entry, instance } = entryId ? await targetState(accountId, entryId) : {};
    if (!entry) return problem(request, response, 404, 'Not Found', 'No RenderTarget found.');
    const rejection = check(entry);
    if (rejection) {
      const [status, title, detail, extra] = rejection;
      return response.status(status).json({ title, status, detail, instance: request.path, ...extra });
    }
    if (!instance || instance.instanceId !== body.graphicInstanceId) return problem(request, response, 404, 'Not Found', 'No GraphicInstance found.');
    const result = await hub.command(accountId, { action, instanceId: instance.instanceId, entryId, params });
    await store.saveRenderInstance(accountId, entryId, { ...instance, ...nextState(instance, result, entry) });
    response.json({ graphicInstanceId: instance.instanceId, ...result });
  }
  // OGraf step model: a graphic with stepCount 0 is played once and animates out by itself, so after a successful play
  // it is no longer on air. A graphic that reported a step before and now returns no currentStep has transitioned to
  // its end. Graphics that never report steps (currentStep missing every time) keep being treated as on air.
  function playState(instance, result, entry) {
    const toEnd = entry.stepCount === 0 || (typeof instance.currentStep === 'number' && result.currentStep === undefined);
    return toEnd ? { playing: false, ended: true, currentStep: null } : { playing: true, ended: false, currentStep: result.currentStep ?? null };
  }
  const paramsOf = (request) => isObject(request.body?.params) ? request.body.params : null;
  const pick = (params, keys) => Object.fromEntries(keys.filter((key) => params[key] !== undefined).map((key) => [key, params[key]]));

  router.post('/renderers/:rendererId/target/graphicInstance/playAction', handle(async (request, response, accountId) => {
    const params = paramsOf(request) ?? {};
    await instanceAction(request, response, accountId, 'playAction', pick(params, ['delta', 'goto', 'skipAnimation']),
      (instance, result, entry) => playState(instance, result, entry));
  }, { renderer: true }));
  router.post('/renderers/:rendererId/target/graphicInstance/stopAction', handle(async (request, response, accountId) => {
    const params = paramsOf(request) ?? {};
    await instanceAction(request, response, accountId, 'stopAction', pick(params, ['skipAnimation']),
      () => ({ playing: false, ended: true, currentStep: null }));
  }, { renderer: true }));
  router.post('/renderers/:rendererId/target/graphicInstance/updateAction', handle(async (request, response, accountId) => {
    const params = paramsOf(request);
    if (!params || params.data === undefined) return problem(request, response, 400, 'Bad Request', 'params.data is required.');
    await instanceAction(request, response, accountId, 'updateAction', pick(params, ['data', 'skipAnimation']),
      (instance) => ({ data: isObject(params.data) ? { ...instance.data, ...params.data } : instance.data }));
  }, { renderer: true }));
  router.post('/renderers/:rendererId/target/graphicInstance/customActions/:customActionId', handle(async (request, response, accountId) => {
    const params = paramsOf(request);
    if (!params || !('payload' in params)) return problem(request, response, 400, 'Bad Request', 'params.payload is required.');
    const actionId = request.params.customActionId;
    await instanceAction(request, response, accountId, 'customAction',
      { id: actionId, ...pick(params, ['payload', 'skipAnimation']) }, () => ({}), (entry) => {
        // Only actions the graphic declares in its manifest, with a payload matching the action's schema.
        const declared = (entry.customActions ?? []).find((candidate) => candidate.id === actionId);
        if (!declared) return [404, 'Not Found', `The graphic has no custom action "${actionId}".`];
        const problems = payloadProblems(declared.schema, params.payload);
        return problems.length ? [400, 'Bad Request', 'The payload does not match the custom action\'s schema.', { errors: problems }] : null;
      });
  }, { renderer: true }));

  router.use((error, request, response, next) => {
    if (error?.type === 'entity.parse.failed') return problem(request, response, 400, 'Bad Request', 'The request body is not valid JSON.');
    if (error?.type === 'entity.too.large') return problem(request, response, 413, 'Payload Too Large', 'The request body is too large.');
    next(error);
  });
  router.use((request, response) => problem(request, response, 501, 'Not Implemented', 'This endpoint is not available yet.'));
  return router;
}
