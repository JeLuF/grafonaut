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

// Splits schema.sql into statements. Full-line `--` comments are dropped first, so a semicolon inside a comment
// cannot split a statement (statements themselves must not contain semicolons in string literals).
export function schemaStatements(schema) {
  return schema.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n')
    .split(';').map((statement) => statement.trim()).filter(Boolean);
}

export async function initializeDatabase() {
  const schema = await fs.readFile(path.resolve('db/schema.sql'), 'utf8');
  const statements = schemaStatements(schema);
  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME' && error.code !== 'ER_FK_DUP_NAME' && error.code !== 'ER_DUP_FIELDNAME') throw error;
    }
  }
}

export async function findAccountById(id) {
  const [rows] = await pool.query('SELECT id, provider, login, display_name, is_approver FROM accounts WHERE id = ?', [id]);
  return rows[0] ?? null;
}

// Creates or updates the account of one login identity ({ provider, providerUserId, login, displayName }).
export async function upsertAccount({ provider, providerUserId, login = null, displayName }) {
  await pool.query(`INSERT INTO accounts (provider, provider_user_id, login, display_name)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE login = VALUES(login), display_name = VALUES(display_name), updated_at = CURRENT_TIMESTAMP`,
  [provider, providerUserId, login, displayName]);
  const [rows] = await pool.query('SELECT id, provider, login, display_name, is_approver FROM accounts WHERE provider = ? AND provider_user_id = ?', [provider, providerUserId]);
  for (const kind of tokenKinds) await ensureAccountToken(rows[0].id, kind);
  await ensureCurrentRundown(rows[0].id);
  return rows[0];
}

// ---- Rundowns: My Graphics entries are grouped per event; the current rundown is what My Graphics, the
// renderer and the OGraf API work with. ----

export const defaultRundownName = 'Default rundown';
export class RundownError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}
// Restricts my_graphics_entries g to the account's current rundown.
const currentRundown = 'JOIN accounts cur ON cur.id = g.account_id AND cur.current_rundown_id = g.rundown_id';

async function inTransaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

// Returns the current rundown ID, creating the default rundown for accounts that have none yet.
export async function ensureCurrentRundown(accountId) {
  const [[account]] = await pool.query('SELECT current_rundown_id AS rundownId FROM accounts WHERE id = ?', [accountId]);
  if (account?.rundownId) return String(account.rundownId);
  return inTransaction(async (connection) => {
    const [[locked]] = await connection.query('SELECT current_rundown_id AS rundownId FROM accounts WHERE id = ? FOR UPDATE', [accountId]);
    if (!locked) throw new RundownError('NOT_FOUND', 'Account not found');
    if (locked.rundownId) return String(locked.rundownId);
    const [[existing]] = await connection.query('SELECT id FROM rundowns WHERE account_id = ? ORDER BY id LIMIT 1', [accountId]);
    const rundownId = existing?.id ?? (await connection.query('INSERT INTO rundowns (account_id, name) VALUES (?, ?)', [accountId, defaultRundownName]))[0].insertId;
    await connection.query('UPDATE accounts SET current_rundown_id = ? WHERE id = ?', [rundownId, accountId]);
    return String(rundownId);
  });
}

export async function listRundowns(accountId) {
  const currentRundownId = await ensureCurrentRundown(accountId);
  const [rows] = await pool.query(`SELECT CAST(r.id AS CHAR) AS id, r.name, COUNT(g.id) AS entryCount
    FROM rundowns r LEFT JOIN my_graphics_entries g ON g.rundown_id = r.id
    WHERE r.account_id = ? GROUP BY r.id, r.name ORDER BY r.created_at, r.id`, [accountId]);
  return { currentRundownId, rundowns: rows.map((row) => ({ ...row, entryCount: Number(row.entryCount) })) };
}

const duplicateName = (error) => error?.code === 'ER_DUP_ENTRY' ? new RundownError('DUPLICATE_NAME', 'A rundown with this name already exists') : error;

export async function createRundown(accountId, name) {
  try {
    const [result] = await pool.query('INSERT INTO rundowns (account_id, name) VALUES (?, ?)', [accountId, name]);
    return { id: String(result.insertId), name, entryCount: 0 };
  } catch (error) { throw duplicateName(error); }
}

export async function renameRundown(accountId, rundownId, name) {
  const [[rundown]] = await pool.query('SELECT id FROM rundowns WHERE id = ? AND account_id = ?', [rundownId, accountId]);
  if (!rundown) throw new RundownError('NOT_FOUND', 'Rundown not found');
  try { await pool.query('UPDATE rundowns SET name = ? WHERE id = ? AND account_id = ?', [name, rundownId, accountId]); }
  catch (error) { throw duplicateName(error); }
}

// Deletes a rundown together with its entries. The current rundown cannot be deleted (switch first), so deleting
// never affects what is on air and every account keeps at least one rundown.
export async function deleteRundown(accountId, rundownId) {
  return inTransaction(async (connection) => {
    const [[account]] = await connection.query('SELECT current_rundown_id AS rundownId FROM accounts WHERE id = ? FOR UPDATE', [accountId]);
    if (account && String(account.rundownId) === String(rundownId)) {
      throw new RundownError('CURRENT', 'The current rundown cannot be deleted. Switch to another rundown first.');
    }
    const [result] = await connection.query('DELETE FROM rundowns WHERE id = ? AND account_id = ?', [rundownId, accountId]);
    if (!account || result.affectedRows !== 1) throw new RundownError('NOT_FOUND', 'Rundown not found');
  });
}

// Makes another rundown current. Graphics of the previous rundown go off air, so this is refused while some are
// loaded unless `force` is set.
export async function switchRundown(accountId, rundownId, { force = false } = {}) {
  return inTransaction(async (connection) => {
    const [[account]] = await connection.query('SELECT current_rundown_id AS rundownId FROM accounts WHERE id = ? FOR UPDATE', [accountId]);
    const [[rundown]] = await connection.query('SELECT id FROM rundowns WHERE id = ? AND account_id = ?', [rundownId, accountId]);
    if (!account || !rundown) throw new RundownError('NOT_FOUND', 'Rundown not found');
    if (String(account.rundownId) === String(rundownId)) return { changed: false };
    const [[{ onAir }]] = await connection.query('SELECT COUNT(*) AS onAir FROM render_instances WHERE account_id = ?', [accountId]);
    if (Number(onAir) && !force) {
      throw new RundownError('ON_AIR', `${onAir} graphic${Number(onAir) === 1 ? ' is' : 's are'} on air in the current rundown`, { onAir: Number(onAir) });
    }
    await connection.query('DELETE FROM render_instances WHERE account_id = ?', [accountId]);
    await connection.query('UPDATE accounts SET current_rundown_id = ? WHERE id = ?', [rundownId, accountId]);
    return { changed: true };
  });
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
  const [rows] = await pool.query(`SELECT a.id, a.login, a.display_name FROM ${table} t
    JOIN accounts a ON a.id = t.account_id WHERE t.token_hash = ?`, [hashToken(token)]);
  return rows[0] ?? null;
}

export async function listPublishedCatalog() {
  const [rows] = await pool.query(`SELECT pv.id AS versionId, pv.archive_id AS archiveId, pv.version_label AS versionLabel,
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
    // GDD `order`: lower values first; properties without an order follow in manifest order.
    properties: Object.entries(properties).map((entry, index) => ({ entry, index }))
      .sort((a, b) => ((typeof a.entry[1]?.order === 'number' ? a.entry[1].order : Infinity) - (typeof b.entry[1]?.order === 'number' ? b.entry[1].order : Infinity)) || (a.index - b.index))
      .map(({ entry }) => entry).filter(([, property]) => isObject(property) && property.hidden !== true).map(([key, property]) => ({
      key, title: text(property.title) ?? text(property.label) ?? key, description: text(property.description),
      type: property.v_spx?.ftype === 'filelist' && typeof property.v_spx.extension === 'string' ? `file (${property.v_spx.extension})`
        : typeof property.type === 'string' ? property.type : null
    }))
  };
}

// Published graphics are visible to everyone; private uploads only to the account that owns them.
function visibleTo(accountId) {
  return accountId == null ? { sql: "pv.review_state = 'published'", params: [] }
    : { sql: "(pv.review_state = 'published' OR p.owner_account_id = ?)", params: [accountId] };
}

export const findPublishedCatalogItem = (versionId) => findCatalogItem(versionId, null);

export async function findCatalogItem(versionId, accountId = null) {
  const visible = visibleTo(accountId);
  const [rows] = await pool.query(`SELECT pv.id AS versionId, pv.archive_id AS archiveId, pv.version_label AS versionLabel,
      pv.manifest_name AS display_name, pv.manifest_description AS description,
      pv.manifest_json AS manifest, pv.manifest_file_relpath AS manifestFile,
      pv.main_file_relpath AS mainFile, pv.source, pv.created_at AS publishedAt,
      pv.review_state AS reviewState, p.id AS packageId, p.manifest_id AS manifestId
    FROM package_versions pv JOIN packages p ON p.id = pv.package_id
    WHERE pv.id = ? AND ${visible.sql} AND p.disabled = FALSE`, [versionId, ...visible.params]);
  const row = rows[0];
  if (!row) return null;
  const { manifest, manifestFile, mainFile, reviewState, ...item } = row;
  const thumbnails = await findThumbnails(row, storageRoot);
  return { ...item, isPrivate: reviewState !== 'published', ...catalogDetails(manifest),
    thumbnailUrl: thumbnails.length ? `/api/catalog/${encodeURIComponent(row.versionId)}/thumbnail` : null,
    thumbnails: thumbnails.map(({ index }) => {
      const declared = manifest.thumbnails[index];
      const width = declared.resolution?.width;
      const height = declared.resolution?.height;
      return { url: `/api/catalog/${encodeURIComponent(row.versionId)}/thumbnails/${index}`,
        width: Number.isFinite(width) ? width : null, height: Number.isFinite(height) ? height : null, animated: declared.animated === true };
    }) };
}

export const findPublishedVersion = (versionId) => findVisibleVersion(versionId, null);

export async function findVisibleVersion(versionId, accountId = null) {
  const visible = visibleTo(accountId);
  const [rows] = await pool.query(`SELECT pv.id AS versionId, pv.archive_id AS archiveId, pv.package_id AS packageId,
      pv.manifest_json AS manifest, pv.manifest_file_relpath AS manifestFile,
      pv.main_file_relpath AS mainFile
    FROM package_versions pv JOIN packages p ON p.id = pv.package_id
    WHERE pv.id = ? AND ${visible.sql} AND p.disabled = FALSE`, [versionId, ...visible.params]);
  return rows[0] ?? null;
}

// Files of any version of an enabled package, for graphic frames in the renderer. Version IDs are random UUIDs that
// only the owner sees for private uploads, so they act as the capability for private package files.
export async function findRenderableVersion(versionId) {
  const [rows] = await pool.query(`SELECT pv.id AS versionId, pv.archive_id AS archiveId, pv.package_id AS packageId, pv.main_file_relpath AS mainFile
    FROM package_versions pv JOIN packages p ON p.id = pv.package_id
    WHERE pv.id = ? AND p.disabled = FALSE`, [versionId]);
  return rows[0] ?? null;
}

// ---- Private catalog: packages uploaded by an account, newest version each ----

export async function listPrivateCatalog(accountId) {
  const [rows] = await pool.query(`SELECT pv.id AS versionId, pv.archive_id AS archiveId, pv.version_label AS versionLabel,
      pv.manifest_name AS display_name, pv.manifest_description AS description,
      pv.manifest_json AS manifest, pv.manifest_file_relpath AS manifestFile, pv.main_file_relpath AS mainFile,
      pv.created_at AS uploadedAt, p.id AS packageId,
      (SELECT COUNT(*) FROM package_versions other WHERE other.package_id = p.id) AS versionCount
    FROM packages p JOIN package_versions pv ON pv.id = p.latest_version_id
    WHERE p.owner_account_id = ? AND p.disabled = FALSE
    ORDER BY pv.created_at DESC, pv.id`, [accountId]);
  return Promise.all(rows.map(async (row) => {
    const { manifest, manifestFile, mainFile, ...item } = row;
    const thumbnail = await findThumbnail(row, storageRoot);
    return { ...item, versionCount: Number(row.versionCount), isPrivate: true,
      thumbnailUrl: thumbnail ? `/api/catalog/${encodeURIComponent(row.versionId)}/thumbnail` : null };
  }));
}

export async function findOwnedUpload(accountId, checksum) {
  const [rows] = await pool.query(`SELECT pv.id AS versionId, pv.archive_id AS archiveId, pv.manifest_name AS name, pv.version_label AS versionLabel
    FROM package_versions pv JOIN packages p ON p.id = pv.package_id
    WHERE p.owner_account_id = ? AND pv.zip_checksum_sha256 = ? LIMIT 1`, [accountId, checksum]);
  return rows[0] ?? null;
}

export async function findOwnedPackageId(accountId, manifestId) {
  const [rows] = await pool.query('SELECT id FROM packages WHERE owner_account_id = ? AND manifest_id = ?', [accountId, manifestId]);
  return rows[0]?.id ?? null;
}

// Saves all graphics of one upload as new private (draft) versions in a single transaction, so an upload is stored
// completely or not at all. A graphic whose package (same manifest id) exists becomes a new version of it.
export async function saveUploadedVersions(accountId, versions) {
  await inTransaction(async (connection) => {
    for (const version of versions) {
      if (version.isNewPackage) {
        await connection.query('INSERT INTO packages (id, owner_account_id, manifest_id, display_name) VALUES (?, ?, ?, ?)',
          [version.packageId, accountId, version.manifestId, version.manifestName]);
      }
      await connection.query(`INSERT INTO package_versions
        (id, package_id, archive_id, version_label, manifest_name, manifest_description, manifest_json, manifest_file_relpath, main_file_relpath,
         zip_checksum_sha256, zip_size_bytes, uncompressed_size_bytes, file_count, source, uploaded_by_account_id, review_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_upload', ?, 'draft')`, [
        version.id, version.packageId, version.archiveId, version.versionLabel, version.manifestName, version.description,
        JSON.stringify(version.manifest), version.manifestFile, version.mainFile, version.checksum, version.zipSize,
        version.uncompressedSize, version.fileCount, accountId
      ]);
      await connection.query('UPDATE packages SET latest_version_id = ?, display_name = ? WHERE id = ? AND owner_account_id = ?',
        [version.id, version.manifestName, version.packageId, accountId]);
    }
  });
}

const addableVersion = `FROM package_versions pv
    JOIN packages p ON p.id = pv.package_id
    WHERE pv.id = ? AND p.disabled = FALSE
      AND (pv.review_state = 'published' OR p.owner_account_id = ?)`;

// New entries go to the current rundown and start with the schema defaults as their properties.
export async function addMyGraphic(accountId, versionId) {
  const [versions] = await pool.query(`SELECT pv.manifest_json AS manifest ${addableVersion}`, [versionId, accountId]);
  if (!versions.length) throw new Error('Available graphic version not found');
  const rundownId = await ensureCurrentRundown(accountId);
  const [result] = await pool.query(`INSERT INTO my_graphics_entries (account_id, rundown_id, package_version_id, schema_data)
    SELECT ?, ?, pv.id, ? ${addableVersion}`, [accountId, rundownId, JSON.stringify(propertyDefaults(versions[0].manifest?.schema)), versionId, accountId]);
  if (result.affectedRows !== 1) throw new Error('Available graphic version not found');
  return String(result.insertId);
}

const myGraphicsSelect = `SELECT CAST(g.id AS CHAR) AS entryId, g.label, g.enabled,
    g.schema_data AS schemaData, pv.id AS versionId, pv.archive_id AS archiveId, pv.version_label AS versionLabel,
    pv.manifest_name AS display_name, pv.manifest_description AS description,
    pv.manifest_json AS manifest, pv.manifest_file_relpath AS manifestFile,
    pv.main_file_relpath AS mainFile, pv.source, p.id AS packageId,
    p.disabled AS packageDisabled,
    CASE WHEN p.owner_account_id = g.account_id THEN 'upload' ELSE 'catalog' END AS origin
  FROM my_graphics_entries g
  JOIN package_versions pv ON pv.id = g.package_version_id
  JOIN packages p ON p.id = pv.package_id`;

// The custom actions a graphic declares in its manifest: id, display name, description and the optional JSON schema
// of the action's payload.
export function manifestCustomActions(manifest) {
  if (!Array.isArray(manifest?.customActions)) return [];
  return manifest.customActions
    .filter((action) => action && typeof action === 'object' && typeof action.id === 'string' && action.id.trim())
    .map((action) => ({
      id: action.id,
      name: typeof action.name === 'string' && action.name.trim() ? action.name : action.id,
      description: typeof action.description === 'string' ? action.description : null,
      schema: action.schema && typeof action.schema === 'object' && !Array.isArray(action.schema) ? action.schema : null
    }));
}

export async function listMyGraphics(accountId) {
  const [rows] = await pool.query(`${myGraphicsSelect} ${currentRundown}
    WHERE g.account_id = ? ORDER BY g.sort_position IS NULL, g.sort_position, g.created_at DESC, g.id DESC`, [accountId]);
  return Promise.all(rows.map(async (row) => {
    const { manifest, manifestFile, mainFile, ...item } = row;
    const [thumbnail, schema] = await Promise.all([!row.packageDisabled && findThumbnail(row, storageRoot), resolvePropertySchema(row, storageRoot)]);
    return { ...item, enabled: Boolean(row.enabled), packageDisabled: Boolean(row.packageDisabled), schema,
      customActions: manifestCustomActions(manifest),
      // Addressed by the immutable version, never by entry ID: entry IDs can repeat (e.g. after a database reset)
      // and a cached image would then show another graphic.
      thumbnailUrl: thumbnail ? `/api/catalog/${encodeURIComponent(row.versionId)}/thumbnail` : null };
  }));
}

export async function findMyGraphic(accountId, entryId) {
  const [rows] = await pool.query(`${myGraphicsSelect} WHERE g.account_id = ? AND g.id = ?`, [accountId, entryId]);
  return rows[0] ?? null;
}

export const copyLabel = (name) => {
  const suffix = ' (copy)';
  const base = [...String(name ?? '')];
  return (base.length + suffix.length > 100 ? base.slice(0, 100 - suffix.length).join('') : base.join('')) + suffix;
};

// Copies an entry of the current rundown (graphic version, properties, enabled state; label with " (copy)") and
// places the copy directly below the original. Returns the new entry ID, or null when there is no such entry.
export async function duplicateMyGraphic(accountId, entryId) {
  return inTransaction(async (connection) => {
    await connection.query('SELECT id FROM accounts WHERE id = ? FOR UPDATE', [accountId]);
    const [entries] = await connection.query(`SELECT CAST(g.id AS CHAR) AS entryId, g.rundown_id AS rundownId, g.package_version_id AS versionId,
        g.label, g.schema_data AS schemaData, g.enabled, pv.manifest_name AS displayName
      FROM my_graphics_entries g JOIN package_versions pv ON pv.id = g.package_version_id ${currentRundown}
      WHERE g.account_id = ? ORDER BY g.sort_position IS NULL, g.sort_position, g.created_at DESC, g.id DESC FOR UPDATE`, [accountId]);
    const index = entries.findIndex((entry) => entry.entryId === String(entryId));
    if (index < 0) return null;
    const original = entries[index];
    const [result] = await connection.query(`INSERT INTO my_graphics_entries (account_id, rundown_id, package_version_id, label, schema_data, enabled)
      VALUES (?, ?, ?, ?, ?, ?)`, [accountId, original.rundownId, original.versionId, copyLabel(original.label || original.displayName),
      JSON.stringify(original.schemaData ?? {}), Boolean(original.enabled)]);
    const newId = String(result.insertId);
    const order = entries.map((entry) => entry.entryId);
    order.splice(index + 1, 0, newId);
    const positions = order.map(() => 'WHEN ? THEN ?').join(' ');
    await connection.query(`UPDATE my_graphics_entries SET sort_position = CASE id ${positions} ELSE sort_position END
      WHERE account_id = ? AND id IN (?)`, [...order.flatMap((id, position) => [id, position]), accountId, order]);
    return newId;
  });
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
    const [entries] = await connection.query(`SELECT CAST(g.id AS CHAR) AS entryId FROM my_graphics_entries g ${currentRundown}
      WHERE g.account_id = ? FOR UPDATE`, [accountId]);
    const ownedIds = new Set(entries.map((entry) => entry.entryId));
    if (entryIds.length !== ownedIds.size || new Set(entryIds).size !== entryIds.length || entryIds.some((entryId) => !ownedIds.has(entryId))) {
      const error = new Error('My Graphics or the current rundown changed. Refresh the list and try again.');
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
  const [rows] = await pool.query(`SELECT CAST(g.id AS CHAR) AS entryId, g.label, g.enabled, g.schema_data AS schemaData,
      pv.id AS versionId, pv.archive_id AS archiveId, pv.version_label AS versionLabel, pv.manifest_name AS display_name,
      pv.manifest_description AS description, pv.main_file_relpath AS mainFile, p.disabled AS packageDisabled,
      pv.manifest_json AS manifest
    FROM my_graphics_entries g
    JOIN package_versions pv ON pv.id = g.package_version_id
    JOIN packages p ON p.id = pv.package_id
    ${currentRundown}
    WHERE g.account_id = ? ORDER BY g.sort_position IS NULL, g.sort_position, g.created_at DESC, g.id DESC`, [accountId]);
  // stepCount follows the OGraf step model: 0 = played once (animates out by itself), 1 = default, -1 = dynamic.
  return rows.map(({ manifest, ...row }) => ({ ...row, enabled: Boolean(row.enabled), packageDisabled: Boolean(row.packageDisabled),
    stepCount: Number.isInteger(manifest?.stepCount) ? manifest.stepCount : 1, customActions: manifestCustomActions(manifest) }));
}

export async function listRenderInstances(accountId) {
  const [rows] = await pool.query(`SELECT CAST(r.entry_id AS CHAR) AS entryId, r.instance_id AS instanceId, r.data,
      r.current_step AS currentStep, r.playing, r.ended, pv.id AS versionId, pv.archive_id AS archiveId, pv.main_file_relpath AS mainFile
    FROM render_instances r
    JOIN my_graphics_entries g ON g.id = r.entry_id AND g.account_id = r.account_id
    JOIN package_versions pv ON pv.id = g.package_version_id
    ${currentRundown}
    WHERE r.account_id = ?`, [accountId]);
  return rows.map((row) => ({ ...row, playing: Boolean(row.playing), ended: Boolean(row.ended), data: row.data ?? {} }));
}

export async function saveRenderInstance(accountId, entryId, { instanceId, data, currentStep = null, playing = false, ended = false }) {
  await pool.query(`INSERT INTO render_instances (entry_id, account_id, instance_id, data, current_step, playing, ended)
    SELECT g.id, g.account_id, ?, ?, ?, ?, ? FROM my_graphics_entries g WHERE g.id = ? AND g.account_id = ?
    ON DUPLICATE KEY UPDATE instance_id = VALUES(instance_id), data = VALUES(data), current_step = VALUES(current_step),
      playing = VALUES(playing), ended = VALUES(ended)`,
  [instanceId, JSON.stringify(data ?? {}), currentStep, playing, ended, entryId, accountId]);
}

export async function deleteRenderInstances(accountId, entryIds) {
  if (!entryIds.length) return;
  await pool.query('DELETE FROM render_instances WHERE account_id = ? AND entry_id IN (?)', [accountId, entryIds]);
}

export async function findAccountGraphic(accountId, versionId) {
  const [rows] = await pool.query(`SELECT pv.manifest_json AS manifest, pv.created_at AS createdAt
    FROM my_graphics_entries g JOIN package_versions pv ON pv.id = g.package_version_id
    ${currentRundown}
    WHERE g.account_id = ? AND pv.id = ? LIMIT 1`, [accountId, versionId]);
  return rows[0] ?? null;
}

// ---- Group actions of the current rundown (FE-7) ----

const groupRow = (row) => ({ id: String(row.id), name: row.name, steps: Array.isArray(row.steps) ? row.steps : [] });

export async function listGroupActions(accountId) {
  const [rows] = await pool.query(`SELECT ga.id, ga.name, ga.steps FROM group_actions ga
    JOIN accounts cur ON cur.id = ga.account_id AND cur.current_rundown_id = ga.rundown_id
    WHERE ga.account_id = ? ORDER BY ga.created_at, ga.id`, [accountId]);
  return rows.map(groupRow);
}

export async function createGroupAction(accountId, { name, steps }) {
  const rundownId = await ensureCurrentRundown(accountId);
  const [result] = await pool.query('INSERT INTO group_actions (account_id, rundown_id, name, steps) VALUES (?, ?, ?, ?)',
    [accountId, rundownId, name, JSON.stringify(steps)]);
  return { id: String(result.insertId), name, steps };
}

// Changes name and/or steps of a group of the current rundown; returns false when there is no such group.
export async function updateGroupAction(accountId, groupId, changes) {
  const fields = [];
  const values = [];
  if (changes.name !== undefined) { fields.push('ga.name = ?'); values.push(changes.name); }
  if (changes.steps !== undefined) { fields.push('ga.steps = ?'); values.push(JSON.stringify(changes.steps)); }
  const [result] = await pool.query(`UPDATE group_actions ga
    JOIN accounts cur ON cur.id = ga.account_id AND cur.current_rundown_id = ga.rundown_id
    SET ${fields.join(', ')} WHERE ga.id = ? AND ga.account_id = ?`, [...values, groupId, accountId]);
  return result.affectedRows === 1;
}

export async function deleteGroupAction(accountId, groupId) {
  const [result] = await pool.query(`DELETE ga FROM group_actions ga
    JOIN accounts cur ON cur.id = ga.account_id AND cur.current_rundown_id = ga.rundown_id
    WHERE ga.id = ? AND ga.account_id = ?`, [groupId, accountId]);
  return result.affectedRows === 1;
}

// ---- Media library ----

const mediaRow = (row) => row && { id: row.id, name: row.name, extension: row.extension, size: Number(row.size_bytes),
  checksum: row.checksum_sha256, createdAt: row.created_at, updatedAt: row.updated_at, accountId: String(row.account_id),
  ...(row.usage_count !== undefined ? { usage: Number(row.usage_count) } : {}) };

// The account's media, newest first, with how many rundown entries (of any rundown) reference each file.
export async function listMedia(accountId) {
  const [rows] = await pool.query(`SELECT m.*, (SELECT COUNT(*) FROM my_graphics_entries g
      WHERE g.account_id = m.account_id AND CAST(g.schema_data AS CHAR) LIKE CONCAT('%', m.id, '%')) AS usage_count
    FROM media m WHERE m.account_id = ? ORDER BY m.created_at DESC, m.name`, [accountId]);
  return rows.map(mediaRow);
}

export async function findMedia(id, accountId = null) {
  const [rows] = await pool.query(`SELECT * FROM media WHERE id = ?${accountId == null ? '' : ' AND account_id = ?'}`,
    accountId == null ? [id] : [id, accountId]);
  return mediaRow(rows[0]) ?? null;
}

export async function insertMedia(accountId, media) {
  await pool.query('INSERT INTO media (id, account_id, name, extension, size_bytes, checksum_sha256) VALUES (?, ?, ?, ?, ?, ?)',
    [media.id, accountId, media.name, media.extension, media.size, media.checksum]);
}

// Changes the name and/or the content details of a file; returns false when the account has no such file.
export async function updateMedia(accountId, id, changes) {
  const fields = [];
  const values = [];
  if (changes.name !== undefined) { fields.push('name = ?'); values.push(changes.name); }
  if (changes.size !== undefined) { fields.push('size_bytes = ?', 'checksum_sha256 = ?'); values.push(changes.size, changes.checksum); }
  const [result] = await pool.query(`UPDATE media SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?`,
    [...values, id, accountId]);
  return result.affectedRows === 1;
}

export async function deleteMedia(accountId, id) {
  const [result] = await pool.query('DELETE FROM media WHERE id = ? AND account_id = ?', [id, accountId]);
  return result.affectedRows === 1;
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
      (id, package_id, archive_id, version_label, manifest_name, manifest_description, manifest_json, manifest_file_relpath, main_file_relpath,
       zip_checksum_sha256, zip_size_bytes, uncompressed_size_bytes, file_count, source, review_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`, [
      versionRecord.id, packageRecord.id, versionRecord.archiveId, versionRecord.versionLabel, versionRecord.manifestName,
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
