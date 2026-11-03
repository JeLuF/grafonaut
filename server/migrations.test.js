import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

let queries;
let existingTables;
let applied;
let failures;
mock.module('mysql2/promise', { defaultExport: { createPool: () => ({ query: async (sql, parameters) => {
  queries.push({ sql, parameters });
  if (sql.startsWith('SHOW TABLES')) return [existingTables];
  if (sql.startsWith('SELECT name FROM schema_migrations')) return [applied.map((name) => ({ name }))];
  const failure = failures.find(([pattern]) => sql.includes(pattern));
  if (failure) throw Object.assign(new Error(failure[1]), { code: failure[1] });
  return [{ affectedRows: 1 }];
} }) } });
mock.module('./storage.js', { namedExports: { storageRoot: '/unused' } });
const { initializeDatabase } = await import('./db.js');

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-migrations-'));
after(() => fs.rm(directory, { recursive: true, force: true }));
const schemaFile = path.join(directory, 'schema.sql');
const migrationsDirectory = path.join(directory, 'migrations');
await fs.mkdir(migrationsDirectory);
await fs.writeFile(schemaFile, 'CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(190));\nCREATE TABLE IF NOT EXISTS media (id CHAR(36), source ENUM(\'file\',\'slide\'));\n');
await fs.writeFile(path.join(migrationsDirectory, '002-second.sql'), '-- second; step\nALTER TABLE media ADD COLUMN b INT;\nUPDATE media SET b = 1;\n');
await fs.writeFile(path.join(migrationsDirectory, '001-first.sql'), 'ALTER TABLE media ADD COLUMN source ENUM(\'file\',\'slide\');\n');
await fs.writeFile(path.join(migrationsDirectory, 'README.md'), 'not a migration');
beforeEach(() => { queries = []; existingTables = [{ table: 'accounts' }]; applied = []; failures = []; });
const run = () => initializeDatabase({ schemaFile, migrationsDirectory });
const executed = () => queries.map((query) => query.sql).filter((sql) => /^(ALTER|UPDATE)/.test(sql));
const recorded = () => queries.filter((query) => query.sql.startsWith('INSERT INTO schema_migrations')).map((query) => query.parameters[0]);

test('an existing database runs the missing upgrade scripts once, in name order', async () => {
  await run();
  assert.deepEqual(executed(), ["ALTER TABLE media ADD COLUMN source ENUM('file','slide')", 'ALTER TABLE media ADD COLUMN b INT', 'UPDATE media SET b = 1']);
  assert.deepEqual(recorded(), ['001-first.sql', '002-second.sql']);
  queries = [];
  applied = ['001-first.sql', '002-second.sql'];
  await run();
  assert.deepEqual(executed(), []);
  assert.deepEqual(recorded(), []);
});

test('a fresh database gets the complete schema and only records the upgrade scripts', async () => {
  existingTables = [];
  await run();
  assert.ok(queries.some((query) => query.sql.startsWith('CREATE TABLE IF NOT EXISTS media')));
  assert.deepEqual(executed(), []);
  assert.deepEqual(recorded(), ['001-first.sql', '002-second.sql']);
});

test('an interrupted upgrade can run again; other errors stop the start', async () => {
  applied = ['001-first.sql'];
  failures = [['ADD COLUMN b', 'ER_DUP_FIELDNAME']];
  await run();
  assert.deepEqual(recorded(), ['002-second.sql']);
  queries = [];
  failures = [['UPDATE media', 'ER_NO_SUCH_TABLE']];
  await assert.rejects(run(), /Database upgrade 002-second\.sql failed/);
  assert.deepEqual(recorded(), []);
});
