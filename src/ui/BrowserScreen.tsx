import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Crumb, DirListing, IndexedEntry, Vault, VaultEntry } from '../vault/vault';
import { collectDropped, itemsFromFileList } from './dropped';
import { downloadEntries } from './download';
import { fileInfo } from './fileTypes';
import { errorMessage, formatBytes, formatDate } from './format';
import {
  AudioIcon, ChevronIcon, DownloadIcon, FileIcon, FolderIcon, FolderPlusIcon, ImageIcon, LockIcon,
  PencilIcon, SearchIcon, TextIcon, TrashIcon, UploadIcon, VideoIcon,
} from './icons';
import { ConfirmDialog, PromptDialog } from './Modal';
import { Preview } from './Preview';
import { TransferPanel } from './TransferPanel';
import { useTransfers } from './transfers';
import { uploadItems, type UploadItem } from './upload';

type SortKey = 'name' | 'size' | 'modified';
interface Row {
  entry: VaultEntry;
  /** Ordnerpfad bei Suchergebnissen über den ganzen Tresor */
  trail?: Crumb[];
}
type Dialog =
  | { type: 'newFolder' }
  | { type: 'rename'; entry: VaultEntry }
  | { type: 'delete'; entries: VaultEntry[] };

const MAX_SEARCH_ROWS = 500;
const keyOf = (e: VaultEntry) => e.storagePath.join('/');

function EntryIcon({ entry }: { entry: VaultEntry }) {
  if (entry.kind === 'directory') return <FolderIcon className="entry-icon folder" />;
  switch (fileInfo(entry.name).kind) {
    case 'image': return <ImageIcon className="entry-icon" />;
    case 'video': return <VideoIcon className="entry-icon" />;
    case 'audio': return <AudioIcon className="entry-icon" />;
    case 'text': return <TextIcon className="entry-icon" />;
    default: return <FileIcon className="entry-icon" />;
  }
}

export function BrowserScreen({ vault, onLock }: { vault: Vault; onLock: () => void }) {
  const writable = vault.writable;
  const { transfers, run, cancel, dismiss, clearFinished } = useTransfers();

  // Navigation
  const [trail, setTrail] = useState<Crumb[]>([]);
  const dirId = trail.length > 0 ? trail[trail.length - 1].dirId : vault.rootDirId;
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  // Suche
  const [query, setQuery] = useState('');
  const [scopeAll, setScopeAll] = useState(false);
  const [index, setIndex] = useState<IndexedEntry[] | null>(null);
  const [indexing, setIndexing] = useState<number | null>(null);

  // Ansicht
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<VaultEntry | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // Verzeichnis laden
  useEffect(() => {
    let stale = false;
    setLoading(true);
    vault
      .listDir(dirId)
      .then((l) => {
        if (stale) return;
        setListing(l);
        setLoadError(undefined);
      })
      .catch((e) => !stale && setLoadError(errorMessage(e)))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [vault, dirId, reloadTick]);

  useEffect(() => setSelected(new Set()), [dirId, reloadTick, query, scopeAll]);

  // Index für die Suche im gesamten Tresor (lazy, einmalig; wird nach Änderungen neu aufgebaut)
  const searchingAll = scopeAll && query.trim() !== '';
  const indexJob = useRef<{ ac: AbortController; generation: number } | null>(null);
  const indexGeneration = useRef(0);
  const [indexVersion, setIndexVersion] = useState(0);
  useEffect(() => {
    if (!searchingAll || index || indexJob.current) return;
    const job = { ac: new AbortController(), generation: indexGeneration.current };
    indexJob.current = job;
    setIndexing(0);
    vault
      .buildIndex({ signal: job.ac.signal, onProgress: setIndexing })
      .then((result) => {
        if (job.generation === indexGeneration.current) setIndex(result);
      })
      .catch((e) => !job.ac.signal.aborted && setNotice(`Suche fehlgeschlagen: ${errorMessage(e)}`))
      .finally(() => {
        indexJob.current = null;
        setIndexing(null);
        // Während des Aufbaus hat sich der Tresor geändert → nächster Versuch
        if (job.generation !== indexGeneration.current) setIndexVersion((v) => v + 1);
      });
  }, [vault, searchingAll, index, indexVersion]);
  useEffect(() => () => indexJob.current?.ac.abort(), [vault]);

  const afterChange = useCallback(() => {
    indexGeneration.current++;
    setIndex(null);
    setMeta(new Map());
    reload();
  }, [reload]);

  // Zeilen
  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base: Row[];
    if (searchingAll) {
      base = (index ?? []).filter((i) => i.entry.name.toLowerCase().includes(q)).map((i) => ({ entry: i.entry, trail: i.trail }));
    } else {
      base = (listing?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q)).map((entry) => ({ entry }));
    }
    const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
    base.sort((a, b) => {
      const da = a.entry.kind === 'directory' ? 0 : 1;
      const db = b.entry.kind === 'directory' ? 0 : 1;
      if (da !== db) return da - db;
      let c = 0;
      if (sort.key === 'size') c = (a.entry.size ?? -1) - (b.entry.size ?? -1);
      else if (sort.key === 'modified') c = (a.entry.modified ?? 0) - (b.entry.modified ?? 0);
      return (c || collator.compare(a.entry.name, b.entry.name)) * sort.dir;
    });
    return base;
  }, [listing, index, query, searchingAll, sort]);
  const shownRows = useMemo(() => (searchingAll ? rows.slice(0, MAX_SEARCH_ROWS) : rows), [rows, searchingAll]);

  // Größe/Datum von Suchtreffern (Index enthält nur Namen) für die sichtbaren Zeilen nachladen.
  const [meta, setMeta] = useState<Map<string, VaultEntry>>(new Map());
  useEffect(() => {
    if (!searchingAll) return;
    const todo = shownRows.map((r) => r.entry).filter((e) => e.kind === 'file' && e.size === undefined && !meta.has(keyOf(e))).slice(0, 100);
    if (todo.length === 0) return;
    let stale = false;
    void Promise.all(todo.map((e) => vault.withMetadata(e).catch(() => e))).then((done) => {
      if (stale) return;
      setMeta((m) => {
        const n = new Map(m);
        for (const e of done) n.set(keyOf(e), e);
        return n;
      });
    });
    return () => {
      stale = true;
    };
  }, [vault, searchingAll, shownRows, meta]);

  const previewable = useMemo(() => rows.map((r) => r.entry).filter((e) => e.kind === 'file'), [rows]);

  // Aktionen
  const openRow = async (row: Row) => {
    const { entry } = row;
    if (entry.kind === 'directory' && entry.dirId !== undefined) {
      setTrail([...(row.trail ?? trail), { dirId: entry.dirId, name: entry.name }]);
      setQuery('');
    } else if (entry.kind === 'file') {
      setPreview(await vault.withMetadata(entry));
    }
  };

  const doUpload = (items: UploadItem[]) => {
    if (!writable || items.length === 0) return;
    const target = dirId;
    const label = items.length === 1 ? `„${items[0].file.name}“ hochladen` : `${items.length} Dateien hochladen`;
    void run('upload', label, (ctl) => uploadItems(vault, target, items, ctl)).then(afterChange);
  };

  const doDownload = (entries: VaultEntry[]) => {
    const label = entries.length === 1 ? `„${entries[0].name}“ herunterladen` : `${entries.length} Einträge herunterladen`;
    void run('download', label, async (ctl) => {
      const done = await downloadEntries(vault, entries, ctl);
      if (!done) throw new DOMException('abgebrochen', 'AbortError');
    });
  };

  const doDelete = (entries: VaultEntry[]) => {
    setDialog(null);
    const label = entries.length === 1 ? `„${entries[0].name}“ löschen` : `${entries.length} Einträge löschen`;
    void run('delete', label, async (ctl) => {
      for (const [i, e] of entries.entries()) {
        ctl.signal.throwIfAborted();
        ctl.progress(i, entries.length);
        await vault.deleteEntry(e);
      }
    }).then(afterChange);
  };

  const doRename = (entry: VaultEntry, name: string) => {
    setDialog(null);
    void run('rename', `„${entry.name}“ → „${name}“`, () => vault.renameEntry(entry, name)).then(afterChange);
  };

  const doNewFolder = async (name: string) => {
    setDialog(null);
    try {
      await vault.createDirectory(dirId, name);
      afterChange();
    } catch (e) {
      setNotice(errorMessage(e));
    }
  };

  // Drag & Drop
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragOver = (e: DragEvent) => {
    if (!writable || !hasFiles(e)) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    if (!writable || !hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    void collectDropped(e.dataTransfer).then(doUpload).catch((err) => setNotice(errorMessage(err)));
  };

  // Auswahl
  const visibleKeys = shownRows.map((r) => keyOf(r.entry));
  const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));
  const selectedEntries = shownRows.map((r) => r.entry).filter((e) => selected.has(keyOf(e)));
  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const sortMark = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');

  return (
    <div className={`app ${transfers.length > 0 ? 'has-transfers' : ''}`} onDragOver={onDragOver} onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)} onDrop={onDrop}>
      <header className="topbar">
        <div className="brand"><LockIcon /> <span>{vault.storage.name}</span></div>
        <div className="search">
          <SearchIcon />
          <input
            type="search"
            placeholder={scopeAll ? 'Im Tresor suchen …' : 'Im Ordner suchen …'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Suche"
          />
          <label className="chip" title="Durchsucht die Namen aller Ordner (Index wird einmalig aufgebaut)">
            <input type="checkbox" checked={scopeAll} onChange={(e) => setScopeAll(e.target.checked)} /> ganzer Tresor
          </label>
        </div>
        <button className="btn" onClick={onLock}><LockIcon /> Sperren</button>
      </header>

      <main className="content">
        {!writable && (
          <p className="alert alert-info">Schreibgeschützt: Dieser Browser erlaubt keinen Schreibzugriff auf Ordner. Hochladen, Umbenennen und Löschen sind deaktiviert (Chrome/Edge verwenden).</p>
        )}
        {notice && (
          <p className="alert alert-error" role="alert">
            {notice} <button className="link-btn" onClick={() => setNotice(undefined)}>OK</button>
          </p>
        )}

        <div className="toolbar">
          <nav className="crumbs" aria-label="Ordnerpfad">
            <button className="crumb" onClick={() => setTrail([])} disabled={trail.length === 0}>Tresor</button>
            {trail.map((c, i) => (
              <span key={c.dirId} className="crumb-wrap">
                <ChevronIcon />
                <button className="crumb" onClick={() => setTrail(trail.slice(0, i + 1))} disabled={i === trail.length - 1}>{c.name}</button>
              </span>
            ))}
          </nav>
          <div className="actions">
            {selected.size > 0 ? (
              <>
                <span className="muted">{selected.size} ausgewählt</span>
                <button className="btn" onClick={() => doDownload(selectedEntries)}><DownloadIcon /> Herunterladen</button>
                {writable && <button className="btn btn-danger-outline" onClick={() => setDialog({ type: 'delete', entries: selectedEntries })}><TrashIcon /> Löschen</button>}
              </>
            ) : (
              writable && (
                <>
                  <button className="btn" onClick={() => setDialog({ type: 'newFolder' })}><FolderPlusIcon /> Neuer Ordner</button>
                  <button className="btn" onClick={() => folderInput.current?.click()}><FolderIcon /> Ordner hochladen</button>
                  <button className="btn btn-primary" onClick={() => fileInput.current?.click()}><UploadIcon /> Dateien hochladen</button>
                </>
              )
            )}
          </div>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
            if (e.target.files) doUpload(Array.from(e.target.files, (file) => ({ file, folder: [] })));
            e.target.value = '';
          }} />
          <input ref={folderInput} type="file" hidden multiple
            // @ts-expect-error webkitdirectory ist nicht in den React-Typen
            webkitdirectory=""
            onChange={(e) => {
              if (e.target.files) doUpload(itemsFromFileList(e.target.files));
              e.target.value = '';
            }} />
        </div>

        {indexing !== null && <p className="hint">Durchsuche Tresor … {indexing} Einträge indexiert</p>}
        {loadError && <p className="alert alert-error" role="alert">{loadError}</p>}
        {listing && listing.skipped > 0 && !searchingAll && (
          <p className="hint">{listing.skipped} Einträge konnten nicht entschlüsselt werden (z. B. Sync-Konfliktkopien) und werden nicht angezeigt.</p>
        )}

        <div className="table-wrap" aria-busy={loading}>
          <table className="files">
            <thead>
              <tr>
                <th className="col-check">
                  <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(visibleKeys))} aria-label="Alle auswählen" />
                </th>
                <th><button className="th-btn" onClick={() => sortBy('name')}>Name{sortMark('name')}</button></th>
                <th className="col-size"><button className="th-btn" onClick={() => sortBy('size')}>Größe{sortMark('size')}</button></th>
                <th className="col-date"><button className="th-btn" onClick={() => sortBy('modified')}>Geändert{sortMark('modified')}</button></th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {shownRows.map((row) => {
                const entry = meta.get(keyOf(row.entry)) ?? row.entry;
                const k = keyOf(entry);
                return (
                  <tr key={k} className={selected.has(k) ? 'selected' : ''}>
                    <td className="col-check"><input type="checkbox" checked={selected.has(k)} onChange={() => toggle(k)} aria-label={`${entry.name} auswählen`} /></td>
                    <td className="col-name">
                      <button className="name-btn" onClick={() => openRow(row)} disabled={entry.kind === 'symlink'} title={entry.name}>
                        <EntryIcon entry={entry} />
                        <span className="name-text">{entry.name}</span>
                      </button>
                      {row.trail && (
                        <button className="path-btn" onClick={() => { setTrail(row.trail!); setQuery(''); }} title="Ordner öffnen">
                          {['Tresor', ...row.trail.map((c) => c.name)].join(' / ')}
                        </button>
                      )}
                    </td>
                    <td className="col-size">{entry.kind === 'file' ? formatBytes(entry.size) : ''}</td>
                    <td className="col-date">{entry.kind === 'file' ? formatDate(entry.modified) : ''}</td>
                    <td className="col-actions">
                      {entry.kind !== 'symlink' && (
                        <button className="icon-btn" onClick={() => doDownload([entry])} title="Herunterladen" aria-label={`${entry.name} herunterladen`}><DownloadIcon /></button>
                      )}
                      {writable && entry.kind !== 'symlink' && (
                        <button className="icon-btn" onClick={() => setDialog({ type: 'rename', entry })} title="Umbenennen" aria-label={`${entry.name} umbenennen`}><PencilIcon /></button>
                      )}
                      {writable && (
                        <button className="icon-btn" onClick={() => setDialog({ type: 'delete', entries: [entry] })} title="Löschen" aria-label={`${entry.name} löschen`}><TrashIcon /></button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && shownRows.length === 0 && indexing === null && (
            <div className="empty">
              {query ? <p>Keine Treffer für „{query}“.</p> : <p>Dieser Ordner ist leer.{writable ? ' Ziehe Dateien hierher, um sie verschlüsselt hinzuzufügen.' : ''}</p>}
            </div>
          )}
          {loading && <div className="empty"><p>Lade …</p></div>}
          {searchingAll && rows.length > MAX_SEARCH_ROWS && <p className="hint">Zeige die ersten {MAX_SEARCH_ROWS} von {rows.length} Treffern – Suche weiter eingrenzen.</p>}
        </div>

        <footer className="status">
          <span>{listing && !searchingAll ? `${listing.entries.length} Einträge` : ''}</span>
          <span>Format {vault.format} · {vault.cipherCombo === 'SIV_GCM' ? 'AES-GCM' : 'AES-CTR + HMAC'} · alles lokal entschlüsselt</span>
        </footer>
      </main>

      {dragging && writable && (
        <div className="drop-overlay"><UploadIcon /><p>Loslassen, um Dateien in „{trail.length ? trail[trail.length - 1].name : 'Tresor'}“ zu verschlüsseln</p></div>
      )}

      <TransferPanel transfers={transfers} onCancel={cancel} onDismiss={dismiss} onClear={clearFinished} />

      {preview && (
        <Preview vault={vault} entry={preview} siblings={previewable} onNavigate={(e) => void vault.withMetadata(e).then(setPreview)} onDownload={(e) => doDownload([e])} onClose={() => setPreview(null)} />
      )}
      {dialog?.type === 'newFolder' && (
        <PromptDialog title="Neuer Ordner" label="Name des Ordners" confirmLabel="Anlegen" onSubmit={doNewFolder} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'rename' && (
        <PromptDialog title="Umbenennen" label="Neuer Name" initial={dialog.entry.name} confirmLabel="Umbenennen" onSubmit={(n) => doRename(dialog.entry, n)} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmDialog
          title="Endgültig löschen?"
          danger
          confirmLabel="Löschen"
          message={
            dialog.entries.length === 1 ? (
              <p>„{dialog.entries[0].name}“{dialog.entries[0].kind === 'directory' ? ' samt Inhalt' : ''} wird aus dem Tresor gelöscht. Das lässt sich nicht rückgängig machen.</p>
            ) : (
              <p>{dialog.entries.length} Einträge (Ordner samt Inhalt) werden aus dem Tresor gelöscht. Das lässt sich nicht rückgängig machen.</p>
            )
          }
          onConfirm={() => doDelete(dialog.entries)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
