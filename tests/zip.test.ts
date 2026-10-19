import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipWriter } from '../src/ui/zip';

async function* chunks(...parts: string[]) {
  for (const p of parts) yield new TextEncoder().encode(p);
}

describe('ZipWriter', () => {
  it('schreibt ein gültiges Archiv (Einträge, CRC, Größen, Verzeichnisse, UTF-8-Namen)', async () => {
    const parts: Uint8Array[] = [];
    const zip = new ZipWriter(async (c) => void parts.push(c));
    await zip.addDirectory('Leer');
    await zip.addFile('Ordner/Ünï ☺.txt', chunks('hallo ', 'welt'));
    await zip.addFile('leer.bin', chunks());
    await zip.finish();

    const buf = Buffer.concat(parts);
    // End-of-central-directory
    const eocd = buf.length - 22;
    expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(buf.readUInt16LE(eocd + 10)).toBe(3);
    let pos = buf.readUInt32LE(eocd + 16);
    const seen: Record<string, { size: number; crc: number }> = {};
    for (let i = 0; i < 3; i++) {
      expect(buf.readUInt32LE(pos)).toBe(0x02014b50);
      const crc = buf.readUInt32LE(pos + 16);
      const size = buf.readUInt32LE(pos + 24);
      const nameLen = buf.readUInt16LE(pos + 28);
      seen[buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')] = { size, crc };
      pos += 46 + nameLen;
    }
    expect(seen['Leer/']).toEqual({ size: 0, crc: 0 });
    expect(seen['Ordner/Ünï ☺.txt']).toEqual({ size: 10, crc: crc32('hallo welt') });
    expect(seen['leer.bin']).toEqual({ size: 0, crc: 0 });
  });
});
