// Dependency-free helpers for the build: CRC32, PNG encoder, ZIP writer, file walking.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encodes RGBA pixels as a PNG buffer. */
export function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Writes a ZIP archive of a directory (deflate). */
export function zipDir(dir, outFile) {
  const files = walk(dir).sort();
  const local = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (1 << 5) | 1 | ((2024 - 1980) << 9); // fixed date: reproducible zips
  for (const file of files) {
    const name = Buffer.from(path.relative(dir, file).split(path.sep).join('/'));
    const data = fs.readFileSync(file);
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outFile, Buffer.concat([...local, cd, end]));
}

export function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function copyDir(src, dest, skip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (skip(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

export function deepMerge(a, b) {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b;
  const out = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = v === null ? undefined : deepMerge(out[k], v);
  return JSON.parse(JSON.stringify(out));
}

/** Chrome managed-storage schema inferred from a defaults object. */
export function schemaFromDefaults(defaults, descriptions = {}) {
  const infer = (v) => {
    if (Array.isArray(v)) {
      const first = v.find((x) => x != null);
      return { type: 'array', items: first === undefined ? { type: 'string' } : infer(first) };
    }
    if (v === null) return { type: 'string' };
    switch (typeof v) {
      case 'boolean': return { type: 'boolean' };
      case 'number': return { type: Number.isInteger(v) ? 'integer' : 'number' };
      case 'string': return { type: 'string' };
      case 'object': {
        const properties = {};
        for (const [k, x] of Object.entries(v)) properties[k] = infer(x);
        return { type: 'object', properties, additionalProperties: Object.keys(v).length ? undefined : { type: 'string' } };
      }
      default: return { type: 'string' };
    }
  };
  const properties = {};
  for (const [k, v] of Object.entries(defaults)) {
    properties[k] = infer(v);
    if (descriptions[k]) properties[k].description = descriptions[k];
  }
  const settingsProps = JSON.parse(JSON.stringify(properties));
  const strProps = (keys) => Object.fromEntries(keys.map((k) => [k, { type: k === 'radius' ? 'integer' : 'string' }]));
  return JSON.parse(JSON.stringify({
    type: 'object',
    properties: {
      defaults: { type: 'object', description: 'Suggested values the user can change. Same keys as the enforced settings.', properties: settingsProps },
      brand: {
        type: 'object',
        description: 'Enforced brand kit fields (locked in Settings -> Branding).',
        properties: strProps(['companyName', 'productPrefix', 'logo', 'primary', 'accent', 'theme', 'radius', 'supportUrl', 'supportEmail', 'footerText']),
      },
      connection: {
        type: 'object',
        description: 'Optional shared-data backend. type: none | webhook | rest | supabase.',
        properties: { type: { type: 'string' }, url: { type: 'string' }, token: { type: 'string' }, tablePrefix: { type: 'string' }, autoSync: { type: 'boolean' } },
      },
      ...properties,
    },
  }));
}
