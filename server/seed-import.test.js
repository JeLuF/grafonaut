import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ograf-seed-test-"));
const archivePath = path.join(root, "theme.ograf.zip");
await fs.writeFile(archivePath, "archive fixture");
const digest = "a".repeat(64);
let files;
let saved;
let knownChecksums;
let storedRoots;
let failOnSave;

mock.module("uuid", { namedExports: { v4: randomUUID } });
mock.module("./db.js", {
  namedExports: {
    findVersionByChecksum: async (value) => knownChecksums.has(value) ? { id: "existing" } : null,
    saveSeedPackage: async (packageRecord, versionRecord) => {
      if (saved.length === failOnSave) throw new Error("Database unavailable");
      saved.push({ packageRecord, versionRecord });
      knownChecksums.add(versionRecord.checksum);
    },
  },
});
mock.module("./storage.js", {
  namedExports: {
    checksum: async () => digest,
    storeArchive: async (sourcePath, packageId, versionId) => {
      const extractionRoot = path.join(root, "packages", packageId, versionId, "extracted");
      await fs.mkdir(extractionRoot, { recursive: true });
      for (const [fileName, contents] of Object.entries(files)) {
        const target = path.join(extractionRoot, fileName);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, contents);
      }
      storedRoots.push(extractionRoot);
      return { extractionRoot, fileCount: Object.keys(files).length, uncompressedSize: 100 };
    },
  },
});
const { importSeedZip, importSeedDirectory } = await import("./seed-import.js");

beforeEach(() => {
  files = {
    "intro.json": JSON.stringify({ id: "intro", name: "Intro", main: "intro.mjs" }),
    "intro.mjs": "export default {};",
    "outro/manifest.json": JSON.stringify({ id: "outro", name: "Outro", mainFile: "outro.mjs" }),
    "outro/outro.mjs": "export default {};",
    "assets/data.json": JSON.stringify({ color: "red" }),
  };
  saved = [];
  knownChecksums = new Set();
  storedRoots = [];
  failOnSave = -1;
});
after(() => fs.rm(root, { recursive: true, force: true }));

test("imports every animation with distinct IDs, checksums and storage", async () => {
  assert.equal(await importSeedZip(archivePath, undefined, "builtin"), 2);
  assert.deepEqual(saved.map(({ versionRecord }) => versionRecord.mainFile), ["intro.mjs", "outro/outro.mjs"]);
  assert.equal(new Set(saved.map(({ packageRecord }) => packageRecord.id)).size, 2);
  assert.equal(new Set(saved.map(({ versionRecord }) => versionRecord.id)).size, 2);
  assert.equal(new Set(saved.map(({ versionRecord }) => versionRecord.checksum)).size, 2);
  for (const { packageRecord, versionRecord } of saved) {
    assert.notEqual(packageRecord.id, versionRecord.id);
    assert.equal(versionRecord.source, "builtin");
    assert.equal(versionRecord.fileCount, 5);
    await fs.access(path.join(root, "packages", packageRecord.id, versionRecord.id, "extracted", versionRecord.mainFile));
  }
});

test("repeat imports skip each animation and remove unused extraction", async () => {
  assert.equal(await importSeedZip(archivePath), 2);
  assert.equal(await importSeedZip(archivePath), 0);
  assert.equal(saved.length, 2);
  await assert.rejects(fs.access(storedRoots.at(-1)), { code: "ENOENT" });
});

test("imports side-by-side root manifests and preserves shared assets", async () => {
  files = {
    "intro.json": JSON.stringify({ id: "intro", main: "intro.mjs" }),
    "outro.json": JSON.stringify({ id: "outro", main: "outro.mjs" }),
    "intro.mjs": "export default {};",
    "outro.mjs": "export default {};",
    "shared/logo.svg": "<svg></svg>",
  };
  assert.equal(await importSeedZip(archivePath), 2);
  assert.deepEqual(saved.map(({ versionRecord }) => versionRecord.mainFile), ["intro.mjs", "outro.mjs"]);
  for (const extractionRoot of storedRoots) {
    await fs.access(path.join(extractionRoot, "shared/logo.svg"));
  }
});

test("a retry imports only animations missing after a partial failure", async () => {
  failOnSave = 1;
  await assert.rejects(importSeedZip(archivePath), /Database unavailable/);
  await fs.access(storedRoots[0]);
  await assert.rejects(fs.access(storedRoots[1]), { code: "ENOENT" });
  failOnSave = -1;
  assert.equal(await importSeedZip(archivePath), 1);
  assert.deepEqual(saved.map(({ packageRecord }) => packageRecord.manifestId), ["intro", "outro"]);
});

test("directory import counts animations rather than archives", async () => {
  assert.equal(await importSeedDirectory(root, "volume"), 2);
  assert.equal(await importSeedDirectory(root, "volume"), 0);
});

test("single-animation archives retain their original checksum", async () => {
  files = {
    "manifest.json": JSON.stringify({ id: "single", main: "main.mjs" }),
    "main.mjs": "export default {};",
  };
  assert.equal(await importSeedZip(archivePath), 1);
  assert.equal(saved[0].versionRecord.checksum, digest);
  assert.equal(await importSeedZip(archivePath), 0);
});

test("validates all entry points before saving any animations", async () => {
  files["outro/manifest.json"] = JSON.stringify({ main: "../../outside.mjs" });
  await assert.rejects(importSeedZip(archivePath), /Unsafe manifest main path/);
  assert.equal(saved.length, 0);
});

test("rejects archives without animation manifests", async () => {
  files = { "data.json": "{}" };
  await assert.rejects(importSeedZip(archivePath), /No JSON manifest/);
});

test("rejects missing or non-file entry points without saving records", async () => {
  files["outro/manifest.json"] = JSON.stringify({ main: "missing.mjs" });
  await assert.rejects(importSeedZip(archivePath), { code: "ENOENT" });
  assert.equal(saved.length, 0);
  files["outro/manifest.json"] = JSON.stringify({ main: "../assets" });
  await assert.rejects(importSeedZip(archivePath), /not a file/);
  assert.equal(saved.length, 0);
});