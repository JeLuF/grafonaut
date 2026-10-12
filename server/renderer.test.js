import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRendererHost, rendererUrl } from './renderer.js';

const request = { protocol: 'https', host: 'app.example.com' };

test('without RENDERER_HOST the renderer uses the main page host and protocol', () => {
  for (const value of [undefined, '', '   ']) assert.equal(parseRendererHost(value), null);
  assert.equal(rendererUrl(request, null, 'abc'), 'https://app.example.com/render/abc/');
  assert.equal(rendererUrl({ protocol: 'http', host: 'localhost:5173' }, null, 'abc'), 'http://localhost:5173/render/abc/');
});

test('a renderer host name keeps the request protocol', () => {
  assert.deepEqual(parseRendererHost('render.example.com'), { host: 'render.example.com' });
  assert.equal(rendererUrl(request, parseRendererHost('Render.Example.com:8443'), 'abc'), 'https://render.example.com:8443/render/abc/');
});

test('a renderer origin sets the protocol explicitly', () => {
  assert.deepEqual(parseRendererHost('http://render.example.com/'), { origin: 'http://render.example.com' });
  assert.equal(rendererUrl(request, parseRendererHost('http://render.example.com'), 'abc'), 'http://render.example.com/render/abc/');
});

test('invalid renderer hosts are rejected at startup', () => {
  for (const value of ['render.example.com/path', 'https://render.example.com/path', 'ftp://render.example.com',
    'https://user:pass@render.example.com', 'https://render.example.com?x=1', 'bad host', 'render.example.com#x']) {
    assert.throws(() => parseRendererHost(value), /Invalid RENDERER_HOST/, value);
  }
});
