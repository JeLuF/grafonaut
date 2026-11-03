import fs from 'node:fs';

// Family, weight and style from a .ttf/.otf file (its "name" and "OS/2" tables). Fonts are registered and offered
// under these real names: node-canvas finds a font by an alias (e.g. "Arial" for Liberation Sans) only with a system
// fontconfig configuration, which slim Docker images lack. null for files that can't be read.
export function readFontInfo(file) {
  let data;
  try { data = fs.readFileSync(file); } catch { return null; }
  try {
    if (data.length < 12) return null;
    const tables = new Map();
    const count = data.readUInt16BE(4);
    for (let index = 0; index < count; index++) {
      const record = 12 + index * 16;
      if (record + 16 > data.length) return null;
      tables.set(data.toString('latin1', record, record + 4), { offset: data.readUInt32BE(record + 8), length: data.readUInt32BE(record + 12) });
    }
    const name = tables.get('name');
    if (!name) return null;
    const names = new Map();
    const records = data.readUInt16BE(name.offset + 2);
    const strings = name.offset + data.readUInt16BE(name.offset + 4);
    for (let index = 0; index < records; index++) {
      const record = name.offset + 6 + index * 12;
      const [platform, , language, id, length, offset] = [0, 2, 4, 6, 8, 10].map((at) => data.readUInt16BE(record + at));
      const start = strings + offset;
      if (start + length > data.length) continue;
      // Windows names (UTF-16BE), US English preferred; else Macintosh Roman.
      let text = null;
      let rank = 0;
      if (platform === 3) {
        const bytes = Buffer.from(data.subarray(start, start + length));
        bytes.swap16();
        text = bytes.toString('utf16le');
        rank = language === 0x409 ? 3 : 2;
      } else if (platform === 1) { text = data.toString('latin1', start, start + length); rank = 1; }
      if (text && rank > (names.get(id)?.rank ?? 0)) names.set(id, { text: text.trim(), rank });
    }
    // Typographic family (16) where there is one, e.g. "Inter" rather than "Inter Medium".
    const family = names.get(16)?.text || names.get(1)?.text;
    if (!family) return null;
    const subfamily = (names.get(17)?.text || names.get(2)?.text || '').toLowerCase();
    const os2 = tables.get('OS/2');
    let weight = /bold|black|heavy/.test(subfamily) ? 700 : 400;
    let italic = /italic|oblique/.test(subfamily);
    if (os2 && os2.length >= 64) {
      weight = data.readUInt16BE(os2.offset + 4) || weight;
      italic = italic || Boolean(data.readUInt16BE(os2.offset + 62) & 1);
    }
    return { family, weight: String(weight), style: italic ? 'italic' : 'normal' };
  } catch { return null; }
}
