import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { configureSession } from './session.js';

async function withSessionServer(options, run) {
  const app = express();
  configureSession(app, { production: true, secret: 'test-session-secret', ...options });
  app.get('/api/auth/twitch/callback', (request, response) => {
    request.session = { accountId: '7' };
    response.redirect('/');
  });
  app.get('/api/auth/me', (request, response) => response.json({ accountId: request.session?.accountId ?? null }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('HTTPS terminated by a trusted proxy sets secure session cookies on the callback redirect', async () => {
  await withSessionServer({}, async (url) => {
    const response = await fetch(`${url}/api/auth/twitch/callback`, { redirect: 'manual', headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.ok(cookies.some((cookie) => cookie.startsWith('ograf_session=')));
    assert.ok(cookies.some((cookie) => cookie.startsWith('ograf_session.sig=')));
    for (const cookie of cookies) {
      assert.match(cookie, /; secure/i);
      assert.match(cookie, /; httponly/i);
      assert.match(cookie, /; samesite=lax/i);
    }
    const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
    const account = await fetch(`${url}/api/auth/me`, { headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https' } });
    assert.equal((await account.json()).accountId, '7');
  });
});

test('production does not issue session cookies over plain HTTP', async () => {
  await withSessionServer({}, async (url) => {
    const response = await fetch(`${url}/api/auth/twitch/callback`, { redirect: 'manual' });
    assert.equal(response.headers.getSetCookie().length, 0);
  });
});

test('HTTPS headers from untrusted clients cannot enable secure-cookie issuance', async () => {
  await withSessionServer({ trustProxy: '10.20.30.40' }, async (url) => {
    const response = await fetch(`${url}/api/auth/twitch/callback`, { redirect: 'manual', headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(response.headers.getSetCookie().length, 0);
  });
});

test('development supports HTTP sessions without requiring a proxy', async () => {
  await withSessionServer({ production: false }, async (url) => {
    const response = await fetch(`${url}/api/auth/twitch/callback`, { redirect: 'manual' });
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.doesNotMatch(cookies[0], /; secure/i);
    const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
    assert.equal((await (await fetch(`${url}/api/auth/me`, { headers: { Cookie: cookie } })).json()).accountId, '7');
  });
});

test('tampered session cookies do not authenticate an account', async () => {
  await withSessionServer({}, async (url) => {
    const response = await fetch(`${url}/api/auth/twitch/callback`, { redirect: 'manual', headers: { 'X-Forwarded-Proto': 'https' } });
    const cookies = response.headers.getSetCookie();
    const signature = cookies.find((cookie) => cookie.startsWith('ograf_session.sig=')).split(';')[0];
    const cookie = `ograf_session=${Buffer.from(JSON.stringify({ accountId: '99' })).toString('base64')}; ${signature}`;
    const account = await fetch(`${url}/api/auth/me`, { headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https' } });
    assert.equal((await account.json()).accountId, null);
  });
});