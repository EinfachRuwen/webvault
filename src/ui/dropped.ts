import type { UploadItem } from './upload';

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, folder: string[], out: UploadItem[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ file, folder });
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) await walk(child, [...folder, entry.name], out);
  }
}

/** Sammelt per Drag & Drop abgelegte Dateien und Ordner (rekursiv). */
export async function collectDropped(dt: DataTransfer): Promise<UploadItem[]> {
  // `webkitGetAsEntry` muss synchron im Drop-Event aufgerufen werden, bevor etwas `await`et wird.
  const entries = Array.from(dt.items)
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry());
  const out: UploadItem[] = [];
  if (entries.some((e) => e === null)) {
    for (const file of Array.from(dt.files)) out.push({ file, folder: [] });
    return out;
  }
  for (const entry of entries) await walk(entry!, [], out);
  return out;
}

/** Dateien aus <input type="file"> (auch `webkitdirectory`) → UploadItems. */
export function itemsFromFileList(files: FileList): UploadItem[] {
  return Array.from(files).map((file) => {
    const rel = file.webkitRelativePath ? file.webkitRelativePath.split('/') : [file.name];
    return { file, folder: rel.slice(0, -1) };
  });
}
