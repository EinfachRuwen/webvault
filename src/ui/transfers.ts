import { useCallback, useRef, useState } from 'react';
import { errorMessage } from './format';

const AUTO_DISMISS_MS = 5000;

export interface Transfer {
  id: number;
  label: string;
  kind: 'upload' | 'download' | 'delete' | 'rename';
  done: number;
  total?: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
}

export interface TransferControl {
  signal: AbortSignal;
  progress(done: number, total?: number): void;
  label(text: string): void;
}

/** Verwaltet laufende/abgeschlossene Up-/Downloads für die Statusleiste. */
export function useTransfers() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const controllers = useRef(new Map<number, AbortController>());
  const nextId = useRef(1);

  const patch = useCallback((id: number, p: Partial<Transfer>) => {
    setTransfers((list) => list.map((t) => (t.id === id ? { ...t, ...p } : t)));
  }, []);

  const run = useCallback(
    async (kind: Transfer['kind'], label: string, task: (c: TransferControl) => Promise<void>): Promise<boolean> => {
      const id = nextId.current++;
      const ac = new AbortController();
      controllers.current.set(id, ac);
      setTransfers((list) => [...list, { id, label, kind, done: 0, status: 'running' }]);
      try {
        await task({
          signal: ac.signal,
          progress: (done, total) => patch(id, total === undefined ? { done } : { done, total }),
          label: (text) => patch(id, { label: text }),
        });
        patch(id, { status: 'done' });
        // Erfolgreiche Übertragungen blenden sich selbst aus; Fehler bleiben stehen.
        window.setTimeout(() => setTransfers((list) => list.filter((t) => !(t.id === id && t.status === 'done'))), AUTO_DISMISS_MS);
        return true;
      } catch (e) {
        if (ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) patch(id, { status: 'cancelled' });
        else patch(id, { status: 'error', error: errorMessage(e) });
        return false;
      } finally {
        controllers.current.delete(id);
      }
    },
    [patch],
  );

  const cancel = useCallback((id: number) => controllers.current.get(id)?.abort(), []);
  const dismiss = useCallback((id: number) => setTransfers((list) => list.filter((t) => t.id !== id)), []);
  const clearFinished = useCallback(() => setTransfers((list) => list.filter((t) => t.status === 'running')), []);

  return { transfers, run, cancel, dismiss, clearFinished };
}
