import type { Vault, VaultEntry } from '../vault/vault';
import type { StagedStorage } from '../storage/staged';
import { ZipWriter } from './zip';
import type { TransferControl } from './transfers';

/**
 * Klartextnamen stammen aus dem (potenziell manipulierten) Tresor. Für ZIP-Pfade und Dateinamen werden
 * Pfadtrenner, Steuerzeichen und „.“/„..“ entschärft, damit beim Entpacken nichts außerhalb des Zielordners landet („Zip-Slip“).
 */
export function safeSegment(name: string): string {
  const cleaned = name.replace(/[\\/\u0000-\u001f]/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}

interface PlannedFile {
  entry: VaultEntry;
  zipPath: string;
}
interface Plan {
  files: PlannedFile[];
  emptyDirs: string[];
  total: number;
}

async function planDirectory(vault: Vault, dirId: string, prefix: string, plan: Plan, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { entries } = await vault.listDir(dirId);
  if (entries.length === 0) plan.emptyDirs.push(prefix);
  for (const e of entries) {
    const path = `${prefix}/${safeSegment(e.name)}`;
    if (e.kind === 'directory' && e.dirId !== undefined) await planDirectory(vault, e.dirId, path, plan, signal);
    else if (e.kind === 'file') {
      plan.files.push({ entry: e, zipPath: path });
      plan.total += e.size ?? 0;
    }
  }
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Ziel, in das gestreamt wird: direkt auf Platte (File System Access) oder – als Fallback – in den Speicher. */
async function openSink(suggestedName: string): Promise<{ write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> } | null> {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName });
      const w = await handle.createWritable();
      return {
        write: (chunk) => w.write(chunk as FileSystemWriteChunkType),
        close: () => w.close(),
        abort: () => w.abort(),
      };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null; // Nutzer hat abgebrochen
      throw e;
    }
  }
  const parts: Uint8Array[] = [];
  return {
    write: async (chunk) => void parts.push(chunk),
    close: async () => triggerBrowserDownload(new Blob(parts as BlobPart[]), suggestedName),
    abort: async () => {},
  };
}

/**
 * Lädt Einträge entschlüsselt herunter: eine einzelne Datei direkt, Ordner/Mehrfachauswahl als ZIP.
 * Gibt `false` zurück, wenn der Nutzer den Speicherdialog abgebrochen hat.
 */
export async function downloadEntries(vault: Vault, entries: VaultEntry[], ctl: TransferControl): Promise<boolean> {
  const single = entries.length === 1 && entries[0].kind === 'file' ? entries[0] : null;
  const zipName = entries.length === 1 ? `${safeSegment(entries[0].name)}.zip` : 'WebVault-Download.zip';

  // Der Speicherdialog braucht eine Nutzeraktion → so früh wie möglich öffnen.
  const sink = await openSink(single ? safeSegment(single.name) : zipName);
  if (!sink) return false;

  try {
    if (single) {
      let done = 0;
      for await (const chunk of vault.decryptFile(single, ctl.signal)) {
        await sink.write(chunk);
        done += chunk.length;
        ctl.progress(done, single.size);
      }
    } else {
      const plan: Plan = { files: [], emptyDirs: [], total: 0 };
      ctl.label('Lese Ordnerstruktur …');
      for (const e of entries) {
        if (e.kind === 'directory' && e.dirId !== undefined) await planDirectory(vault, e.dirId, safeSegment(e.name), plan, ctl.signal);
        else if (e.kind === 'file') {
          const meta = await vault.withMetadata(e);
          plan.files.push({ entry: meta, zipPath: safeSegment(e.name) });
          plan.total += meta.size ?? 0;
        }
      }
      ctl.label(entries.length === 1 ? `„${entries[0].name}“ als ZIP` : `${entries.length} Einträge als ZIP`);
      const zip = new ZipWriter((chunk) => sink.write(chunk));
      let done = 0;
      for (const dir of plan.emptyDirs) await zip.addDirectory(dir);
      for (const f of plan.files) {
        const source = (async function* () {
          for await (const chunk of vault.decryptFile(f.entry, ctl.signal)) {
            done += chunk.length;
            ctl.progress(done, plan.total);
            yield chunk;
          }
        })();
        await zip.addFile(f.zipPath, source, f.entry.modified ? new Date(f.entry.modified) : new Date());
      }
      await zip.finish();
    }
    await sink.close();
    return true;
  } catch (e) {
    await sink.abort().catch(() => {});
    throw e;
  }
}

async function* blobChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  const SLICE = 4 * 1024 * 1024;
  for (let pos = 0; pos < blob.size; pos += SLICE) yield new Uint8Array(await blob.slice(pos, pos + SLICE).arrayBuffer());
}

/**
 * Exportiert die gesammelten (bereits verschlüsselten) Änderungen als ZIP mit tresor-relativen Pfaden (`d/AB/…`),
 * das der Nutzer in den Tresor-Ordner kopiert. Gibt `false` zurück, wenn der Speicherdialog abgebrochen wurde.
 */
export async function exportStagedChanges(staged: StagedStorage, ctl: TransferControl): Promise<boolean> {
  const files = staged.pendingFiles();
  const total = files.reduce((n, f) => n + f.blob.size, 0);
  const sink = await openSink('WebVault-Aenderungen.zip');
  if (!sink) return false;
  try {
    const zip = new ZipWriter((chunk) => sink.write(chunk));
    let done = 0;
    for (const f of files) {
      ctl.signal.throwIfAborted();
      const source = (async function* () {
        for await (const chunk of blobChunks(f.blob)) {
          done += chunk.length;
          ctl.progress(done, total);
          yield chunk;
        }
      })();
      await zip.addFile(f.path.join('/'), source, new Date(f.modified));
    }
    await zip.finish();
    await sink.close();
    return true;
  } catch (e) {
    await sink.abort().catch(() => {});
    throw e;
  }
}
