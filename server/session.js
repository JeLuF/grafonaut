import cookieSession from 'cookie-session';

// Placeholders from the examples and earlier defaults: a cookie signed with a known secret can name any account.
const knownSecrets = new Set(['local-development-secret', 'change-me-in-production', 'replace-with-a-long-random-value', 'replace-me']);

// The secret that signs session cookies. In production it must be set, at least 32 characters long and not a
// published placeholder; the app refuses to start otherwise. Development falls back to a fixed secret.
export function sessionSecret(value, production) {
  const secret = String(value ?? '').trim();
  if (!production) return secret || 'local-development-secret';
  if (!secret || knownSecrets.has(secret) || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters in production (e.g. openssl rand -base64 48)');
  }
  return secret;
}

export function configureSession(app, {
  production = process.env.NODE_ENV === 'production',
  secret = sessionSecret(process.env.SESSION_SECRET, production),
  trustProxy = process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal'
} = {}) {
  app.set('trust proxy', trustProxy);
  app.use(cookieSession({ name: 'grafanaut_session', keys: [secret], httpOnly: true,
    sameSite: 'lax', secure: production }));
}
