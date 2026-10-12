import crypto from 'node:crypto';

// Account tokens scope the renderer URL (and later the OGraf Server API) to one account. They are stored
// AES-256-GCM encrypted so they can be shown again, plus a SHA-256 hash for lookups by token.
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const developmentKey = crypto.createHash('sha256').update('ograf-local-development-token-key').digest();
let cachedKey;

export function parseTokenKey(value, production) {
  const setting = value?.trim();
  if (!setting) {
    if (production) throw new Error('TOKEN_ENCRYPTION_KEY is required in production (32 random bytes, base64 or hex encoded)');
    return developmentKey;
  }
  const key = /^[0-9a-f]{64}$/i.test(setting) ? Buffer.from(setting, 'hex') : Buffer.from(setting, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes (e.g. `openssl rand -base64 32`)');
  return key;
}

export function tokenKey() {
  cachedKey ??= parseTokenKey(process.env.TOKEN_ENCRYPTION_KEY, process.env.NODE_ENV === 'production');
  return cachedKey;
}

export const generateToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function encryptToken(token, key = tokenKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ciphertext].map((part) => typeof part === 'string' ? part : part.toString('base64url')).join(':');
}

export function decryptToken(stored, key = tokenKey()) {
  const [version, iv, tag, ciphertext] = String(stored).split(':');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unsupported token format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
