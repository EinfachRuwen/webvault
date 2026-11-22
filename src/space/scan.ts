// Speicherplatz: Ordnerbaum mit Größen, Kategorien, größte Dateien, leere Ordner und Duplikate.
// Alles lokal: Größen kommen aus den Dateisystem-Metadaten (Klartextgröße aus der Chiffratgröße),
// nur der Duplikat-Vergleich entschlüsselt Inhalte – und auch das nur auf Knopfdruck.

import { sha256 } from '@noble/hashes/sha2';
import type { Crumb, Vault, VaultEntry } from '../vault/vault';
import { extensionOf, fileInfo } from '../ui/fileTypes';

export interface DirNode {
  name: string;
  dirId: string;
  /** Pfad vom Tresor-Root bis einschließlich dieses Ordners */
  trail: Crumb[];
  /** Eintrag im Elternordner (fehlt beim Startordner) */
  entry?: VaultEntry;
  files: VaultEntry[];
  dirs: DirNode[];
  /** rekursiv */
  size: number;
  fileCount: number;
  dirCount: number;
}

export interface FileRef { entry: VaultEntry; trail: Crumb[] }

export type Category = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';
export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'video', label: 'Videos' },
  { id: 'image', label: 'Fotos' },
  { id: 'audio', label: 'Audio' },
  { id: 'document', label: 'Dokumente' },
  { id: 'archive', label: 'Archive' },
  { id: 'other', label: 'Sonstiges' },
];

const DOCS = new Set('doc docx xls xlsx ppt pptx odt ods odp pages numbers key rtf epub'.split(' '));
const ARCHIVES = new Set('zip rar 7z tar gz tgz bz2 xz dmg iso img pkg'.split(' '));

export function categoryOf(name: string): Category {
  const kind = fileInfo(name).kind;
  if (kind === 'image' || kind === 'video' || kind === 'audio') return kind;
  const ext = extensionOf(name);
  if (kind === 'pdf' || kind === 'text' || DOCS.has(ext)) return 'document';
  if (ARCHIVES.has(ext)) return 'archive';
  return 'other';
}

const keyOf = (e: VaultEntry) => e.storagePath.join('/');

async function eachLimit<T>(xs: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, async () => { while (next < xs.length) await fn(xs[next++]); }));
}

/** Liest den Baum ab `start` (Pfad ab Root; leer = ganzer Tresor) Ebene für Ebene mit begrenzter Parallelität. */
export async function scanTree(
  vault: Vault,
  start: Crumb[],
  opts: { signal?: AbortSignal; onProgress?: (files: number, bytes: number) => void } = {},
): Promise<DirNode> {
  const last = start[start.length - 1];
  const root: DirNode = { name: last?.name ?? vault.storage.name, dirId: last?.dirId ?? vault.rootDirId, trail: start, files: [], dirs: [], size: 0, fileCount: 0, dirCount: 0 };
  let level = [root];
  let files = 0, bytes = 0;
  while (level.length > 0) {
    const nextLevel: DirNode[] = [];
    await eachLimit(level, 4, async (node) => {
      opts.signal?.throwIfAborted();
      const { entries } = await vault.listDir(node.dirId);
      for (const e of entries) {
        if (e.kind === 'file') {
          node.files.push(e);
          files++;
          bytes += e.size ?? 0;
        } else if (e.kind === 'directory' && e.dirId !== undefined) {
          const child: DirNode = { name: e.name, dirId: e.dirId, trail: [...node.trail, { dirId: e.dirId, name: e.name }], entry: e, files: [], dirs: [], size: 0, fileCount: 0, dirCount: 0 };
          node.dirs.push(child);
          nextLevel.push(child);
        }
      }
      opts.onProgress?.(files, bytes);
    });
    level = nextLevel;
  }
  recompute(root);
  return root;
}

/** Summen neu berechnen (nach dem Scan und nach Löschungen). */
export function recompute(node: DirNode): void {
  for (const d of node.dirs) recompute(d);
  node.size = node.files.reduce((s, f) => s + (f.size ?? 0), 0) + node.dirs.reduce((s, d) => s + d.size, 0);
  node.fileCount = node.files.length + node.dirs.reduce((s, d) => s + d.fileCount, 0);
  node.dirCount = node.dirs.length + node.dirs.reduce((s, d) => s + d.dirCount, 0);
}

export function allFiles(node: DirNode, out: FileRef[] = []): FileRef[] {
  for (const f of node.files) out.push({ entry: f, trail: node.trail });
  for (const d of node.dirs) allFiles(d, out);
  return out;
}

export function byCategory(files: FileRef[]): Map<Category, { bytes: number; count: number }> {
  const m = new Map<Category, { bytes: number; count: number }>();
  for (const { entry } of files) {
    const c = categoryOf(entry.name);
    const v = m.get(c) ?? { bytes: 0, count: 0 };
    v.bytes += entry.size ?? 0;
    v.count++;
    m.set(c, v);
  }
  return m;
}

export function largest(files: FileRef[], n = 100, category?: Category): FileRef[] {
  return files
    .filter((f) => !category || categoryOf(f.entry.name) === category)
    .sort((a, b) => (b.entry.size ?? 0) - (a.entry.size ?? 0))
    .slice(0, n);
}

/** Ordner ohne eine einzige Datei (auch nicht in Unterordnern) – jeweils nur der oberste. */
export function emptyDirs(node: DirNode, out: DirNode[] = []): DirNode[] {
  for (const d of node.dirs) {
    if (d.fileCount === 0) out.push(d);
    else emptyDirs(d, out);
  }
  return out;
}

/** Duplikat-Kandidaten: gleiche Klartextgröße (> 0). Größte mögliche Ersparnis zuerst. */
export function sameSizeGroups(files: FileRef[]): FileRef[][] {
  const m = new Map<number, FileRef[]>();
  for (const f of files) {
    const s = f.entry.size ?? 0;
    if (s > 0) m.set(s, [...(m.get(s) ?? []), f]);
  }
  return [...m.values()].filter((g) => g.length > 1).sort((a, b) => wasted(b) - wasted(a));
}

/** Platz, den alle Kopien außer einer belegen */
export const wasted = (g: FileRef[]) => (g[0]?.entry.size ?? 0) * (g.length - 1);

/** Inhalte der Kandidaten entschlüsseln und per SHA-256 vergleichen. Liefert echte Duplikat-Gruppen. */
export async function hashDuplicates(
  vault: Vault,
  candidates: FileRef[][],
  opts: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {},
): Promise<FileRef[][]> {
  let done = 0;
  const result: FileRef[][] = [];
  for (const group of candidates) {
    const byHash = new Map<string, FileRef[]>();
    for (const f of group) {
      const h = sha256.create();
      for await (const chunk of vault.decryptFile(f.entry, opts.signal)) {
        h.update(chunk);
        done += chunk.length;
        opts.onProgress?.(done);
      }
      const hex = Array.from(h.digest(), (b) => b.toString(16).padStart(2, '0')).join('');
      byHash.set(hex, [...(byHash.get(hex) ?? []), f]);
    }
    for (const g of byHash.values()) if (g.length > 1) result.push(g);
  }
  return result.sort((a, b) => wasted(b) - wasted(a));
}

/** Eintrag aus dem Baum entfernen (nach erfolgreichem Löschen) und Summen aktualisieren. */
export function removeFromTree(root: DirNode, target: VaultEntry): void {
  const k = keyOf(target);
  const walk = (n: DirNode): boolean => {
    const fi = n.files.findIndex((f) => keyOf(f) === k);
    if (fi >= 0) { n.files.splice(fi, 1); return true; }
    const di = n.dirs.findIndex((d) => d.entry && keyOf(d.entry) === k);
    if (di >= 0) { n.dirs.splice(di, 1); return true; }
    return n.dirs.some(walk);
  };
  walk(root);
  recompute(root);
}
