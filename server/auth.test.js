import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { after, beforeEach, test } from 'node:test';
import { configuredProviders, createAuth } from './auth.js';
import { configureSession } from './session.js';

const env = {
  TWITCH_CLIENT_ID: 'tw-id', TWITCH_CLIENT_SECRET: 'tw-secret', TWITCH_REDIRECT_URI: 'https://app.test/api/auth/twitch/callback',
  GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret', GOOGLE_REDIRECT_URI: 'https://app.test/api/auth/google/callback'
};
let accounts;
let calls;
let clock;
let tokenStatus;
// Simulated Twitch and Google endpoints.
const fakeFetch = async (url, options = {}) => {
  calls.push({ url, options });
  if (url.endsWith('/token')) return Response.json(tokenStatus === 200 ? { access_token: 'access-1', id_token: 'x' } : { error: 'invalid_grant' }, { status: tokenStatus });
  if (url.includes('helix/users')) return Response.json({ data: [{ id: '123', login: 'host', display_name: 'Host' }] });
  if (url.includes('userinfo')) return Response.json({ sub: 'g-987', name: 'Tube Host' });
  return new Response('not found', { status: 404 });
};
const upsertAccount = async (identity) => { accounts.push(identity); return { id: accounts.length }; };

function server(environment) {
  const app = express();
  configureSession(app, { production: false, secret: 'test-secret' });
  app.use('/api/auth', createAuth({ upsertAccount, env: environment, fetchImpl: fakeFetch, now: () => clock }));
  app.get('/whoami', (request, response) => response.json({ accountId: request.session?.accountId ?? null }));
  const listening = app.listen(0, '127.0.0.1');
  return listening;
}
const app = server(env);
await once(app, 'listening');
const base = `http://127.0.0.1:${app.address().port}`;
after(() => new Promise((resolve) => app.close(resolve)));
beforeEach(() => { accounts = []; calls = []; clock = 1_000_000; tokenStatus = 200; });

// A tiny browser: keeps the session cookie between requests.
function browser() {
  let cookie = '';
  return async (path, method = 'GET') => {
    const response = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: cookie ? { cookie } : {} });
    const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]);
    if (cookies.length) cookie = cookies.join('; ');
    return response;
  };
}
const startLogin = async (visit, provider) => new URL((await visit(`/api/auth/${provider}`)).headers.get('location'));

test('only fully configured providers are offered', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/auth/providers`)).json(), { providers: { twitch: true, google: true } });
  assert.deepEqual(configuredProviders({ ...env, GOOGLE_CLIENT_SECRET: '' }), { twitch: true, google: false });
  assert.deepEqual(configuredProviders({}), { twitch: false, google: false });
  const bare = server({ ...env, GOOGLE_REDIRECT_URI: ' ' });
  await once(bare, 'listening');
  const response = await fetch(`http://127.0.0.1:${bare.address().port}/api/auth/google`, { redirect: 'manual' });
  assert.equal(response.status, 503);
  await new Promise((resolve) => bare.close(resolve));
});

test('YouTube (Google) login uses state and PKCE and creates a Google account', async () => {
  const visit = browser();
  const authorize = await startLogin(visit, 'google');
  assert.equal(authorize.origin + authorize.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const params = Object.fromEntries(authorize.searchParams);
  assert.equal(params.scope, 'openid profile');
  assert.equal(params.code_challenge_method, 'S256');
  assert.equal(params.redirect_uri, env.GOOGLE_REDIRECT_URI);
  assert.match(params.state, /^[\w-]{43}$/);
  const callback = await visit(`/api/auth/google/callback?code=abc&state=${params.state}`);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/');
  const exchange = new URLSearchParams(calls[0].options.body);
  assert.equal(exchange.get('code'), 'abc');
  assert.equal(exchange.get('client_secret'), 'g-secret');
  assert.equal(crypto.createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), params.code_challenge);
  assert.deepEqual(accounts, [{ provider: 'google', providerUserId: 'g-987', login: null, displayName: 'Tube Host' }]);
  assert.deepEqual(await (await visit('/whoami')).json(), { accountId: 1 });
});

test('Twitch login checks the state too and creates a Twitch account', async () => {
  const visit = browser();
  const authorize = await startLogin(visit, 'twitch');
  assert.equal(authorize.searchParams.get('code_challenge'), null);
  const state = authorize.searchParams.get('state');
  assert.equal((await visit(`/api/auth/twitch/callback?code=abc&state=${state}`)).status, 302);
  assert.equal(new URLSearchParams(calls[0].options.body).get('code_verifier'), null);
  assert.deepEqual(accounts, [{ provider: 'twitch', providerUserId: '123', login: 'host', displayName: 'Host' }]);
});

test('callbacks with a wrong, missing, foreign, reused or expired state are refused', async () => {
  const visit = browser();
  const state = (await startLogin(visit, 'google')).searchParams.get('state');
  assert.equal((await visit('/api/auth/google/callback?code=abc&state=forged')).status, 400);
  // The failed attempt consumed the pending login, so even the right state no longer works.
  assert.equal((await visit(`/api/auth/google/callback?code=abc&state=${state}`)).status, 400);
  // A callback in a browser that never started a login (login CSRF).
  assert.equal((await fetch(`${base}/api/auth/google/callback?code=abc&state=${state}`, { redirect: 'manual' })).status, 400);
  const twitchState = (await startLogin(visit, 'twitch')).searchParams.get('state');
  assert.equal((await visit(`/api/auth/google/callback?code=abc&state=${twitchState}`)).status, 400);
  const expired = (await startLogin(visit, 'google')).searchParams.get('state');
  clock += 11 * 60 * 1000;
  const response = await visit(`/api/auth/google/callback?code=abc&state=${expired}`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /expired or was not started from this browser/);
  const used = (await startLogin(visit, 'google')).searchParams.get('state');
  assert.equal((await visit(`/api/auth/google/callback?code=abc&state=${used}`)).status, 302);
  assert.equal((await visit(`/api/auth/google/callback?code=abc&state=${used}`)).status, 400);
  assert.equal(accounts.length, 1);
  assert.equal(calls.filter(({ url }) => url.endsWith('/token')).length, 1);
});

test('cancelled logins and failed token exchanges show an explanation and sign nobody in', async () => {
  const visit = browser();
  let state = (await startLogin(visit, 'google')).searchParams.get('state');
  const cancelled = await visit(`/api/auth/google/callback?error=access_denied&state=${state}`);
  assert.equal(cancelled.status, 400);
  assert.match(await cancelled.text(), /The YouTube sign-in was cancelled/);
  tokenStatus = 400;
  state = (await startLogin(visit, 'google')).searchParams.get('state');
  const failed = await visit(`/api/auth/google/callback?code=bad&state=${state}`);
  assert.equal(failed.status, 502);
  assert.equal(accounts.length, 0);
  assert.deepEqual(await (await visit('/whoami')).json(), { accountId: null });
});

test('signing out drops the session', async () => {
  const visit = browser();
  const state = (await startLogin(visit, 'twitch')).searchParams.get('state');
  await visit(`/api/auth/twitch/callback?code=abc&state=${state}`);
  assert.deepEqual(await (await visit('/whoami')).json(), { accountId: 1 });
  assert.equal((await visit('/api/auth/logout', 'POST')).status, 204);
  assert.deepEqual(await (await visit('/whoami')).json(), { accountId: null });
});
