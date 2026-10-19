// Minimaler, streamender ZIP-Writer (nur „stored“, ohne Kompression, kein ZIP64).
// Dateien werden mit Data-Descriptor geschrieben, so dass kein Zwischenpuffer nötig ist.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc: number, data: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const MAX = 0xffffffff;

interface CentralEntry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  isDir: boolean;
}

export class ZipWriter {
  private offset = 0;
  private readonly central: CentralEntry[] = [];
  private readonly enc = new TextEncoder();

  constructor(private readonly sink: (chunk: Uint8Array) => Promise<void>) {}

  private async write(chunk: Uint8Array) {
    this.offset += chunk.length;
    if (this.offset > MAX) throw new Error('Das ZIP-Archiv würde 4 GB überschreiten. Bitte weniger Dateien auf einmal herunterladen.');
    await this.sink(chunk);
  }

  private localHeader(name: Uint8Array, time: number, date: number, isDir: boolean): Uint8Array {
    const h = new Uint8Array(30 + name.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, isDir ? 0x0800 : 0x0808, true); // Bit 11: UTF-8, Bit 3: Data-Descriptor
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint16(26, name.length, true);
    h.set(name, 30);
    return h;
  }

  async addDirectory(path: string, modified = new Date()): Promise<void> {
    const name = this.enc.encode(path.endsWith('/') ? path : `${path}/`);
    const { time, date } = dosDateTime(modified);
    this.central.push({ name, crc: 0, size: 0, offset: this.offset, time, date, isDir: true });
    await this.write(this.localHeader(name, time, date, true));
  }

  async addFile(path: string, data: AsyncIterable<Uint8Array>, modified = new Date()): Promise<void> {
    const name = this.enc.encode(path);
    const { time, date } = dosDateTime(modified);
    const entry: CentralEntry = { name, crc: 0, size: 0, offset: this.offset, time, date, isDir: false };
    await this.write(this.localHeader(name, time, date, false));
    for await (const chunk of data) {
      entry.crc = crc32(entry.crc, chunk);
      entry.size += chunk.length;
      await this.write(chunk);
    }
    if (entry.size > MAX) throw new Error('Datei zu groß für ZIP (> 4 GB).');
    const dd = new Uint8Array(16);
    const v = new DataView(dd.buffer);
    v.setUint32(0, 0x08074b50, true);
    v.setUint32(4, entry.crc, true);
    v.setUint32(8, entry.size, true);
    v.setUint32(12, entry.size, true);
    await this.write(dd);
    this.central.push(entry);
  }

  async finish(): Promise<void> {
    if (this.central.length > 0xffff) throw new Error('Zu viele Dateien für ein ZIP-Archiv (> 65.535).');
    const start = this.offset;
    for (const e of this.central) {
      const h = new Uint8Array(46 + e.name.length);
      const v = new DataView(h.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, e.isDir ? 0x0800 : 0x0808, true);
      v.setUint16(12, e.time, true);
      v.setUint16(14, e.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      if (e.isDir) v.setUint32(38, 0x10, true); // MS-DOS-Verzeichnisattribut
      v.setUint32(42, e.offset, true);
      h.set(e.name, 46);
      await this.write(h);
    }
    const size = this.offset - start;
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, this.central.length, true);
    v.setUint16(10, this.central.length, true);
    v.setUint32(12, size, true);
    v.setUint32(16, start, true);
    await this.write(end);
  }
}
