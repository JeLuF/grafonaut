import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mock, test } from 'node:test';

mock.module('mysql2/promise', { defaultExport: { createPool: () => ({ query: async () => [[]] }) } });
mock.module('./storage.js', { namedExports: { storageRoot: '/unused' } });
const { schemaStatements } = await import('./db.js');

test('schema.sql splits into complete statements even with semicolons in comments', async () => {
  const statements = schemaStatements(await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  assert.ok(statements.length >= 10);
  for (const statement of statements) assert.match(statement, /^(CREATE TABLE IF NOT EXISTS|ALTER TABLE) /, statement.slice(0, 80));
  assert.deepEqual(schemaStatements('-- note; with a semicolon\nCREATE TABLE a (id INT);\n  -- another; one\nALTER TABLE a ADD b INT;'),
    ['CREATE TABLE a (id INT)', 'ALTER TABLE a ADD b INT']);
});
