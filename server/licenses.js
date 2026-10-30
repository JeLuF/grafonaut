import fs from 'node:fs/promises';
import path from 'node:path';
import { extractedRoot, findManifest } from './thumbnails.js';

// A graphic's license file: LICENSE, LICENSE.md or LICENSE.txt (any case). Searched in the manifest's folder first,
// then in the folders above it up to the package root, so a package with several graphics can share one license.
const licenseNames = ['license', 'license.md', 'license.txt'];
export const maxLicenseBytes = 256 * 1024;

export async function findLicense(version, storageRoot) {
  const root = extractedRoot(version, storageRoot);
  if (!root) return null;
  try {
    const manifestPath = await findManifest(root, version);
    if (!manifestPath) return null;
    const realRoot = await fs.realpath(root);
    for (let directory = path.dirname(manifestPath); directory === root || directory.startsWith(`${root}${path.sep}`); directory = path.dirname(directory)) {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const name of licenseNames) {
        const entry = entries.find((candidate) => candidate.name.toLowerCase() === name && candidate.isFile());
        if (!entry) continue;
        const file = await fs.realpath(path.join(directory, entry.name));
        if (file.startsWith(`${realRoot}${path.sep}`)) return { name: entry.name, file };
      }
      if (directory === root) break;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  return null;
}

// The license text for the "Show license" dialog; long files are cut at maxLicenseBytes.
export async function readLicense(version, storageRoot) {
  const license = await findLicense(version, storageRoot);
  if (!license) return null;
  const handle = await fs.open(license.file);
  try {
    const buffer = Buffer.alloc(maxLicenseBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxLicenseBytes, 0);
    const size = (await handle.stat()).size;
    return { name: license.name, text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: size > maxLicenseBytes };
  } finally { await handle.close(); }
}
