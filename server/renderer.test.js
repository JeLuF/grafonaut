import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHosts } from './hosts.js';
import { parseRendererHost, rendererDocument, rendererUrl } from './renderer.js';

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

test('invalid renderer hosts are rejected at startup', () => {
  for (const value of ['render.example.com/path', 'https://render.example.com', 'http://render.example.com/', 'https://render.example.com/path',
    'render.example.com, render2.example.com', 'ftp://render.example.com',
    'https://user:pass@render.example.com', 'https://render.example.com?x=1', 'bad host', 'render.example.com#x']) {
    assert.throws(() => parseRendererHost(value), /Invalid RENDERER_HOST/, value);
  }
});

test('in production, links to the own hosts are https even if the proxy reports http', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const plain = { protocol: 'http', host: 'render.example.com' };
    assert.equal(rendererUrl(plain, null, 'abc'), 'https://render.example.com/render/abc/');
    const page = rendererDocument(plain, 'abc', { isolated: true, graphicsOrigin: 'https://graphics.example.com' });
    assert.match(page.html, /"framePath":"https:\/\/graphics\.example\.com\/render\/frame"/);
    assert.match(page.headers['Content-Security-Policy'], /connect-src wss:\/\/render\.example\.com/);
    assert.equal(createHosts({ graphicsHost: { host: 'graphics.example.com' } }).graphicsOrigin(plain), 'https://graphics.example.com');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});
