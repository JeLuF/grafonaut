import fs from 'node:fs/promises';
import path from 'node:path';
import { extractedRoot, findManifest } from './thumbnails.js';

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

function fileListOptions(property) {
  const spx = property.v_spx;
  if (!isObject(spx) || spx.ftype !== 'filelist' || typeof spx.assetfolder !== 'string' || typeof spx.extension !== 'string') return null;
  const folder = spx.assetfolder.trim();
  const extensions = spx.extension.split(',').map((extension) => extension.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
  if (!folder || !extensions.length || folder.includes('\\') || path.posix.isAbsolute(folder) || path.win32.isAbsolute(folder)) return null;
  return { folder, extensions };
}

// Lists regular files directly inside an asset folder, resolved relative to the manifest and confined to the package.
export async function listAssetFiles(root, manifestDirectory, folder, extensions) {
  const directory = path.resolve(manifestDirectory, folder);
  if (!inside(root, directory)) return [];
  try {
    const [realRoot, realDirectory] = await Promise.all([fs.realpath(root), fs.realpath(directory)]);
    if (!inside(realRoot, realDirectory)) return [];
    const entries = await fs.readdir(realDirectory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.') &&
      extensions.includes(path.extname(entry.name).slice(1).toLowerCase()))
      .map((entry) => entry.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

// Replaces SPX-style `filelist` string properties with a select of the files found in their asset folder.
export async function applyFileLists(schema, listFiles) {
  const cache = new Map();
  async function visit(node) {
    if (Array.isArray(node)) return Promise.all(node.map(visit));
    if (!isObject(node)) return node;
    const result = { ...node };
    if (isObject(node.properties)) {
      result.properties = Object.fromEntries(await Promise.all(Object.entries(node.properties).map(async ([key, value]) => [key, await visit(value)])));
    }
    if (node.items) result.items = await visit(node.items);
    const options = fileListOptions(node);
    if (!options || node.enum || node.oneOf || (node.type !== undefined && node.type !== 'string')) return result;
    const cacheKey = JSON.stringify(options);
    if (!cache.has(cacheKey)) cache.set(cacheKey, listFiles(options.folder, options.extensions));
    const prefix = options.folder.endsWith('/') ? options.folder : `${options.folder}/`;
    const choices = (await cache.get(cacheKey)).map((name) => ({ const: `${prefix}${name}`, title: name }));
    if (typeof node.default === 'string' && node.default && !choices.some((choice) => choice.const === node.default)) {
      choices.unshift({ const: node.default, title: path.posix.basename(node.default) || node.default });
    }
    return choices.length ? { ...result, type: 'string', oneOf: choices } : result;
  }
  return isObject(schema) ? visit(schema) : schema;
}

export async function resolvePropertySchema(version, storageRoot) {
  const schema = version.manifest?.schema ?? { type: 'object', properties: {} };
  const root = extractedRoot(version, storageRoot);
  let manifestDirectory = null;
  return applyFileLists(schema, async (folder, extensions) => {
    if (!root) return [];
    if (manifestDirectory === null) {
      try { manifestDirectory = path.dirname(await findManifest(root, version) ?? '') || ''; }
      catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        manifestDirectory = '';
      }
    }
    return manifestDirectory && manifestDirectory !== '.' ? listAssetFiles(root, manifestDirectory, folder, extensions) : [];
  });
}
