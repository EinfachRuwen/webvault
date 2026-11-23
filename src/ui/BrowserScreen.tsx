import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Crumb, DirListing, IndexedEntry, Vault, VaultEntry } from '../vault/vault';
import { isStaged } from '../storage/staged';
import { collectDropped, itemsFromFileList } from './dropped';
import { downloadEntries, exportStagedChanges } from './download';
import { ExportDialog } from './ExportDialog';
import { fileInfo } from './fileTypes';
import { errorMessage, formatBytes, formatDate } from './format';
import {
  AudioIcon, ChevronIcon, DownloadIcon, FileIcon, FolderIcon, FolderPlusIcon, ImageIcon, LockIcon,
  CopyIcon, MoveIcon, PasteIcon, PencilIcon, PieIcon, SearchIcon, TextIcon, TrashIcon, UploadIcon, VideoIcon,
} from './icons';
import { LegalLinks } from './LegalLinks';
import { ConfirmDialog, PromptDialog } from './Modal';
import { Preview } from './Preview';
import { FolderPicker } from './FolderPicker';
import { SpaceScreen } from '../space/SpaceScreen';
import { isHiddenName } from './fileTypes';
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
  | { type: 'delete'; entries: VaultEntry[] }
  | { type: 'export' }
  | { type: 'pick'; mode: 'move' | 'copy'; entries: VaultEntry[] };

/** Interner Drag-Typ: unterscheidet Verschieben im Tresor von Datei-Uploads vom Computer */
const DRAG_TYPE = 'application/x-webvault-entries';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

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
  /** Änderungspaket-Modus: Tresor ist nur lesbar, Neues wird gesammelt und exportiert. */
  const staged = isStaged(vault.storage) ? vault.storage : null;
  const [pending, setPending] = useState(() => staged?.pending() ?? { files: 0, bytes: 0 });
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
  /** Punkt-Dateien (.DS_Store, ._Fotos von macOS …) sind standardmäßig ausgeblendet. */
  const [showHidden, setShowHidden] = useState(false);
  /** Zwischenablage für Ausschneiden/Kopieren/Einfügen */
  const [clip, setClip] = useState<{ mode: 'move' | 'copy'; entries: VaultEntry[] } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ text: string; run: () => void } | null>(null);
  const dragged = useRef<VaultEntry[]>([]);
  const lastClicked = useRef<number | null>(null);
  const [space, setSpace] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // Verzeichnis laden
  const shownDir = useRef(dirId);
  useEffect(() => {
    let stale = false;
    setLoading(true);
    // Beim Ordnerwechsel nicht kurz den alten Inhalt unter dem neuen Pfad zeigen (Fehlklick-Gefahr); beim Neuladen schon
    if (shownDir.current !== dirId) setListing(null);
    shownDir.current = dirId;
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
    if (staged) setPending(staged.pending());
    reload();
  }, [reload, staged]);

  // Nicht exportierte Änderungen: vor versehentlichem Schließen des Tabs warnen
  useEffect(() => {
    if (pending.files === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending.files]);

  // Zeilen
  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base: Row[];
    if (searchingAll) {
      base = (index ?? []).filter((i) => i.entry.name.toLowerCase().includes(q)).map((i) => ({ entry: i.entry, trail: i.trail }));
    } else {
      base = (listing?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q)).map((entry) => ({ entry }));
    }
    if (!showHidden) base = base.filter((r) => !isHiddenName(r.entry.name) && !(r.trail ?? []).some((c) => isHiddenName(c.name)));
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
  }, [listing, index, query, searchingAll, sort, showHidden]);
  const hiddenCount = useMemo(() => (showHidden ? 0 : (listing?.entries ?? []).filter((e) => isHiddenName(e.name)).length), [listing, showHidden]);
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

  const doUpload = (items: UploadItem[], target = dirId) => {
    if (!writable || items.length === 0) return;
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

  // ---------------------------------------------------------------- Verschieben, Kopieren, Duplizieren
  const idsOf = (t: Crumb[]) => t.map((c) => c.dirId);
  const doTransfer = (mode: 'move' | 'copy', entries: VaultEntry[], target: Crumb[]) => {
    setDialog(null);
    if (!writable || entries.length === 0) return;
    const targetDirId = target.length ? target[target.length - 1].dirId : vault.rootDirId;
    const where = target.length ? target[target.length - 1].name : 'Tresor';
    // Originale im Änderungspaket-Modus können nicht gelöscht werden → dort nur kopieren
    const effective = mode === 'move' && entries.some((e) => e.removable === false) ? 'copy' : mode;
    if (effective !== mode) setNotice('Originale lassen sich in diesem Browser nicht verschieben – sie werden stattdessen kopiert.');
    const what = entries.length === 1 ? `„${entries[0].name}“` : `${entries.length} Einträge`;
    const moved: { from: string; to: VaultEntry }[] = [];
    void run(effective, `${what} → „${where}“`, async (ctl) => {
      for (const [i, e] of entries.entries()) {
        ctl.signal.throwIfAborted();
        ctl.progress(i, entries.length);
        if (effective === 'move') {
          const to = await vault.moveEntry(e, targetDirId, idsOf(target));
          if (to !== e) moved.push({ from: e.parentDirId, to });
        } else {
          await vault.copyEntry(e, targetDirId, idsOf(target), { signal: ctl.signal });
        }
      }
      ctl.progress(entries.length, entries.length);
    }).then(() => {
      afterChange();
      setSelected(new Set());
      if (moved.length) {
        setUndo({
          text: `${moved.length === 1 ? `„${moved[0].to.name}“` : `${moved.length} Einträge`} nach „${where}“ verschoben.`,
          run: () => {
            setUndo(null);
            void run('move', 'Verschieben rückgängig', async () => {
              for (const m of moved) await vault.moveEntry(m.to, m.from, []);
            }).then(afterChange);
          },
        });
      }
    });
  };
  const doDuplicate = (entries: VaultEntry[]) => {
    const what = entries.length === 1 ? `„${entries[0].name}“` : `${entries.length} Einträge`;
    void run('copy', `${what} duplizieren`, async (ctl) => {
      for (const [i, e] of entries.entries()) {
        ctl.signal.throwIfAborted();
        ctl.progress(i, entries.length);
        await vault.copyEntry(e, e.parentDirId, [], { signal: ctl.signal });
      }
    }).then(afterChange);
  };
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 12_000);
    return () => window.clearTimeout(t);
  }, [undo]);

  const doRename = (entry: VaultEntry, name: string) => {
    setDialog(null);
    void run('rename', `„${entry.name}“ → „${name}“`, async () => { await vault.renameEntry(entry, name); }).then(afterChange);
  };

  const doExport = () => {
    if (!staged) return;
    setDialog(null);
    void run('download', 'Änderungspaket erstellen', async (ctl) => {
      const done = await exportStagedChanges(staged, ctl);
      if (!done) throw new DOMException('abgebrochen', 'AbortError');
    });
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

  const isInternal = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(DRAG_TYPE);
  const onRowDragStart = (e: DragEvent, entry: VaultEntry) => {
    const list = selected.has(keyOf(entry)) ? selectedEntries : [entry];
    dragged.current = list;
    e.dataTransfer.setData(DRAG_TYPE, String(list.length));
    e.dataTransfer.effectAllowed = 'copyMove';
    if (list.length > 1) {
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = `${list.length} Einträge`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      window.setTimeout(() => ghost.remove());
    }
  };
  /** Ordnerzeilen und Pfad oben als Ablageziel: intern = verschieben (⌥/Strg = kopieren), vom Computer = hochladen */
  const dropProps = (target: Crumb[], key: string) => ({
    onDragOver: (e: DragEvent) => {
      const internal = isInternal(e);
      if (!writable || (!internal && !hasFiles(e))) return;
      const tid = target.length ? target[target.length - 1].dirId : vault.rootDirId;
      if (internal && dragged.current.some((d) => d.kind === 'directory' && (d.dirId === tid || idsOf(target).includes(d.dirId ?? '')))) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = internal ? (e.altKey || e.ctrlKey ? 'copy' : 'move') : 'copy';
      if (dropTarget !== key) setDropTarget(key);
    },
    onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
    onDrop: (e: DragEvent) => {
      setDropTarget(null);
      setDragging(false);
      if (!writable) return;
      const tid = target.length ? target[target.length - 1].dirId : vault.rootDirId;
      if (isInternal(e)) {
        e.preventDefault();
        e.stopPropagation();
        doTransfer(e.altKey || e.ctrlKey ? 'copy' : 'move', dragged.current, target);
        dragged.current = [];
      } else if (hasFiles(e)) {
        e.preventDefault();
        e.stopPropagation();
        void collectDropped(e.dataTransfer).then((items) => doUpload(items, tid)).catch((err) => setNotice(errorMessage(err)));
      }
    },
  });

  // Auswahl
  const visibleKeys = shownRows.map((r) => keyOf(r.entry));
  const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));
  const selectedEntries = shownRows.map((r) => r.entry).filter((e) => selected.has(keyOf(e)));
  const clickCheck = (e: React.MouseEvent, index: number) => {
    const from = lastClicked.current;
    lastClicked.current = index;
    if (!e.shiftKey || from === null) return;
    e.preventDefault();
    const [a, b] = from < index ? [from, index] : [index, from];
    setSelected((s) => new Set([...s, ...visibleKeys.slice(a, b + 1)]));
  };
  // Handy: lange auf eine Zeile drücken wählt aus; solange etwas ausgewählt ist, wählt Antippen weitere aus (statt zu öffnen).
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const rowPress = (k: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch' || (e.target as HTMLElement).closest('.col-check, .col-actions')) return;
      const p = { x: e.clientX, y: e.clientY, fired: false, timer: 0 };
      p.timer = window.setTimeout(() => { p.fired = true; toggle(k); navigator.vibrate?.(10); }, 450);
      press.current = p;
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) { clearTimeout(p.timer); press.current = null; }
    },
    onPointerUp: () => { if (press.current && !press.current.fired) { clearTimeout(press.current.timer); press.current = null; } },
    onPointerCancel: () => { if (press.current) clearTimeout(press.current.timer); press.current = null; },
    onContextMenu: (e: React.MouseEvent) => { if (coarse) e.preventDefault(); },
    onClickCapture: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('.col-check, .col-actions')) return;
      if (press.current?.fired) { e.preventDefault(); e.stopPropagation(); press.current = null; return; }
      if (coarse && selected.size > 0) { e.preventDefault(); e.stopPropagation(); toggle(k); }
    },
  });
  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!!dialog || !!preview || space) return;
      if ((e.target as HTMLElement | null)?.closest?.('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'a') { e.preventDefault(); setSelected(new Set(visibleKeys)); }
      else if (mod && (k === 'c' || k === 'x') && selectedEntries.length) { e.preventDefault(); setClip({ mode: k === 'x' ? 'move' : 'copy', entries: selectedEntries }); }
      else if (mod && k === 'v' && clip && writable) { e.preventDefault(); doTransfer(clip.mode, clip.entries, trail); if (clip.mode === 'move') setClip(null); }
      else if ((k === 'delete' || (k === 'backspace' && mod)) && selectedEntries.length && writable) { e.preventDefault(); setDialog({ type: 'delete', entries: selectedEntries }); }
      else if (k === 'f2' && selectedEntries.length === 1 && writable) { e.preventDefault(); setDialog({ type: 'rename', entry: selectedEntries[0] }); }
      else if (k === 'escape' && (selected.size || clip)) { setSelected(new Set()); setClip(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
          <label className="chip" title="Dateien und Ordner, deren Name mit einem Punkt beginnt (z. B. .DS_Store, ._Fotos von macOS)">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> versteckte
          </label>
        </div>
        <button className="btn" onClick={() => setSpace(true)} title="Speicherplatz: große Ordner und Dateien, Duplikate, leere Ordner"><PieIcon /> Speicher</button>
        <button className="btn" onClick={onLock}><LockIcon /> Sperren</button>
      </header>

      <main className="content">
        {!writable && (
          <p className="alert alert-info">Schreibgeschützt: Dieser Browser erlaubt keinen Schreibzugriff auf Ordner. Hochladen, Umbenennen und Löschen sind deaktiviert (Chrome/Edge verwenden).</p>
        )}
        {staged && (
          <p className="alert alert-info">
            <strong>Änderungspaket-Modus:</strong> Dieser Browser kann nicht direkt in den Tresor-Ordner schreiben. Ansehen, Suchen und Herunterladen funktionieren normal.
            Neu Hochgeladenes wird verschlüsselt gesammelt und lässt sich als <strong>Änderungspaket</strong> herunterladen. Vorhandene Dateien können hier nicht gelöscht oder
            umbenannt werden (dafür Chrome, Edge oder Opera am Computer nutzen).
          </p>
        )}
        {notice && (
          <p className="alert alert-error" role="alert">
            {notice} <button className="link-btn" onClick={() => setNotice(undefined)}>OK</button>
          </p>
        )}

        {undo && (
          <p className="alert alert-info undo-bar" role="status">
            {undo.text} <button className="link-btn" onClick={undo.run}>Rückgängig</button>
            <button className="link-btn" onClick={() => setUndo(null)}>OK</button>
          </p>
        )}

        <div className="toolbar">
          <nav className="crumbs" aria-label="Ordnerpfad">
            <button className={`crumb ${dropTarget === 'crumb:' ? 'drop-target' : ''}`} onClick={() => setTrail([])} disabled={trail.length === 0} {...dropProps([], 'crumb:')}>Tresor</button>
            {trail.map((c, i) => (
              <span key={c.dirId} className="crumb-wrap">
                <ChevronIcon />
                <button className={`crumb ${dropTarget === `crumb:${c.dirId}` ? 'drop-target' : ''}`} onClick={() => setTrail(trail.slice(0, i + 1))} disabled={i === trail.length - 1} {...dropProps(trail.slice(0, i + 1), `crumb:${c.dirId}`)}>{c.name}</button>
              </span>
            ))}
          </nav>
          <div className={`actions${selected.size > 0 ? ' has-selection' : ''}`}>
            {clip && writable && (
              <>
                <button className="btn btn-primary" onClick={() => { doTransfer(clip.mode, clip.entries, trail); if (clip.mode === 'move') setClip(null); }}
                  title={`${clip.mode === 'move' ? 'Ausgeschnittenes hierher verschieben' : 'Kopiertes hier einfügen'} (${isMac ? '⌘V' : 'Strg+V'})`}>
                  <PasteIcon /> Einfügen ({clip.entries.length})
                </button>
                <button className="icon-btn" onClick={() => setClip(null)} aria-label="Zwischenablage leeren" title="Zwischenablage leeren"><span aria-hidden="true">×</span></button>
              </>
            )}
            {staged && pending.files > 0 && (
              <button className="btn btn-primary" onClick={() => setDialog({ type: 'export' })}>
                <DownloadIcon /> Änderungspaket ({pending.files})
              </button>
            )}
            {selected.size > 0 ? (
              <>
                <button className="icon-btn" onClick={() => setSelected(new Set())} aria-label="Auswahl aufheben" title="Auswahl aufheben (Esc)"><span aria-hidden="true">×</span></button>
                <span className="muted">{selected.size} ausgewählt</span>
                <button className="btn" onClick={() => doDownload(selectedEntries)}><DownloadIcon /> Herunterladen</button>
                {writable && (
                  <>
                    <button className="btn" onClick={() => setDialog({ type: 'pick', mode: 'move', entries: selectedEntries })} title={`Verschieben nach … (oder auf einen Ordner ziehen · ${isMac ? '⌘X/⌘V' : 'Strg+X/Strg+V'})`}><MoveIcon /> Verschieben</button>
                    <button className="btn" onClick={() => setDialog({ type: 'pick', mode: 'copy', entries: selectedEntries })} title={`Kopieren nach … (oder mit ${isMac ? '⌥' : 'Strg'} auf einen Ordner ziehen · ${isMac ? '⌘C/⌘V' : 'Strg+C/Strg+V'})`}><CopyIcon /> Kopieren</button>
                    <button className="btn" onClick={() => doDuplicate(selectedEntries)} title="Kopie im selben Ordner anlegen">Duplizieren</button>
                  </>
                )}
                {writable && (
                  <button
                    className="btn btn-danger-outline"
                    disabled={selectedEntries.some((e) => e.removable === false)}
                    title={selectedEntries.some((e) => e.removable === false) ? 'Originale lassen sich in diesem Browser nicht löschen' : undefined}
                    onClick={() => setDialog({ type: 'delete', entries: selectedEntries })}
                  >
                    <TrashIcon /> Löschen
                  </button>
                )}
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
              {shownRows.map((row, index) => {
                const entry = meta.get(keyOf(row.entry)) ?? row.entry;
                const k = keyOf(entry);
                const isCut = clip?.mode === 'move' && clip.entries.some((c) => keyOf(c) === k);
                const folderTarget = entry.kind === 'directory' && entry.dirId ? [...(row.trail ?? trail), { dirId: entry.dirId, name: entry.name }] : null;
                return (
                  <tr
                    key={k}
                    className={`${selected.has(k) ? 'selected' : ''} ${dropTarget === k ? 'drop-target' : ''} ${isCut ? 'cut' : ''}`}
                    draggable={writable && !coarse && entry.kind !== 'symlink'}
                    onDragStart={(e) => onRowDragStart(e, entry)}
                    onDragEnd={() => { dragged.current = []; setDropTarget(null); }}
                    {...(folderTarget ? dropProps(folderTarget, k) : {})}
                    {...rowPress(k)}
                  >
                    <td className="col-check"><label className="check-hit"><input type="checkbox" checked={selected.has(k)} onClick={(e) => clickCheck(e, index)} onChange={() => toggle(k)} aria-label={`${entry.name} auswählen`} /></label></td>
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
                        <button
                          className="icon-btn"
                          disabled={entry.removable === false}
                          onClick={() => setDialog({ type: 'rename', entry })}
                          title={entry.removable === false ? 'Originale lassen sich in diesem Browser nicht umbenennen' : 'Umbenennen'}
                          aria-label={`${entry.name} umbenennen`}
                        >
                          <PencilIcon />
                        </button>
                      )}
                      {writable && (
                        <button
                          className="icon-btn"
                          disabled={entry.removable === false}
                          onClick={() => setDialog({ type: 'delete', entries: [entry] })}
                          title={entry.removable === false ? 'Originale lassen sich in diesem Browser nicht löschen' : 'Löschen'}
                          aria-label={`${entry.name} löschen`}
                        >
                          <TrashIcon />
                        </button>
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
          <span>{listing && !searchingAll ? `${listing.entries.length - hiddenCount} Einträge${hiddenCount ? ` · ${hiddenCount} versteckte ausgeblendet` : ''}` : ''}</span>
          <span>Format {vault.format} · {vault.cipherCombo === 'SIV_GCM' ? 'AES-GCM' : 'AES-CTR + HMAC'} · alles lokal entschlüsselt</span>
          <LegalLinks className="legal-links" />
        </footer>
      </main>

      {dragging && writable && (
        <div className="drop-overlay"><UploadIcon /><p>Loslassen, um Dateien in „{trail.length ? trail[trail.length - 1].name : 'Tresor'}“ zu verschlüsseln</p></div>
      )}

      <TransferPanel transfers={transfers} onCancel={cancel} onDismiss={dismiss} onClear={clearFinished} />

      {preview && (
        <Preview vault={vault} entry={preview} siblings={previewable} onNavigate={(e) => void vault.withMetadata(e).then(setPreview)} onDownload={(e) => doDownload([e])} onClose={() => setPreview(null)} />
      )}
      {space && (
        <SpaceScreen
          vault={vault}
          start={trail}
          onClose={(changed) => { setSpace(false); if (changed) afterChange(); }}
          onReveal={(t, changed) => { setSpace(false); setQuery(''); setTrail(t); if (changed) afterChange(); }}
          onDownload={doDownload}
        />
      )}
      {dialog?.type === 'export' && <ExportDialog pending={pending} onExport={doExport} onClose={() => setDialog(null)} />}
      {dialog?.type === 'pick' && (
        <FolderPicker vault={vault} mode={dialog.mode} entries={dialog.entries} start={trail} onPick={(t) => doTransfer(dialog.mode, dialog.entries, t)} onClose={() => setDialog(null)} />
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
