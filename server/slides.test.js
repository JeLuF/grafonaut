import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { closeSlideRunner, createSlideMedia, createSlideRunner, renderSlide, runSlideTool, slideMediaName, SlideError, validateSlide } from './slides.js';
import { describeFonts, discoverFonts, editorFonts, fontFileFamily, prepareSlideFonts, readGoogleFontList, replaceMissingFonts, slideFonts } from './slide-fonts.js';
import { readFontInfo } from './font-info.js';

const example = JSON.parse(await fs.readFile(new URL('./fixtures/be-right-back-slide.json', import.meta.url), 'utf8'));
const blank = { type: 'slide-editor', version: 1, width: 640, height: 360, backgroundStyle: { fill: '#123456', opacity: 1 }, canvas: { version: '7.4.0', objects: [] } };
const withImage = (src) => ({ ...blank, canvas: { ...blank.canvas, objects: [{ type: 'Image', src, left: 0, top: 0, width: 1, height: 1 }] } });
const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-slides-'));
after(async () => { await closeSlideRunner(); await fs.rm(storageRoot, { recursive: true, force: true }); });

test('slides must have the slide-editor format, a sane size and only embedded images', () => {
  assert.deepEqual(validateSlide(example), { width: 1920, height: 1080 });
  assert.throws(() => validateSlide({ type: 'other' }), SlideError);
  assert.throws(() => validateSlide({ ...blank, width: 5000 }), /between 16 and 4096/);
  assert.throws(() => validateSlide({ ...blank, canvas: null }), /no content/);
  for (const src of ['https://example.com/a.png', 'http://169.254.169.254/latest', '/etc/hostname', 'file:///etc/hostname', '../other/secret.png', 'data:text/html,<b>x</b>']) {
    assert.throws(() => validateSlide(withImage(src)), /only contain embedded images/, src);
  }
  assert.throws(() => validateSlide({ ...blank, canvas: { objects: [{ type: 'Rect', fill: { type: 'pattern', source: '/etc/passwd' } }] } }), /embedded images/);
  assert.doesNotThrow(() => validateSlide(withImage('data:image/png;base64,iVBORw0KGgo=')));
});

test('slides render to PNG in the worker', async () => {
  const { png, width, height, issues } = await renderSlide(example);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([width, height], [1920, 1080]);
  assert.ok(Array.isArray(issues));
  await assert.rejects(renderSlide(withImage('/etc/hostname')), SlideError);
});

test('the slide tools run in the worker; images from the internet are refused there', async () => {
  const added = await runSlideTool('add_element', { slideId: 's1', element: { type: 'text', name: 'title', text: 'Back soon', fontSize: 60 } }, { s1: blank });
  assert.equal(added.result.isError, undefined);
  assert.equal(added.saved.s1.canvas.objects.length, 1);
  const remote = await runSlideTool('add_element', { slideId: 's1', element: { type: 'image', src: 'https://example.com/a.png' } }, { s1: blank });
  assert.equal(remote.result.isError, true);
  assert.match(remote.result.content[0].text, /embedded or in the media library/);
  assert.deepEqual(remote.saved, {});
  const missing = await runSlideTool('describe_slide', { slideId: 'nope' }, {});
  assert.equal(missing.result.isError, true);
});

test('slides are stored as PNG media items with their JSON next to them', async () => {
  const rows = [];
  const store = { insertMedia: async (accountId, media) => rows.push({ accountId, ...media }), updateMedia: async (accountId, id, changes) => Object.assign(rows.find((row) => row.id === id), changes) };
  const slides = createSlideMedia({ store, storageRoot });
  const { media } = await slides.create('7', 'Break.json', blank);
  assert.deepEqual([media.name, media.extension, media.source], ['Break.png', 'png', 'slide']);
  const directory = path.join(storageRoot, 'media', '7');
  assert.deepEqual((await fs.readdir(directory)).sort(), [`${media.id}.png`, `${media.id}.slide.json`]);
  assert.deepEqual(await slides.load('7', media), blank);
  const changed = { ...blank, backgroundStyle: { fill: '#ff0000', opacity: 1 } };
  const updated = await slides.update('7', media, changed);
  assert.notEqual(updated.media.checksum, media.checksum);
  assert.deepEqual(await slides.load('7', media), changed);
  assert.equal(slideMediaName('  '), 'Slide.png');
  assert.equal(slideMediaName('Title.PNG'), 'Title.png');
});

test('even without the check, the worker loads no image from the network or the disk', async () => {
  // A red PNG on disk: if the worker loaded file: URLs, it would show on the slide.
  const red = await renderSlide({ ...blank, backgroundStyle: { fill: '#ff0000', opacity: 1 } });
  const file = path.join(storageRoot, 'red.png');
  await fs.writeFile(file, red.png);
  const image = (src) => ({ ...blank, canvas: { ...blank.canvas, objects: [{ type: 'Image', version: '7.4.0', src, left: 0, top: 0, width: 640, height: 360,
    originX: 'left', originY: 'top', scaleX: 1, scaleY: 1 }] } });
  const render = async (slide) => (await runSlideTool('render_slide', { slideId: 's', format: 'png' }, { s: slide })).result;
  const fromDisk = await render(image(`file://${file}`));
  const missing = await render(image(`file://${file}.missing`));
  assert.equal(fromDisk.content?.[0]?.data, missing.content?.[0]?.data);
  const fromSvg = await runSlideTool('add_element', { slideId: 's', element: { type: 'svg',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image xlink:href="file://${file}" width="10" height="10"/></svg>` } }, { s: blank });
  assert.doesNotMatch(JSON.stringify(fromSvg.saved), /data:image\/png/);
});

test('a slide that takes too long stops only its renderer process, not the app', async () => {
  // Stopping a worker thread in the middle of canvas drawing aborted the whole process; the child process is killed.
  const slides = createSlideRunner({ timeoutMs: 150 });
  after(() => slides.close());
  await renderSlide(blank, { slides });
  await assert.rejects(renderSlide({ ...example, width: 4096, height: 4096 }, { slides }), /took too long/);
  const again = await renderSlide(blank, { slides });
  assert.equal(again.png.subarray(1, 4).toString(), 'PNG');
});

// A minimal font file: just the "name" (family, subfamily) and "OS/2" (weight, italic bit) tables readFontInfo uses.
function fontFile(family, subfamily, weight, italic) {
  const utf16 = (text) => { const bytes = Buffer.from(text, 'utf16le'); bytes.swap16(); return bytes; };
  const strings = [utf16(family), utf16(subfamily)];
  const name = Buffer.alloc(6 + 2 * 12);
  name.writeUInt16BE(0, 0); name.writeUInt16BE(2, 2); name.writeUInt16BE(6 + 2 * 12, 4);
  let offset = 0;
  strings.forEach((text, index) => {
    const record = 6 + index * 12;
    [3, 1, 0x409, index + 1, text.length, offset].forEach((value, at) => name.writeUInt16BE(value, record + at * 2));
    offset += text.length;
  });
  const nameTable = Buffer.concat([name, ...strings]);
  const os2 = Buffer.alloc(78);
  os2.writeUInt16BE(weight, 4);
  os2.writeUInt16BE(italic ? 1 : 0, 62);
  const header = Buffer.alloc(12 + 2 * 16);
  header.writeUInt32BE(0x00010000, 0); header.writeUInt16BE(2, 4);
  [['name', nameTable], ['OS/2', os2]].reduce((at, [tag, table], index) => {
    const record = 12 + index * 16;
    header.write(tag, record, 'latin1'); header.writeUInt32BE(at, record + 8); header.writeUInt32BE(table.length, record + 12);
    return at + table.length;
  }, header.length);
  return Buffer.concat([header, nameTable, os2]);
}

test('Google Fonts of google-fonts.txt are downloaded at startup and offered like the other fonts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-google-fonts-'));
  after(() => fs.rm(directory, { recursive: true, force: true }));
  const seedFonts = path.join(directory, 'seed', 'fonts');
  const cache = path.join(directory, 'cache');
  await fs.mkdir(seedFonts, { recursive: true });
  await fs.writeFile(path.join(seedFonts, 'google-fonts.txt'), `<style>
@import url('https://fonts.googleapis.com/css2?family=Gorditas:wght@400;700&family=Metamorphous&family=Story+Script&display=swap');
</style>`);
  assert.deepEqual(readGoogleFontList(seedFonts), [{ name: 'Gorditas', google: 'Gorditas:wght@400;700' },
    { name: 'Metamorphous', google: 'Metamorphous' }, { name: 'Story Script', google: 'Story Script' }]);
  assert.deepEqual(readGoogleFontList(path.join(directory, 'missing')), []);

  // A stand-in for slide-editor's prepareFonts(): a folder per family with the files and a <hash>.json describing them.
  const requested = [];
  const download = async (fonts, cacheDirectory) => {
    requested.push(...fonts.map((font) => font.name));
    for (const [folder, spec, faces] of [['gorditas-1', 'Gorditas:wght@400;700', [400, 700]], ['metamorphous-2', 'Metamorphous', [400]]]) {
      await fs.mkdir(path.join(cacheDirectory, folder), { recursive: true });
      for (const weight of faces) await fs.writeFile(path.join(cacheDirectory, folder, `${weight}-normal.ttf`), 'font');
      await fs.writeFile(path.join(cacheDirectory, folder, 'abc.json'), JSON.stringify({ spec, faces: faces.map((weight) => ({ weight, style: 'normal', file: `${weight}-normal.ttf` })) }));
    }
    return { loaded: ['Gorditas', 'Metamorphous'], failed: [{ family: 'Story Script', error: 'offline' }] };
  };
  const failed = await prepareSlideFonts({ download, directory: seedFonts, cacheDirectory: cache });
  assert.deepEqual(requested, ['Gorditas', 'Metamorphous', 'Story Script']);
  assert.deepEqual(failed, [{ family: 'Story Script', error: 'offline' }]);
  const google = slideFonts().filter((font) => font.file.startsWith(cache));
  assert.deepEqual(google.map((font) => [font.family, font.weight, font.key]),
    [['Gorditas', '400', 'gorditas-1-400-normal.ttf'], ['Gorditas', '700', 'gorditas-1-700-normal.ttf'], ['Metamorphous', '400', 'metamorphous-2-400-normal.ttf']]);
  // The same file names in different folders get their own URLs.
  const menu = editorFonts(google, []);
  assert.deepEqual(menu.map((font) => font.name), ['Gorditas', 'Metamorphous']);
  assert.equal(menu[1].files[0].url, '/api/slides/fonts/metamorphous-2-400-normal.ttf');

  // Without a font list nothing is downloaded; a failing download leaves the fonts out.
  await fs.rm(path.join(seedFonts, 'google-fonts.txt'));
  assert.deepEqual(await prepareSlideFonts({ download: () => assert.fail('no download'), directory: seedFonts, cacheDirectory: cache }), []);
  await fs.writeFile(path.join(seedFonts, 'google-fonts.txt'), '<link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet">');
  assert.deepEqual(await prepareSlideFonts({ download: async () => { throw new Error('renderer failed'); }, directory: seedFonts, cacheDirectory: cache }),
    [{ family: 'Inter', error: 'renderer failed' }]);
});

test('fonts are offered under their real names (read from the files), only fonts the server has', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-fonts-'));
  after(() => fs.rm(directory, { recursive: true, force: true }));
  const write = async (file, ...info) => { await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await fs.writeFile(path.join(directory, file), fontFile(...info)); };
  await write('system/truetype/croscore/Arimo-Regular.ttf', 'Arimo', 'Regular', 400, false);
  await write('system/truetype/croscore/Arimo-BoldItalic.ttf', 'Arimo', 'Bold Italic', 700, true);
  await write('system/truetype/croscore/Tinos-Regular.ttf', 'Tinos', 'Regular', 400, false);
  await write('system/opentype/urw/NimbusSans-Regular.otf', 'Nimbus Sans', 'Regular', 400, false);
  await write('system/opentype/urw/NimbusMonoPS-Regular.otf', 'Nimbus Mono PS', 'Regular', 400, false);
  await write('system/truetype/other/Comic-Regular.ttf', 'Comic', 'Regular', 400, false);
  // Own fonts: the family comes from the file, whatever the file is called.
  await write('custom/whatever.ttf', 'Inter Display', 'Medium', 500, false);
  await fs.writeFile(path.join(directory, 'custom', 'Archivo Black.ttf'), 'not a font');
  assert.deepEqual(readFontInfo(path.join(directory, 'system/truetype/croscore/Arimo-BoldItalic.ttf')), { family: 'Arimo', weight: '700', style: 'italic' });
  assert.equal(readFontInfo(path.join(directory, 'custom', 'Archivo Black.ttf')), null);
  const fonts = discoverFonts({ systemDirectories: [path.join(directory, 'system')], customDirectory: path.join(directory, 'custom') });
  // One family per kind (Croscore before URW), nothing else from the system; own fonts after them.
  assert.deepEqual(fonts.map((font) => [font.family, font.weight, font.style]),
    [['Arimo', '700', 'italic'], ['Arimo', '400', 'normal'], ['Tinos', '400', 'normal'], ['Nimbus Mono PS', '400', 'normal'], ['Archivo Black', '400', 'normal'], ['Inter Display', '500', 'normal']]);
  assert.deepEqual(editorFonts(fonts, ['Arial']).map((font) => font.name), ['Arimo', 'Tinos', 'Nimbus Mono PS', 'Archivo Black', 'Inter Display']);
  assert.deepEqual(editorFonts(fonts, ['Arial'])[0].files, [{ url: '/api/slides/fonts/Arimo-BoldItalic.ttf', weight: '700', style: 'italic' },
    { url: '/api/slides/fonts/Arimo-Regular.ttf', weight: '400', style: 'normal' }]);
  assert.deepEqual(editorFonts([], ['Arial', 'Georgia']), ['Arial', 'Georgia']);
  assert.equal(describeFonts(fonts), 'Slide fonts: Arimo, Tinos, Nimbus Mono PS, Archivo Black, Inter Display');
  assert.match(describeFonts([]), /none found/);
  assert.deepEqual(fontFileFamily('/f/Inter-BoldItalic.ttf'), { family: 'Inter', weight: '700', style: 'italic' });

  // Slides with Arial, Times New Roman or Courier New switch to the family with the same widths; others stay.
  const slide = { ...blank, canvas: { objects: [{ type: 'Textbox', fontFamily: 'Arial', styles: [{ 0: { fontFamily: '"Times New Roman"' } }] },
    { type: 'Textbox', fontFamily: 'Impact' }, { type: 'Textbox', fontFamily: 'Courier New' }] } };
  const { slide: switched, replaced } = replaceMissingFonts(slide, fonts);
  assert.deepEqual([switched.canvas.objects[0].fontFamily, switched.canvas.objects[0].styles[0][0].fontFamily, switched.canvas.objects[1].fontFamily, switched.canvas.objects[2].fontFamily],
    ['Arimo', 'Tinos', 'Impact', 'Nimbus Mono PS']);
  assert.deepEqual(replaced.sort(), ['"Times New Roman" → Tinos', 'Arial → Arimo', 'Courier New → Nimbus Mono PS']);
  assert.equal(slide.canvas.objects[0].fontFamily, 'Arial', 'the original is not changed');
  assert.equal(replaceMissingFonts(blank, fonts).slide, blank);
});
