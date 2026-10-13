import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.apng', '.svg']);

function containedPath(root, file, directory = root) {
  if (typeof file !== 'string' || !file || file.includes('\\') || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return null;
  const target = path.resolve(directory, file);
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

export async function findManifest(root, version) {
  if (version.manifestFile) return containedPath(root, version.manifestFile);
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await visit(target);
        if (found) return found;
      } else if (entry.isFile() && path.extname(entry.name) === '.json') {
        let manifest;
        try { manifest = JSON.parse(await fs.readFile(target, 'utf8')); }
        catch { continue; }
        const main = manifest?.main ?? manifest?.mainFile;
        if (typeof main === 'string' && isDeepStrictEqual(manifest, version.manifest) &&
          path.resolve(directory, main) === path.resolve(root, version.mainFile)) return target;
      }
    }
    return null;
  }
  return visit(root);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Unpacked package files live once per uploaded archive; every graphic version from that archive points at it.
export const archiveDirectory = (storageRoot, archiveId) => path.resolve(storageRoot, 'archives', archiveId);

export function extractedRoot(version, storageRoot) {
  if (typeof version.archiveId !== 'string' || !uuidPattern.test(version.archiveId)) return null;
  return path.join(archiveDirectory(storageRoot, version.archiveId), 'extracted');
}

export async function findThumbnails(version, storageRoot, limit = Infinity) {
  const thumbnails = version.manifest?.thumbnails;
  if (!Array.isArray(thumbnails) || !thumbnails.length) return [];
  const root = extractedRoot(version, storageRoot);
  if (!root) return [];
  const found = [];
  try {
    const manifestPath = await findManifest(root, version);
    if (!manifestPath) return [];
    const realRoot = await fs.realpath(root);
    for (const [index, thumbnail] of thumbnails.entries()) {
      if (found.length >= limit) break;
      const file = thumbnail?.file;
      if (typeof file !== 'string' || !imageExtensions.has(path.extname(file).toLowerCase())) continue;
      const target = containedPath(root, file, path.dirname(manifestPath));
      if (!target || !target.startsWith(`${root}${path.sep}`)) continue;
      try {
        const realTarget = await fs.realpath(target);
        if (realTarget.startsWith(`${realRoot}${path.sep}`) && (await fs.stat(realTarget)).isFile()) found.push({ index, file: realTarget });
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  return found;
}

export async function findThumbnail(version, storageRoot) {
  return (await findThumbnails(version, storageRoot, 1))[0]?.file ?? null;
}
