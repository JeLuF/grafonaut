import fs from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { findVersionByChecksum, saveSeedPackage } from './db.js';
import { checksum, storeArchive } from './storage.js';

const allowedExtensions = new Set(['.json', '.mjs', '.js', '.jpg', '.jpeg', '.png', '.apng', '.webp', '.gif', '.svg', '.mp3', '.mp4']);

export async function importSeedDirectory(directory, source) {
  let files;
  try { files = await fs.readdir(directory); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let imported = 0;
  for (const file of files.filter((name) => name.endsWith('.ograf.zip'))) {
    const archivePath = path.join(directory, file);
    const digest = await checksum(archivePath);
    if (await findVersionByChecksum(digest)) continue;
    const packageId = uuid();
    const versionId = uuid();
    const stored = await storeArchive(archivePath, packageId, versionId);
    const manifestPath = await locateManifest(stored.extractionRoot);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const mainFile = manifest.main ?? manifest.mainFile;
    if (!mainFile) throw new Error(`Manifest in ${file} has no main file`);
    const mainPath = path.resolve(stored.extractionRoot, mainFile);
    if (!mainPath.startsWith(`${stored.extractionRoot}${path.sep}`)) throw new Error(`Unsafe manifest main path in ${file}`);
    const manifestStat = await fs.stat(mainPath);
    if (!manifestStat.isFile()) throw new Error(`Manifest main path is not a file in ${file}`);
    const record = {
      id: packageId,
      manifestId: String(manifest.id ?? file),
      displayName: String(manifest.name ?? manifest.id ?? file),
      versionLabel: String(manifest.version ?? '1.0.0'),
      manifestName: String(manifest.name ?? manifest.id ?? file),
      description: manifest.description ?? null,
      manifest,
      mainFile: path.relative(stored.extractionRoot, mainPath).replaceAll(path.sep, '/'),
      checksum: digest,
      zipSize: (await fs.stat(archivePath)).size,
      uncompressedSize: stored.uncompressedSize,
      fileCount: stored.fileCount,
      source
    };
    await saveSeedPackage(record, { id: versionId, ...record });
    imported += 1;
  }
  return imported;
}

async function locateManifest(root) {
  const candidates = ['manifest.json', 'ograf.json', 'package.json'];
  for (const candidate of candidates) {
    try { await fs.access(path.join(root, candidate)); return path.join(root, candidate); } catch {}
  }
  const files = await fs.readdir(root);
  const jsonFile = files.find((file) => path.extname(file) === '.json');
  if (!jsonFile) throw new Error('No JSON manifest found in seed package');
  return path.join(root, jsonFile);
}

export { allowedExtensions };
