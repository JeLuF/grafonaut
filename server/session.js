import cookieSession from 'cookie-session';

export function configureSession(app, {
  production = process.env.NODE_ENV === 'production',
  secret = process.env.SESSION_SECRET ?? 'local-development-secret',
  trustProxy = process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal'
} = {}) {
  app.set('trust proxy', trustProxy);
  app.use(cookieSession({ name: 'ograf_session', keys: [secret], httpOnly: true,
    sameSite: 'lax', secure: production }));
}