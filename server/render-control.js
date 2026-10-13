import crypto from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { moduleUrl, RendererError } from './render-hub.js';

// Loading graphics and running actions on the account's renderer, shared by the OGraf API endpoints and by group
// actions. Errors that should become an API answer are ControlErrors (status, title, detail, extra fields).
export class ControlError extends Error {
  constructor(status, title, detail, extra = {}) {
    super(detail);
    Object.assign(this, { status, title, detail, extra });
  }
}

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

// Only actions the graphic declares in its manifest, with a payload matching the action's schema.
export function customActionError(entry, actionId, payload) {
  const declared = (entry.customActions ?? []).find((candidate) => candidate.id === actionId);
  if (!declared) return new ControlError(404, 'Not Found', `The graphic has no custom action "${actionId}".`);
  const problems = payloadProblems(declared.schema, payload);
  return problems.length ? new ControlError(400, 'Bad Request', 'The payload does not match the custom action\'s schema.', { errors: problems }) : null;
}

// OGraf step model: a graphic with stepCount 0 is played once and animates out by itself, so after a successful play
// it is no longer on air. A graphic that reported a step before and now returns no currentStep has transitioned to
// its end. Graphics that never report steps (currentStep missing every time) keep being treated as on air.
export function playState(instance, result, entry) {
  const toEnd = entry.stepCount === 0 || (typeof instance.currentStep === 'number' && result.currentStep === undefined);
  return toEnd ? { playing: false, ended: true, currentStep: null } : { playing: true, ended: false, currentStep: result.currentStep ?? null };
}

const nextStates = {
  playAction: playState,
  stopAction: () => ({ playing: false, ended: true, currentStep: null }),
  updateAction: (instance, _result, _entry, params) => ({ data: isObject(params.data) ? { ...instance.data, ...params.data } : instance.data }),
  customAction: () => ({})
};

export function createRenderControl({ hub, store }) {
  async function targetState(accountId, entryId) {
    const [entries, instances] = await Promise.all([store.listRenderEntries(accountId), store.listRenderInstances(accountId)]);
    return { entry: entries.find((candidate) => candidate.entryId === entryId), instance: instances.find((candidate) => candidate.entryId === entryId) };
  }

  // Creates the entry's graphic instance (replacing one already there) and loads it on every connected renderer.
  async function load(accountId, entry, data) {
    if (!entry.enabled || entry.packageDisabled) throw new ControlError(409, 'Conflict', 'This rundown entry is disabled.');
    if (!hub.connections(accountId).length) throw new RendererError('no-renderer', 'No renderer is connected.');
    const instanceId = `gi-${crypto.randomUUID()}`;
    const instance = { entryId: entry.entryId, instanceId, data: isObject(data) ? data : {}, currentStep: null, playing: false, ended: false };
    // Stored before the renderers load it, so a state broadcast in between keeps the new frame.
    await store.saveRenderInstance(accountId, entry.entryId, instance);
    try {
      const result = await hub.command(accountId, { action: 'load', instanceId, entryId: entry.entryId, module: moduleUrl(entry.versionId, entry.mainFile), data: instance.data });
      return { instance, result: { graphicInstanceId: instanceId, ...result } };
    } catch (error) {
      await store.deleteRenderInstances(accountId, [entry.entryId]);
      await hub.broadcastState(accountId).catch(() => {});
      throw error;
    }
  }

  // Runs playAction/stopAction/updateAction/customAction on a loaded instance and keeps its state.
  async function act(accountId, entry, instance, action, params) {
    const result = await hub.command(accountId, { action, instanceId: instance.instanceId, entryId: entry.entryId, params });
    await store.saveRenderInstance(accountId, entry.entryId, { ...instance, ...nextStates[action](instance, result, entry, params) });
    return { graphicInstanceId: instance.instanceId, ...result };
  }

  // Removes instances from the state and from every renderer.
  async function clear(accountId, instances) {
    await store.deleteRenderInstances(accountId, instances.map((instance) => instance.entryId));
    await hub.broadcastState(accountId);
  }

  // One step as the rundown buttons run it: play and custom actions load the graphic with its saved properties when
  // it is not loaded or has ended; stop animates out and clears it; update sends the saved properties.
  async function runStep(accountId, step) {
    const { entry, instance } = await targetState(accountId, step.entryId);
    if (!entry) throw new ControlError(404, 'Not Found', 'the graphic is no longer in this rundown');
    const data = isObject(entry.schemaData) ? entry.schemaData : {};
    const ready = async () => (!instance || instance.ended ? (await load(accountId, entry, data)).instance : instance);
    if (step.type === 'play') return act(accountId, entry, await ready(), 'playAction', {});
    if (step.type === 'custom') {
      const payload = step.payload ?? {};
      const problem = customActionError(entry, step.actionId, payload);
      if (problem) throw problem;
      return act(accountId, entry, await ready(), 'customAction', { id: step.actionId, payload });
    }
    if (!instance) return { statusCode: 200, notLoaded: true };
    if (step.type === 'update') return act(accountId, entry, instance, 'updateAction', { data });
    const result = await act(accountId, entry, instance, 'stopAction', {});
    await clear(accountId, [instance]);
    return result;
  }

  return { targetState, load, act, clear, runStep };
}
