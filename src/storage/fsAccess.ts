// Lese-/Schreibzugriff über die File System Access API (Chromium: Chrome, Edge, Brave, Opera …).

import { NotFoundError } from '../crypto/errors';
import type { StorageEntry, StorageStat, VaultStorage, WriteSource } from './types';

export function fsAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function isNotFound(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');
}

export class FsAccessStorage implements VaultStorage {
  readonly writable = true;

  constructor(private readonly root: FileSystemDirectoryHandle) {}

  get name(): string {
    return this.root.name;
  }

  private async dir(path: string[], create = false): Promise<FileSystemDirectoryHandle> {
    let cur = this.root;
    for (const seg of path) {
      try {
        cur = await cur.getDirectoryHandle(seg, { create });
      } catch (e) {
        if (isNotFound(e)) throw new NotFoundError(`Verzeichnis nicht gefunden: ${path.join('/')}`);
        throw e;
      }
    }
    return cur;
  }

  async list(path: string[]): Promise<StorageEntry[]> {
    const dir = await this.dir(path);
    const out: StorageEntry[] = [];
    for await (const [name, handle] of dir.entries()) out.push({ name, kind: handle.kind });
    return out;
  }

  async exists(path: string[]): Promise<boolean> {
    if (path.length === 0) return true;
    try {
      const parent = await this.dir(path.slice(0, -1));
      const name = path[path.length - 1];
      try {
        await parent.getFileHandle(name);
        return true;
      } catch {
        await parent.getDirectoryHandle(name);
        return true;
      }
    } catch {
      return false;
    }
  }

  async getFile(path: string[]): Promise<File> {
    const parent = await this.dir(path.slice(0, -1));
    try {
      return await (await parent.getFileHandle(path[path.length - 1])).getFile();
    } catch (e) {
      if (isNotFound(e)) throw new NotFoundError(`Datei nicht gefunden: ${path.join('/')}`);
      throw e;
    }
  }

  async stat(path: string[]): Promise<StorageStat> {
    const f = await this.getFile(path);
    return { size: f.size, lastModified: f.lastModified };
  }

  async writeFile(path: string[], data: WriteSource): Promise<void> {
    const parent = await this.dir(path.slice(0, -1), true);
    const handle = await parent.getFileHandle(path[path.length - 1], { create: true });
    const writable = await handle.createWritable();
    try {
      if (data instanceof Blob || data instanceof Uint8Array) {
        await writable.write(data as FileSystemWriteChunkType);
      } else {
        for await (const chunk of data) await writable.write(chunk as FileSystemWriteChunkType);
      }
      await writable.close();
    } catch (e) {
      // Verwirft die Swap-Datei – die ursprüngliche Datei bleibt unverändert.
      await writable.abort().catch(() => {});
      throw e;
    }
  }

  async makeDir(path: string[]): Promise<void> {
    await this.dir(path, true);
  }

  async remove(path: string[], recursive = false): Promise<void> {
    const parent = await this.dir(path.slice(0, -1));
    try {
      await parent.removeEntry(path[path.length - 1], { recursive });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
}

export async function pickDirectoryWithFsAccess(): Promise<FsAccessStorage> {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'webvault' });
  return new FsAccessStorage(handle);
}
