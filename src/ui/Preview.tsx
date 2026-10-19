import { useCallback, useEffect, useState } from 'react';
import type { Vault, VaultEntry } from '../vault/vault';
import { errorMessage, formatBytes } from './format';
import { fileInfo } from './fileTypes';
import { ArrowLeftIcon, ChevronIcon, CloseIcon, DownloadIcon } from './icons';
import { Modal } from './Modal';

const MAX_PREVIEW_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_CHARS = 1_000_000;

type State =
  | { phase: 'loading'; done: number }
  | { phase: 'ready'; url: string; text?: string; truncated?: boolean }
  | { phase: 'unsupported'; reason: string }
  | { phase: 'error'; message: string };

export function Preview({
  vault,
  entry,
  siblings,
  onNavigate,
  onDownload,
  onClose,
}: {
  vault: Vault;
  entry: VaultEntry;
  /** Weitere Dateien des Ordners für Vor/Zurück */
  siblings: VaultEntry[];
  onNavigate: (e: VaultEntry) => void;
  onDownload: (e: VaultEntry) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ phase: 'loading', done: 0 });
  const info = fileInfo(entry.name);
  const index = siblings.findIndex((s) => s.storagePath.join('/') === entry.storagePath.join('/'));
  const prev = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined;

  useEffect(() => {
    const ac = new AbortController();
    let url: string | undefined;
    setState({ phase: 'loading', done: 0 });
    (async () => {
      if (!info.kind) return setState({ phase: 'unsupported', reason: 'Für diesen Dateityp gibt es keine Vorschau.' });
      if ((entry.size ?? 0) > MAX_PREVIEW_BYTES) {
        return setState({ phase: 'unsupported', reason: `Die Datei ist mit ${formatBytes(entry.size)} zu groß für die Vorschau. Lade sie stattdessen herunter.` });
      }
      try {
        const blob = await vault.readFile(entry, {
          signal: ac.signal,
          type: info.mime,
          onProgress: (done) => setState({ phase: 'loading', done }),
        });
        if (ac.signal.aborted) return;
        let text: string | undefined;
        let truncated = false;
        if (info.kind === 'text') {
          text = await blob.slice(0, MAX_TEXT_CHARS * 2).text();
          if (text.length > MAX_TEXT_CHARS) {
            text = text.slice(0, MAX_TEXT_CHARS);
            truncated = true;
          } else truncated = blob.size > MAX_TEXT_CHARS * 2;
        }
        url = URL.createObjectURL(blob);
        setState({ phase: 'ready', url, text, truncated });
      } catch (e) {
        if (!ac.signal.aborted) setState({ phase: 'error', message: errorMessage(e) });
      }
    })();
    return () => {
      ac.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [vault, entry, info.kind, info.mime]);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.key === 'ArrowLeft' && prev) onNavigate(prev);
      if (e.key === 'ArrowRight' && next) onNavigate(next);
    },
    [prev, next, onNavigate],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return (
    <Modal onClose={onClose} wide className="preview-modal">
      <div className="preview">
        <header className="preview-head">
          <button className="icon-btn" disabled={!prev} onClick={() => prev && onNavigate(prev)} aria-label="Vorherige Datei" title="Vorherige (←)"><ArrowLeftIcon /></button>
          <button className="icon-btn" disabled={!next} onClick={() => next && onNavigate(next)} aria-label="Nächste Datei" title="Nächste (→)"><ChevronIcon /></button>
          <div className="preview-title">
            <strong title={entry.name}>{entry.name}</strong>
            <small>{formatBytes(entry.size)}</small>
          </div>
          <button className="btn" onClick={() => onDownload(entry)}><DownloadIcon /> Herunterladen</button>
          <button className="icon-btn" onClick={onClose} aria-label="Schließen"><CloseIcon /></button>
        </header>
        <div className="preview-body">
          {state.phase === 'loading' && (
            <div className="center-note">
              <progress value={entry.size ? state.done : undefined} max={entry.size || undefined} />
              <small>Entschlüssele … {formatBytes(state.done)}</small>
            </div>
          )}
          {state.phase === 'unsupported' && (
            <div className="center-note">
              <p>{state.reason}</p>
              <button className="btn btn-primary" onClick={() => onDownload(entry)}><DownloadIcon /> Entschlüsselt herunterladen</button>
            </div>
          )}
          {state.phase === 'error' && <p className="alert alert-error">{state.message}</p>}
          {state.phase === 'ready' && info.kind === 'image' && <img src={state.url} alt={entry.name} />}
          {state.phase === 'ready' && info.kind === 'video' && <video src={state.url} controls autoPlay={false} />}
          {state.phase === 'ready' && info.kind === 'audio' && <audio src={state.url} controls />}
          {state.phase === 'ready' && info.kind === 'pdf' && <iframe src={state.url} title={entry.name} />}
          {state.phase === 'ready' && info.kind === 'text' && (
            <>
              <pre>{state.text}</pre>
              {state.truncated && <p className="hint">Anzeige gekürzt – lade die Datei herunter, um sie vollständig zu sehen.</p>}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
