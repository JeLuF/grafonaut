import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';
import { validateManifest } from './manifest-validation.js';
import { archiveDirectory } from './thumbnails.js';

// Hardened ingestion of user-uploaded .ograf.zip packages (requirements §6). Everything is checked before any
// package is saved: archive limits and entry names from the zip directory, then the real extracted size while
// streaming, then every manifest (official OGraf schema) and its main file.

// The requirements' list plus the web assets real graphics need (stylesheets, HTML pages, fonts) and docs.
// HTML/SVG are only ever served in a CSP sandbox. Override with UPLOAD_ALLOWED_EXTENSIONS (comma separated).
export const defaultAllowedExtensions = ['.json', '.mjs', '.js', '.jpg', '.jpeg', '.png', '.apng', '.webp', '.gif', '.svg',
  '.mp3', '.mp4', '.css', '.html', '.htm', '.ttf', '.otf', '.woff', '.woff2', '.md', '.txt'];

export function uploadLimits(env = process.env) {
  const number = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  const extensions = env.UPLOAD_ALLOWED_EXTENSIONS?.trim()
    ? env.UPLOAD_ALLOWED_EXTENSIONS.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean).map((item) => item.startsWith('.') ? item : `.${item}`)
    : defaultAllowedExtensions;
  return {
    maxZipBytes: number(env.UPLOAD_MAX_ZIP_BYTES, 10 * 1024 * 1024),
    maxUncompressedBytes: number(env.UPLOAD_MAX_UNCOMPRESSED_BYTES, 50 * 1024 * 1024),
    maxFiles: number(env.UPLOAD_MAX_FILES, 5000),
    extractionTimeoutMs: number(env.UPLOAD_EXTRACTION_TIMEOUT_MS, 30000),
    allowedExtensions: new Set(extensions)
  };
}

export class UploadError extends Error {
  constructor(message, details = [], status = 422) {
    super(message);
    this.details = details;
    this.status = status;
  }
}

const isSymlink = (entry) => ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
function unsafeName(name) {
  return !name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || /^[a-z]:/i.test(name) ||
    name.split('/').some((segment) => segment === '..');
}

// Checks the archive directory without extracting anything.
function inspectEntries(files, limits) {
  if (files.length > limits.maxFiles) throw new UploadError(`The package has ${files.length} entries; at most ${limits.maxFiles} are allowed.`);
  const problems = [];
  let declared = 0;
  for (const entry of files) {
    if (unsafeName(entry.path)) problems.push(`Unsafe path: ${entry.path}`);
    else if (isSymlink(entry)) problems.push(`Symbolic links are not allowed: ${entry.path}`);
    else if (entry.type === 'File') {
      const extension = path.posix.extname(entry.path).toLowerCase();
      if (!limits.allowedExtensions.has(extension)) problems.push(`File type not allowed: ${entry.path}`);
      declared += entry.uncompressedSize;
    }
  }
  if (problems.length) throw new UploadError('The package contains files that are not allowed.', problems.slice(0, 20));
  // The declared sizes can be forged downwards, so this only rejects early; extraction counts the real bytes.
  if (declared > limits.maxUncompressedBytes) throw new UploadError(`The package is larger than ${limits.maxUncompressedBytes} bytes when unpacked.`);
}

// Extracts while counting the bytes actually written; aborts as soon as the limit or the deadline is exceeded.
async function extract(files, root, limits) {
  const signal = AbortSignal.timeout(limits.extractionTimeoutMs);
  let written = 0;
  for (const entry of files) {
    if (entry.type !== 'File') continue;
    const target = path.resolve(root, entry.path);
    if (!target.startsWith(`${root}${path.sep}`)) throw new UploadError(`Unsafe path: ${entry.path}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const counter = new Transform({ transform(chunk, _encoding, callback) {
      written += chunk.length;
      callback(written > limits.maxUncompressedBytes ? new UploadError(`The package is larger than ${limits.maxUncompressedBytes} bytes when unpacked.`) : null, chunk);
    } });
    try { await pipeline(entry.stream(), counter, createWriteStream(target, { flags: 'wx' }), { signal }); }
    catch (error) {
      if (error instanceof UploadError) throw error;
      if (signal.aborted) throw new UploadError('Unpacking the package took too long.');
      throw new UploadError(`The archive could not be unpacked (${entry.path}).`);
    }
  }
  return written;
}

async function findManifests(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ograf.json')) found.push(target);
    }
  }
  await visit(root);
  return found;
}

// Validates every manifest and its main file; returns one record per graphic or throws with all problems.
async function readGraphics(root) {
  const manifestPaths = await findManifests(root);
  if (!manifestPaths.length) throw new UploadError('No OGraf manifest (*.ograf.json) found in the package.');
  const problems = [];
  const graphics = [];
  for (const manifestPath of manifestPaths) {
    const relative = path.relative(root, manifestPath).split(path.sep).join('/');
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
    catch { problems.push(`${relative}: not valid JSON`); continue; }
    const schemaProblems = validateManifest(manifest);
    if (schemaProblems.length) { problems.push(...schemaProblems.map((problem) => `${relative}: ${problem}`)); continue; }
    const mainPath = path.resolve(path.dirname(manifestPath), manifest.main);
    const mainFile = path.relative(root, mainPath).split(path.sep).join('/');
    if (!mainPath.startsWith(`${root}${path.sep}`) || !/\.m?js$/i.test(mainPath)) { problems.push(`${relative}: main must be a .mjs or .js file inside the package`); continue; }
    try {
      if (!(await fs.stat(mainPath)).isFile()) throw new Error();
    } catch { problems.push(`${relative}: main file ${mainFile} is missing`); continue; }
    if (graphics.some((graphic) => graphic.manifest.id === manifest.id)) { problems.push(`${relative}: another manifest in the package already uses the id ${manifest.id}`); continue; }
    graphics.push({ manifest, manifestFile: relative, mainFile });
  }
  if (problems.length) throw new UploadError('The package is not a valid OGraf package.', problems.slice(0, 20));
  return graphics;
}

// Validates an uploaded archive in a staging area, then moves it (archive and unpacked files, once) to
// storage/archives/<archiveId> and hands all its graphics to `persist`, which saves them and returns
// { saved, skipped }. The archive directory is removed again when nothing was saved or saving failed.
export async function ingestUpload(buffer, { storageRoot, limits = uploadLimits(), persist }) {
  if (buffer.length > limits.maxZipBytes) throw new UploadError(`The file is larger than ${limits.maxZipBytes} bytes.`, [], 413);
  const staging = path.join(storageRoot, 'staging', crypto.randomUUID());
  const archivePath = path.join(staging, 'package.ograf.zip');
  const root = path.join(staging, 'extracted');
  await fs.mkdir(root, { recursive: true });
  try {
    await fs.writeFile(archivePath, buffer);
    let directory;
    try { directory = await unzipper.Open.file(archivePath); }
    catch { throw new UploadError('The file is not a valid zip archive.'); }
    inspectEntries(directory.files, limits);
    const uncompressedSize = await extract(directory.files, root, limits);
    const graphics = await readGraphics(root);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    const upload = {
      archiveId: crypto.randomUUID(), zipSize: buffer.length, uncompressedSize,
      fileCount: directory.files.filter((entry) => entry.type === 'File').length,
      graphics: graphics.map((graphic) => ({ ...graphic,
        checksum: graphics.length === 1 ? digest : crypto.createHash('sha256').update(`${digest}:${graphic.manifestFile}`).digest('hex') }))
    };
    const destination = archiveDirectory(storageRoot, upload.archiveId);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(staging, destination);
    let result;
    try { result = await persist(upload); }
    catch (error) {
      await fs.rm(destination, { recursive: true, force: true });
      throw error;
    }
    if (!result.saved.length) await fs.rm(destination, { recursive: true, force: true });
    return result;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
