export async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? payload.detail ?? 'The request could not be completed');
  return payload;
}

export function canControlGraphic(control) {
  return Boolean(typeof control?.apiBaseUrl === 'string' && control.apiBaseUrl &&
    typeof control.rendererId === 'string' && control.rendererId &&
    typeof control.graphicInstanceId === 'string' && control.graphicInstanceId &&
    control.renderTarget && typeof control.renderTarget === 'object' && !Array.isArray(control.renderTarget));
}

export async function triggerGraphicAction(control, action, data) {
  if (!canControlGraphic(control)) throw new Error('Renderer controls are not available');
  if (!['playAction', 'stopAction', 'updateAction'].includes(action)) throw new Error('Unknown graphic action');
  const baseUrl = new URL(control.apiBaseUrl);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('Invalid OGraf API base URL');
  }
  const endpoint = `${baseUrl.href.replace(/\/$/, '')}/renderers/${encodeURIComponent(control.rendererId)}/target/graphicInstance/${action}`;
  const params = action === 'updateAction' ? { data } : action === 'playAction' ? { goto: 0 } : {};
  const response = await fetch(endpoint, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ renderTarget: control.renderTarget, graphicInstanceId: control.graphicInstanceId, params }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.statusCode !== 'number' || payload.statusCode < 200 || payload.statusCode >= 300) {
    throw new Error(payload.statusMessage ?? payload.detail ?? payload.title ?? 'The renderer could not complete the action');
  }
  return payload;
}