// „Änderungspaket“-Modus für Browser ohne Schreibzugriff auf Ordner (Firefox, Safari, Handys).
//
// Der Originaltresor bleibt schreibgeschützt. Neue (bereits verschlüsselte) Dateien und Ordner werden in einer
// Überlagerung gesammelt und lassen sich als ZIP exportieren, das der Nutzer in den Tresor-Ordner kopiert.
// Weil ein ZIP nichts löschen kann, dürfen nur Einträge entfernt/umbenannt werden, die in dieser Sitzung neu entstanden sind.

import { NotFoundError, VaultError } from '../crypto/errors';
import type { StorageEntry, StorageStat, VaultStorage, WriteSource } from './types';

const key = (path: string[]) => path.join('/');

interface Staged {
  blob: Blob;
  modified: number;
}

export interface PendingSummary {
  files: number;
  bytes: number;
}

export class StagedStorage implements VaultStorage {
  readonly writable = true;
  /** Marker für die Oberfläche */
  readonly staged = true;
  private readonly files = new Map<string, Staged>();
  private readonly dirs = new Set<string>();

  constructor(private readonly base: VaultStorage) {}

  get name(): string {
    return this.base.name;
  }

  // ---------------------------------------------------------------- Überlagerung

  private overlayHasDir(path: string[]): boolean {
    if (path.length === 0) return true;
    const prefix = `${key(path)}/`;
    if (this.dirs.has(key(path))) return true;
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    for (const k of this.dirs) if (k.startsWith(prefix)) return true;
    return false;
  }

  private overlayChildren(path: string[]): StorageEntry[] {
    const prefix = path.length === 0 ? '' : `${key(path)}/`;
    const out = new Map<string, StorageEntry>();
    const consider = (k: string, isFile: boolean) => {
      if (!k.startsWith(prefix)) return;
      const rest = k.slice(prefix.length);
      if (rest === '') return;
      const slash = rest.indexOf('/');
      if (slash < 0) out.set(rest, { name: rest, kind: isFile ? 'file' : 'directory' });
      else out.set(rest.slice(0, slash), { name: rest.slice(0, slash), kind: 'directory' });
    };
    for (const k of this.files.keys()) consider(k, true);
    for (const k of this.dirs) consider(k, false);
    return [...out.values()];
  }

  /** Anzahl und Größe der noch nicht exportierten Dateien. */
  pending(): PendingSummary {
    let bytes = 0;
    for (const f of this.files.values()) bytes += f.blob.size;
    return { files: this.files.size, bytes };
  }

  /** Alle gesammelten Dateien mit tresor-relativem Pfad (für den Export). */
  pendingFiles(): { path: string[]; blob: Blob; modified: number }[] {
    return [...this.files.entries()].map(([k, f]) => ({ path: k.split('/'), blob: f.blob, modified: f.modified }));
  }

  // ---------------------------------------------------------------- VaultStorage

  async list(path: string[]): Promise<StorageEntry[]> {
    let baseEntries: StorageEntry[] | null = null;
    try {
      baseEntries = await this.base.list(path);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
    const over = this.overlayChildren(path);
    if (baseEntries === null && over.length === 0 && !this.overlayHasDir(path)) throw new NotFoundError(`Verzeichnis nicht gefunden: ${key(path)}`);
    const merged = new Map<string, StorageEntry>();
    for (const e of baseEntries ?? []) merged.set(e.name, e);
    for (const e of over) merged.set(e.name, e);
    return [...merged.values()];
  }

  async exists(path: string[]): Promise<boolean> {
    if (this.files.has(key(path)) || this.overlayHasDir(path)) return true;
    return this.base.exists(path);
  }

  async getFile(path: string[]): Promise<File> {
    const s = this.files.get(key(path));
    if (s) return new File([s.blob], path[path.length - 1], { lastModified: s.modified });
    return this.base.getFile(path);
  }

  async stat(path: string[]): Promise<StorageStat> {
    const s = this.files.get(key(path));
    if (s) return { size: s.blob.size, lastModified: s.modified };
    return this.base.stat(path);
  }

  async writeFile(path: string[], data: WriteSource): Promise<void> {
    if (!this.files.has(key(path)) && (await this.base.exists(path))) {
      throw new VaultError('Eine Originaldatei des Tresors kann in diesem Browser nicht überschrieben werden.');
    }
    let blob: Blob;
    if (data instanceof Blob) blob = data;
    else if (data instanceof Uint8Array) blob = new Blob([data as BlobPart]);
    else {
      const parts: Uint8Array[] = [];
      for await (const chunk of data) parts.push(chunk);
      blob = new Blob(parts as BlobPart[]);
    }
    this.files.set(key(path), { blob, modified: Date.now() });
  }

  async makeDir(path: string[]): Promise<void> {
    if (!(await this.base.exists(path))) this.dirs.add(key(path));
  }

  async canRemove(path: string[]): Promise<boolean> {
    return (this.files.has(key(path)) || this.overlayHasDir(path)) && !(await this.base.exists(path));
  }

  async remove(path: string[], recursive = false): Promise<void> {
    if (await this.base.exists(path)) {
      throw new VaultError('Dieser Eintrag gehört zum Original-Tresor und kann in diesem Browser nicht gelöscht werden (nur in Chrome, Edge oder Opera).');
    }
    const k = key(path);
    this.files.delete(k);
    this.dirs.delete(k);
    if (recursive) {
      const prefix = `${k}/`;
      for (const f of [...this.files.keys()]) if (f.startsWith(prefix)) this.files.delete(f);
      for (const d of [...this.dirs]) if (d.startsWith(prefix)) this.dirs.delete(d);
    }
  }
}

export function isStaged(s: VaultStorage): s is StagedStorage {
  return (s as Partial<StagedStorage>).staged === true;
}
