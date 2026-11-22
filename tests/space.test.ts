// Speicherplatz-Manager: Summen, größte Dateien, leere Ordner, Duplikate per Inhalt.
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allFiles, byCategory, categoryOf, emptyDirs, hashDuplicates, largest, removeFromTree, sameSizeGroups, scanTree, wasted } from '../src/space/scan';
import { Vault } from '../src/vault/vault';
import { NodeStorage } from './helpers/nodeStorage';

describe('Speicherplatz', () => {
  it('summiert, findet Größtes, leere Ordner und echte Duplikate', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'space-')), 'vault');
    cpSync(path.join(__dirname, 'fixtures', 'vault-SIV_GCM'), dir, { recursive: true });
    const vault = await Vault.unlock(new NodeStorage(dir), 'correct horse battery staple');
    const manifest: { size: number }[] = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'vault-SIV_GCM.manifest.json'), 'utf8'));

    const same = new Uint8Array(200_000).fill(7);
    const other = new Uint8Array(200_000).fill(8);
    const box = await vault.createDirectory(vault.rootDirId, 'Ablage');
    await vault.uploadFile(vault.rootDirId, 'film.mp4', new Blob([same]));
    await vault.uploadFile(box.dirId!, 'film-kopie.mp4', new Blob([same]));
    await vault.uploadFile(box.dirId!, 'anders.bin', new Blob([other]));
    const leer = await vault.createDirectory(box.dirId!, 'Leer');
    await vault.createDirectory(leer.dirId!, 'auch leer');

    let progressed = 0;
    const root = await scanTree(vault, [], { onProgress: (n) => { progressed = n; } });
    const files = allFiles(root);
    expect(root.size).toBe(manifest.reduce((s, f) => s + f.size, 0) + 600_000);
    expect(root.fileCount).toBe(manifest.length + 3);
    expect(progressed).toBe(root.fileCount);
    expect(root.dirs.find((d) => d.name === 'Ablage')?.size).toBe(400_000);

    expect(largest(files, 3).map((f) => f.entry.size)).toEqual([200_000, 200_000, 200_000]);
    expect(categoryOf('film.mp4')).toBe('video');
    expect(byCategory(files).get('video')).toEqual({ bytes: 400_000, count: 2 });
    expect(emptyDirs(root).map((d) => d.name)).toEqual(['Leer']);

    const candidates = sameSizeGroups(files).filter((g) => g[0].entry.size === 200_000);
    expect(candidates[0]).toHaveLength(3);
    const dupes = await hashDuplicates(vault, candidates);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].map((f) => f.entry.name).sort()).toEqual(['film-kopie.mp4', 'film.mp4']);
    expect(wasted(dupes[0])).toBe(200_000);

    const copy = dupes[0].find((f) => f.entry.name === 'film-kopie.mp4')!.entry;
    await vault.deleteEntry(copy);
    removeFromTree(root, copy);
    expect(root.size).toBe(manifest.reduce((s, f) => s + f.size, 0) + 400_000);
    expect((await scanTree(vault, [])).size).toBe(root.size);
  });
});
