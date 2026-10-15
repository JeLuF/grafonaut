import crypto from 'node:crypto';
import express from 'express';

// Sign-in with Twitch and Google ("YouTube login"). Each provider has its own accounts; there is no linking.
// Every login attempt gets a random `state` kept in the signed session cookie and checked on the callback
// (protects against login CSRF); Google additionally uses PKCE (S256).
const STATE_TTL_MS = 10 * 60 * 1000;
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const challengeFor = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

export const providers = {
  twitch: {
    label: 'Twitch',
    env: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_REDIRECT_URI'],
    authorizeUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scope: 'user:read:email',
    pkce: false,
    async profile(fetchImpl, token, env) {
      const response = await fetchImpl('https://api.twitch.tv/helix/users', { headers: { Authorization: `Bearer ${token.access_token}`, 'Client-Id': env.TWITCH_CLIENT_ID } });
      const user = response.ok ? (await response.json()).data?.[0] : null;
      if (!user?.id) throw new Error('The Twitch profile is unavailable');
      return { providerUserId: String(user.id), login: user.login ?? null, displayName: user.display_name || user.login || 'Twitch user' };
    }
  },
  google: {
    label: 'YouTube',
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid profile',
    pkce: true,
    extraParams: { prompt: 'select_account' },
    async profile(fetchImpl, token) {
      const response = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } });
      const user = response.ok ? await response.json() : null;
      if (!user?.sub) throw new Error('The Google profile is unavailable');
      return { providerUserId: String(user.sub), login: null, displayName: user.name || user.given_name || 'YouTube user' };
    }
  }
};

const settingsOf = (name, env) => {
  const [clientId, clientSecret, redirectUri] = providers[name].env.map((key) => env[key]?.trim());
  return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null;
};

export function configuredProviders(env = process.env) {
  return Object.fromEntries(Object.keys(providers).map((name) => [name, Boolean(settingsOf(name, env))]));
}

const failurePage = (response, status, message) => response.status(status).type('html').set('Cache-Control', 'no-store')
  .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed · Grafonaut</title></head>
<body style="font:16px system-ui,sans-serif;background:#070b1e;color:#eef1ff;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:480px;text-align:center"><h1 style="font-size:24px">Sign-in failed</h1><p>${message}</p>
<p><a href="/" style="color:#4cc9ff">Back to Grafonaut</a></p></main></body></html>`);

export function createAuth({ upsertAccount, env = process.env, fetchImpl = fetch, now = () => Date.now() }) {
  const router = express.Router();
  router.get('/providers', (_request, response) => response.json({ providers: configuredProviders(env) }));
  // Sign-out: drops the session cookie. POST, so the app's same-origin check applies (no sign-out by cross-site links).
  router.post('/logout', (request, response) => {
    request.session = null;
    response.sendStatus(204);
  });

  for (const [name, provider] of Object.entries(providers)) {
    router.get(`/${name}`, (request, response) => {
      const settings = settingsOf(name, env);
      if (!settings) return failurePage(response, 503, `${provider.label} login is not configured on this server.`);
      const state = randomToken();
      const verifier = provider.pkce ? randomToken() : undefined;
      // The signed session cookie carries the pending login; it is replaced by the account on success.
      request.session = { ...(request.session ?? {}), oauth: { provider: name, state, verifier, created: now() } };
      const params = new URLSearchParams({ client_id: settings.clientId, redirect_uri: settings.redirectUri, response_type: 'code',
        scope: provider.scope, state, ...(verifier ? { code_challenge: challengeFor(verifier), code_challenge_method: 'S256' } : {}),
        ...(provider.extraParams ?? {}) });
      response.redirect(`${provider.authorizeUrl}?${params}`);
    });

    router.get(`/${name}/callback`, async (request, response) => {
      const settings = settingsOf(name, env);
      if (!settings) return failurePage(response, 503, `${provider.label} login is not configured on this server.`);
      const pending = request.session?.oauth;
      const { code, state, error } = request.query;
      // A login attempt is only accepted from the browser that started it, once, within STATE_TTL_MS.
      if (request.session) delete request.session.oauth;
      const stateValid = pending && pending.provider === name && typeof state === 'string' && typeof pending.state === 'string' &&
        state.length === pending.state.length && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state)) &&
        now() - pending.created <= STATE_TTL_MS;
      if (!stateValid) return failurePage(response, 400, 'This sign-in link has expired or was not started from this browser. Please try again.');
      if (error) return failurePage(response, 400, error === 'access_denied' ? `The ${provider.label} sign-in was cancelled.` : `${provider.label} reported an error: ${String(error).slice(0, 100).replace(/[<>&"']/g, '')}`);
      if (typeof code !== 'string' || !code) return failurePage(response, 400, `${provider.label} did not return a sign-in code.`);
      try {
        const body = new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, code,
          grant_type: 'authorization_code', redirect_uri: settings.redirectUri, ...(pending.verifier ? { code_verifier: pending.verifier } : {}) });
        const tokenResponse = await fetchImpl(provider.tokenUrl, { method: 'POST', body });
        const token = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !token.access_token) throw new Error(`The ${provider.label} sign-in could not be completed`);
        const identity = await provider.profile(fetchImpl, token, env);
        const account = await upsertAccount({ provider: name, ...identity });
        request.session = { accountId: account.id };
        response.redirect('/');
      } catch (failure) {
        console.error(`${provider.label} sign-in failed:`, failure.message);
        failurePage(response, 502, `${provider.label} sign-in failed. Please try again.`);
      }
    });
  }
  return router;
}
