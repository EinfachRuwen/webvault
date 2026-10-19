import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NotFoundError } from '../../src/crypto/errors';
import type { StorageEntry, VaultStorage, WriteSource } from '../../src/storage/types';

/** VaultStorage auf einem echten Verzeichnis – nur für Tests. */
export class NodeStorage implements VaultStorage {
  readonly writable = true;
  constructor(
    private readonly root: string,
    readonly name = path.basename(root),
  ) {}

  private p(segs: string[]) {
    return path.join(this.root, ...segs);
  }

  async list(segs: string[]): Promise<StorageEntry[]> {
    try {
      const items = await fs.readdir(this.p(segs), { withFileTypes: true });
      return items.map((d) => ({ name: d.name, kind: d.isDirectory() ? 'directory' : 'file' }));
    } catch {
      throw new NotFoundError(segs.join('/'));
    }
  }
  async exists(segs: string[]) {
    return fs.access(this.p(segs)).then(() => true, () => false);
  }
  async getFile(segs: string[]): Promise<File> {
    try {
      const full = this.p(segs);
      const [buf, st] = await Promise.all([fs.readFile(full), fs.stat(full)]);
      return new File([buf], segs[segs.length - 1], { lastModified: st.mtimeMs });
    } catch {
      throw new NotFoundError(segs.join('/'));
    }
  }
  async writeFile(segs: string[], data: WriteSource) {
    await fs.mkdir(path.dirname(this.p(segs)), { recursive: true });
    const parts: Uint8Array[] = [];
    if (data instanceof Blob) parts.push(new Uint8Array(await data.arrayBuffer()));
    else if (data instanceof Uint8Array) parts.push(data);
    else for await (const c of data) parts.push(c);
    await fs.writeFile(this.p(segs), Buffer.concat(parts));
  }
  async makeDir(segs: string[]) {
    await fs.mkdir(this.p(segs), { recursive: true });
  }
  async remove(segs: string[], recursive = false) {
    await fs.rm(this.p(segs), { recursive, force: true });
  }
}
