import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { FileListStorage } from '../../src/storage/fileList';

/** Echten Tresor-Ordner als schreibgeschützten FileList-Speicher laden (wie <input webkitdirectory>). */
export function fileListFromDir(dir: string): FileListStorage {
  const root = path.basename(dir);
  const files: { file: File; path: string[] }[] = [];
  const walk = (d: string, rel: string[]) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, [...rel, e.name]);
      else files.push({ file: new File([readFileSync(full)], e.name, { lastModified: statSync(full).mtimeMs }), path: [root, ...rel, e.name] });
    }
  };
  walk(dir, []);
  return new FileListStorage(root, files);
}
