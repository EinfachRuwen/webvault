export interface StorageEntry {
  name: string;
  kind: 'file' | 'directory';
}

export type WriteSource = Blob | Uint8Array | AsyncIterable<Uint8Array>;

/**
 * Minimale, pfadbasierte Sicht auf den (verschlüsselten) Tresor-Ordner.
 * Pfade sind Segmentlisten relativ zum Tresor-Root.
 */
export interface VaultStorage {
  /** Anzeigename (Ordnername) */
  readonly name: string;
  readonly writable: boolean;

  /** Wirft NotFoundError, wenn der Pfad nicht existiert oder kein Verzeichnis ist. */
  list(path: string[]): Promise<StorageEntry[]>;
  exists(path: string[]): Promise<boolean>;
  /** Wirft NotFoundError. */
  getFile(path: string[]): Promise<File>;

  /** Legt fehlende Elternverzeichnisse an und ersetzt eine vorhandene Datei. */
  writeFile(path: string[], data: WriteSource): Promise<void>;
  makeDir(path: string[]): Promise<void>;
  remove(path: string[], recursive?: boolean): Promise<void>;
}
