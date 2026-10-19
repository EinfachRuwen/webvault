// Änderungspaket-Modus: schreibgeschützter Tresor + Überlagerung → ZIP-Export → in Tresor-Ordner einspielen.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StagedStorage } from '../src/storage/staged';
import { ZipStorage } from '../src/storage/zipRead';
import { Vault } from '../src/vault/vault';
import { NodeStorage } from './helpers/nodeStorage';
import { fileListFromDir } from './helpers/fixtureStorage';

const PASSWORD = 'correct horse battery staple';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe.each(['SIV_GCM', 'SIV_CTRMAC'] as const)('Änderungspaket (%s)', (combo) => {
  const fixture = path.join(__dirname, 'fixtures', `vault-${combo}`);

  it('sammelt Uploads/Ordner, schützt Originale und liefert ein einspielbares Paket', async () => {
    const staged = new StagedStorage(fileListFromDir(fixture));
    const vault = await Vault.unlock(staged, PASSWORD);

    // Originale sind nicht änderbar, Neues schon
    const root = (await vault.listDir(vault.rootDirId)).entries;
    const hello = root.find((e) => e.name === 'hello.txt')!;
    expect(hello.removable).toBe(false);
    await expect(vault.deleteEntry(hello)).rejects.toThrow(/Original-Tresor/);
    await expect(vault.renameEntry(hello, 'x.txt')).rejects.toThrow(/Original-Tresor/);
    expect((await vault.listDir(vault.rootDirId)).entries.some((e) => e.name === 'hello.txt')).toBe(true);

    // Hochladen: in die Wurzel, in einen bestehenden Ordner, in einen neuen Ordner
    const big = randomBytes(70 * 32768 + 5);
    await vault.uploadFile(vault.rootDirId, 'neu-gross.bin', new Blob([new Uint8Array(big)]));
    const docs = root.find((e) => e.name === 'docs')!;
    await vault.uploadFile(docs.dirId!, 'ergänzung.txt', new Blob(['in bestehendem Ordner']));
    const neu = await vault.createDirectory(vault.rootDirId, 'Neuer Ordner');
    await vault.uploadFile(neu.dirId!, 'a'.repeat(220) + '.txt', new Blob(['langer Name']));
    // Sitzungs-lokale Einträge dürfen umbenannt/gelöscht werden
    await vault.uploadFile(vault.rootDirId, 'tippfehler.txt', new Blob(['x']));
    await vault.uploadFile(vault.rootDirId, 'weg.txt', new Blob(['y']));
    let entries = (await vault.listDir(vault.rootDirId)).entries;
    const typo = entries.find((e) => e.name === 'tippfehler.txt')!;
    expect(typo.removable).toBe(true);
    await vault.renameEntry(typo, 'korrekt.txt');
    await vault.deleteEntry(entries.find((e) => e.name === 'weg.txt')!);
    const gone = await vault.createDirectory(vault.rootDirId, 'Verworfen');
    await vault.uploadFile(gone.dirId!, 'x.txt', new Blob(['x']));
    await vault.deleteEntry((await vault.listDir(vault.rootDirId)).entries.find((e) => e.name === 'Verworfen')!);

    entries = (await vault.listDir(vault.rootDirId)).entries;
    expect(entries.map((e) => e.name).sort()).toEqual(
      ['D'.repeat(210), 'Neuer Ordner', 'docs', 'empty.bin', 'exact-chunk.bin', 'hello.txt', 'korrekt.txt', 'l'.repeat(200) + '.txt', 'multi-chunk.bin', 'neu-gross.bin', 'sub with space', 'Ünïcödé – 日本語.txt'.normalize('NFC')].sort(),
    );

    // Export → ZIP lesen
    const pending = staged.pending();
    expect(pending.files).toBeGreaterThan(0);
    const files = staged.pendingFiles();
    expect(files.every((f) => f.path[0] === 'd')).toBe(true); // nur Tresor-Inhalte, keine Originale
    const { ZipWriter } = await import('../src/ui/zip');
    const parts: Uint8Array[] = [];
    const zip = new ZipWriter(async (c) => void parts.push(c));
    for (const f of files) {
      await zip.addFile(f.path.join('/'), (async function* () { yield new Uint8Array(await f.blob.arrayBuffer()); })());
    }
    await zip.finish();

    // „Einspielen“: Paket in eine Kopie des Tresor-Ordners entpacken (Zusammenführen)
    const tmp = mkdtempSync(path.join(tmpdir(), 'webvault-merge-'));
    const merged = path.join(tmp, `vault-${combo}`);
    cpSync(fixture, merged, { recursive: true });
    const pkg = await ZipStorage.openRaw(new File([Buffer.concat(parts)], 'paket.zip'));
    const target = new NodeStorage(merged);
    for (const f of pkg) await target.writeFile(f.path, await f.file());
    writeFileSync(path.join(tmp, 'ok'), '');
    if (process.env.WEBVAULT_KEEP) cpSync(merged, path.join(process.env.WEBVAULT_KEEP, `staged-${combo}`), { recursive: true });

    // Ergebnis mit frischem Vault lesen
    const result = await Vault.unlock(new NodeStorage(merged), PASSWORD);
    const rootEntries = (await result.listDir(result.rootDirId)).entries;
    const read = async (e: (typeof rootEntries)[number]) => Buffer.from(await (await result.readFile(e)).arrayBuffer());
    expect(sha(await read(rootEntries.find((e) => e.name === 'neu-gross.bin')!))).toBe(sha(big));
    expect((await read(rootEntries.find((e) => e.name === 'korrekt.txt')!)).toString()).toBe('x');
    expect(rootEntries.some((e) => ['weg.txt', 'tippfehler.txt', 'Verworfen'].includes(e.name))).toBe(false);
    const docsAfter = rootEntries.find((e) => e.name === 'docs')!;
    const docsNames = (await result.listDir(docsAfter.dirId!)).entries.map((e) => e.name).sort();
    expect(docsNames).toEqual(['ergänzung.txt', 'nested', 'readme.md']);
    const neuAfter = rootEntries.find((e) => e.name === 'Neuer Ordner')!;
    const inNeu = (await result.listDir(neuAfter.dirId!)).entries;
    expect(inNeu.map((e) => e.name)).toEqual(['a'.repeat(220) + '.txt']);
    expect((await read(inNeu[0])).toString()).toBe('langer Name');
    // Originale unverändert
    expect((await read(rootEntries.find((e) => e.name === 'hello.txt')!)).toString()).toBe('Hallo Welt ☺\n');
  });
});
