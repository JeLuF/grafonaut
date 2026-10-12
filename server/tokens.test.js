import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, mock, test } from 'node:test';
import { decryptToken, encryptToken, generateToken, hashToken, parseTokenKey, tokenPattern } from './tokens.js';

let rows;
let queries;
mock.module('mysql2/promise', { defaultExport: {
  createPool: () => ({ query: async (sql, parameters) => {
    queries.push({ sql, parameters });
    return sql.startsWith('SELECT') ? [rows.shift() ?? []] : [{ affectedRows: 1 }];
  } })
} });
mock.module('./storage.js', { namedExports: { storageRoot: '/unused' } });
const { ensureAccountToken, findAccountByToken, findAccountToken, rotateAccountToken, upsertTwitchAccount } = await import('./db.js');
beforeEach(() => { rows = []; queries = []; });

test('tokens are unpredictable 32-byte values', () => {
  const tokens = new Set(Array.from({ length: 200 }, generateToken));
  assert.equal(tokens.size, 200);
  for (const token of tokens) {
    assert.match(token, tokenPattern);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
  }
});

test('encryption round-trips and detects a wrong key or tampering', () => {
  const key = crypto.randomBytes(32);
  const token = generateToken();
  const stored = encryptToken(token, key);
  assert.equal(stored.includes(token), false);
  assert.notEqual(encryptToken(token, key), stored);
  assert.equal(decryptToken(stored, key), token);
  assert.throws(() => decryptToken(stored, crypto.randomBytes(32)));
  const parts = stored.split(':');
  parts[3] = Buffer.from('x'.repeat(43)).toString('base64url');
  assert.throws(() => decryptToken(parts.join(':'), key));
  assert.throws(() => decryptToken('plain-token', key), /Unsupported token format/);
});

test('the encryption key must be 32 bytes and is required in production', () => {
  const key = crypto.randomBytes(32);
  assert.deepEqual(parseTokenKey(key.toString('base64'), true), key);
  assert.deepEqual(parseTokenKey(key.toString('hex'), true), key);
  assert.throws(() => parseTokenKey('', true), /required in production/);
  assert.throws(() => parseTokenKey(crypto.randomBytes(16).toString('base64'), false), /exactly 32 bytes/);
  assert.equal(parseTokenKey(undefined, false).length, 32);
});

test('new accounts get a token without replacing an existing one', async () => {
  rows = [[{ id: 7, twitch_login: 'host' }]];
  await upsertTwitchAccount({ id: 'twitch-7', login: 'host', display_name: 'Host' });
  const insert = queries.at(-1);
  assert.match(insert.sql, /^INSERT IGNORE INTO account_tokens/);
  assert.equal(insert.parameters[0], 7);
  assert.match(insert.parameters[1], /^[0-9a-f]{64}$/);
  assert.equal(insert.parameters[1], hashToken(decryptToken(insert.parameters[2])));
});

test('the stored token is decrypted for display and created for accounts that predate tokens', async () => {
  const token = generateToken();
  rows = [[{ ciphertext: encryptToken(token) }]];
  assert.equal(await findAccountToken(7), token);
  rows = [[], [{ ciphertext: encryptToken(token) }]];
  assert.equal(await findAccountToken(7), token);
  assert.match(queries[2].sql, /^INSERT IGNORE INTO account_tokens/);
  rows = [[{ ciphertext: encryptToken(token, crypto.randomBytes(32)) }]];
  await assert.rejects(findAccountToken(7), (error) => error.code === 'TOKEN_UNREADABLE');
});

test('rotating replaces the token so the old one no longer resolves', async () => {
  const token = await rotateAccountToken(7);
  assert.match(queries[0].sql, /ON DUPLICATE KEY UPDATE token_hash = VALUES\(token_hash\)/);
  assert.deepEqual(queries[0].parameters.slice(0, 2), [7, hashToken(token)]);
  assert.notEqual(await rotateAccountToken(7), token);
  queries = [];
  rows = [[{ id: 7 }]];
  assert.deepEqual(await findAccountByToken(token), { id: 7 });
  assert.deepEqual(queries[0].parameters, [hashToken(token)]);
  for (const invalid of [undefined, '', 'short', `${token}x`, '../'.repeat(15)]) assert.equal(await findAccountByToken(invalid), null);
  assert.equal(queries.length, 1);
  await ensureAccountToken(8);
});
