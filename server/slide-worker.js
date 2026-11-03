import { createRequire } from 'node:module';

// Renders slides and runs the slide-editor MCP tools for slides.js, in a child process of its own: canvas is native
// code, and stopping a worker thread in the middle of drawing aborts the whole server, while a child process can be
// killed safely. Slides come from users: they reach this process only after validateSlide() (images embedded as data:
// URLs), and the only network access allowed here is the icon search (Iconify) used by the MCP tools and Google Fonts
// (fonts imported in the editor, downloaded once into SLIDE_WORKER_FONT_CACHE). The process gets only the environment
// it needs (no secrets of the app).
const require = createRequire(import.meta.url);
// The icon server of the stack (ICONIFY_API_URL), if any, replaces the public Iconify API.
const iconApi = process.env.SLIDE_WORKER_ICON_API || null;
const allowedOrigins = new Set([new URL(iconApi ?? 'https://api.iconify.design').origin, 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!allowedOrigins.has(url.origin)) return Promise.reject(new Error('Slides may only use images that are embedded or in the media library'));
  return realFetch(input, init);
};

// fabric's Node environment loads images through jsdom, whose resource loader would fetch http(s) and read file: URLs.
// Before fabric creates its jsdom window, the loader is limited to data: URLs (embedded images).
const { ResourceLoader } = require('jsdom');
const loaderFetch = ResourceLoader.prototype.fetch;
ResourceLoader.prototype.fetch = function fetchEmbeddedOnly(url, options) {
  if (/^data:/i.test(String(url))) return loaderFetch.call(this, url, options);
  // A failed load (the image element reports an error) rather than none, which would leave fabric waiting.
  const refused = Promise.reject(new Error(`Slides may only use embedded images, not ${String(url).slice(0, 80)}`));
  refused.catch(() => {});
  return Object.assign(refused, { abort() {} });
};

const S = require('slide-editor/node');
const { createSlideTools } = require('slide-editor/mcp');
for (const font of JSON.parse(process.env.SLIDE_WORKER_FONTS ?? '[]')) {
  try { S.registerFont(font.file, { family: font.family, weight: font.weight, style: font.style }); }
  catch (error) { console.error(`Slide font ${font.file} could not be registered: ${error.message}`); }
}
// Google Fonts of a slide (its `fonts` list) are fetched before it is loaded; a font that can't be fetched falls back
// and is reported as missing.
const googleFonts = process.env.SLIDE_WORKER_FONT_CACHE ? { cacheDir: process.env.SLIDE_WORKER_FONT_CACHE } : true;

const tasks = {
  async render({ json, maxWidth }) {
    const doc = await S.loadSlide(json, { googleFonts });
    const png = new Uint8Array(S.toImageBuffer(doc, { format: 'png', ...(maxWidth ? { maxWidth } : {}) }));
    return { png, width: doc.width, height: doc.height, issues: doc.describe({ compact: true }).issues };
  },
  // Downloads Google Fonts ([{ name, google }]) into cacheDir, for the server's font list (google-fonts.txt).
  async installFonts({ fonts, cacheDir }) {
    return S.prepareFonts({ fonts }, { cacheDir, maxFamilies: 100, maxFiles: 500 });
  },
  // Runs one tool of slide-editor/mcp against the given slides (by ID); returns its result and the slides it saved.
  async tool({ name, args, slides }) {
    const store = new Map(Object.entries(slides ?? {}));
    const saved = {};
    const tools = createSlideTools({ googleFonts, ...(iconApi ? { iconApi } : {}), store: {
      load: async (id) => store.get(id) ?? null,
      save: async (id, json) => { store.set(id, json); saved[id] = json; }
    } });
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown slide tool ${name}`);
    return { result: await tool.handler(args), saved };
  }
};

process.on('message', async ({ id, task, payload }) => {
  try { process.send({ id, result: await tasks[task](payload) }); }
  catch (error) { process.send({ id, error: String(error?.message ?? error) }); }
});
// Without the app, the process has nothing to do.
process.on('disconnect', () => process.exit(0));
process.send({ ready: true });
