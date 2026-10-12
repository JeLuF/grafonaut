import fs from "node:fs/promises";

import path from "node:path";

import { createHash } from "node:crypto";

import { v4 as uuid } from "uuid";

import { findVersionByChecksum, saveSeedPackage } from "./db.js";

import { checksum, storeArchive } from "./storage.js";

const allowedExtensions = new Set([
  ".json",
  ".mjs",
  ".js",
  ".jpg",
  ".jpeg",
  ".png",
  ".apng",
  ".webp",
  ".gif",
  ".svg",
  ".mp3",
  ".mp4",
]);

export async function importSeedDirectory(directory, source) {
  let files;
  try {
    files = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let imported = 0;
  for (const file of files.filter((name) => name.endsWith(".ograf.zip"))) {
    const archivePath = path.join(directory, file);
    imported += await importSeedZip(archivePath, file, source);
  }
  return imported;
}

export async function importSeedZip(
  archivePath,
  fileName = path.basename(archivePath),
  source,
) {
  const digest = await checksum(archivePath);
  const packageId = uuid();
  const versionId = uuid();
  const stored = await storeArchive(archivePath, packageId, versionId);
  let storedUsed = false;
  try {
    const manifests = await locateManifests(stored.extractionRoot);
    const zipSize = (await fs.stat(archivePath)).size;
    const records = [];
    for (const { manifestPath, manifest } of manifests) {
      const mainFile = manifest.main ?? manifest.mainFile;
      if (!mainFile) {
        throw new Error(`Manifest in ${fileName} has no main file`);
      }
      const mainPath = path.resolve(path.dirname(manifestPath), mainFile);
      if (!mainPath.startsWith(`${stored.extractionRoot}${path.sep}`)) {
        throw new Error(`Unsafe manifest main path in ${fileName}`);
      }
      const mainStat = await fs.stat(mainPath);
      if (!mainStat.isFile()) {
        throw new Error(`Manifest main path is not a file in ${fileName}`);
      }
      const relativeManifest = path
        .relative(stored.extractionRoot, manifestPath)
        .replaceAll(path.sep, "/");
      const animationDigest = manifests.length === 1
        ? digest
        : createHash("sha256").update(`${digest}:${relativeManifest}`).digest("hex");
      const fallbackName = manifests.length === 1 ? fileName : relativeManifest;
      records.push({
        manifestId: String(manifest.id ?? fallbackName),
        displayName: String(manifest.name ?? manifest.id ?? fallbackName),
        versionLabel: String(manifest.version ?? "1.0.0"),
        manifestName: String(manifest.name ?? manifest.id ?? fallbackName),
        description: manifest.description ?? null,
        manifest,
        mainFile: path.relative(stored.extractionRoot, mainPath).replaceAll(path.sep, "/"),
        checksum: animationDigest,
        zipSize,
        uncompressedSize: stored.uncompressedSize,
        fileCount: stored.fileCount,
        source,
      });
    }
    let imported = 0;
    for (const record of records) {
      if (await findVersionByChecksum(record.checksum)) {
        continue;
      }
      const nextPackageId = storedUsed ? uuid() : packageId;
      const nextVersionId = storedUsed ? uuid() : versionId;
      const animationStored = storedUsed
        ? await storeArchive(archivePath, nextPackageId, nextVersionId)
        : stored;
      try {
        await saveSeedPackage({ id: nextPackageId, ...record }, {
          ...record,
          id: nextVersionId,
        });
      } catch (error) {
        if (storedUsed) {
          await fs.rm(path.dirname(animationStored.extractionRoot), { recursive: true, force: true });
        }
        throw error;
      }
      storedUsed = true;
      imported += 1;
    }
    return imported;
  } finally {
    if (!storedUsed) {
      await fs.rm(path.dirname(stored.extractionRoot), { recursive: true, force: true });
    }
  }
}

async function locateManifests(root) {
  const manifests = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const manifestPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(manifestPath);
      } else if (entry.isFile() && path.extname(entry.name) === ".json") {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        if (manifest && (manifest.main || manifest.mainFile ||
          entry.name === "manifest.json" || entry.name === "ograf.json")) {
          manifests.push({ manifestPath, manifest });
        }
      }
    }
  }
  await visit(root);
  if (!manifests.length) {
    throw new Error("No JSON manifest found in seed package");
  }
  return manifests;
}

export { allowedExtensions };
