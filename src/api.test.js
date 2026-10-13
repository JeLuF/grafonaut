import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { canControlGraphic, fetchRendererStatus, requestJson, triggerGraphicAction } from './api.js';

const base = 'https://app.example.invalid/token/ograf/v1/';
const control = { apiBaseUrl: base, rendererId: 'main', renderTarget: { entryId: '7' }, graphicId: 'version-1' };
afterEach(() => mock.restoreAll());

// Answers like the OGraf API; `loaded` decides whether the target already holds an instance.
function mockApi({ loaded = false, ended = false, failAt } = {}) {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, options) => {
    const path = url.slice(base.length - 1);
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method: options.method, path, body, options });
    if (failAt && path.includes(failAt)) return Response.json({ title: 'Service Unavailable', detail: 'No renderer is connected.' }, { status: 503 });
    if (path.startsWith('/renderers/main/target?')) return Response.json({ renderTarget: { entryId: '7' }, graphicInstances: loaded ? [{ graphicInstanceId: 'gi-1', playing: !ended, ended }] : [] });
    if (path.endsWith('/load')) return Response.json({ graphicInstanceId: 'gi-new', statusCode: 200 });
    if (path.endsWith('/playAction')) return Response.json({ graphicInstanceId: body.graphicInstanceId, statusCode: 200, currentStep: 0 });
    if (path.endsWith('/clear')) return Response.json({ graphicInstances: [{ renderTarget: { entryId: '7' }, graphicInstanceId: 'gi-1' }] });
    return Response.json({ graphicInstanceId: body?.graphicInstanceId, statusCode: 200 });
  });
  return { calls, fetchMock };
}

test('controls require an API base URL, renderer, render target and graphic', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('Should not fetch'); });
  assert.equal(canControlGraphic(control), true);
  assert.equal(canControlGraphic(null), false);
  assert.equal(canControlGraphic({ ...control, graphicId: undefined }), false);
  assert.equal(canControlGraphic({ ...control, renderTarget: ['7'] }), false);
  await assert.rejects(triggerGraphicAction(null, 'playAction'), /not available/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('play loads the graphic with the saved properties before playing it', async () => {
  const { calls } = mockApi();
  const result = await triggerGraphicAction(control, 'playAction', { name: 'Host' });
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path.split('?')[0]}`), [
    'GET /renderers/main/target', 'POST /renderers/main/target/graphicInstance/load', 'POST /renderers/main/target/graphicInstance/playAction'
  ]);
  assert.equal(new URL(`https://x${calls[0].path}`).searchParams.get('renderTarget'), '{"entryId":"7"}');
  assert.deepEqual(calls[1].body, { renderTarget: { entryId: '7' }, graphicId: 'version-1', params: { data: { name: 'Host' } } });
  assert.deepEqual(calls[2].body, { renderTarget: { entryId: '7' }, graphicInstanceId: 'gi-new', params: {} });
  assert.equal(calls[1].options.credentials, 'omit');
  assert.equal(calls[1].options.referrerPolicy, 'no-referrer');
  assert.equal(result.currentStep, 0);
});

test('play on a loaded graphic advances it without reloading', async () => {
  const { calls } = mockApi({ loaded: true });
  await triggerGraphicAction(control, 'playAction', { name: 'Host' });
  assert.deepEqual(calls.map(({ path }) => path.split('?')[0]), ['/renderers/main/target', '/renderers/main/target/graphicInstance/playAction']);
  assert.equal(calls[1].body.graphicInstanceId, 'gi-1');
});

test('play on an ended graphic loads it again with the current properties', async () => {
  const { calls } = mockApi({ loaded: true, ended: true });
  await triggerGraphicAction(control, 'playAction', { name: 'Changed' });
  assert.deepEqual(calls.map(({ path }) => path.split('?')[0]), ['/renderers/main/target', '/renderers/main/target/graphicInstance/load',
    '/renderers/main/target/graphicInstance/playAction']);
  assert.deepEqual(calls[1].body.params, { data: { name: 'Changed' } });
  assert.equal(calls[2].body.graphicInstanceId, 'gi-new');
});

test('update sends the complete saved state to the loaded instance', async () => {
  const { calls } = mockApi({ loaded: true });
  const data = { name: 'Host', role: 'Presenter', nested: { visible: true } };
  await triggerGraphicAction(control, 'updateAction', data);
  assert.deepEqual(calls[1].body, { renderTarget: { entryId: '7' }, graphicInstanceId: 'gi-1', params: { data } });
});

test('stop animates out and then clears the instance', async () => {
  const { calls } = mockApi({ loaded: true });
  await triggerGraphicAction(control, 'stopAction', { name: 'ignored' });
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path.split('?')[0]}`), [
    'GET /renderers/main/target', 'POST /renderers/main/target/graphicInstance/stopAction', 'PUT /renderers/main/target/graphicInstance/clear'
  ]);
  assert.deepEqual(calls[1].body.params, {});
  assert.deepEqual(calls[2].body, { filters: [{ renderTarget: { entryId: '7' }, graphicInstanceId: 'gi-1' }] });
});

test('stop and update do nothing when the graphic is not loaded', async () => {
  for (const action of ['stopAction', 'updateAction']) {
    const { calls } = mockApi();
    assert.equal((await triggerGraphicAction(control, action, {})).notLoaded, true);
    assert.equal(calls.length, 1);
    mock.restoreAll();
  }
});

test('API problems and graphic error status codes are reported as failures', async () => {
  mockApi({ failAt: '/load' });
  await assert.rejects(triggerGraphicAction(control, 'playAction', {}), /No renderer is connected/);
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => Response.json({ graphicInstances: [{ graphicInstanceId: 'gi-1' }], statusCode: 500, statusMessage: 'Graphic failed' }));
  await assert.rejects(triggerGraphicAction(control, 'updateAction', {}), /Graphic failed/);
});

test('invalid action names and base URLs are rejected before requests', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({}));
  await assert.rejects(triggerGraphicAction(control, 'delete'), /Unknown graphic action/);
  await assert.rejects(triggerGraphicAction({ ...control, apiBaseUrl: 'javascript:alert(1)' }, 'playAction'), /Invalid OGraf API/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('renderer status lists connections and instances per entry', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ renderer: { status: { status: 'OK', connections: 2 }, renderTargets: [
    { renderTarget: { entryId: '7' }, graphicInstances: [{ graphicInstanceId: 'gi-1', playing: true }] },
    { renderTarget: { entryId: '9' }, graphicInstances: [{ graphicInstanceId: 'gi-2', playing: false, ended: true }] },
    { renderTarget: { entryId: '8' }, graphicInstances: [] }
  ] } }));
  const status = await fetchRendererStatus(base);
  assert.equal(status.connections, 2);
  assert.deepEqual([...status.instances], [['7', { playing: true, ended: false }], ['9', { playing: false, ended: true }]]);
});

test('account API failures retain their error message', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Sign-in required' }, { status: 401 }));
  await assert.rejects(requestJson('/api/my-graphics'), /Sign-in required/);
});
