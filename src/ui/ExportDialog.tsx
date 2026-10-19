import type { PendingSummary } from '../storage/staged';
import { formatBytes } from './format';
import { DownloadIcon } from './icons';
import { Modal } from './Modal';

export function ExportDialog({ pending, onExport, onClose }: { pending: PendingSummary; onExport: () => void; onClose: () => void }) {
  return (
    <Modal onClose={onClose} className="export-modal">
      <div className="dialog-body">
        <h2>Änderungspaket herunterladen</h2>
        <p>
          Dein Browser darf nicht direkt in den Tresor-Ordner schreiben. Deshalb wurden <strong>{pending.files} neue verschlüsselte Dateien</strong>{' '}
          ({formatBytes(pending.bytes)}) gesammelt. Lade sie als ZIP herunter und kopiere sie in deinen Tresor-Ordner:
        </p>
        <ol className="steps">
          <li>Entpacke das ZIP. Es enthält einen Ordner <code>d</code>.</li>
          <li>
            Kopiere <code>d</code> in deinen Tresor-Ordner (dort, wo <code>vault.cryptomator</code> liegt) und wähle bei der Rückfrage{' '}
            <strong>„Zusammenführen“</strong> bzw. „Beide behalten“.
          </li>
          <li>Warte, bis dein Sync-Dienst fertig ist, und öffne den Tresor danach neu.</li>
        </ol>
        <p className="alert alert-error">
          <strong>Niemals „Ersetzen“ wählen!</strong> Das würde die vorhandenen Tresor-Inhalte im Ordner <code>d</code> löschen.
          <br />
          <strong>Mac:</strong> Der Finder bietet „Zusammenführen“ nur an, wenn du beim Ablegen die Wahltaste (⌥) gedrückt hältst – sonst steht nur „Ersetzen“ zur Wahl.
          Windows und Linux führen Ordner standardmäßig zusammen.
        </p>
        <p className="hint">
          Tipp: Mach vorher eine Sicherungskopie des Tresor-Ordners. Auf Handy und Tablet ist das Einspielen je nach Dateien-App umständlich – am Computer geht es am sichersten.
          Das Paket enthält nur Neues; bereits vorhandene Dateien werden nie überschrieben.
        </p>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Später</button>
          <button className="btn btn-primary" onClick={onExport}><DownloadIcon /> Paket herunterladen</button>
        </div>
      </div>
    </Modal>
  );
}
