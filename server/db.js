import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { storageRoot } from './storage.js';
import { findThumbnail } from './thumbnails.js';

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
  return rows[0];
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

export async function findPublishedVersion(versionId) {
  const [rows] = await pool.query(`SELECT pv.id AS versionId, pv.package_id AS packageId,
      pv.manifest_json AS manifest, pv.manifest_file_relpath AS manifestFile,
      pv.main_file_relpath AS mainFile
    FROM package_versions pv JOIN packages p ON p.id = pv.package_id
    WHERE pv.id = ? AND pv.review_state = 'published' AND p.disabled = FALSE`, [versionId]);
  return rows[0] ?? null;
}

export async function addMyGraphic(accountId, versionId) {
  const [result] = await pool.query(`INSERT INTO my_graphics_entries (account_id, package_version_id, schema_data)
    SELECT ?, pv.id, JSON_OBJECT() FROM package_versions pv
    JOIN packages p ON p.id = pv.package_id
    WHERE pv.id = ? AND p.disabled = FALSE
      AND (pv.review_state = 'published' OR p.owner_account_id = ?)`, [accountId, versionId, accountId]);
  if (result.affectedRows !== 1) throw new Error('Available graphic version not found');
  return String(result.insertId);
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
    WHERE g.account_id = ? ORDER BY g.created_at DESC, g.id DESC`, [accountId]);
  return Promise.all(rows.map(async (row) => {
    const { manifest, manifestFile, mainFile, ...item } = row;
    const thumbnail = !row.packageDisabled && await findThumbnail(row, storageRoot);
    return { ...item, enabled: Boolean(row.enabled), packageDisabled: Boolean(row.packageDisabled),
      schema: manifest?.schema ?? { type: 'object', properties: {} },
      thumbnailUrl: thumbnail ? `/api/my-graphics/${encodeURIComponent(row.entryId)}/thumbnail` : null };
  }));
}

export async function findMyGraphic(accountId, entryId) {
  const [rows] = await pool.query(`${myGraphicsSelect} WHERE g.account_id = ? AND g.id = ?`, [accountId, entryId]);
  return rows[0] ?? null;
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
