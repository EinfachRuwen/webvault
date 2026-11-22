// HEIC-Container. Testbilder: libheif 1.23 (pillow-heif) bzw. Pillow.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { heifExif, hevcCodecString, parseHeifImage } from '../src/media/heif';

const media = (n: string) => new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', 'media', n)));

describe('HEIF', () => {
  it('liest Größe, HEVC-Konfiguration und Bilddaten', () => {
    const img = parseHeifImage(media('foto.heic'));
    expect([img.width, img.height, img.columns, img.tiles.length, img.rotation]).toEqual([96, 64, 1, 1, 0]);
    expect(img.hvcC[0]).toBe(1); // configurationVersion
    expect(hevcCodecString(img.hvcC)).toMatch(/^hvc1\.[A-C]?\d+\.[0-9A-F]+\.[LH]\d+(\.[0-9A-F]+)*$/);
    // Kachel = Länge-präfixierte NAL-Einheiten, die genau aufgehen
    const t = img.tiles[0];
    let o = 0;
    while (o < t.length) o += 4 + new DataView(t.buffer, t.byteOffset + o).getUint32(0);
    expect(o).toBe(t.length);
  });
  it('findet den EXIF-Block im HEIC', () => {
    expect(heifExif(media('foto.heic'))?.subarray(0, 2)).toEqual(new Uint8Array([0x4d, 0x4d]));
  });
  it('lehnt Nicht-HEIF ab und verkraftet abgeschnittene Dateien', () => {
    expect(() => parseHeifImage(media('foto.jpg'))).toThrow();
    expect(() => parseHeifImage(media('foto.heic').subarray(0, 40))).toThrow();
  });
});

