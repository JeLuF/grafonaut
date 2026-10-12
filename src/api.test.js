import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { canControlGraphic, requestJson, triggerGraphicAction } from './api.js';

const control = { apiBaseUrl: 'https://renderer.example.invalid/account/ograf/v1', rendererId: 'renderer/main',
  renderTarget: { layer: 2 }, graphicInstanceId: 'instance-7' };
afterEach(() => mock.restoreAll());

test('actions require a real public API binding', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('Should not fetch'); });
  assert.equal(canControlGraphic(null), false);
  assert.equal(canControlGraphic({ apiBaseUrl: control.apiBaseUrl }), false);
  await assert.rejects(triggerGraphicAction(null, 'playAction'), /not available/);
  assert.equal(fetchMock.mock.callCount(), 0);
});
test('play targets the selected graphic instance through the public OGraf API', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ statusCode: 200, currentStep: 0 }));
  await triggerGraphicAction(control, 'playAction');
  const [url, options] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, 'https://renderer.example.invalid/account/ograf/v1/renderers/renderer%2Fmain/target/graphicInstance/playAction');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(options.body), { renderTarget: { layer: 2 }, graphicInstanceId: 'instance-7', params: { goto: 0 } });
});
test('update sends the complete saved state rather than a partial diff', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ statusCode: 200 }));
  const data = { name: 'Host', role: 'Presenter', nested: { visible: true } };
  await triggerGraphicAction(control, 'updateAction', data);
  assert.deepEqual(JSON.parse(fetchMock.mock.calls[0].arguments[1].body).params, { data });
});
test('stop uses the same instance and does not send property updates', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ statusCode: 200 }));
  await triggerGraphicAction(control, 'stopAction');
  assert.deepEqual(JSON.parse(fetchMock.mock.calls[0].arguments[1].body).params, {});
});
test('renderer error payloads are not treated as successful actions', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ statusCode: 503, statusMessage: 'No renderer connected' }));
  await assert.rejects(triggerGraphicAction(control, 'playAction'), /No renderer connected/);
});
test('invalid action names and base URLs are rejected before requests', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ statusCode: 200 }));
  await assert.rejects(triggerGraphicAction(control, 'delete'), /Unknown graphic action/);
  await assert.rejects(triggerGraphicAction({ ...control, apiBaseUrl: 'javascript:alert(1)' }, 'playAction'), /Invalid OGraf API/);
  assert.equal(fetchMock.mock.callCount(), 0);
});
test('account API failures retain their error message', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Sign-in required' }, { status: 401 }));
  await assert.rejects(requestJson('/api/my-graphics'), /Sign-in required/);
});