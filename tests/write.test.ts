// Schreibzugriffe: Upload, Ordner anlegen, Umbenennen, Löschen – und anschließend erneut lesen.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vault, NameExistsError } from '../src/vault/vault';
import { NodeStorage } from './helpers/nodeStorage';

const PASSWORD = 'correct horse battery staple';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function names(vault: Vault, dirId: string) {
  return (await vault.listDir(dirId)).entries.map((e) => e.name).sort();
}

describe.each(['SIV_GCM', 'SIV_CTRMAC'] as const)('Schreiben (%s)', (combo) => {
  async function open() {
    // WEBVAULT_KEEP: Ergebnis behalten, um es mit der Java-Referenz gegenzuprüfen (tests/reference).
    const base = process.env.WEBVAULT_KEEP ?? mkdtempSync(path.join(tmpdir(), 'webvault-'));
    const dir = path.join(base, `vault-${combo}`);
    cpSync(path.join(__dirname, 'fixtures', `vault-${combo}`), dir, { recursive: true });
    return { dir, vault: await Vault.unlock(new NodeStorage(dir), PASSWORD) };
  }

  it('lädt Dateien hoch, legt Ordner an, benennt um und löscht', async () => {
    const { dir, vault } = await open();
    const sizes = [0, 1, 100, 32767, 32768, 32769, 5 * 32768 + 17, 70 * 32768 + 3]; // letzte: mehrere Batches
    const payloads = new Map<string, Buffer>();
    for (const size of sizes) {
      const data = randomBytes(size);
      const name = `upload-${size}.bin`;
      payloads.set(name, data);
      await vault.uploadFile(vault.rootDirId, name, new Blob([new Uint8Array(data)]));
    }

    // Ordner + Unterordner + Datei darin (inkl. langem Namen → .c9s)
    const folder = await vault.createDirectory(vault.rootDirId, 'Neuer Ordner ✓');
    const sub = await vault.createDirectory(folder.dirId!, 'Sub');
    const longName = 'x'.repeat(220) + '.txt';
    await vault.uploadFile(sub.dirId!, longName, new Blob(['tief unten']));
    await vault.uploadFile(sub.dirId!, 'kurz.txt', new Blob(['kurz']));

    // Neu öffnen (frischer Zustand ohne Caches) und alles zurücklesen.
    const again = await Vault.unlock(new NodeStorage(dir), PASSWORD);
    const root = (await again.listDir(again.rootDirId)).entries;
    for (const [name, data] of payloads) {
      const e = root.find((x) => x.name === name)!;
      expect(e.size).toBe(data.length);
      expect(sha(Buffer.from(await (await again.readFile(e)).arrayBuffer()))).toBe(sha(data));
    }
    const f = root.find((x) => x.name === 'Neuer Ordner ✓')!;
    const s = (await again.listDir(f.dirId!)).entries.find((x) => x.name === 'Sub')!;
    expect(await names(again, s.dirId!)).toEqual([longName, 'kurz.txt'].sort());
    const long = (await again.listDir(s.dirId!)).entries.find((x) => x.name === longName)!;
    expect(long.storagePath.at(-1)).toMatch(/\.c9s$/);
    expect(await (await again.readFile(long)).text()).toBe('tief unten');

    // Doppelte Namen werden abgelehnt, uniqueName schlägt Alternative vor
    await expect(again.uploadFile(again.rootDirId, 'hello.txt', new Blob(['x']))).rejects.toBeInstanceOf(NameExistsError);
    expect(await again.uniqueName(again.rootDirId, 'hello.txt')).toBe('hello (1).txt');

    // Umbenennen: Datei (kurz → lang und zurück) und Ordner
    const hello = root.find((x) => x.name === 'hello.txt')!;
    await again.renameEntry(hello, 'y'.repeat(230) + '.txt');
    await again.renameEntry((await again.listDir(again.rootDirId)).entries.find((x) => x.name.startsWith('yyy'))!, 'Hallo.txt');
    const renamed = (await again.listDir(again.rootDirId)).entries.find((x) => x.name === 'Hallo.txt')!;
    expect(await (await again.readFile(renamed)).text()).toBe('Hallo Welt ☺\n');
    await again.renameEntry(f, 'Umbenannt');
    const f2 = (await again.listDir(again.rootDirId)).entries.find((x) => x.name === 'Umbenannt')!;
    expect(f2.dirId).toBe(f.dirId);
    expect(await names(again, f2.dirId!)).toEqual(['Sub']);

    // Löschen: Datei und Ordner rekursiv (Inhalte der Unterordner verschwinden aus d/)
    await again.deleteEntry(renamed);
    await again.deleteEntry(f2);
    const finalNames = await names(again, again.rootDirId);
    expect(finalNames).not.toContain('Hallo.txt');
    expect(finalNames).not.toContain('Umbenannt');
    expect(await new NodeStorage(dir).exists(await (again as unknown as { names: { dirStoragePath(id: string): Promise<string[]> } }).names.dirStoragePath(s.dirId!))).toBe(false);
  });
});

// Erzeugt einen Zustand, den die offizielle Cryptomator-Bibliothek gegenlesen kann (siehe tests/reference/README.md).
describe.each(['SIV_GCM', 'SIV_CTRMAC'] as const)('Interop-Zustand (%s)', (combo) => {
  it('schreibt Struktur und Manifest', async () => {
    const base = process.env.WEBVAULT_KEEP;
    if (!base) return; // nur auf Anforderung
    const dir = path.join(base, `interop-${combo}`);
    cpSync(path.join(__dirname, 'fixtures', `vault-${combo}`), dir, { recursive: true });
    const vault = await Vault.unlock(new NodeStorage(dir), PASSWORD);
    const expected: { path: string; size: number; sha256: string }[] = [];
    const up = async (dirId: string, prefix: string, name: string, data: Buffer) => {
      await vault.uploadFile(dirId, name, new Blob([new Uint8Array(data)]));
      expected.push({ path: `${prefix}/${name}`, size: data.length, sha256: sha(data) });
    };
    await up(vault.rootDirId, '', 'neu-leer.bin', Buffer.alloc(0));
    await up(vault.rootDirId, '', 'neu-gross.bin', randomBytes(70 * 32768 + 11));
    const ordner = await vault.createDirectory(vault.rootDirId, 'Mein Ordner ✓');
    await up(ordner.dirId!, '/Mein Ordner ✓', 'a.txt', Buffer.from('a'));
    const langerOrdner = await vault.createDirectory(ordner.dirId!, 'O'.repeat(215));
    await up(langerOrdner.dirId!, `/Mein Ordner ✓/${'O'.repeat(215)}`, 'z'.repeat(215) + '.dat', randomBytes(40000));
    // Umbenannte Datei: Zielname + Inhalt prüfen
    await up(vault.rootDirId, '', 'alt.txt', Buffer.from('wird umbenannt'));
    const alt = (await vault.listDir(vault.rootDirId)).entries.find((e) => e.name === 'alt.txt')!;
    await vault.renameEntry(alt, 'umbenannt.txt');
    expected.pop();
    expected.push({ path: '/umbenannt.txt', size: 14, sha256: sha(Buffer.from('wird umbenannt')) });
    // Gelöschte Datei darf nicht mehr auftauchen
    await up(vault.rootDirId, '', 'weg.txt', Buffer.from('x'));
    await vault.deleteEntry((await vault.listDir(vault.rootDirId)).entries.find((e) => e.name === 'weg.txt')!);
    expected.pop();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${dir}.expected.json`, JSON.stringify(expected, null, 1));
  });
});
