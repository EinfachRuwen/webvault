import { encoder } from '../crypto/bytes';
import { ContentCryptor } from '../crypto/content';
import { NotAVaultError, NotFoundError, UnsupportedVaultError, VaultError } from '../crypto/errors';
import { type VaultKeys, deriveVaultKeys } from '../crypto/keys';
import { unlockMasterkeyFile } from '../crypto/masterkey';
import { ENCRYPTED_SUFFIX, NameCryptor, SHORTENED_SUFFIX } from '../crypto/names';
import { type CipherCombo, parseVaultConfig, verifyVaultConfig } from '../crypto/vaultconfig';
import type { StorageEntry, VaultStorage } from '../storage/types';

export type EntryKind = 'file' | 'directory' | 'symlink';

export interface VaultEntry {
  /** Klartextname */
  name: string;
  kind: EntryKind;
  /** Klartextgröße (nur Dateien, nur wenn Metadaten geladen wurden) */
  size?: number;
  /** Änderungszeit der verschlüsselten Datei in ms seit Epoche */
  modified?: number;
  /** Bei Verzeichnissen: deren eigene ID */
  dirId?: string;
  parentDirId: string;
  /** Pfad des Eintrags (Datei, `.c9r`- oder `.c9s`-Verzeichnis) relativ zum Tresor-Root */
  storagePath: string[];
  /** Pfad der Nutzdaten (verschlüsselte Datei bzw. dir.c9r / symlink.c9r) */
  payloadPath: string[];
}

export interface DirListing {
  entries: VaultEntry[];
  /** Einträge, die nicht entschlüsselt werden konnten (Konfliktkopien o. Ä.) */
  skipped: number;
}

/** Ein Schritt im Ordnerpfad (ohne Root). */
export interface Crumb {
  dirId: string;
  name: string;
}

export interface IndexedEntry {
  entry: VaultEntry;
  /** Ordnerpfad des Eintrags, z. B. [Fotos, 2024] – ohne Root */
  trail: Crumb[];
}

export class NameExistsError extends VaultError {
  constructor(name: string) {
    super(`„${name}“ existiert bereits in diesem Ordner.`);
  }
}

export interface UnlockOptions {
  /** 0..1 – scrypt-Fortschritt */
  onProgress?: (fraction: number) => void;
}

const ENTRY_CONCURRENCY = 16;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readText(storage: VaultStorage, path: string[]): Promise<string> {
  return (await storage.getFile(path)).text();
}

export class Vault {
  readonly rootDirId = '';

  private constructor(
    readonly storage: VaultStorage,
    readonly cipherCombo: CipherCombo,
    readonly format: number,
    private readonly names: NameCryptor,
    private readonly content: ContentCryptor,
  ) {}

  get writable(): boolean {
    return this.storage.writable;
  }

  static async unlock(storage: VaultStorage, password: string, opts: UnlockOptions = {}): Promise<Vault> {
    if (!(await storage.exists(['vault.cryptomator']))) {
      if (await storage.exists(['masterkey.cryptomator'])) {
        throw new UnsupportedVaultError(
          'Dieser Ordner enthält einen Tresor im alten Format (ohne vault.cryptomator). Bitte in Cryptomator auf das aktuelle Format migrieren.',
        );
      }
      throw new NotAVaultError('In diesem Ordner wurde kein Cryptomator-Tresor gefunden (vault.cryptomator fehlt). Bitte den Tresor-Ordner selbst auswählen.');
    }
    const config = parseVaultConfig(await readText(storage, ['vault.cryptomator']));
    let masterkeyText: string;
    try {
      masterkeyText = await readText(storage, config.masterkeyPath.split('/'));
    } catch {
      throw new NotAVaultError(`Masterkey-Datei „${config.masterkeyPath}“ fehlt im Tresor-Ordner.`);
    }
    const raw = await unlockMasterkeyFile(masterkeyText, password, opts.onProgress);
    try {
      await verifyVaultConfig(config, raw);
      const keys: VaultKeys = await deriveVaultKeys(raw);
      const names = new NameCryptor(keys, config.shorteningThreshold);
      const content = new ContentCryptor(keys, config.cipherCombo);
      return new Vault(storage, config.cipherCombo, config.format, names, content);
    } finally {
      raw.encKey.fill(0);
      raw.macKey.fill(0);
    }
  }

  // ---------------------------------------------------------------- Lesen

  /** Listet ein Verzeichnis. `stat: false` spart pro Datei einen Dateizugriff. */
  async listDir(dirId: string, { stat = true }: { stat?: boolean } = {}): Promise<DirListing> {
    const dirPath = await this.names.dirStoragePath(dirId);
    let raw: StorageEntry[];
    try {
      raw = await this.storage.list(dirPath);
    } catch (e) {
      if (e instanceof NotFoundError) return { entries: [], skipped: 0 }; // leerer Ordner ohne Speicherverzeichnis
      throw e;
    }
    const candidates = raw.filter((e) => e.name.endsWith(ENCRYPTED_SUFFIX) || e.name.endsWith(SHORTENED_SUFFIX)).filter((e) => e.name !== 'dirid.c9r');
    const results = await mapLimit(candidates, ENTRY_CONCURRENCY, (e) => this.classify(dirId, dirPath, e, stat));
    const entries = results.filter((r): r is VaultEntry => r !== null);
    return { entries, skipped: results.length - entries.length };
  }

  /** Ein Verzeichniseintrag → Klartext-Eintrag; `null` wenn nicht lesbar. */
  private async classify(parentDirId: string, dirPath: string[], raw: StorageEntry, stat: boolean): Promise<VaultEntry | null> {
    try {
      const storagePath = [...dirPath, raw.name];
      let encryptedName: string;
      let kind: EntryKind;
      let payloadPath: string[];

      if (raw.name.endsWith(SHORTENED_SUFFIX)) {
        if (raw.kind !== 'directory') return null;
        const children = new Set((await this.storage.list(storagePath)).map((c) => c.name));
        if (!children.has('name.c9s')) return null;
        const full = await readText(this.storage, [...storagePath, 'name.c9s']);
        if (!full.endsWith(ENCRYPTED_SUFFIX)) return null;
        encryptedName = full.slice(0, -ENCRYPTED_SUFFIX.length);
        if (children.has('contents.c9r')) [kind, payloadPath] = ['file', [...storagePath, 'contents.c9r']];
        else if (children.has('dir.c9r')) [kind, payloadPath] = ['directory', [...storagePath, 'dir.c9r']];
        else if (children.has('symlink.c9r')) [kind, payloadPath] = ['symlink', [...storagePath, 'symlink.c9r']];
        else return null;
      } else {
        encryptedName = raw.name.slice(0, -ENCRYPTED_SUFFIX.length);
        if (raw.kind === 'file') {
          [kind, payloadPath] = ['file', storagePath];
        } else {
          const children = new Set((await this.storage.list(storagePath)).map((c) => c.name));
          if (children.has('dir.c9r')) [kind, payloadPath] = ['directory', [...storagePath, 'dir.c9r']];
          else if (children.has('symlink.c9r')) [kind, payloadPath] = ['symlink', [...storagePath, 'symlink.c9r']];
          else return null;
        }
      }

      const name = await this.names.decryptName(encryptedName, parentDirId);
      const entry: VaultEntry = { name, kind, parentDirId, storagePath, payloadPath };
      if (kind === 'directory') entry.dirId = (await readText(this.storage, payloadPath)).trim();
      if (kind === 'file' && stat) {
        const file = await this.storage.getFile(payloadPath);
        entry.size = this.content.cleartextSize(file.size);
        entry.modified = file.lastModified;
      }
      return entry;
    } catch {
      return null;
    }
  }

  /** Klartext-Stücke einer Datei (streamend, authentifiziert). */
  decryptFile(entry: VaultEntry, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const storage = this.storage;
    const content = this.content;
    return (async function* () {
      const file = await storage.getFile(entry.payloadPath);
      yield* content.decrypt(file, signal);
    })();
  }

  /** Entschlüsselt eine Datei komplett in den Speicher. */
  async readFile(entry: VaultEntry, opts: { signal?: AbortSignal; type?: string; onProgress?: (bytes: number) => void } = {}): Promise<Blob> {
    const parts: Uint8Array[] = [];
    let done = 0;
    for await (const chunk of this.decryptFile(entry, opts.signal)) {
      parts.push(chunk);
      done += chunk.length;
      opts.onProgress?.(done);
    }
    return new Blob(parts as BlobPart[], { type: opts.type ?? '' });
  }

  /** Alle Einträge des Tresors (Breitensuche) – Grundlage der Namenssuche über den gesamten Tresor. */
  async buildIndex(
    opts: { signal?: AbortSignal; onProgress?: (entriesSoFar: number) => void } = {},
  ): Promise<IndexedEntry[]> {
    const out: IndexedEntry[] = [];
    const queue: { dirId: string; trail: Crumb[] }[] = [{ dirId: this.rootDirId, trail: [] }];
    while (queue.length > 0) {
      opts.signal?.throwIfAborted();
      const { dirId, trail } = queue.shift()!;
      const { entries } = await this.listDir(dirId, { stat: false });
      for (const entry of entries) {
        out.push({ entry, trail });
        if (entry.kind === 'directory' && entry.dirId !== undefined) queue.push({ dirId: entry.dirId, trail: [...trail, { dirId: entry.dirId, name: entry.name }] });
      }
      opts.onProgress?.(out.length);
    }
    return out;
  }

  /** Größe/Datum nachladen (für Einträge aus dem Index). */
  async withMetadata(entry: VaultEntry): Promise<VaultEntry> {
    if (entry.kind !== 'file' || entry.size !== undefined) return entry;
    const file = await this.storage.getFile(entry.payloadPath);
    return { ...entry, size: this.content.cleartextSize(file.size), modified: file.lastModified };
  }

  // ---------------------------------------------------------------- Schreiben

  private async locate(parentDirId: string, name: string, kind: 'file' | 'directory') {
    const parentPath = await this.names.dirStoragePath(parentDirId);
    const encrypted = await this.names.encryptName(name, parentDirId);
    const s = await this.names.storageName(encrypted);
    const storagePath = [...parentPath, s.name];
    const payloadName = kind === 'directory' ? 'dir.c9r' : 'contents.c9r';
    const payloadPath = kind === 'file' && !s.shortened ? storagePath : [...storagePath, payloadName];
    return { storagePath, payloadPath, shortened: s.shortened, fullName: s.fullName };
  }

  private async assertNameFree(parentDirId: string, name: string): Promise<void> {
    const { entries } = await this.listDir(parentDirId, { stat: false });
    const wanted = name.normalize('NFC');
    if (entries.some((e) => e.name.normalize('NFC') === wanted)) throw new NameExistsError(name);
  }

  /** Liefert einen noch nicht vergebenen Namen („foto.jpg“ → „foto (1).jpg“). */
  async uniqueName(parentDirId: string, name: string): Promise<string> {
    const { entries } = await this.listDir(parentDirId, { stat: false });
    const taken = new Set(entries.map((e) => e.name.normalize('NFC')));
    const base = name.normalize('NFC');
    if (!taken.has(base)) return base;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let i = 1; ; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private requireWritable(): void {
    if (!this.storage.writable) throw new VaultError('Der Tresor ist schreibgeschützt geöffnet.');
  }

  async uploadFile(
    parentDirId: string,
    name: string,
    source: Blob,
    opts: { signal?: AbortSignal; onProgress?: (cleartextBytes: number) => void } = {},
  ): Promise<void> {
    this.requireWritable();
    await this.assertNameFree(parentDirId, name);
    const loc = await this.locate(parentDirId, name, 'file');
    try {
      if (loc.shortened) await this.storage.writeFile([...loc.storagePath, 'name.c9s'], encoder.encode(loc.fullName));
      const content = this.content;
      const encrypted = (async function* () {
        let produced = 0;
        for await (const chunk of content.encrypt(source, opts.signal)) {
          yield chunk;
          produced += chunk.length;
          // Näherung: Fortschritt anhand der Quellgröße, gedeckelt auf 100 %.
          opts.onProgress?.(Math.min(source.size, produced));
        }
      })();
      await this.storage.writeFile(loc.payloadPath, encrypted);
      opts.onProgress?.(source.size);
    } catch (e) {
      await this.storage.remove(loc.storagePath, true).catch(() => {});
      throw e;
    }
  }

  async createDirectory(parentDirId: string, name: string): Promise<VaultEntry> {
    this.requireWritable();
    await this.assertNameFree(parentDirId, name);
    const loc = await this.locate(parentDirId, name, 'directory');
    const dirId = crypto.randomUUID();
    const contentPath = await this.names.dirStoragePath(dirId);
    try {
      if (loc.shortened) await this.storage.writeFile([...loc.storagePath, 'name.c9s'], encoder.encode(loc.fullName));
      await this.storage.writeFile(loc.payloadPath, encoder.encode(dirId));
      await this.storage.makeDir(contentPath);
      // Sicherungskopie der Verzeichnis-ID im Verzeichnis selbst (wie Cryptomator ≥ 1.7).
      const idBackup = new Blob([encoder.encode(dirId) as BlobPart]);
      await this.storage.writeFile([...contentPath, 'dirid.c9r'], this.content.encrypt(idBackup));
    } catch (e) {
      await this.storage.remove(loc.storagePath, true).catch(() => {});
      await this.storage.remove(contentPath, true).catch(() => {});
      throw e;
    }
    return { name: name.normalize('NFC'), kind: 'directory', dirId, parentDirId, storagePath: loc.storagePath, payloadPath: loc.payloadPath };
  }

  async deleteEntry(entry: VaultEntry): Promise<void> {
    this.requireWritable();
    if (entry.kind === 'directory' && entry.dirId !== undefined) await this.deleteDirectoryContents(entry.dirId);
    await this.storage.remove(entry.storagePath, true);
  }

  private async deleteDirectoryContents(dirId: string): Promise<void> {
    const { entries } = await this.listDir(dirId, { stat: false });
    for (const e of entries) {
      if (e.kind === 'directory' && e.dirId !== undefined) await this.deleteDirectoryContents(e.dirId);
    }
    const path = await this.names.dirStoragePath(dirId);
    await this.storage.remove(path, true);
    // Leeres Shard-Verzeichnis `d/XX` aufräumen.
    const shard = path.slice(0, 2);
    try {
      if ((await this.storage.list(shard)).length === 0) await this.storage.remove(shard);
    } catch {
      /* nicht kritisch */
    }
  }

  /** Benennt um. Die Nutzdaten werden unverändert (verschlüsselt) kopiert – der Inhalt hängt nicht vom Namen ab. */
  async renameEntry(entry: VaultEntry, newName: string): Promise<void> {
    this.requireWritable();
    if (entry.kind === 'symlink') throw new VaultError('Symlinks können nicht umbenannt werden.');
    if (newName.normalize('NFC') === entry.name.normalize('NFC')) return;
    await this.assertNameFree(entry.parentDirId, newName);
    const loc = await this.locate(entry.parentDirId, newName, entry.kind);
    try {
      if (loc.shortened) await this.storage.writeFile([...loc.storagePath, 'name.c9s'], encoder.encode(loc.fullName));
      if (entry.kind === 'directory') {
        await this.storage.writeFile(loc.payloadPath, encoder.encode(entry.dirId ?? ''));
      } else {
        await this.storage.writeFile(loc.payloadPath, await this.storage.getFile(entry.payloadPath));
      }
    } catch (e) {
      await this.storage.remove(loc.storagePath, true).catch(() => {});
      throw e;
    }
    await this.storage.remove(entry.storagePath, true);
  }
}
