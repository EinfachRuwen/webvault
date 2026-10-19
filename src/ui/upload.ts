import type { Vault } from '../vault/vault';
import type { TransferControl } from './transfers';

/** Datei samt relativem Ordnerpfad (ohne Dateiname), z. B. ['Urlaub', '2024']. */
export interface UploadItem {
  file: File;
  folder: string[];
}

/** Lädt Dateien (ggf. mit Ordnerstruktur) in `parentDirId` hoch; bereits vorhandene Namen werden mit „ (1)“ ergänzt. */
export async function uploadItems(vault: Vault, parentDirId: string, items: UploadItem[], ctl: TransferControl): Promise<void> {
  const total = items.reduce((sum, i) => sum + i.file.size, 0);
  let finished = 0;
  const folderIds = new Map<string, string>([['', parentDirId]]);

  async function ensureFolder(folder: string[]): Promise<string> {
    let key = '';
    let dirId = parentDirId;
    for (const segment of folder) {
      key += `/${segment}`;
      const cached = folderIds.get(key);
      if (cached !== undefined) {
        dirId = cached;
        continue;
      }
      const { entries } = await vault.listDir(dirId, { stat: false });
      const existing = entries.find((e) => e.kind === 'directory' && e.name.normalize('NFC') === segment.normalize('NFC'));
      dirId = existing?.dirId ?? (await vault.createDirectory(dirId, segment)).dirId!;
      folderIds.set(key, dirId);
    }
    return dirId;
  }

  for (const item of items) {
    ctl.signal.throwIfAborted();
    const dirId = await ensureFolder(item.folder);
    const name = await vault.uniqueName(dirId, item.file.name);
    await vault.uploadFile(dirId, name, item.file, {
      signal: ctl.signal,
      onProgress: (bytes) => ctl.progress(finished + bytes, total),
    });
    finished += item.file.size;
    ctl.progress(finished, total);
  }
}
