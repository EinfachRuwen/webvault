// Verschieben und Kopieren im Tresor – mit erneutem Lesen und Inhaltsvergleich.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vault, type VaultEntry } from '../src/vault/vault';
import { NodeStorage } from './helpers/nodeStorage';

const sha = async (vault: Vault, e: VaultEntry) => createHash('sha256').update(new Uint8Array(await (await vault.readFile(e)).arrayBuffer())).digest('hex');
const names = async (vault: Vault, dirId: string) => (await vault.listDir(dirId)).entries.map((e) => e.name).sort();
const find = async (vault: Vault, dirId: string, name: string) => (await vault.listDir(dirId)).entries.find((e) => e.name === name)!;

describe.each(['SIV_GCM', 'SIV_CTRMAC'] as const)('Verschieben & Kopieren (%s)', (combo) => {
  async function open() {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'webvault-move-')), 'vault');
    cpSync(path.join(__dirname, 'fixtures', `vault-${combo}`), dir, { recursive: true });
    return { dir, vault: await Vault.unlock(new NodeStorage(dir), 'correct horse battery staple') };
  }

  it('verschiebt Dateien und Ordner, löst Namenskonflikte und lässt sich rückgängig machen', async () => {
    const { dir, vault } = await open();
    const root = vault.rootDirId;
    const a = await vault.createDirectory(root, 'A');
    const b = await vault.createDirectory(root, 'B');
    const data = randomBytes(70_000);
    await vault.uploadFile(root, 'foto.jpg', new Blob([new Uint8Array(data)]));
    await vault.uploadFile(b.dirId!, 'foto.jpg', new Blob([new Uint8Array(randomBytes(10))]));
    const long = 'L'.repeat(230) + '.txt'; // langer Name → .c9s
    await vault.uploadFile(root, long, new Blob(['lang']));

    const foto = await find(vault, root, 'foto.jpg');
    const want = await sha(vault, foto);
    const moved = await vault.moveEntry(foto, b.dirId!, [b.dirId!]);
    expect(moved.name).toBe('foto (1).jpg');
    expect(await names(vault, b.dirId!)).toEqual(['foto (1).jpg', 'foto.jpg']);
    expect(await names(vault, root)).not.toContain('foto.jpg');
    expect(await sha(vault, await find(vault, b.dirId!, 'foto (1).jpg'))).toBe(want);

    await vault.moveEntry(await find(vault, root, long), a.dirId!, [a.dirId!]);
    expect(await names(vault, a.dirId!)).toEqual([long]);

    // Ordner B (mit Inhalt) nach A, danach rückgängig
    const bEntry = await find(vault, root, 'B');
    const bMoved = await vault.moveEntry(bEntry, a.dirId!, [a.dirId!]);
    expect(await names(vault, a.dirId!)).toEqual(['B', long].sort());
    expect(await names(vault, bMoved.dirId!)).toEqual(['foto (1).jpg', 'foto.jpg']);
    await vault.moveEntry(bMoved, root, []);
    expect(await names(vault, root)).toContain('B');

    // Nicht in sich selbst
    const aEntry = await find(vault, root, 'A');
    const inner = await vault.createDirectory(a.dirId!, 'innen');
    await expect(vault.moveEntry(aEntry, inner.dirId!, [a.dirId!, inner.dirId!])).rejects.toThrow(/in sich selbst/);
    await expect(vault.copyEntry(aEntry, a.dirId!, [a.dirId!])).rejects.toThrow(/in sich selbst/);

    // Frisch entsperrt alles lesbar
    const again = await Vault.unlock(new NodeStorage(dir), 'correct horse battery staple');
    const bAgain = await find(again, root, 'B');
    expect(await sha(again, await find(again, bAgain.dirId!, 'foto (1).jpg'))).toBe(want);
  });

  it('kopiert Dateien und Ordner rekursiv bitgleich; Original bleibt', async () => {
    const { vault } = await open();
    const root = vault.rootDirId;
    const src = await vault.createDirectory(root, 'Quelle');
    const sub = await vault.createDirectory(src.dirId!, 'Unter');
    const d1 = randomBytes(40_000), d2 = randomBytes(3 * 32768 + 5);
    await vault.uploadFile(src.dirId!, 'eins.bin', new Blob([new Uint8Array(d1)]));
    await vault.uploadFile(sub.dirId!, 'zwei.bin', new Blob([new Uint8Array(d2)]));
    let files = 0;
    const copy = await vault.copyEntry(await find(vault, root, 'Quelle'), root, [], { onFile: () => files++ });
    expect(copy.name).toBe('Quelle (1)');
    expect(files).toBe(2);
    expect(copy.dirId).not.toBe(src.dirId);
    const cSub = await find(vault, copy.dirId!, 'Unter');
    expect(await sha(vault, await find(vault, cSub.dirId!, 'zwei.bin'))).toBe(createHash('sha256').update(d2).digest('hex'));
    expect(await sha(vault, await find(vault, copy.dirId!, 'eins.bin'))).toBe(createHash('sha256').update(d1).digest('hex'));
    // Kopie ist unabhängig: Löschen der Kopie lässt das Original stehen
    await vault.deleteEntry(await find(vault, root, 'Quelle (1)'));
    expect(await names(vault, sub.dirId!)).toEqual(['zwei.bin']);
    // Duplizieren im selben Ordner
    const dup = await vault.copyEntry(await find(vault, src.dirId!, 'eins.bin'), src.dirId!, [src.dirId!]);
    expect(dup.name).toBe('eins (1).bin');
  });
});
