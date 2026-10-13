import zlib from 'node:zlib';

// Minimal zip writer (stored entries) so tests can build hostile archives: odd names, symlinks, forged sizes.
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = '', mode = 0o100644, declaredSize } of entries) {
    const body = Buffer.from(data);
    const fileName = Buffer.from(name);
    const crc = zlib.crc32(body);
    const size = declaredSize ?? body.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, body);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export const manifest = (id, extra = {}) => JSON.stringify({ $schema: 'https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json',
  id, name: `Graphic ${id}`, version: '1.2.0', main: 'graphic.mjs', supportsRealTime: true, supportsNonRealTime: false, ...extra });
export const graphicFiles = (prefix = '', id = 'lower-third') => [
  { name: `${prefix}${id}.ograf.json`, data: manifest(id) },
  { name: `${prefix}graphic.mjs`, data: 'export default class extends HTMLElement {}' },
  { name: `${prefix}style.css`, data: 'p{}' }
];
