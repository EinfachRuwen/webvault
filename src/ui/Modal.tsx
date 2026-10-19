import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';

/** Modaler Dialog auf Basis des nativen <dialog> (Fokus-Falle, Escape, Backdrop inklusive). */
export function Modal({ onClose, children, wide, className }: { onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''} ${className ?? ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose(); // Klick auf Backdrop
      }}
    >
      {children}
    </dialog>
  );
}

export function PromptDialog({
  title,
  label,
  initial = '',
  confirmLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const invalid = value.trim() === '' || /[/\\]/.test(value) || value === '.' || value === '..';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!invalid) onSubmit(value.trim());
  };
  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} className="dialog-body">
        <h2>{title}</h2>
        <label className="field">
          <span>{label}</span>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => {
              const dot = initial.lastIndexOf('.');
              e.target.setSelectionRange(0, dot > 0 ? dot : initial.length);
            }}
          />
        </label>
        {/[/\\]/.test(value) && <p className="hint error-text">Namen dürfen kein „/“ oder „\“ enthalten.</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Abbrechen</button>
          <button type="submit" className="btn btn-primary" disabled={invalid}>{confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose}>
      <div className="dialog-body">
        <h2>{title}</h2>
        <div className="dialog-message">{message}</div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose} autoFocus>Abbrechen</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}
