import { deflateRawSync, crc32 } from 'node:zlib';

export interface TestZipEntry {
  name: string;
  data?: Uint8Array | string; // fehlt = Verzeichnis
  method?: 0 | 8;
}

/** Baut ZIPs für Tests – optional im ZIP64-Layout (0xFFFFFFFF-Marker, Extra-Felder, EOCD64 + Locator). */
export function buildZip(entries: TestZipEntry[], { zip64 = false }: { zip64?: boolean } = {}): Buffer {
  const out: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const isDir = e.data === undefined;
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(typeof e.data === 'string' ? Buffer.from(e.data) : e.data!);
    const method = isDir ? 0 : (e.method ?? 0);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const cen = Buffer.alloc(46 + name.length + extra.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(45, 4);
    cen.writeUInt16LE(45, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
    cen.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(extra.length, 30);
    cen.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    name.copy(cen, 46);
    extra.copy(cen, 46 + name.length);
    central.push(cen);

    out.push(local, body);
    offset += local.length + body.length;
  }
  const cd = Buffer.concat(central);
  const cdOffset = offset;
  const parts = [...out, cd];
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(rec, loc);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
  } else {
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
  }
  parts.push(eocd);
  return Buffer.concat(parts);
}
