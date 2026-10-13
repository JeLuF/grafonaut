export async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error ?? payload.detail ?? 'The request could not be completed'), { status: response.status, payload });
  }
  return payload;
}

export function canControlGraphic(control) {
  return Boolean(typeof control?.apiBaseUrl === 'string' && control.apiBaseUrl &&
    typeof control.rendererId === 'string' && control.rendererId &&
    typeof control.graphicId === 'string' && control.graphicId &&
    control.renderTarget && typeof control.renderTarget === 'object' && !Array.isArray(control.renderTarget));
}

function apiBase(apiBaseUrl) {
  const baseUrl = new URL(apiBaseUrl);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('Invalid OGraf API base URL');
  }
  return baseUrl.href.replace(/\/$/, '');
}

// Calls the public OGraf Server API: the Control UI uses the same API as any third-party controller.
export async function ografRequest(apiBaseUrl, method, path, body) {
  const response = await fetch(`${apiBase(apiBaseUrl)}${path}`, { method, credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (typeof payload.statusCode === 'number' && (payload.statusCode < 200 || payload.statusCode >= 300))) {
    throw new Error(payload.statusMessage ?? payload.detail ?? payload.title ?? 'The renderer could not complete the action');
  }
  return payload;
}

// Play loads the graphic with the saved properties if it is not loaded yet, then plays (again: next step).
// Stop animates out and then clears the instance, so the next play starts fresh with the current properties.
// Update sends the complete saved state. Stop and update do nothing when the graphic is not loaded.
export async function triggerGraphicAction(control, action, data) {
  if (!canControlGraphic(control)) throw new Error('Renderer controls are not available');
  if (!['playAction', 'stopAction', 'updateAction'].includes(action)) throw new Error('Unknown graphic action');
  const renderer = `/renderers/${encodeURIComponent(control.rendererId)}`;
  const { renderTarget } = control;
  const target = await ografRequest(control.apiBaseUrl, 'GET', `${renderer}/target?renderTarget=${encodeURIComponent(JSON.stringify(renderTarget))}`);
  let graphicInstanceId = target.graphicInstances?.[0]?.graphicInstanceId;
  if (action === 'playAction') {
    if (!graphicInstanceId) {
      graphicInstanceId = (await ografRequest(control.apiBaseUrl, 'POST', `${renderer}/target/graphicInstance/load`,
        { renderTarget, graphicId: control.graphicId, params: { data: data ?? {} } })).graphicInstanceId;
    }
    return ografRequest(control.apiBaseUrl, 'POST', `${renderer}/target/graphicInstance/playAction`, { renderTarget, graphicInstanceId, params: {} });
  }
  if (!graphicInstanceId) return { statusCode: 200, notLoaded: true };
  if (action === 'updateAction') {
    return ografRequest(control.apiBaseUrl, 'POST', `${renderer}/target/graphicInstance/updateAction`, { renderTarget, graphicInstanceId, params: { data: data ?? {} } });
  }
  const result = await ografRequest(control.apiBaseUrl, 'POST', `${renderer}/target/graphicInstance/stopAction`, { renderTarget, graphicInstanceId, params: {} });
  await ografRequest(control.apiBaseUrl, 'PUT', `${renderer}/target/graphicInstance/clear`, { filters: [{ renderTarget, graphicInstanceId }] });
  return result;
}

// Connection count and per-entry instance state of the account's renderer.
export async function fetchRendererStatus(apiBaseUrl, rendererId = 'main') {
  const { renderer } = await ografRequest(apiBaseUrl, 'GET', `/renderers/${encodeURIComponent(rendererId)}`);
  const instances = new Map();
  for (const target of renderer.renderTargets ?? []) {
    const instance = target.graphicInstances?.[0];
    if (instance) instances.set(String(target.renderTarget?.entryId), { playing: Boolean(instance.playing) });
  }
  return { connections: Number(renderer.status?.connections ?? 0), instances };
}
