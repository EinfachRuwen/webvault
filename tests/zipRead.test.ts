import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotAVaultError } from '../src/crypto/errors';
import { ZipStorage } from '../src/storage/zipRead';
import { Vault } from '../src/vault/vault';
import { buildZip } from './helpers/zipBuilder';

const zipFile = (buf: Buffer, name = 'x.zip') => new File([new Uint8Array(buf)], name);
const text = async (s: ZipStorage, p: string[]) => (await s.getFile(p)).text();

describe.each([{ zip64: false }, { zip64: true }])('ZipStorage (zip64=$zip64)', ({ zip64 }) => {
  it('liest gespeicherte und deflate-komprimierte Einträge, erkennt den Oberordner', async () => {
    const zip = buildZip(
      [
        { name: 'Mein Tresor/', },
        { name: 'Mein Tresor/vault.cryptomator', data: 'jwt', method: 8 },
        { name: 'Mein Tresor/masterkey.cryptomator', data: '{"a":1}' },
        { name: 'Mein Tresor/d/AB/CDEF/name.c9r', data: 'x'.repeat(5000), method: 8 },
        { name: '__MACOSX/Mein Tresor/._vault.cryptomator', data: 'junk' },
        { name: 'Mein Tresor/.DS_Store', data: 'junk' },
      ],
      { zip64 },
    );
    const s = await ZipStorage.open(zipFile(zip));
    expect(s.name).toBe('Mein Tresor');
    expect((await s.list([])).map((e) => e.name).sort()).toEqual(['d', 'masterkey.cryptomator', 'vault.cryptomator']);
    expect(await text(s, ['vault.cryptomator'])).toBe('jwt');
    expect(await text(s, ['masterkey.cryptomator'])).toBe('{"a":1}');
    expect((await text(s, ['d', 'AB', 'CDEF', 'name.c9r'])).length).toBe(5000);
    expect((await s.stat(['d', 'AB', 'CDEF', 'name.c9r'])).size).toBe(5000);
    expect(await s.exists(['__MACOSX'])).toBe(false);
  });

  it('akzeptiert einen Tresor direkt im ZIP-Wurzelverzeichnis', async () => {
    const s = await ZipStorage.open(zipFile(buildZip([{ name: 'vault.cryptomator', data: 'a' }, { name: 'd/AB/CD/f.c9r', data: 'b' }], { zip64 }), 'Backup.zip'));
    expect(s.name).toBe('Backup');
    expect(await text(s, ['d', 'AB', 'CD', 'f.c9r'])).toBe('b');
  });
});

describe('ZipStorage Fehlerfälle', () => {
  it('lehnt Nicht-ZIP und ZIP ohne Tresor ab', async () => {
    await expect(ZipStorage.open(new File(['kein zip'], 'a.zip'))).rejects.toBeInstanceOf(NotAVaultError);
    await expect(ZipStorage.open(zipFile(buildZip([{ name: 'foto.jpg', data: 'x' }])))).rejects.toBeInstanceOf(NotAVaultError);
  });
});

// Echte Archive von Info-ZIP (Deflate, Verzeichniseinträge, ZIP64 per -fz) – nur wenn `zip` installiert ist.
const hasZip = spawnSync('zip', ['-v']).status === 0;
describe.skipIf(!hasZip).each([
  ['deflate', []],
  ['zip64', ['-fz']],
  ['gespeichert', ['-0']],
])('Info-ZIP-Archiv (%s) eines echten Cryptomator-Tresors', (_label, flags) => {
  it('lässt sich entsperren und bitgenau lesen', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'webvault-zip-'));
    const out = path.join(tmp, 'tresor.zip');
    const fixtures = path.join(__dirname, 'fixtures');
    execFileSync('zip', ['-q', '-r', ...flags, out, 'vault-SIV_GCM'], { cwd: fixtures });
    const storage = await ZipStorage.open(new File([new Uint8Array(readFileSync(out))], 'tresor.zip'));
    expect(storage.name).toBe('vault-SIV_GCM');
    const vault = await Vault.unlock(storage, 'correct horse battery staple');
    const manifest: { path: string; size: number; sha256: string }[] = JSON.parse(readFileSync(path.join(fixtures, 'vault-SIV_GCM.manifest.json'), 'utf8'));
    const walk = async (dirId: string, prefix: string, acc: Map<string, Awaited<ReturnType<Vault['listDir']>>['entries'][number]>) => {
      for (const e of (await vault.listDir(dirId)).entries) {
        acc.set(`${prefix}/${e.name}`, e);
        if (e.kind === 'directory') await walk(e.dirId!, `${prefix}/${e.name}`, acc);
      }
      return acc;
    };
    const tree = await walk(vault.rootDirId, '', new Map());
    for (const m of manifest) {
      const e = tree.get(m.path)!;
      const data = Buffer.from(await (await vault.readFile(e)).arrayBuffer());
      expect(createHash('sha256').update(data).digest('hex')).toBe(m.sha256);
    }
    writeFileSync(path.join(tmp, 'done'), '');
  });
});
