import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { replaceMissingFonts, slideFonts } from './slide-fonts.js';
import { storageRoot } from './storage.js';

// Slides of slide-editor (https://www.npmjs.com/package/slide-editor) in the media library. A slide is a media item of
// type PNG (`source` 'slide'): the PNG rendered from the slide is what graphics use, and the slide JSON is stored next
// to it as <id>.slide.json. Editing a slide renders the PNG again and keeps its URL.
export const MAX_SLIDE_SIDE = 4096;
export class SlideError extends Error {}

// Slides come from users and are rendered on the server, where fabric would load any image URL or file path it finds.
// Only embedded images (data:image/...) are allowed, and a slide must have the slide-editor format and a sane size.
const urlKeys = new Set(['src', 'source', 'href', 'xlink:href', 'url', 'uri']);
const embeddedImage = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml)(;[a-z0-9=._+-]+)*,/i;

export function isSlide(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && value.type === 'slide-editor';
}

export function validateSlide(slide) {
  if (!isSlide(slide)) throw new SlideError('Not a slide: the JSON needs "type": "slide-editor"');
  const { width, height } = slide;
  if (![width, height].every((side) => Number.isInteger(side) && side >= 16 && side <= MAX_SLIDE_SIDE)) {
    throw new SlideError(`The slide size must be between 16 and ${MAX_SLIDE_SIDE} pixels per side`);
  }
  if (!slide.canvas || typeof slide.canvas !== 'object') throw new SlideError('The slide has no content ("canvas")');
  const visit = (value, key, depth) => {
    if (depth > 200) throw new SlideError('The slide is nested too deeply');
    if (typeof value === 'string') {
      if (urlKeys.has(key) && !embeddedImage.test(value)) {
        throw new SlideError('Slides may only contain embedded images (data:image/...). Add images from your computer or the media library.');
      }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, key, depth + 1); return; }
    if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
  };
  visit(slide, '', 0);
  return { width, height };
}

// One child process (slide-worker.js), one task at a time, with a time limit; a stuck or crashed process is replaced.
// A child process rather than a worker thread: terminating a thread while canvas (native code) draws aborts the app.
// Google Fonts imported in the editor are downloaded once into `fontCache` (in storage, so they survive restarts).
export function createSlideRunner({ timeoutMs = 30000, fonts = slideFonts(), memoryMb = 1024, fontCache = path.join(storageRoot, 'slide-fonts') } = {}) {
  let state = null;
  let queue = Promise.resolve();
  let nextId = 0;
  function spawn() {
    const child = fork(new URL('./slide-worker.js', import.meta.url), [], {
      serialization: 'advanced', execArgv: [`--max-old-space-size=${memoryMb}`], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      // Only what rendering needs: no secrets of the app.
      env: { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV ?? '', SLIDE_WORKER_FONTS: JSON.stringify(fonts),
        SLIDE_WORKER_FONT_CACHE: fontCache }
    });
    const current = { child, pending: null };
    current.ready = new Promise((resolve, reject) => {
      child.on('message', (message) => {
        if (message.ready) return resolve();
        if (current.pending?.id === message.id) current.pending.settle(message);
      });
      child.on('error', (error) => { reject(error); current.pending?.settle({ error: error.message }); });
      child.on('exit', (code, signal) => {
        if (state === current) state = null;
        reject(new Error('The slide renderer stopped'));
        current.pending?.settle({ error: `The slide renderer stopped (${signal ?? `exit code ${code}`})` });
      });
    });
    current.ready.catch(() => {});
    idle(current);
    return current;
  }
  // The child keeps the app alive only while it works on a task.
  const idle = (current) => { current.child.unref(); current.child.channel?.unref(); };
  const busy = (current) => { current.child.ref(); current.child.channel?.ref(); };
  async function execute(task, payload) {
    state ??= spawn();
    const current = state;
    busy(current);
    try {
      await current.ready;
      return await new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          current.pending = null;
          if (state === current) state = null;
          current.child.kill('SIGKILL');
          reject(new SlideError('Rendering the slide took too long'));
        }, timeoutMs);
        current.pending = { id, settle: ({ result, error }) => {
          clearTimeout(timer);
          current.pending = null;
          if (error !== undefined) reject(new SlideError(error)); else resolve(result);
        } };
        current.child.send({ id, task, payload });
      });
    } finally { idle(current); }
  }
  return {
    run(task, payload) {
      const job = queue.then(() => execute(task, payload));
      queue = job.catch(() => {});
      return job;
    },
    close: () => { if (state) { state.child.kill('SIGKILL'); state = null; } }
  };
}

let defaultRunner = null;
const runner = () => (defaultRunner ??= createSlideRunner());
export const closeSlideRunner = () => defaultRunner?.close();

// Downloads the Google Fonts of the server's font list ([{ name, google }]) at startup, in a renderer process of its own
// (it may reach Google's font hosts, the app may not need it). Resolves to { loaded, failed } of slide-editor's prepareFonts().
export async function downloadGoogleFonts(fonts, cacheDir) {
  const slides = createSlideRunner({ fonts: [], timeoutMs: 180000 });
  try { return await slides.run('installFonts', { fonts, cacheDir }); }
  finally { slides.close(); }
}

// PNG (Buffer) and layout issues of a slide, after validateSlide().
export async function renderSlide(slide, { slides = runner() } = {}) {
  validateSlide(slide);
  const result = await slides.run('render', { json: slide });
  return { ...result, png: Buffer.from(result.png.buffer, result.png.byteOffset, result.png.byteLength) };
}

export async function runSlideTool(name, args, slidesById, { slides = runner() } = {}) {
  return slides.run('tool', { name, args, slides: slidesById });
}

// ---- Slides as media items ----

export const slideFile = (storageRoot, accountId, id) => path.join(storageRoot, 'media', String(accountId), `${id}.slide.json`);
const pngFile = (storageRoot, accountId, id) => path.join(storageRoot, 'media', String(accountId), `${id}.png`);

async function writeAtomically(target, data) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, data);
  await fs.rename(temporary, target);
}

// "Lower third.json" → "Lower third.png"
export function slideMediaName(name) {
  const base = String(name ?? '').replace(/\.(json|png)$/i, '').trim() || 'Slide';
  return `${[...base].slice(0, 250).join('')}.png`;
}

// `fonts`: the server's slide fonts; slides using web-safe names the server lacks switch to the family with the same
// character widths (replaceMissingFonts), when they are stored and when they are loaded into the editor.
export function createSlideMedia({ store, storageRoot, render = renderSlide, fonts = slideFonts() }) {
  async function write(accountId, id, given) {
    const { slide } = replaceMissingFonts(given, fonts);
    const { png, issues } = await render(slide);
    const json = JSON.stringify(slide);
    await writeAtomically(slideFile(storageRoot, accountId, id), json);
    await writeAtomically(pngFile(storageRoot, accountId, id), png);
    return { size: png.length, checksum: crypto.createHash('sha256').update(png).digest('hex'), issues };
  }
  return {
    // A new media item from a slide.
    async create(accountId, name, slide) {
      const id = crypto.randomUUID();
      const written = await write(accountId, id, slide);
      const media = { id, name: slideMediaName(name), extension: 'png', source: 'slide', size: written.size, checksum: written.checksum };
      try { await store.insertMedia(accountId, media); }
      catch (error) {
        await Promise.all([fs.rm(slideFile(storageRoot, accountId, id), { force: true }), fs.rm(pngFile(storageRoot, accountId, id), { force: true })]);
        throw error;
      }
      return { media, issues: written.issues };
    },
    // Saves a changed slide: new JSON and PNG, same media item and URL.
    async update(accountId, media, slide) {
      const written = await write(accountId, media.id, slide);
      await store.updateMedia(accountId, media.id, { size: written.size, checksum: written.checksum });
      return { media: { ...media, size: written.size, checksum: written.checksum }, issues: written.issues };
    },
    async load(accountId, media) {
      return replaceMissingFonts(JSON.parse(await fs.readFile(slideFile(storageRoot, accountId, media.id), 'utf8')), fonts).slide;
    },
    remove: (accountId, id) => fs.rm(slideFile(storageRoot, accountId, id), { force: true })
  };
}
