import type { Transfer } from './transfers';
import { formatBytes } from './format';
import { CloseIcon } from './icons';

const KIND_LABEL = { upload: 'Hochladen', download: 'Herunterladen', delete: 'Löschen', rename: 'Umbenennen' } as const;

export function TransferPanel({
  transfers,
  onCancel,
  onDismiss,
  onClear,
}: {
  transfers: Transfer[];
  onCancel: (id: number) => void;
  onDismiss: (id: number) => void;
  onClear: () => void;
}) {
  if (transfers.length === 0) return null;
  const hasFinished = transfers.some((t) => t.status !== 'running');
  return (
    <aside className="transfers" aria-label="Übertragungen" aria-live="polite">
      <div className="transfers-head">
        <strong>Übertragungen</strong>
        {hasFinished && <button className="link-btn" onClick={onClear}>Erledigte entfernen</button>}
      </div>
      <ul>
        {transfers.map((t) => (
          <li key={t.id} className={`transfer transfer-${t.status}`}>
            <div className="transfer-row">
              <span className="transfer-label" title={t.label}>{t.label}</span>
              {t.status === 'running' ? (
                <button className="icon-btn" onClick={() => onCancel(t.id)} title="Abbrechen" aria-label="Abbrechen"><CloseIcon /></button>
              ) : (
                <button className="icon-btn" onClick={() => onDismiss(t.id)} title="Ausblenden" aria-label="Ausblenden"><CloseIcon /></button>
              )}
            </div>
            {t.status === 'running' && (
              <>
                <progress value={t.total ? t.done : undefined} max={t.total} />
                <small>
                  {KIND_LABEL[t.kind]}
                  {t.total ? ` · ${formatBytes(t.done)} von ${formatBytes(t.total)}` : ''}
                </small>
              </>
            )}
            {t.status === 'done' && <small className="ok-text">{KIND_LABEL[t.kind]} abgeschlossen</small>}
            {t.status === 'cancelled' && <small>Abgebrochen</small>}
            {t.status === 'error' && <small className="error-text">{t.error}</small>}
          </li>
        ))}
      </ul>
    </aside>
  );
}
