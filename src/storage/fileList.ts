// Schreibgeschützter Fallback für Browser ohne File System Access API (Firefox, Safari):
// Der Nutzer wählt den Ordner über <input webkitdirectory> oder per Drag & Drop.

import { NotFoundError, ReadOnlyError } from '../crypto/errors';
import type { StorageEntry, VaultStorage } from './types';

interface Node {
  dirs: Map<string, Node>;
  files: Map<string, File>;
}

function newNode(): Node {
  return { dirs: new Map(), files: new Map() };
}

export class FileListStorage implements VaultStorage {
  readonly writable = false;
  private readonly root = newNode();

  /**
   * @param files Dateien samt Pfad *inklusive* Ordnername als erstem Segment (wie `webkitRelativePath`).
   */
  constructor(
    readonly name: string,
    files: { file: File; path: string[] }[],
  ) {
    for (const { file, path } of files) {
      const segs = path.slice(1); // Wurzelordner abschneiden
      let node = this.root;
      for (const seg of segs.slice(0, -1)) {
        let next = node.dirs.get(seg);
        if (!next) node.dirs.set(seg, (next = newNode()));
        node = next;
      }
      node.files.set(segs[segs.length - 1], file);
    }
  }

  static fromInput(files: FileList): FileListStorage {
    const list = Array.from(files).map((file) => ({ file, path: (file.webkitRelativePath || file.name).split('/') }));
    return new FileListStorage(list[0]?.path[0] ?? 'Tresor', list);
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

  async getFile(path: string[]): Promise<File> {
    const file = this.node(path.slice(0, -1)).files.get(path[path.length - 1]);
    if (!file) throw new NotFoundError(`Datei nicht gefunden: ${path.join('/')}`);
    return file;
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

/** Liest einen per Drag & Drop abgelegten Ordner (webkitGetAsEntry) rekursiv ein. */
export async function storageFromDroppedEntry(entry: FileSystemEntry): Promise<FileListStorage> {
  const out: { file: File; path: string[] }[] = [];

  const readAll = (reader: FileSystemDirectoryReader) =>
    new Promise<FileSystemEntry[]>((resolve, reject) => {
      const all: FileSystemEntry[] = [];
      const next = () =>
        reader.readEntries((batch) => {
          if (batch.length === 0) resolve(all);
          else {
            all.push(...batch);
            next();
          }
        }, reject);
      next();
    });

  async function walk(e: FileSystemEntry, path: string[]): Promise<void> {
    if (e.isFile) {
      const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: [...path, e.name] });
    } else if (e.isDirectory) {
      const children = await readAll((e as FileSystemDirectoryEntry).createReader());
      for (const c of children) await walk(c, [...path, e.name]);
    }
  }

  if (!entry.isDirectory) throw new NotFoundError('Bitte einen Ordner ablegen, keine einzelne Datei.');
  await walk(entry, []);
  return new FileListStorage(entry.name, out);
}
