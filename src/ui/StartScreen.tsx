import { useRef, useState } from 'react';
import { FsAccessStorage, fsAccessSupported, pickDirectoryWithFsAccess } from '../storage/fsAccess';
import { FileListStorage, storageFromDroppedEntry } from '../storage/fileList';
import type { VaultStorage } from '../storage/types';
import { errorMessage } from './format';
import { FolderIcon, ShieldIcon } from './icons';

export function StartScreen({ onStorage }: { onStorage: (s: VaultStorage) => void }) {
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const canWrite = fsAccessSupported();

  const guard = async (fn: () => Promise<VaultStorage | null>) => {
    setError(undefined);
    try {
      const s = await fn();
      if (s) onStorage(s);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // Auswahl abgebrochen
      setError(errorMessage(e));
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const item = e.dataTransfer.items[0];
    if (!item) return;
    // Beides synchron anstoßen, bevor das DataTransfer-Objekt ungültig wird.
    const handleP = canWrite && 'getAsFileSystemHandle' in item ? item.getAsFileSystemHandle() : null;
    const entry = item.webkitGetAsEntry();
    void guard(async () => {
      const handle = await handleP;
      if (handle && handle.kind === 'directory') {
        const dir = handle as FileSystemDirectoryHandle;
        if ((await dir.requestPermission({ mode: 'readwrite' })) === 'granted') return new FsAccessStorage(dir);
      }
      if (!entry) throw new Error('Das abgelegte Element konnte nicht gelesen werden.');
      return storageFromDroppedEntry(entry);
    });
  };

  return (
    <div className="start">
      <div className="hero">
        <div className="logo"><ShieldIcon /></div>
        <h1>WebVault</h1>
        <p className="lead">
          Cryptomator-Tresore direkt im Browser öffnen: durchsuchen, ansehen, herunterladen und neue Dateien verschlüsselt hinzufügen –
          <strong> ohne Server, ohne Upload, ohne Konto.</strong>
        </p>
      </div>

      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <FolderIcon className="dropzone-icon" />
        <p>Tresor-Ordner hierher ziehen</p>
        <span className="muted">oder</span>
        <button
          className="btn btn-primary btn-large"
          onClick={() =>
            guard(async () => {
              if (canWrite) return pickDirectoryWithFsAccess();
              input.current?.click();
              return null;
            })
          }
        >
          Tresor-Ordner auswählen
        </button>
        <input
          ref={input}
          type="file"
          hidden
          // @ts-expect-error webkitdirectory ist nicht in den React-Typen
          webkitdirectory=""
          multiple
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) void guard(async () => FileListStorage.fromInput(files));
            e.target.value = '';
          }}
        />
        <p className="hint">Gemeint ist der Ordner, der <code>vault.cryptomator</code> und <code>masterkey.cryptomator</code> enthält.</p>
      </div>

      {error && <p className="alert alert-error" role="alert">{error}</p>}

      {!canWrite && (
        <p className="alert alert-info">
          Dein Browser kann Ordner nur <strong>lesen</strong> (kein Schreibzugriff). Ansehen und Herunterladen funktionieren, Hochladen und Ändern nicht.
          Für den vollen Funktionsumfang nutze Chrome, Edge, Brave oder Opera.
        </p>
      )}

      <ul className="facts">
        <li><strong>Alles lokal.</strong> Passwort und Schlüssel verlassen diesen Tab nie – die Seite lädt nach dem Start keine Daten nach (per Content-Security-Policy erzwungen).</li>
        <li><strong>Kompatibel.</strong> Liest und schreibt das Cryptomator-Format 7/8 (AES-SIV + AES-GCM bzw. CTR-HMAC), getestet gegen die offizielle Bibliothek.</li>
        <li><strong>Sync-Ordner geeignet.</strong> Funktioniert mit jedem lokal synchronisierten Tresor (Dropbox, iCloud, OneDrive, Nextcloud …).</li>
      </ul>
    </div>
  );
}
