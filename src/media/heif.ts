// Minimaler HEIF/HEIC-Container-Parser (ISO/IEC 23008-12): genau so viel, wie für die Anzeige von iPhone-Fotos
// und das Aufnahmedatum nötig ist. Liest nur Struktur, dekodiert nichts. Toleriert abgeschnittene Daten
// (für das Aufnahmedatum wird nur der Dateianfang entschlüsselt).

export interface HeifExtent { offset: number; length: number }
export interface HeifItem { id: number; type: string; extents: HeifExtent[]; method: number }
export interface HeifImage {
  /** HEVC-Konfiguration (Inhalt der hvcC-Box ohne Kopf) */
  hvcC: Uint8Array;
  /** Kacheln in Zeilenreihenfolge, je Länge-präfixierte NAL-Einheiten */
  tiles: Uint8Array[];
  tileWidth: number;
  tileHeight: number;
  columns: number;
  /** Ausgabegröße (bei Raster beschnitten) */
  width: number;
  height: number;
  /** Drehung gegen den Uhrzeigersinn in Vierteldrehungen (irot) */
  rotation: number;
  /** Spiegelung (imir): 0 = vertikale Achse, 1 = horizontale Achse */
  mirror?: number;
}

export class HeifError extends Error {}

interface Box { type: string; start: number; end: number; body: number }

class Reader {
  readonly v: DataView;
  constructor(readonly b: Uint8Array) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8(o: number) { return this.b[o]; }
  u16(o: number) { return this.v.getUint16(o); }
  u32(o: number) { return this.v.getUint32(o); }
  uN(o: number, n: number) {
    if (n === 0) return 0;
    if (n === 1) return this.u8(o);
    if (n === 2) return this.u16(o);
    if (n === 4) return this.u32(o);
    if (n === 8) return this.u32(o) * 2 ** 32 + this.u32(o + 4);
    throw new HeifError(`Feldbreite ${n}`);
  }
  fourcc(o: number) { return String.fromCharCode(this.b[o], this.b[o + 1], this.b[o + 2], this.b[o + 3]); }
  /** Boxen zwischen start und end; hört an abgeschnittenen Boxen auf. */
  boxes(start: number, end: number): Box[] {
    const out: Box[] = [];
    let o = start;
    while (o + 8 <= end) {
      let size = this.u32(o);
      const type = this.fourcc(o + 4);
      let body = o + 8;
      if (size === 1) { size = this.uN(o + 8, 8); body = o + 16; }
      else if (size === 0) size = end - o;
      if (size < 8) break;
      out.push({ type, start: o, end: Math.min(o + size, end), body });
      if (o + size > end) break;
      o += size;
    }
    return out;
  }
}

export interface HeifMeta {
  primary: number;
  items: Map<number, HeifItem>;
  /** Eigenschaften je Item (ipco-Boxen in Zuordnungsreihenfolge) */
  props: Map<number, Box[]>;
  /** dimg-Verweise (Raster → Kacheln) und cdsc-Verweise (Exif → Bild) */
  refs: { type: string; from: number; to: number[] }[];
  idat?: Box;
  r: Reader;
}

export function parseHeifMeta(bytes: Uint8Array): HeifMeta {
  const r = new Reader(bytes);
  const top = r.boxes(0, bytes.length);
  if (top[0]?.type !== 'ftyp') throw new HeifError('Keine HEIF-Datei');
  const meta = top.find((b) => b.type === 'meta');
  if (!meta || meta.end - meta.start < 12) throw new HeifError('meta-Box fehlt');
  const kids = r.boxes(meta.body + 4, meta.end); // FullBox
  const find = (t: string) => kids.find((k) => k.type === t);

  const pitm = find('pitm');
  const primary = pitm ? (r.u8(pitm.body) === 0 ? r.u16(pitm.body + 4) : r.u32(pitm.body + 4)) : 0;

  const items = new Map<number, HeifItem>();
  const iinf = find('iinf');
  if (iinf) {
    const v = r.u8(iinf.body);
    for (const infe of r.boxes(iinf.body + (v === 0 ? 6 : 8), iinf.end).filter((b) => b.type === 'infe')) {
      const iv = r.u8(infe.body);
      if (iv < 2) continue;
      const id = iv === 2 ? r.u16(infe.body + 4) : r.u32(infe.body + 4);
      const typeAt = infe.body + 4 + (iv === 2 ? 2 : 4) + 2;
      items.set(id, { id, type: r.fourcc(typeAt), extents: [], method: 0 });
    }
  }

  const iloc = find('iloc');
  if (iloc) {
    let o = iloc.body;
    const v = r.u8(o);
    o += 4;
    const offSize = r.u8(o) >> 4, lenSize = r.u8(o) & 15, baseSize = r.u8(o + 1) >> 4, idxSize = v >= 1 ? r.u8(o + 1) & 15 : 0;
    o += 2;
    const count = v < 2 ? r.u16(o) : r.u32(o);
    o += v < 2 ? 2 : 4;
    for (let i = 0; i < count && o < iloc.end; i++) {
      const id = v < 2 ? r.u16(o) : r.u32(o);
      o += v < 2 ? 2 : 4;
      let method = 0;
      if (v >= 1) { method = r.u16(o) & 15; o += 2; }
      o += 2; // data_reference_index
      const base = r.uN(o, baseSize);
      o += baseSize;
      const n = r.u16(o);
      o += 2;
      const extents: HeifExtent[] = [];
      for (let e = 0; e < n; e++) {
        o += idxSize;
        const offset = base + r.uN(o, offSize);
        o += offSize;
        const length = r.uN(o, lenSize);
        o += lenSize;
        extents.push({ offset, length });
      }
      const it = items.get(id) ?? { id, type: '', extents: [], method: 0 };
      it.extents = extents;
      it.method = method;
      items.set(id, it);
    }
  }

  const props = new Map<number, Box[]>();
  const iprp = find('iprp');
  if (iprp) {
    const parts = r.boxes(iprp.body, iprp.end);
    const ipco = parts.find((b) => b.type === 'ipco');
    const all = ipco ? r.boxes(ipco.body, ipco.end) : [];
    for (const ipma of parts.filter((b) => b.type === 'ipma')) {
      const v = r.u8(ipma.body), wide = (r.u32(ipma.body) & 1) === 1;
      let o = ipma.body + 4;
      const count = r.u32(o);
      o += 4;
      for (let i = 0; i < count && o < ipma.end; i++) {
        const id = v < 1 ? r.u16(o) : r.u32(o);
        o += v < 1 ? 2 : 4;
        const n = r.u8(o++);
        const list = props.get(id) ?? [];
        for (let a = 0; a < n; a++) {
          const idx = wide ? r.u16(o) & 0x7fff : r.u8(o) & 0x7f;
          o += wide ? 2 : 1;
          if (idx > 0 && all[idx - 1]) list.push(all[idx - 1]);
        }
        props.set(id, list);
      }
    }
  }

  const refs: HeifMeta['refs'] = [];
  const iref = find('iref');
  if (iref) {
    const wide = r.u8(iref.body) !== 0;
    for (const ref of r.boxes(iref.body + 4, iref.end)) {
      let o = ref.body;
      const from = wide ? r.u32(o) : r.u16(o);
      o += wide ? 4 : 2;
      const n = r.u16(o);
      o += 2;
      const to: number[] = [];
      for (let i = 0; i < n; i++) { to.push(wide ? r.u32(o) : r.u16(o)); o += wide ? 4 : 2; }
      refs.push({ type: ref.type, from, to });
    }
  }
  return { primary, items, props, refs, idat: find('idat'), r };
}

/** Daten eines Items, oder `undefined`, wenn sie außerhalb des gelesenen Bereichs liegen. */
export function itemData(m: HeifMeta, item: HeifItem): Uint8Array | undefined {
  const base = item.method === 1 ? (m.idat?.body ?? -1) : 0;
  if (base < 0 || (item.method !== 0 && item.method !== 1)) return undefined;
  const total = item.extents.reduce((s, e) => s + e.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const e of item.extents) {
    const start = base + e.offset;
    if (start + e.length > m.r.b.length) return undefined;
    out.set(m.r.b.subarray(start, start + e.length), pos);
    pos += e.length;
  }
  return out;
}

const prop = (m: HeifMeta, id: number, type: string) => m.props.get(id)?.find((p) => p.type === type);

export function parseHeifImage(bytes: Uint8Array): HeifImage {
  const m = parseHeifMeta(bytes);
  const r = m.r;
  const primary = m.items.get(m.primary);
  if (!primary) throw new HeifError('Primärbild fehlt');

  let tileIds: number[];
  let columns = 1, width = 0, height = 0;
  if (primary.type === 'grid') {
    const desc = itemData(m, primary);
    if (!desc || desc.length < 8) throw new HeifError('Rasterbeschreibung fehlt');
    const d = new Reader(desc);
    const wide = (d.u8(1) & 1) === 1;
    columns = d.u8(3) + 1;
    width = wide ? d.u32(4) : d.u16(4);
    height = wide ? d.u32(8) : d.u16(6);
    tileIds = m.refs.find((x) => x.type === 'dimg' && x.from === primary.id)?.to ?? [];
    if (tileIds.length !== columns * (d.u8(2) + 1)) throw new HeifError('Kachelanzahl passt nicht');
  } else if (primary.type === 'hvc1') {
    tileIds = [primary.id];
  } else {
    throw new HeifError(`Bildtyp ${primary.type} wird nicht unterstützt`);
  }

  const first = tileIds[0];
  const hvcC = prop(m, first, 'hvcC');
  const ispe = prop(m, first, 'ispe');
  if (!hvcC || !ispe) throw new HeifError('HEVC-Konfiguration fehlt');
  const tileWidth = r.u32(ispe.body + 4), tileHeight = r.u32(ispe.body + 8);
  if (primary.type !== 'grid') { width = tileWidth; height = tileHeight; }
  const pIspe = prop(m, primary.id, 'ispe');
  if (pIspe && primary.type === 'grid') { width = r.u32(pIspe.body + 4) || width; height = r.u32(pIspe.body + 8) || height; }

  const tiles = tileIds.map((id) => {
    const it = m.items.get(id);
    const data = it && itemData(m, it);
    if (!data) throw new HeifError('Kacheldaten fehlen');
    return data;
  });
  const irot = prop(m, primary.id, 'irot');
  const imir = prop(m, primary.id, 'imir');
  return {
    hvcC: r.b.slice(hvcC.body, hvcC.end),
    tiles, tileWidth, tileHeight, columns, width, height,
    rotation: irot ? r.u8(irot.body) & 3 : 0,
    mirror: imir ? r.u8(imir.body) & 1 : undefined,
  };
}

/** Exif-Block (TIFF-Kopf an Position 0) des Primärbilds, falls im gelesenen Bereich. */
export function heifExif(bytes: Uint8Array): Uint8Array | undefined {
  const m = parseHeifMeta(bytes);
  const exifIds = [...m.items.values()].filter((i) => i.type === 'Exif').map((i) => i.id);
  const id = m.refs.find((x) => x.type === 'cdsc' && exifIds.includes(x.from) && x.to.includes(m.primary))?.from ?? exifIds[0];
  const item = id !== undefined ? m.items.get(id) : undefined;
  const data = item && itemData(m, item);
  if (!data || data.length < 4) return undefined;
  const skip = new DataView(data.buffer, data.byteOffset).getUint32(0) + 4;
  return skip < data.length ? data.subarray(skip) : undefined;
}

/** RFC-6381-Codec-Kennung aus hvcC, z. B. „hvc1.1.6.L93.B0“. */
export function hevcCodecString(hvcC: Uint8Array): string {
  const b1 = hvcC[1];
  const space = ['', 'A', 'B', 'C'][b1 >> 6];
  const tier = (b1 >> 5) & 1 ? 'H' : 'L';
  const profile = b1 & 31;
  let compat = ((hvcC[2] << 24) | (hvcC[3] << 16) | (hvcC[4] << 8) | hvcC[5]) >>> 0;
  let rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const constraints = Array.from(hvcC.subarray(6, 12));
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  const c = constraints.map((x) => x.toString(16).toUpperCase());
  return ['hvc1', `${space}${profile}`, (rev >>> 0).toString(16).toUpperCase(), `${tier}${hvcC[12]}`, ...c].join('.');
}
