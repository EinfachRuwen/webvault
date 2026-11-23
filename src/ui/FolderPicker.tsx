import { type FormEvent, useEffect, useState } from 'react';
import type { Crumb, Vault, VaultEntry } from '../vault/vault';
import { errorMessage } from './format';
import { isHiddenName } from './fileTypes';
import { ChevronIcon, FolderIcon, FolderPlusIcon } from './icons';
import { Modal } from './Modal';

/** Zielordner wählen – für „Verschieben nach …“ / „Kopieren nach …“ (auch am Handy, wo es kein Drag & Drop gibt). */
export function FolderPicker({ vault, mode, entries, start, onPick, onClose }: {
  vault: Vault;
  mode: 'move' | 'copy';
  entries: VaultEntry[];
  start: Crumb[];
  onPick: (target: Crumb[]) => void;
  onClose: () => void;
}) {
  const [trail, setTrail] = useState<Crumb[]>(start);
  const [dirs, setDirs] = useState<VaultEntry[] | null>(null);
  const [error, setError] = useState<string>();
  const [newName, setNewName] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const dirId = trail.length ? trail[trail.length - 1].dirId : vault.rootDirId;
  /** Verschobene Ordner selbst sind als Ziel tabu (auch ihr Inneres) */
  const blocked = new Set(entries.filter((e) => e.kind === 'directory' && e.dirId).map((e) => e.dirId!));
  const insideBlocked = trail.some((c) => blocked.has(c.dirId));
  const sameFolder = mode === 'move' && entries.every((e) => e.parentDirId === dirId);

  useEffect(() => {
    let stale = false;
    setDirs(null);
    vault.listDir(dirId, { stat: false }).then(
      ({ entries: list }) => {
        if (stale) return;
        const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
        setDirs(list.filter((e) => e.kind === 'directory' && !isHiddenName(e.name)).sort((a, b) => collator.compare(a.name, b.name)));
      },
      (e) => !stale && setError(errorMessage(e)),
    );
    return () => { stale = true; };
  }, [vault, dirId, tick]);

  const createFolder = async (e: FormEvent) => {
    e.preventDefault();
    const name = newName?.trim();
    if (!name || /[/\\]/.test(name)) return;
    try {
      const created = await vault.createDirectory(dirId, name);
      setNewName(null);
      setTrail([...trail, { dirId: created.dirId!, name: created.name }]);
      setTick((t) => t + 1);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const what = entries.length === 1 ? `„${entries[0].name}“` : `${entries.length} Einträge`;
  const verb = mode === 'move' ? 'verschieben' : 'kopieren';
  return (
    <Modal onClose={onClose} className="picker-modal">
      <div className="dialog-body picker">
        <h2>{what} {verb}</h2>
        <nav className="crumbs picker-crumbs" aria-label="Zielordner">
          <button className="crumb" onClick={() => setTrail([])} disabled={trail.length === 0}>Tresor</button>
          {trail.map((c, i) => (
            <span key={c.dirId} className="crumb-wrap">
              <ChevronIcon />
              <button className="crumb" onClick={() => setTrail(trail.slice(0, i + 1))} disabled={i === trail.length - 1}>{c.name}</button>
            </span>
          ))}
        </nav>
        <ul className="picker-list" aria-busy={dirs === null}>
          {dirs === null && <li className="hint">Lade …</li>}
          {dirs?.length === 0 && <li className="hint">Keine Unterordner.</li>}
          {dirs?.map((d) => (
            <li key={d.dirId}>
              <button className="picker-item" disabled={blocked.has(d.dirId!)} onClick={() => setTrail([...trail, { dirId: d.dirId!, name: d.name }])}
                title={blocked.has(d.dirId!) ? 'Ein Ordner kann nicht in sich selbst' : undefined}>
                <FolderIcon className="entry-icon folder" /> <span>{d.name}</span> <ChevronIcon className="picker-go" />
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="alert alert-error">{error}</p>}
        {newName !== null ? (
          <form className="picker-new" onSubmit={(e) => void createFolder(e)}>
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name des neuen Ordners" aria-label="Name des neuen Ordners" />
            <button className="btn" type="submit" disabled={!newName.trim() || /[/\\]/.test(newName)}>Anlegen</button>
            <button className="btn" type="button" onClick={() => setNewName(null)}>Abbrechen</button>
          </form>
        ) : (
          vault.writable && <button className="link-btn picker-newbtn" onClick={() => setNewName('')}><FolderPlusIcon /> Neuer Ordner hier</button>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Abbrechen</button>
          <button className="btn btn-primary" disabled={insideBlocked || sameFolder || dirs === null} onClick={() => onPick(trail)}>
            Hierher {verb}
          </button>
        </div>
        {sameFolder && <p className="hint">Die Auswahl liegt bereits hier.</p>}
      </div>
    </Modal>
  );
}
