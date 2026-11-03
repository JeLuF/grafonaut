import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFontInfo } from './font-info.js';
import { storageRoot } from './storage.js';

const require = createRequire(import.meta.url);
const { parseFontImport } = require('slide-editor/core');

// Fonts for slides, under their real names (as stored in the font files): the server registers them for rendering, and
// the editor offers exactly these and loads the same files from /api/slides/fonts, so it shows text as the PNG will.
// Only fonts the server has are offered:
// - from the system, one family each for sans, serif and monospace text, with the character widths of Arial, Times New
//   Roman and Courier New: Liberation (Debian fonts-liberation, in the Docker image), else Croscore (Arimo, Tinos,
//   Cousine), else URW (Nimbus);
// - from the seed volume's fonts folder (<SEED_VOLUME_DIR>/fonts): every .ttf/.otf file, and the Google Fonts listed in
//   google-fonts.txt (the @import or <link> code from fonts.google.com), downloaded at startup into storage.
const systemFamilies = [
  { prefixes: ['LiberationSans', 'Arimo', 'NimbusSans'], replaces: ['Arial', 'Helvetica'] },
  { prefixes: ['LiberationSerif', 'Tinos', 'NimbusRoman'], replaces: ['Times New Roman'] },
  { prefixes: ['LiberationMono', 'Cousine', 'NimbusMonoPS'], replaces: ['Courier New'] }
];
const systemFontDirectories = ['/usr/share/fonts', '/usr/local/share/fonts'];
export const seedFontDirectory = () => path.join(process.env.SEED_VOLUME_DIR ?? './seeds/volume', 'fonts');
export const googleFontCache = () => path.join(storageRoot, 'seed-fonts');
export const googleFontList = 'google-fonts.txt';

function findFiles(directory, depth = 4) {
  const found = [];
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && depth > 0) found.push(...findFiles(target, depth - 1));
    else if (entry.isFile() && /\.(ttf|otf)$/i.test(entry.name)) found.push(target);
  }
  return found;
}

// For files whose names can't be read: "Inter-BoldItalic.ttf" → { family: 'Inter', weight: '700', style: 'italic' }
export function fontFileFamily(file) {
  const base = path.basename(file).replace(/\.(ttf|otf)$/i, '');
  const match = /^(.*?)[-_ ](regular|bold|italic|bolditalic|boldoblique|oblique)$/i.exec(base);
  const variant = match?.[2].toLowerCase() ?? 'regular';
  return { family: (match ? match[1] : base).trim(), weight: variant.startsWith('bold') ? '700' : '400', style: /italic|oblique/.test(variant) ? 'italic' : 'normal' };
}

const describeFile = (file, custom) => {
  const info = readFontInfo(file) ?? fontFileFamily(file);
  return info.family ? { ...info, file, key: path.basename(file), custom } : null;
};

// The Google Fonts of <directory>/google-fonts.txt: [{ name, google }] as the editor's import saves them in slides.
export function readGoogleFontList(directory = seedFontDirectory()) {
  let code;
  try { code = fs.readFileSync(path.join(directory, googleFontList), 'utf8'); } catch { return []; }
  const fonts = new Map();
  for (const font of parseFontImport(code)) fonts.set(font.name, font);
  return [...fonts.values()];
}

// The downloaded files of `googleFonts` in `cacheDirectory`, as slide-editor's prepareFonts() keeps them: a folder per
// family with a <hash>.json ({ spec, faces: [{ weight, style, file }] }) next to the files.
function cachedGoogleFonts(googleFonts, cacheDirectory) {
  const fonts = [];
  let folders;
  try { folders = fs.readdirSync(cacheDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return fonts; }
  for (const { name, google } of googleFonts) {
    for (const folder of folders) {
      const directory = path.join(cacheDirectory, folder.name);
      for (const metaFile of fs.readdirSync(directory).filter((file) => file.endsWith('.json'))) {
        let meta;
        try { meta = JSON.parse(fs.readFileSync(path.join(directory, metaFile), 'utf8')); } catch { continue; }
        if (meta?.spec !== google || !Array.isArray(meta.faces)) continue;
        for (const face of meta.faces) {
          const file = path.join(directory, path.basename(String(face.file)));
          if (!fs.existsSync(file)) continue;
          fonts.push({ family: name, file, key: `${folder.name}-${path.basename(file)}`, weight: String(face.weight ?? 400),
            style: face.style === 'italic' ? 'italic' : 'normal', custom: true });
        }
      }
    }
  }
  return fonts;
}

// [{ family, file, key, weight, style, custom, replaces? }]: the system families, then the fonts of `customDirectory`
// and the downloaded `googleFonts`. `replaces`: the web-safe names whose slides switch to this family (same character
// widths); `key`: the file's name in /api/slides/fonts.
export function discoverFonts({ customDirectory = seedFontDirectory(), systemDirectories = systemFontDirectories,
  googleFonts = [], googleCacheDirectory = googleFontCache() } = {}) {
  const fonts = [];
  const systemFiles = systemDirectories.flatMap((directory) => findFiles(directory));
  for (const { prefixes, replaces } of systemFamilies) {
    const variants = (prefix) => systemFiles.filter((file) => new RegExp(`^${prefix}-(Regular|Bold|Italic|BoldItalic)\\.(ttf|otf)$`, 'i').test(path.basename(file)));
    const prefix = prefixes.find((candidate) => variants(candidate).some((file) => /-Regular\./i.test(file)));
    if (!prefix) continue;
    for (const file of variants(prefix).sort()) {
      const font = describeFile(file, false);
      if (font) fonts.push({ ...font, replaces });
    }
  }
  if (customDirectory) {
    for (const file of findFiles(path.resolve(customDirectory), 0).sort()) {
      const font = describeFile(file, true);
      if (font) fonts.push(font);
    }
  }
  fonts.push(...cachedGoogleFonts(googleFonts, googleCacheDirectory));
  return fonts;
}

let cachedFonts = null;
// The fonts of this server, looked up once (after prepareSlideFonts() at startup).
export const slideFonts = () => (cachedFonts ??= discoverFonts());

// At startup, before slideFonts() is used: downloads the Google Fonts of google-fonts.txt with `download(fonts,
// cacheDirectory)` (fonts already downloaded are taken from the cache), then looks up all fonts.
// Returns the fonts that could not be downloaded: [{ family, error }].
export async function prepareSlideFonts({ download, directory = seedFontDirectory(), cacheDirectory = googleFontCache() }) {
  const googleFonts = readGoogleFontList(directory);
  let failed = [];
  if (googleFonts.length) {
    try { ({ failed } = await download(googleFonts, cacheDirectory)); }
    catch (error) { failed = googleFonts.map((font) => ({ family: font.name, error: error.message })); }
  }
  cachedFonts = discoverFonts({ customDirectory: directory, googleFonts, googleCacheDirectory: cacheDirectory });
  return failed;
}

// One line for the server log: which fonts slides are rendered with.
export function describeFonts(fonts) {
  if (!fonts.length) {
    return 'Slide fonts: none found. Slides are rendered with a fallback font and look different from the editor: install fonts-liberation (included in the Docker image) or put fonts into the seed volume\'s fonts folder.';
  }
  return `Slide fonts: ${[...new Set(fonts.map((font) => font.family))].join(', ')}`;
}

// The editor's font menu: the server's families with their files. Without any server fonts (e.g. a development machine
// without fonts), the browser's web-safe fonts.
export function editorFonts(fonts, webSafe) {
  if (!fonts.length) return [...webSafe];
  const families = new Map();
  for (const font of fonts) {
    const files = families.get(font.family) ?? [];
    files.push({ url: `/api/slides/fonts/${encodeURIComponent(font.key ?? path.basename(font.file))}`, weight: font.weight ?? '400', style: font.style ?? 'normal' });
    families.set(font.family, files);
  }
  return [...families].map(([name, files]) => ({ name, files }));
}

// Slides made before (or elsewhere) may use web-safe names the server doesn't have. Where the server has a family with the
// same character widths (Liberation Sans for Arial and Helvetica, ...), the slide switches to it, so it renders and
// edits as before. Returns the slide (a copy where something changed) and the replacements made.
export function replaceMissingFonts(slide, fonts) {
  const available = new Set(fonts.map((font) => font.family.toLowerCase()));
  const replacement = new Map();
  for (const font of fonts) for (const name of font.replaces ?? []) if (!available.has(name.toLowerCase())) replacement.set(name.toLowerCase(), font.family);
  const replaced = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === 'fontFamily' && typeof child === 'string') {
        const target = replacement.get(child.replace(/^["']|["']$/g, '').trim().toLowerCase());
        if (target) { replaced.add(`${child} → ${target}`); return [key, target]; }
      }
      return [key, visit(child)];
    }));
  };
  const result = visit(slide);
  return replaced.size ? { slide: result, replaced: [...replaced] } : { slide, replaced: [] };
}
