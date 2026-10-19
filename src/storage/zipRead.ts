// Schreibgeschützter Zugriff auf einen als ZIP-Datei gepackten Tresor-Ordner.
// Gedacht für Geräte ohne Ordnerauswahl (Handy/Tablet): Tresor in der Dateien-App zippen, ZIP hier öffnen.
// Es wird nur das Inhaltsverzeichnis gelesen; Dateiinhalte werden erst bei Bedarf per File.slice() geholt.

import { NotAVaultError, NotFoundError, ReadOnlyError, UnsupportedVaultError } from '../crypto/errors';
import type { StorageEntry, StorageStat, VaultStorage } from './types';

interface ZipEntry {
  path: string[];
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  lastModified: number;
}

interface Node {
  dirs: Map<string, Node>;
  files: Map<string, ZipEntry>;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function dosToMs(time: number, date: number): number {
  const d = new Date(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0x0f) - 1, date & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
  return d.getTime();
}

async function readBytes(file: Blob, start: number, end: number): Promise<DataView> {
  const buf = await file.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

/** Liest das Inhaltsverzeichnis (inkl. ZIP64). Gibt nur Dateien zurück, keine Verzeichnisse. */
export async function readZipDirectory(file: Blob): Promise<ZipEntry[]> {
  // End-of-central-directory suchen (max. 64 KiB Kommentar)
  const tailStart = Math.max(0, file.size - (22 + 0xffff));
  const tail = await readBytes(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new NotAVaultError('Das ist keine gültige ZIP-Datei (Inhaltsverzeichnis nicht gefunden).');

  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locPos = eocd - 20;
    if (locPos < 0 || tail.getUint32(locPos, true) !== SIG_LOC64) throw new NotAVaultError('ZIP64-Verzeichnis ist beschädigt.');
    const eocd64Offset = Number(tail.getBigUint64(locPos + 8, true));
    const rec = await readBytes(file, eocd64Offset, eocd64Offset + 56);
    if (rec.getUint32(0, true) !== SIG_EOCD64) throw new NotAVaultError('ZIP64-Verzeichnis ist beschädigt.');
    count = Number(rec.getBigUint64(32, true));
    cdSize = Number(rec.getBigUint64(40, true));
    cdOffset = Number(rec.getBigUint64(48, true));
  }

  const cd = await readBytes(file, cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder('utf-8');
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cd.byteLength || cd.getUint32(pos, true) !== SIG_CEN) throw new NotAVaultError('ZIP-Inhaltsverzeichnis ist beschädigt.');
    const flags = cd.getUint16(pos + 8, true);
    const method = cd.getUint16(pos + 10, true);
    const time = cd.getUint16(pos + 12, true);
    const date = cd.getUint16(pos + 14, true);
    let compressedSize = cd.getUint32(pos + 20, true);
    let size = cd.getUint32(pos + 24, true);
    const nameLen = cd.getUint16(pos + 28, true);
    const extraLen = cd.getUint16(pos + 30, true);
    const commentLen = cd.getUint16(pos + 32, true);
    let localOffset = cd.getUint32(pos + 42, true);
    const name = decoder.decode(new Uint8Array(cd.buffer, pos + 46, nameLen));

    // ZIP64-Extra-Feld: enthält nur die Werte, die im 32-Bit-Feld 0xFFFFFFFF sind (Reihenfolge fest)
    let ex = pos + 46 + nameLen;
    const exEnd = ex + extraLen;
    while (ex + 4 <= exEnd) {
      const id = cd.getUint16(ex, true);
      const len = cd.getUint16(ex + 2, true);
      if (id === 0x0001) {
        let p = ex + 4;
        if (size === 0xffffffff) {
          size = Number(cd.getBigUint64(p, true));
          p += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(cd.getBigUint64(p, true));
          p += 8;
        }
        if (localOffset === 0xffffffff) localOffset = Number(cd.getBigUint64(p, true));
      }
      ex += 4 + len;
    }
    pos += 46 + nameLen + extraLen + commentLen;

    void flags;
    if (name.endsWith('/')) continue; // Verzeichniseintrag
    entries.push({ path: name.split('/').filter((s) => s !== ''), method, compressedSize, size, localOffset, lastModified: dosToMs(time, date) });
  }
  return entries;
}

function newNode(): Node {
  return { dirs: new Map(), files: new Map() };
}

export class ZipStorage implements VaultStorage {
  readonly writable = false;
  private readonly root = newNode();

  private constructor(
    readonly name: string,
    private readonly zip: Blob,
    entries: ZipEntry[],
  ) {
    for (const e of entries) {
      let node = this.root;
      for (const seg of e.path.slice(0, -1)) {
        let next = node.dirs.get(seg);
        if (!next) node.dirs.set(seg, (next = newNode()));
        node = next;
      }
      node.files.set(e.path[e.path.length - 1], e);
    }
  }

  static async open(zip: File): Promise<ZipStorage> {
    const all = await readZipDirectory(zip);
    // Mac-Metadaten und Versteckte ignorieren
    const entries = all.filter((e) => e.path[0] !== '__MACOSX' && !e.path.at(-1)!.startsWith('._') && e.path.at(-1) !== '.DS_Store');

    // Der Tresor liegt meist in einem Oberordner („Mein Tresor/vault.cryptomator“) oder direkt im Wurzelverzeichnis.
    const rootEntry = entries
      .filter((e) => e.path.at(-1) === 'vault.cryptomator' && e.path.length <= 2)
      .sort((a, b) => a.path.length - b.path.length)[0];
    if (!rootEntry) {
      if (entries.some((e) => e.path.at(-1) === 'masterkey.cryptomator')) {
        throw new UnsupportedVaultError('Dieses ZIP enthält einen Tresor im alten Format (ohne vault.cryptomator).');
      }
      throw new NotAVaultError('In dieser ZIP-Datei wurde kein Cryptomator-Tresor gefunden (vault.cryptomator fehlt). Bitte den kompletten Tresor-Ordner zippen.');
    }
    const prefix = rootEntry.path.slice(0, -1);
    const inVault = entries
      .filter((e) => prefix.every((seg, i) => e.path[i] === seg))
      .map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
    const name = prefix[0] ?? zip.name.replace(/\.zip$/i, '');
    return new ZipStorage(name, zip, inVault);
  }

  /** Alle Dateien eines beliebigen ZIPs (ohne Tresor-Prüfung), z. B. um ein exportiertes Änderungspaket zu verifizieren. */
  static async openRaw(zip: File): Promise<{ path: string[]; file: () => Promise<File> }[]> {
    const entries = await readZipDirectory(zip);
    const storage = new ZipStorage(zip.name, zip, entries);
    return entries.map((e) => ({ path: e.path, file: () => storage.getFile(e.path) }));
  }

  private node(path: string[]): Node {
    let cur = this.root;
    for (const seg of path) {
      const next = cur.dirs.get(seg);
      if (!next) throw new NotFoundError(`Verzeichnis nicht gefunden: ${path.join('/')}`);
      cur = next;
    }
    return cur;
  }

  private entry(path: string[]): ZipEntry {
    let e: ZipEntry | undefined;
    try {
      e = this.node(path.slice(0, -1)).files.get(path[path.length - 1]);
    } catch {
      /* unten */
    }
    if (!e) throw new NotFoundError(`Datei nicht gefunden: ${path.join('/')}`);
    return e;
  }

  async list(path: string[]): Promise<StorageEntry[]> {
    const n = this.node(path);
    return [
      ...Array.from(n.dirs.keys(), (name): StorageEntry => ({ name, kind: 'directory' })),
      ...Array.from(n.files.keys(), (name): StorageEntry => ({ name, kind: 'file' })),
    ];
  }

  async exists(path: string[]): Promise<boolean> {
    if (path.length === 0) return true;
    try {
      const parent = this.node(path.slice(0, -1));
      const name = path[path.length - 1];
      return parent.dirs.has(name) || parent.files.has(name);
    } catch {
      return false;
    }
  }

  async stat(path: string[]): Promise<StorageStat> {
    const e = this.entry(path);
    return { size: e.size, lastModified: e.lastModified };
  }

  async getFile(path: string[]): Promise<File> {
    const e = this.entry(path);
    // Lokalen Header lesen, um den Beginn der Daten zu finden (Extra-Feld kann vom zentralen abweichen).
    const header = await readBytes(this.zip, e.localOffset, e.localOffset + 30);
    if (header.getUint32(0, true) !== SIG_LOCAL) throw new NotAVaultError('ZIP-Eintrag ist beschädigt.');
    const start = e.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const raw = this.zip.slice(start, start + e.compressedSize);
    const name = path[path.length - 1];
    if (e.method === 0) return new File([raw], name, { lastModified: e.lastModified });
    if (e.method === 8) {
      // Tresor-Dateien sind verschlüsselt und damit kaum komprimiert; kleine Metadateien entpacken wir komplett.
      const blob = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      return new File([blob], name, { lastModified: e.lastModified });
    }
    throw new UnsupportedVaultError(`Nicht unterstützte ZIP-Kompression (Methode ${e.method}). Bitte ohne oder mit normaler Kompression zippen.`);
  }

  async writeFile(): Promise<void> {
    throw new ReadOnlyError();
  }
  async makeDir(): Promise<void> {
    throw new ReadOnlyError();
  }
  async remove(): Promise<void> {
    throw new ReadOnlyError();
  }
}
