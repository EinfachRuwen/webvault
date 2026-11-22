import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Crumb, Vault, VaultEntry } from '../vault/vault';
import { isStaged } from '../storage/staged';
import { errorMessage, formatBytes, formatDate } from '../ui/format';
import { CloseIcon, DownloadIcon, FolderIcon, PieIcon, TrashIcon } from '../ui/icons';
import { ConfirmDialog } from '../ui/Modal';
import {
  allFiles, byCategory, type Category, CATEGORIES, categoryOf, type DirNode, emptyDirs, type FileRef,
  hashDuplicates, largest, removeFromTree, sameSizeGroups, scanTree, wasted,
} from './scan';
import './space.css';

type Tab = 'tree' | 'bigdirs' | 'largest' | 'duplicates' | 'empty';
type Dupes = { phase: 'idle' } | { phase: 'running'; done: number; total: number; ac: AbortController } | { phase: 'done'; groups: FileRef[][] } | { phase: 'error'; message: string };

const pct = (part: number, whole: number) => (whole > 0 ? Math.max(0.5, (part / whole) * 100) : 0);
const pathOf = (trail: Crumb[], root: string) => [root, ...trail.map((c) => c.name)].join(' › ');

export function SpaceScreen({ vault, start, onClose, onReveal, onDownload }: {
  vault: Vault;
  /** Startordner (Pfad ab Tresor-Root) */
  start: Crumb[];
  /** `changed`: es wurde etwas gelöscht */
  onClose: (changed: boolean) => void;
  onReveal: (trail: Crumb[], changed: boolean) => void;
  onDownload: (entries: VaultEntry[]) => void;
}) {
  const canDelete = vault.writable && !isStaged(vault.storage);
  const rootName = vault.storage.name;
  const [root, setRoot] = useState<DirNode | null>(null);
  const [progress, setProgress] = useState({ files: 0, bytes: 0 });
  const [error, setError] = useState<string>();
  const [rescan, setRescan] = useState(0);
  const [, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>('tree');
  /** Aufgeklappte Ordner im Baum (dirId) */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<Category | undefined>();
  const [dupes, setDupes] = useState<Dupes>({ phase: 'idle' });
  const [confirm, setConfirm] = useState<{ entry: VaultEntry; label: string } | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setRoot(null);
    setError(undefined);
    setExpanded(new Set());
    setDupes({ phase: 'idle' });
    scanTree(vault, start, { signal: ac.signal, onProgress: (files, bytes) => setProgress({ files, bytes }) }).then(
      (r) => {
        if (ac.signal.aborted) return;
        // Wie TreeSize: Wurzel und der jeweils größte Unterordner zwei Ebenen tief aufgeklappt
        const open = new Set([r.dirId]);
        let n: DirNode | undefined = r;
        for (let i = 0; i < 2 && n; i++) { n = [...n.dirs].sort((a, b) => b.size - a.size)[0]; if (n) open.add(n.dirId); }
        setRoot(r);
        setExpanded(open);
      },
      (e) => { if (!ac.signal.aborted) setError(errorMessage(e)); },
    );
    return () => ac.abort();
  }, [vault, start, rescan]);

  const dupeJob = useRef<AbortController | null>(null);
  useEffect(() => () => dupeJob.current?.abort(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !confirm) onClose(changed); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm, changed, onClose]);

  const files = useMemo(() => (root ? allFiles(root) : []), [root, root?.fileCount, root?.size]);
  const cats = useMemo(() => byCategory(files), [files]);
  const candidates = useMemo(() => sameSizeGroups(files), [files]);
  const empties = useMemo(() => (root ? emptyDirs(root) : []), [root, root?.dirCount, root?.fileCount]);
  const candidateBytes = candidates.reduce((s, g) => s + g.reduce((t, f) => t + (f.entry.size ?? 0), 0), 0);
  const allDirs = useMemo(() => {
    const out: DirNode[] = [];
    const walk = (n: DirNode) => { for (const d of n.dirs) { out.push(d); walk(d); } };
    if (root) walk(root);
    return out.sort((a, b) => b.size - a.size);
  }, [root, root?.size, root?.dirCount]);
  const toggle = (id: string) => setExpanded((e) => { const n = new Set(e); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const showInTree = (d: DirNode) => {
    setExpanded((e) => new Set([...e, ...(root ? [root.dirId] : []), ...d.trail.slice(start.length).map((c) => c.dirId)]));
    setTab('tree');
  };

  /** Baum als flache Zeilenliste: nur aufgeklappte Äste, größte zuerst, lose Dateien als eigene Zeile. */
  const treeRows = useMemo(() => {
    const rows: ({ kind: 'dir'; node: DirNode; depth: number; parent: number } | { kind: 'files'; node: DirNode; depth: number; size: number })[] = [];
    const walk = (n: DirNode, depth: number) => {
      for (const d of [...n.dirs].sort((a, b) => b.size - a.size)) {
        rows.push({ kind: 'dir', node: d, depth, parent: n.size });
        if (expanded.has(d.dirId)) walk(d, depth + 1);
      }
      if (n.files.length > 0 && n.dirs.length > 0) rows.push({ kind: 'files', node: n, depth, size: n.files.reduce((s, f) => s + (f.size ?? 0), 0) });
    };
    if (root) walk(root, 0);
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, root?.size, root?.dirCount, expanded]);

  const runDupes = async () => {
    const ac = new AbortController();
    dupeJob.current = ac;
    setDupes({ phase: 'running', done: 0, total: candidateBytes, ac });
    try {
      const groups = await hashDuplicates(vault, candidates, { signal: ac.signal, onProgress: (done) => setDupes({ phase: 'running', done, total: candidateBytes, ac }) });
      setDupes({ phase: 'done', groups });
    } catch (e) {
      setDupes(ac.signal.aborted ? { phase: 'idle' } : { phase: 'error', message: errorMessage(e) });
    }
  };

  const doDelete = async (entry: VaultEntry) => {
    setConfirm(null);
    setBusy(true);
    try {
      await vault.deleteEntry(entry);
      if (root) removeFromTree(root, entry);
      if (dupes.phase === 'done') {
        const k = entry.storagePath.join('/');
        setDupes({ phase: 'done', groups: dupes.groups.map((g) => g.filter((f) => f.entry.storagePath.join('/') !== k)).filter((g) => g.length > 1) });
      }
      setChanged(true);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const deletable = (e: VaultEntry) => canDelete && e.removable !== false;

  const fileRow = (f: FileRef, extra?: ReactNode) => (
    <li key={f.entry.storagePath.join('/')} className="sp-row">
      <span className={`sp-dot cat-${categoryOf(f.entry.name)}`} aria-hidden="true" />
      <div className="sp-main">
        <strong title={f.entry.name}>{f.entry.name}</strong>
        <small>{pathOf(f.trail, rootName)} · {formatDate(f.entry.modified)}</small>
      </div>
      <span className="sp-size">{formatBytes(f.entry.size)}</span>
      <div className="sp-actions">
        {extra}
        <button className="icon-btn" title="Im Ordner zeigen" aria-label={`${f.entry.name} im Ordner zeigen`} onClick={() => onReveal(f.trail, changed)}><FolderIcon /></button>
        <button className="icon-btn" title="Herunterladen" aria-label={`${f.entry.name} herunterladen`} onClick={() => onDownload([f.entry])}><DownloadIcon /></button>
        {deletable(f.entry) && (
          <button className="icon-btn danger" title="Löschen" aria-label={`${f.entry.name} löschen`} disabled={busy} onClick={() => setConfirm({ entry: f.entry, label: `„${f.entry.name}“ (${formatBytes(f.entry.size)})` })}><TrashIcon /></button>
        )}
      </div>
    </li>
  );

  return (
    <div className="space" role="dialog" aria-modal="true" aria-label="Speicherplatz">
      <header className="sp-head">
        <h2><PieIcon /> Speicherplatz</h2>
        <span className="sp-scope" title={pathOf(start, rootName)}>{pathOf(start, rootName)}</span>
        <button className="btn" onClick={() => setRescan((n) => n + 1)} disabled={!root}>Neu einlesen</button>
        <button className="icon-btn" onClick={() => onClose(changed)} aria-label="Speicherplatz schließen" title="Schließen (Esc)"><CloseIcon /></button>
      </header>

      {error && <p className="alert alert-error" role="alert">{error} <button className="link-btn" onClick={() => setError(undefined)}>OK</button></p>}

      {!root && !error && (
        <div className="sp-scan">
          <div className="sp-spinner" />
          <p>Lese Ordner … <strong>{progress.files.toLocaleString('de')}</strong> Dateien, {formatBytes(progress.bytes)}</p>
          <small className="muted">Es werden nur Größen gelesen, nichts entschlüsselt.</small>
        </div>
      )}

      {root && (
        <>
          <section className="sp-summary">
            <div className="sp-total">
              <span className="sp-big">{formatBytes(root.size)}</span>
              <span className="muted">{root.fileCount.toLocaleString('de')} Dateien in {root.dirCount.toLocaleString('de')} Ordnern</span>
            </div>
            <div className="sp-bar" role="img" aria-label="Verteilung nach Dateityp">
              {CATEGORIES.filter((c) => cats.get(c.id)?.bytes).map((c) => (
                <span key={c.id} className={`cat-${c.id}`} style={{ width: `${pct(cats.get(c.id)!.bytes, root.size)}%` }} title={`${c.label}: ${formatBytes(cats.get(c.id)!.bytes)}`} />
              ))}
            </div>
            <div className="sp-legend">
              {CATEGORIES.filter((c) => cats.get(c.id)?.count).map((c) => (
                <button key={c.id} className={`sp-chip ${category === c.id ? 'on' : ''}`} onClick={() => { setCategory(category === c.id ? undefined : c.id); setTab('largest'); }}>
                  <span className={`sp-dot cat-${c.id}`} /> {c.label} <b>{formatBytes(cats.get(c.id)!.bytes)}</b> <small>{cats.get(c.id)!.count}</small>
                </button>
              ))}
            </div>
          </section>

          <nav className="sp-tabs" role="tablist">
            {([['tree', 'Ordnerbaum'], ['bigdirs', 'Größte Ordner'], ['largest', 'Größte Dateien'], ['duplicates', `Duplikate${dupes.phase === 'done' ? ` (${dupes.groups.length})` : ''}`], ['empty', `Leere Ordner (${empties.length})`]] as [Tab, string][]).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
            ))}
          </nav>

          <div className="sp-body">
            {tab === 'tree' && (
              <>
                <div className="sp-crumbs">
                  <span className="muted">Ordner nach Größe · Klick klappt auf und zu</span>
                  <button className="link-btn sp-open" onClick={() => setExpanded(new Set(allDirs.map((d) => d.dirId)))}>Alle aufklappen</button>
                  <button className="link-btn" onClick={() => setExpanded(new Set())}>Alle zuklappen</button>
                </div>
                {treeRows.length === 0 ? <p className="hint">Hier gibt es keine Unterordner.</p> : (
                  <ul className="sp-tree" role="tree">
                    <li className="sp-node sp-node-files sp-tree-head" aria-hidden="true">
                      <span className="sp-node-btn">
                        <span />
                        <span />
                        <span className="sp-node-name">Ordner</span>
                        <span className="sp-node-bar-label">Anteil</span>
                        <span className="sp-node-pct">%</span>
                        <span className="sp-node-count">Dateien</span>
                        <span className="sp-size">Größe</span>
                      </span>
                      <span className="sp-node-spacer" />
                    </li>
                    {treeRows.map((r) => r.kind === 'dir' ? (
                      <li key={r.node.dirId} role="treeitem" aria-expanded={r.node.dirs.length ? expanded.has(r.node.dirId) : undefined} className="sp-node" style={{ paddingLeft: `${r.depth * 1.15}rem` }}>
                        <button className="sp-node-btn" onClick={() => r.node.dirs.length && toggle(r.node.dirId)} title={pathOf(r.node.trail, rootName)}>
                          <span className={`sp-caret ${r.node.dirs.length ? '' : 'none'} ${expanded.has(r.node.dirId) ? 'open' : ''}`} aria-hidden="true">▸</span>
                          <FolderIcon className="entry-icon folder" />
                          <span className="sp-node-name">{r.node.name}</span>
                          <span className="sp-meter sp-node-meter" title={`${Math.round((r.node.size / (r.parent || 1)) * 100)} % des Elternordners`}><span style={{ width: `${pct(r.node.size, r.parent)}%` }} /></span>
                          <span className="sp-node-pct">{r.parent ? `${Math.round((r.node.size / r.parent) * 100)} %` : ''}</span>
                          <span className="sp-node-count" title="Dateien (mit Unterordnern)">{r.node.fileCount.toLocaleString('de')}</span>
                          <span className="sp-size">{formatBytes(r.node.size)}</span>
                        </button>
                        <button className="icon-btn" title="Im Tresor öffnen" aria-label={`${r.node.name} im Tresor öffnen`} onClick={() => onReveal(r.node.trail, changed)}><FolderIcon /></button>
                      </li>
                    ) : (
                      <li key={`${r.node.dirId}:files`} className="sp-node sp-node-files" style={{ paddingLeft: `${r.depth * 1.15}rem` }}>
                        <span className="sp-node-btn">
                          <span className="sp-caret none" aria-hidden="true">▸</span>
                          <span />
                          <span className="sp-node-name muted">{r.node.files.length} {r.node.files.length === 1 ? 'Datei' : 'Dateien'} direkt hier</span>
                          <span className="sp-meter sp-node-meter"><span style={{ width: `${pct(r.size, r.node.size)}%` }} /></span>
                          <span className="sp-node-pct">{r.node.size ? `${Math.round((r.size / r.node.size) * 100)} %` : ''}</span>
                          <span className="sp-node-count">{r.node.files.length}</span>
                          <span className="sp-size">{formatBytes(r.size)}</span>
                        </span>
                        <span className="sp-node-spacer" />
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {tab === 'bigdirs' && (
              <ul className="sp-list">
                {allDirs.slice(0, 50).map((d) => (
                  <li key={d.dirId} className="sp-row">
                    <FolderIcon className="entry-icon folder" />
                    <div className="sp-main">
                      <strong>{d.name}</strong>
                      <small>{pathOf(d.trail.slice(0, -1), rootName)} · {d.fileCount.toLocaleString('de')} Dateien</small>
                      <span className="sp-meter"><span style={{ width: `${pct(d.size, root.size)}%` }} /></span>
                    </div>
                    <span className="sp-size">{formatBytes(d.size)}<small>{root.size ? `${Math.round((d.size / root.size) * 100)} %` : ''}</small></span>
                    <div className="sp-actions">
                      <button className="icon-btn" title="Im Baum zeigen" aria-label={`${d.name} im Baum zeigen`} onClick={() => showInTree(d)}><PieIcon /></button>
                      <button className="icon-btn" title="Im Tresor öffnen" aria-label={`${d.name} im Tresor öffnen`} onClick={() => onReveal(d.trail, changed)}><FolderIcon /></button>
                    </div>
                  </li>
                ))}
                {allDirs.length === 0 && <p className="hint">Keine Unterordner.</p>}
              </ul>
            )}

            {tab === 'largest' && (
              <>
                {category && <p className="hint">Gefiltert: {CATEGORIES.find((c) => c.id === category)?.label} · <button className="link-btn" onClick={() => setCategory(undefined)}>alle zeigen</button></p>}
                <ul className="sp-list">{largest(files, 100, category).map((f) => fileRow(f))}</ul>
              </>
            )}

            {tab === 'duplicates' && (
              <>
                {dupes.phase === 'idle' && (
                  <div className="sp-card">
                    {candidates.length === 0 ? <p>Keine zwei Dateien haben dieselbe Größe – also gibt es keine Duplikate.</p> : (
                      <>
                        <p><strong>{candidates.reduce((s, g) => s + g.length, 0)} Dateien</strong> in {candidates.length} Gruppen haben jeweils dieselbe Größe. Ob sie wirklich gleich sind,
                          zeigt erst ein Vergleich der Inhalte: Dafür werden {formatBytes(candidateBytes)} lokal entschlüsselt und per SHA-256 verglichen.</p>
                        <button className="btn btn-primary" onClick={() => void runDupes()}>Inhalte vergleichen</button>
                      </>
                    )}
                  </div>
                )}
                {dupes.phase === 'running' && (
                  <div className="sp-card">
                    <p>Vergleiche Inhalte … {formatBytes(dupes.done)} von {formatBytes(dupes.total)}</p>
                    <progress value={dupes.done} max={dupes.total || 1} />
                    <button className="btn" onClick={() => dupes.ac.abort()}>Abbrechen</button>
                  </div>
                )}
                {dupes.phase === 'error' && <p className="alert alert-error">{dupes.message}</p>}
                {dupes.phase === 'done' && (dupes.groups.length === 0 ? <p className="hint">Keine Duplikate gefunden – gleiche Größe, aber unterschiedlicher Inhalt.</p> : (
                  <>
                    <p className="hint">{dupes.groups.length} Gruppen identischer Dateien · {formatBytes(dupes.groups.reduce((s, g) => s + wasted(g), 0))} doppelt belegt. Eine Datei pro Gruppe bleibt immer stehen.</p>
                    {dupes.groups.map((g) => (
                      <section key={g[0].entry.storagePath.join('/')} className="sp-group">
                        <h3>{g.length} × {formatBytes(g[0].entry.size)} <small>· {formatBytes(wasted(g))} doppelt</small></h3>
                        <ul className="sp-list">{g.map((f) => fileRow(f))}</ul>
                      </section>
                    ))}
                  </>
                ))}
              </>
            )}

            {tab === 'empty' && (
              empties.length === 0 ? <p className="hint">Keine leeren Ordner.</p> : (
                <ul className="sp-list">
                  {empties.map((d) => (
                    <li key={d.dirId} className="sp-row">
                      <FolderIcon className="entry-icon folder" />
                      <div className="sp-main"><strong>{d.name}</strong><small>{pathOf(d.trail.slice(0, -1), rootName)}{d.dirCount ? ` · ${d.dirCount} leere Unterordner` : ''}</small></div>
                      <div className="sp-actions">
                        <button className="icon-btn" title="Im Tresor öffnen" aria-label={`${d.name} öffnen`} onClick={() => onReveal(d.trail, changed)}><FolderIcon /></button>
                        {d.entry && deletable(d.entry) && (
                          <button className="icon-btn danger" title="Löschen" aria-label={`${d.name} löschen`} disabled={busy} onClick={() => setConfirm({ entry: d.entry!, label: `den leeren Ordner „${d.name}“` })}><TrashIcon /></button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
          {!canDelete && <p className="hint sp-foot">Löschen geht hier nur in Chrome, Edge oder Opera am Computer mit Schreibzugriff.</p>}
        </>
      )}

      {confirm && (
        <ConfirmDialog
          title="Endgültig löschen?"
          danger
          confirmLabel="Löschen"
          message={<p>{confirm.label} wird aus dem Tresor gelöscht. Das lässt sich nicht rückgängig machen.</p>}
          onConfirm={() => void doDelete(confirm.entry)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
