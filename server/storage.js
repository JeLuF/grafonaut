import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';

const storageRoot = path.resolve(process.env.STORAGE_ROOT ?? './storage');

export async function storeArchive(sourcePath, packageId, versionId) {
  const destination = path.join(storageRoot, 'packages', packageId, versionId);
  await fs.mkdir(destination, { recursive: true });
  const archivePath = path.join(destination, 'package.ograf.zip');
  await fs.copyFile(sourcePath, archivePath);
  const extractionRoot = path.join(destination, 'extracted');
  await fs.mkdir(extractionRoot, { recursive: true });
  const directory = await unzipper.Open.file(archivePath);
  let uncompressedSize = 0;
  for (const entry of directory.files) {
    const target = path.resolve(extractionRoot, entry.path);
    if (!target.startsWith(`${extractionRoot}${path.sep}`) || entry.type === 'SymbolicLink') {
      throw new Error(`Unsafe archive entry: ${entry.path}`);
    }
    if (entry.type === 'File') {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await pipeline(entry.stream(), createWriteStream(target, { flags: 'wx' }));
      const stat = await fs.stat(target);
      uncompressedSize += stat.size;
    }
  }
  return { archivePath, extractionRoot, fileCount: directory.files.length, uncompressedSize };
}

export async function checksum(filePath) {
  const hash = crypto.createHash('sha256');
  const file = await fs.readFile(filePath);
  hash.update(file);
  return hash.digest('hex');
}

export { storageRoot };
