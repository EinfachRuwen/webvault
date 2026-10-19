import { type FormEvent, useState } from 'react';
import { isStaged } from '../storage/staged';
import type { VaultStorage } from '../storage/types';
import { Vault } from '../vault/vault';
import { WrongPasswordError } from '../crypto/errors';
import { errorMessage } from './format';
import { ArrowLeftIcon, EyeIcon, EyeOffIcon, FolderIcon } from './icons';
import { ConfirmDialog } from './Modal';

export function UnlockScreen({ storage, onUnlocked, onBack }: { storage: VaultStorage; onUnlocked: (v: Vault) => void; onBack: () => void }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string>();
  const [confirmBack, setConfirmBack] = useState(false);
  const pending = isStaged(storage) ? storage.pending() : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || password === '') return;
    setBusy(true);
    setError(undefined);
    setProgress(0);
    try {
      const vault = await Vault.unlock(storage, password, { onProgress: setProgress });
      setPassword('');
      onUnlocked(vault);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof WrongPasswordError) setPassword('');
      setBusy(false);
    }
  };

  return (
    <div className="start">
      <form className="card unlock" onSubmit={submit}>
        <button type="button" className="link-btn back" onClick={() => (pending && pending.files > 0 ? setConfirmBack(true) : onBack())} disabled={busy}>
          <ArrowLeftIcon /> Anderen Tresor wählen
        </button>
        <div className="vault-name"><FolderIcon /> <strong>{storage.name}</strong></div>
        {pending && pending.files > 0 && (
          <p className="alert alert-info">Es liegen noch <strong>{pending.files} nicht exportierte Änderungen</strong> vor. Nach dem Entsperren kannst du sie als Änderungspaket herunterladen.</p>
        )}

        <label className="field">
          <span>Tresor-Passwort</span>
          <div className="password-row">
            <input
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? 'Passwort verbergen' : 'Passwort anzeigen'}>
              {show ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </label>

        {busy && (
          <div className="unlock-progress">
            <progress value={progress} max={1} />
            <small>Schlüssel wird abgeleitet (scrypt) – das dauert absichtlich einen Moment …</small>
          </div>
        )}
        {error && <p className="alert alert-error" role="alert">{error}</p>}

        <button className="btn btn-primary btn-large" disabled={busy || password === ''}>
          {busy ? 'Entsperre …' : 'Entsperren'}
        </button>
      </form>
      {confirmBack && (
        <ConfirmDialog
          title="Nicht exportierte Änderungen verwerfen?"
          danger
          confirmLabel="Verwerfen"
          message={<p>Die gesammelten neuen Dateien wurden noch nicht als Änderungspaket heruntergeladen und gehen verloren, wenn du einen anderen Tresor wählst.</p>}
          onConfirm={onBack}
          onClose={() => setConfirmBack(false)}
        />
      )}
    </div>
  );
}
