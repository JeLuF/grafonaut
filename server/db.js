import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { storageRoot } from './storage.js';
import { findThumbnail, findThumbnails } from './thumbnails.js';
import { resolvePropertySchema } from './asset-files.js';
import { propertyDefaults } from './property-defaults.js';
import { decryptToken, encryptToken, generateToken, hashToken, tokenPattern } from './tokens.js';

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST ?? 'localhost',
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? 'ograf',
  password: process.env.MYSQL_PASSWORD ?? 'ograf',
  database: process.env.MYSQL_DATABASE ?? 'ograf',
  waitForConnections: true,
  connectionLimit: 10
});

export async function initializeDatabase() {
  const schema = await fs.readFile(path.resolve('db/schema.sql'), 'utf8');
  const statements = schema.split(';').map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME' && error.code !== 'ER_FK_DUP_NAME' && error.code !== 'ER_DUP_FIELDNAME') throw error;
    }
  }
}

export async function findAccountById(id) {
  const [rows] = await pool.query('SELECT id, twitch_login, twitch_display_name, is_approver FROM accounts WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function upsertTwitchAccount(profile) {
  await pool.query(`INSERT INTO accounts (twitch_user_id, twitch_login, twitch_display_name)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE twitch_login = VALUES(twitch_login), twitch_display_name = VALUES(twitch_display_name), updated_at = CURRENT_TIMESTAMP`,
  [profile.id, profile.login, profile.display_name ?? profile.login]);
  const [rows] = await pool.query('SELECT id, twitch_login, twitch_display_name, is_approver FROM accounts WHERE twitch_user_id = ?', [profile.id]);
  for (const kind of tokenKinds) await ensureAccountToken(rows[0].id, kind);
  return rows[0];
}

// Each token kind has its own table, so a token only ever unlocks the purpose it was issued for.
// (account_tokens predates the API token and holds renderer tokens.)
const tokenTables = { renderer: 'account_tokens', api: 'api_tokens' };
export const tokenKinds = Object.keys(tokenTables);
function tokenTable(kind) {
  if (!Object.hasOwn(tokenTables, kind)) throw new Error(`Unknown token kind: ${kind}`);
  return tokenTables[kind];
}

// Gives the account a random token unless it already has one (new accounts, and accounts created before the token kind existed).
export async function ensureAccountToken(accountId, kind = 'renderer') {
  const token = generateToken();
  await pool.query(`INSERT IGNORE INTO ${tokenTable(kind)} (account_id, token_hash, token_ciphertext) VALUES (?, ?, ?)`,
    [accountId, hashToken(token), encryptToken(token)]);
}

export async function findAccountToken(accountId, kind = 'renderer') {
  const select = `SELECT token_ciphertext AS ciphertext FROM ${tokenTable(kind)} WHERE account_id = ?`;
  let [rows] = await pool.query(select, [accountId]);
  if (!rows.length) {
    await ensureAccountToken(accountId, kind);
    [rows] = await pool.query(select, [accountId]);
  }
  try { return decryptToken(rows[0].ciphertext); }
  catch {
    const error = new Error('This token cannot be read with the current encryption key. Create a new token.');
    error.code = 'TOKEN_UNREADABLE';
    throw error;
  }
}

// Replaces the account token of one kind; every URL containing its previous value stops working.
export async function rotateAccountToken(accountId, kind = 'renderer') {
  const token = generateToken();
  await pool.query(`INSERT INTO ${tokenTable(kind)} (account_id, token_hash, token_ciphertext) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), token_ciphertext = VALUES(token_ciphertext), created_at = CURRENT_TIMESTAMP`,
  [accountId, hashToken(token), encryptToken(token)]);
  return token;
}

export async function findAccountByToken(token, kind = 'renderer') {
  const table = tokenTable(kind);
  if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
  const [rows] = await pool.query(`SELECT a.id, a.twitch_login, a.twitch_display_name FROM ${table} t
    JOIN accounts a ON a.id = t.account_id WHERE t.token_hash = ?`, [hashToken(token)]);
  return rows[0] ?? null;
}

export async function listPublishedCatalog() {
  const [rows] = await pool.query(`SELECT pv.id AS versionId, pv.version_label AS versionLabel,
      pv.manifest_name AS display_name, pv.manifest_description AS description,
      pv.manifest_json AS manifest, pv.manifest_file_relpath AS manifestFile,
      pv.main_file_relpath AS mainFile,
      p.id AS packageId
    FROM package_versions pv
    JOIN packages p ON p.id = pv.package_id
    WHERE pv.review_state = 'published' AND p.disabled = FALSE
    ORDER BY pv.created_at DESC`);
  return Promise.all(rows.map(async (row) => {
    const { manifest, manifestFile, mainFile, ...item } = row;
    const thumbnail = await findThumbnail(row, storageRoot);
    return { ...item, thumbnailUrl: thumbnail ? `/api/catalog/${encodeURIComponent(row.versionId)}/thumbnail` : null };
  }));
}

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function authorInfo(author) {
  if (typeof author === 'string') return text(author) ? { name: text(author), email: null, url: null } : null;
  if (!isObject(author)) return null;
  let url = text(author.url);
  if (url) {
    try {
      const parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`);
      url = ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
    } catch { url = null; }
  }
  const email = text(author.email);
  const info = { name: text(author.name), email: email && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null, url };
  return info.name || info.email || info.url ? info : null;
}

function constraint(value) {
  if (typeof value === 'number') return { exact: value };
  if (!isObject(value)) return null;
  const result = Object.fromEntries(['exact', 'ideal', 'min', 'max'].filter((key) => typeof value[key] === 'number').map((key) => [key, value[key]]));
  return Object.keys(result).length ? result : null;
}

export function catalogDetails(manifest) {
  const durations = Array.isArray(manifest?.actionDurations) ? manifest.actionDurations.filter(isObject) : [];
  const durationOf = (type, id) => durations.find((item) => item.type === type && (id === undefined || item.customActionId === id))?.duration ?? null;
  const properties = isObject(manifest?.schema?.properties) ? manifest.schema.properties : {};
  return {
    manifestVersion: text(manifest?.version),
    author: authorInfo(manifest?.author),
    supportsRealTime: manifest?.supportsRealTime === true,
    supportsNonRealTime: manifest?.supportsNonRealTime === true,
    stepCount: Number.isInteger(manifest?.stepCount) ? manifest.stepCount : null,
    actions: ['playAction', 'updateAction', 'stopAction'].map((type) => ({ type, duration: durationOf(type) })),
    customActions: (Array.isArray(manifest?.customActions) ? manifest.customActions : [])
      .filter((action) => isObject(action) && text(action.id))
      .map((action) => ({ id: text(action.id), name: text(action.name) ?? text(action.id), description: text(action.description),
        hasParameters: isObject(action.schema), duration: durationOf('customAction', action.id) })),
    renderRequirements: (Array.isArray(manifest?.renderRequirements) ? manifest.renderRequirements : []).filter(isObject).map((requirement) => ({
      width: constraint(requirement.resolution?.width), height: constraint(requirement.resolution?.height), frameRate: constraint(requirement.frameRate)
    })),
    properties: Object.entries(properties).filter(([, property]) => isObject(property) && property.hidden !== true).map(([key, property]) => ({
      key, title: text(property.title) ?? text(property.label) ?? key, description: text(property.description),
      type: property.v_spx?.ftype === 'filelist' && typeof property.v_spx.extension === 'string' ? `file (${property.v_spx.extension})`
        : typeof property.type === 'string' ? property.type : null
    }))
  };
}

export async function findPublishedCatalogItem(versionId) {
  const [rows] = await pool.query(`SELECT pv.id AS versionId, pv.version_label AS versionLabel,
      pv.manifest_name AS display_name, pv.manifest_description AS description,
      pv.manifest_json AS manifest, pv.manifest_file_relpath AS manifestFile,
      pv.main_file_relpath AS mainFile, pv.source, pv.created_at AS publishedAt,
      p.id AS packageId, p.manifest_id AS manifestId
    FROM package_versions pv JOIN packages p ON p.id = pv.package_id
    WHERE pv.id = ? AND pv.review_state = 'published' AND p.disabled = FALSE`, [versionId]);
  const row = rows[0];
  if (!row) return null;
  const { manifest, manifestFile, mainFile, ...item } = row;
  const thumbnails = await findThumbnails(row, storageRoot);
  return { ...item, ...catalogDetails(manifest),
    thumbnailUrl: thumbnails.length ? `/api/catalog/${encodeURIComponent(row.versionId)}/thumbnail` : null,
    thumbnails: thumbnails.map(({ index }) => {
      const declared = manifest.thumbnails[index];
      const width = declared.resolution?.width;
      const height = declared.resolution?.height;
      return { url: `/api/catalog/${encodeURIComponent(row.versionId)}/thumbnails/${index}`,
        width: Number.isFinite(width) ? width : null, height: Number.isFinite(height) ? height : null, animated: declared.animated === true };
    }) };
}

export async function findPublishedVersion(versionId) {
  const [rows] = await pool.query(`SELECT pv.id AS versionId, pv.package_id AS packageId,
      pv.manifest_json AS manifest, pv.manifest_file_relpath AS manifestFile,
      pv.main_file_relpath AS mainFile
    FROM package_versions pv JOIN packages p ON p.id = pv.package_id
    WHERE pv.id = ? AND pv.review_state = 'published' AND p.disabled = FALSE`, [versionId]);
  return rows[0] ?? null;
}

const addableVersion = `FROM package_versions pv
    JOIN packages p ON p.id = pv.package_id
    WHERE pv.id = ? AND p.disabled = FALSE
      AND (pv.review_state = 'published' OR p.owner_account_id = ?)`;

// New entries start with the schema defaults as their properties.
export async function addMyGraphic(accountId, versionId) {
  const [versions] = await pool.query(`SELECT pv.manifest_json AS manifest ${addableVersion}`, [versionId, accountId]);
  if (!versions.length) throw new Error('Available graphic version not found');
  const [result] = await pool.query(`INSERT INTO my_graphics_entries (account_id, package_version_id, schema_data)
    SELECT ?, pv.id, ? ${addableVersion}`, [accountId, JSON.stringify(propertyDefaults(versions[0].manifest?.schema)), versionId, accountId]);
  if (result.affectedRows !== 1) throw new Error('Available graphic version not found');
  return String(result.insertId);
}

// One-time fix for entries added before defaults were stored on creation: fills entries whose properties were
// never saved (still an empty object) with the schema defaults. Returns the number of updated entries.
export async function backfillPropertyDefaults() {
  const [rows] = await pool.query(`SELECT g.id, pv.manifest_json AS manifest FROM my_graphics_entries g
    JOIN package_versions pv ON pv.id = g.package_version_id WHERE JSON_LENGTH(g.schema_data) = 0`);
  let updated = 0;
  for (const row of rows) {
    const defaults = propertyDefaults(row.manifest?.schema);
    if (!Object.keys(defaults).length) continue;
    const [result] = await pool.query('UPDATE my_graphics_entries SET schema_data = ? WHERE id = ? AND JSON_LENGTH(schema_data) = 0',
      [JSON.stringify(defaults), row.id]);
    updated += result.affectedRows;
  }
  return updated;
}

const myGraphicsSelect = `SELECT CAST(g.id AS CHAR) AS entryId, g.label, g.enabled,
    g.schema_data AS schemaData, pv.id AS versionId, pv.version_label AS versionLabel,
    pv.manifest_name AS display_name, pv.manifest_description AS description,
    pv.manifest_json AS manifest, pv.manifest_file_relpath AS manifestFile,
    pv.main_file_relpath AS mainFile, pv.source, p.id AS packageId,
    p.disabled AS packageDisabled,
    CASE WHEN p.owner_account_id = g.account_id THEN 'upload' ELSE 'catalog' END AS origin
  FROM my_graphics_entries g
  JOIN package_versions pv ON pv.id = g.package_version_id
  JOIN packages p ON p.id = pv.package_id`;

export async function listMyGraphics(accountId) {
  const [rows] = await pool.query(`${myGraphicsSelect}
    WHERE g.account_id = ? ORDER BY g.sort_position IS NULL, g.sort_position, g.created_at DESC, g.id DESC`, [accountId]);
  return Promise.all(rows.map(async (row) => {
    const { manifest, manifestFile, mainFile, ...item } = row;
    const [thumbnail, schema] = await Promise.all([!row.packageDisabled && findThumbnail(row, storageRoot), resolvePropertySchema(row, storageRoot)]);
    return { ...item, enabled: Boolean(row.enabled), packageDisabled: Boolean(row.packageDisabled), schema,
      thumbnailUrl: thumbnail ? `/api/my-graphics/${encodeURIComponent(row.entryId)}/thumbnail` : null };
  }));
}

export async function findMyGraphic(accountId, entryId) {
  const [rows] = await pool.query(`${myGraphicsSelect} WHERE g.account_id = ? AND g.id = ?`, [accountId, entryId]);
  return rows[0] ?? null;
}

export async function deleteMyGraphic(accountId, entryId) {
  const [result] = await pool.query('DELETE FROM my_graphics_entries WHERE account_id = ? AND id = ?', [accountId, entryId]);
  return result.affectedRows === 1;
}

export async function reorderMyGraphics(accountId, entryIds) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM accounts WHERE id = ? FOR UPDATE', [accountId]);
    const [entries] = await connection.query('SELECT CAST(id AS CHAR) AS entryId FROM my_graphics_entries WHERE account_id = ? FOR UPDATE', [accountId]);
    const ownedIds = new Set(entries.map((entry) => entry.entryId));
    if (entryIds.length !== ownedIds.size || new Set(entryIds).size !== entryIds.length || entryIds.some((entryId) => !ownedIds.has(entryId))) {
      const error = new Error('My Graphics changed. Refresh the list and try again.');
      error.code = 'STALE_GRAPHICS_ORDER';
      throw error;
    }
    if (entryIds.length) {
      const positions = entryIds.map(() => 'WHEN ? THEN ?').join(' ');
      const values = entryIds.flatMap((entryId, index) => [entryId, index]);
      await connection.query(`UPDATE my_graphics_entries SET sort_position = CASE id ${positions} ELSE sort_position END WHERE account_id = ?`, [...values, accountId]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

export async function updateMyGraphic(accountId, entryId, changes) {
  const fields = [];
  const values = [];
  if (Object.hasOwn(changes, 'label')) { fields.push('label = ?'); values.push(changes.label); }
  if (Object.hasOwn(changes, 'enabled')) { fields.push('enabled = ?'); values.push(changes.enabled); }
  if (Object.hasOwn(changes, 'schemaData')) { fields.push('schema_data = ?'); values.push(JSON.stringify(changes.schemaData)); }
  if (!fields.length) return;
  await pool.query(`UPDATE my_graphics_entries SET ${fields.join(', ')} WHERE account_id = ? AND id = ?`, [...values, accountId, entryId]);
}

// ---- Renderer state: one graphic instance per My Graphics entry, in My Graphics order ----

export async function listRenderEntries(accountId) {
  const [rows] = await pool.query(`SELECT CAST(g.id AS CHAR) AS entryId, g.label, g.enabled,
      pv.id AS versionId, pv.version_label AS versionLabel, pv.manifest_name AS display_name,
      pv.manifest_description AS description, pv.main_file_relpath AS mainFile, p.disabled AS packageDisabled
    FROM my_graphics_entries g
    JOIN package_versions pv ON pv.id = g.package_version_id
    JOIN packages p ON p.id = pv.package_id
    WHERE g.account_id = ? ORDER BY g.sort_position IS NULL, g.sort_position, g.created_at DESC, g.id DESC`, [accountId]);
  return rows.map((row) => ({ ...row, enabled: Boolean(row.enabled), packageDisabled: Boolean(row.packageDisabled) }));
}

export async function listRenderInstances(accountId) {
  const [rows] = await pool.query(`SELECT CAST(r.entry_id AS CHAR) AS entryId, r.instance_id AS instanceId, r.data,
      r.current_step AS currentStep, r.playing, pv.id AS versionId, pv.main_file_relpath AS mainFile
    FROM render_instances r
    JOIN my_graphics_entries g ON g.id = r.entry_id AND g.account_id = r.account_id
    JOIN package_versions pv ON pv.id = g.package_version_id
    WHERE r.account_id = ?`, [accountId]);
  return rows.map((row) => ({ ...row, playing: Boolean(row.playing), data: row.data ?? {} }));
}

export async function saveRenderInstance(accountId, entryId, { instanceId, data, currentStep = null, playing = false }) {
  await pool.query(`INSERT INTO render_instances (entry_id, account_id, instance_id, data, current_step, playing)
    SELECT g.id, g.account_id, ?, ?, ?, ? FROM my_graphics_entries g WHERE g.id = ? AND g.account_id = ?
    ON DUPLICATE KEY UPDATE instance_id = VALUES(instance_id), data = VALUES(data), current_step = VALUES(current_step), playing = VALUES(playing)`,
  [instanceId, JSON.stringify(data ?? {}), currentStep, playing, entryId, accountId]);
}

export async function deleteRenderInstances(accountId, entryIds) {
  if (!entryIds.length) return;
  await pool.query('DELETE FROM render_instances WHERE account_id = ? AND entry_id IN (?)', [accountId, entryIds]);
}

export async function findAccountGraphic(accountId, versionId) {
  const [rows] = await pool.query(`SELECT pv.manifest_json AS manifest, pv.created_at AS createdAt
    FROM my_graphics_entries g JOIN package_versions pv ON pv.id = g.package_version_id
    WHERE g.account_id = ? AND pv.id = ? LIMIT 1`, [accountId, versionId]);
  return rows[0] ?? null;
}

export async function findVersionByChecksum(checksum) {
  const [rows] = await pool.query('SELECT id FROM package_versions WHERE zip_checksum_sha256 = ?', [checksum]);
  return rows[0] ?? null;
}

export async function saveSeedPackage(packageRecord, versionRecord) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`INSERT INTO packages (id, manifest_id, display_name)
      VALUES (?, ?, ?)`, [packageRecord.id, packageRecord.manifestId, packageRecord.displayName]);
    await connection.query(`INSERT INTO package_versions
      (id, package_id, version_label, manifest_name, manifest_description, manifest_json, manifest_file_relpath, main_file_relpath,
       zip_checksum_sha256, zip_size_bytes, uncompressed_size_bytes, file_count, source, review_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`, [
      versionRecord.id, packageRecord.id, versionRecord.versionLabel, versionRecord.manifestName,
      versionRecord.description, JSON.stringify(versionRecord.manifest), versionRecord.manifestFile ?? null, versionRecord.mainFile,
      versionRecord.checksum, versionRecord.zipSize, versionRecord.uncompressedSize, versionRecord.fileCount,
      versionRecord.source
    ]);
    await connection.query(`UPDATE packages SET latest_version_id = ?, current_published_version_id = ? WHERE id = ?`, [versionRecord.id, versionRecord.id, packageRecord.id]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export { pool };
