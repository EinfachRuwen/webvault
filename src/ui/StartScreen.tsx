import { useRef, useState } from 'react';
import { FsAccessStorage, fsAccessSupported, pickDirectoryWithFsAccess } from '../storage/fsAccess';
import { FileListStorage, storageFromDroppedEntry } from '../storage/fileList';
import { StagedStorage } from '../storage/staged';
import type { VaultStorage } from '../storage/types';
import { ZipStorage } from '../storage/zipRead';
import { errorMessage } from './format';
import { FolderIcon, ShieldIcon } from './icons';

/** Nur lesbare Speicher werden im Änderungspaket-Modus betrieben, damit trotzdem hochgeladen werden kann. */
const stage = (s: VaultStorage): VaultStorage => (s.writable ? s : new StagedStorage(s));

export function StartScreen({ onStorage }: { onStorage: (s: VaultStorage) => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const canWrite = fsAccessSupported();
  // Touchgeräte haben praktisch nie eine Ordnerauswahl → ZIP als Hauptweg anbieten
  const touchFirst = !canWrite && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  const guard = async (fn: () => Promise<VaultStorage | null>) => {
    setError(undefined);
    setBusy(true);
    try {
      const s = await fn();
      if (s) onStorage(stage(s));
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setError(errorMessage(e)); // Abbruch der Auswahl ist kein Fehler
    } finally {
      setBusy(false);
    }
  };

  const pickFolder = () =>
    guard(async () => {
      if (canWrite) return pickDirectoryWithFsAccess();
      folderInput.current?.click();
      return null;
    });

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const item = e.dataTransfer.items[0];
    if (!item) return;
    // Alles synchron anstoßen, bevor das DataTransfer-Objekt ungültig wird.
    const file = item.kind === 'file' ? item.getAsFile() : null;
    const handleP = canWrite && 'getAsFileSystemHandle' in item ? item.getAsFileSystemHandle() : null;
    const entry = item.webkitGetAsEntry();
    void guard(async () => {
      if (file && /\.zip$/i.test(file.name) && !entry?.isDirectory) return ZipStorage.open(file);
      const handle = await handleP;
      if (handle && handle.kind === 'directory') {
        const dir = handle as FileSystemDirectoryHandle;
        if ((await dir.requestPermission({ mode: 'readwrite' })) === 'granted') return new FsAccessStorage(dir);
      }
      if (!entry) throw new Error('Das abgelegte Element konnte nicht gelesen werden.');
      return storageFromDroppedEntry(entry);
    });
  };

  const folderBtn = (primary: boolean) => (
    <button className={`btn btn-large ${primary ? 'btn-primary' : ''}`} onClick={pickFolder} disabled={busy}>
      Tresor-Ordner auswählen
    </button>
  );
  const zipBtn = (primary: boolean) => (
    <button className={`btn btn-large ${primary ? 'btn-primary' : ''}`} onClick={() => zipInput.current?.click()} disabled={busy}>
      Tresor als ZIP-Datei öffnen
    </button>
  );

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
        <p>Tresor-Ordner (oder ZIP-Datei) hierher ziehen</p>
        <span className="muted">oder</span>
        <div className="start-buttons">
          {touchFirst ? zipBtn(true) : folderBtn(true)}
          {touchFirst ? folderBtn(false) : zipBtn(false)}
        </div>
        <input
          ref={folderInput}
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
        <input
          ref={zipInput}
          type="file"
          hidden
          accept=".zip,application/zip,application/x-zip-compressed"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void guard(() => ZipStorage.open(file));
            e.target.value = '';
          }}
        />
        <p className="hint">Gemeint ist der Ordner, der <code>vault.cryptomator</code> und <code>masterkey.cryptomator</code> enthält.</p>
      </div>

      {busy && <p className="hint center">Lese Tresor …</p>}
      {error && <p className="alert alert-error" role="alert">{error}</p>}

      {!canWrite && (
        <p className="alert alert-info">
          <strong>Dieser Browser kann nicht direkt in Ordner schreiben</strong> (das können nur Chrome, Edge und Opera am Computer). Du kannst den Tresor trotzdem öffnen,
          durchsuchen, ansehen und herunterladen. Neues Hochgeladenes wird verschlüsselt gesammelt und als <strong>Änderungspaket</strong> (ZIP) zum Einspielen in den Tresor-Ordner bereitgestellt.
        </p>
      )}

      <details className="zip-help">
        <summary>Tresor als ZIP öffnen – wie geht das (z. B. auf dem Handy)?</summary>
        <ol>
          <li>Der Tresor-Ordner muss auf dem Gerät liegen (Cloud-Dateien vorher „offline verfügbar“ machen bzw. herunterladen).</li>
          <li>In der Dateien-App den <em>kompletten</em> Tresor-Ordner zu einer ZIP-Datei komprimieren (meist: Ordner lange drücken bzw. Menü → „Komprimieren“).</li>
          <li>Hier „Tresor als ZIP-Datei öffnen“ wählen. Die Datei wird nicht hochgeladen, sondern nur lokal gelesen – auch große ZIPs sind kein Problem.</li>
        </ol>
        <p className="hint">Gilt für Tresore im Cryptomator-Format 7/8. Änderungen landen im Änderungspaket und müssen anschließend in den Tresor-Ordner kopiert werden.</p>
      </details>

      <ul className="facts">
        <li><strong>Alles lokal.</strong> Passwort und Schlüssel verlassen diesen Tab nie – die Seite lädt nach dem Start keine Daten nach (per Content-Security-Policy erzwungen).</li>
        <li><strong>Kompatibel.</strong> Liest und schreibt das Cryptomator-Format 7/8 (AES-SIV + AES-GCM bzw. CTR-HMAC), getestet gegen die offizielle Bibliothek.</li>
        <li><strong>Sync-Ordner geeignet.</strong> Funktioniert mit jedem lokal synchronisierten Tresor (Dropbox, iCloud, OneDrive, Nextcloud …).</li>
      </ul>
      <p className="hint center">
        <a href="https://focusonruwen.com/impressum" target="_blank" rel="noopener">Impressum</a>
        {" · "}
        <a href="https://focusonruwen.com/datenschutz" target="_blank" rel="noopener">Datenschutz</a>
      </p>
    </div>
  );
}
