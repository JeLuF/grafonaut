import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { editorFonts, slideFonts } from './slide-fonts.js';

const require = createRequire(import.meta.url);
const { DEFAULT_FONTS } = require('slide-editor/core');

// The slide editor's settings (/api/slides/config) and the font files it loads (/api/slides/fonts/<file>): the same files
// the server renders slides with.
export function createSlideRoutes({ fonts = slideFonts() } = {}) {
  const router = express.Router();
  const files = new Map();
  for (const font of fonts) {
    const key = font.key ?? path.basename(font.file);
    if (!files.has(key)) files.set(key, font.file);
  }
  router.get('/config', (_request, response) => {
    response.set('Cache-Control', 'private, max-age=300').json({ fonts: editorFonts(fonts, DEFAULT_FONTS) });
  });
  router.get('/fonts/:file', (request, response) => {
    const file = files.get(request.params.file);
    if (!file) return response.sendStatus(404);
    response.sendFile(file, { headers: { 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
      'Content-Type': /\.otf$/i.test(file) ? 'font/otf' : 'font/ttf' } });
  });
  return router;
}
