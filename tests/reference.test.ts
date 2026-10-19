// Liest Tresore, die von der *offiziellen* Cryptomator-Bibliothek (cryptofs, siehe tests/reference) erzeugt wurden.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WrongPasswordError } from '../src/crypto/errors';
import { type VaultEntry, Vault } from '../src/vault/vault';
import { NodeStorage } from './helpers/nodeStorage';

const FIXTURES = path.join(__dirname, 'fixtures');
const PASSWORD = 'correct horse battery staple';

interface ManifestItem {
  path: string;
  size: number;
  sha256: string;
}

async function collect(vault: Vault, dirId: string, prefix: string, out: Map<string, VaultEntry>) {
  const { entries } = await vault.listDir(dirId);
  for (const e of entries) {
    const p = `${prefix}/${e.name}`;
    out.set(p, e);
    if (e.kind === 'directory') await collect(vault, e.dirId!, p, out);
  }
}

describe.each(['SIV_GCM', 'SIV_CTRMAC'] as const)('Referenz-Tresor %s', (combo) => {
  const dir = path.join(FIXTURES, `vault-${combo}`);
  const manifest: ManifestItem[] = JSON.parse(readFileSync(`${dir}.manifest.json`, 'utf8'));

  it('lehnt falsches Passwort ab', async () => {
    await expect(Vault.unlock(new NodeStorage(dir), 'falsch')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('entsperrt, listet alle Einträge und entschlüsselt jede Datei bitgenau', async () => {
    const vault = await Vault.unlock(new NodeStorage(dir), PASSWORD);
    expect(vault.cipherCombo).toBe(combo);
    const tree = new Map<string, VaultEntry>();
    await collect(vault, vault.rootDirId, '', tree);

    for (const item of manifest) {
      const entry = tree.get(item.path);
      expect(entry, `fehlt: ${item.path}`).toBeDefined();
      expect(entry!.kind).toBe('file');
      expect(entry!.size).toBe(item.size);
      const blob = await vault.readFile(entry!);
      const data = Buffer.from(await blob.arrayBuffer());
      expect(data.length).toBe(item.size);
      expect(createHash('sha256').update(data).digest('hex')).toBe(item.sha256);
    }
    const files = [...tree.values()].filter((e) => e.kind === 'file');
    expect(files.length).toBe(manifest.length);
  });

  it('erkennt Verzeichnisse, auch mit gekürzten (.c9s) Namen', async () => {
    const vault = await Vault.unlock(new NodeStorage(dir), PASSWORD);
    const { entries, skipped } = await vault.listDir(vault.rootDirId);
    expect(skipped).toBe(0);
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain('docs');
    expect(names).toContain('D'.repeat(210));
    expect(names).toContain('l'.repeat(200) + '.txt');
    expect(names).toContain('Ünïcödé – 日本語.txt'.normalize('NFC'));
    expect(entries.find((e) => e.name === 'docs')!.kind).toBe('directory');
    expect(entries.find((e) => e.name === 'D'.repeat(210))!.storagePath.at(-1)).toMatch(/\.c9s$/);
  });

  it('bricht bei manipuliertem Inhalt ab (Integritätsprüfung)', async () => {
    class Tampering extends NodeStorage {
      override async getFile(segs: string[]): Promise<File> {
        const f = await super.getFile(segs);
        if (!segs.at(-1)!.endsWith('.c9r') || f.size < 50000) return f;
        const bytes = new Uint8Array(await f.arrayBuffer());
        bytes[bytes.length - 40] ^= 0x01; // Bit im letzten Chunk kippen
        return new File([bytes], f.name);
      }
    }
    const vault = await Vault.unlock(new Tampering(dir), PASSWORD);
    const { entries } = await vault.listDir(vault.rootDirId);
    await expect(vault.readFile(entries.find((e) => e.name === 'multi-chunk.bin')!)).rejects.toThrow(/beschädigt|manipuliert|authentifiziert/);
  });
});
