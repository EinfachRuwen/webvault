import { useCallback, useEffect, useState } from 'react';
import type { VaultStorage } from './storage/types';
import type { Vault } from './vault/vault';
import { BrowserScreen } from './ui/BrowserScreen';
import { StartScreen } from './ui/StartScreen';
import { UnlockScreen } from './ui/UnlockScreen';

type Phase = { name: 'start' } | { name: 'unlock'; storage: VaultStorage } | { name: 'open'; vault: Vault };

/** Nach dieser Zeit ohne Eingabe wird der Tresor automatisch gesperrt. */
const IDLE_LOCK_MS = 15 * 60 * 1000;

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'start' });
  const [lockedByIdle, setLockedByIdle] = useState(false);

  const lock = useCallback((idle = false) => {
    setLockedByIdle(idle);
    // Vault-Objekt (und damit alle Schlüssel) wird freigegeben und vom GC eingesammelt.
    setPhase({ name: 'start' });
  }, []);

  useEffect(() => {
    if (phase.name !== 'open') return;
    let timer = window.setTimeout(() => lock(true), IDLE_LOCK_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => lock(true), IDLE_LOCK_MS);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [phase.name, lock]);

  switch (phase.name) {
    case 'start':
      return (
        <>
          {lockedByIdle && <p className="alert alert-info idle-note">Der Tresor wurde nach 15 Minuten Inaktivität automatisch gesperrt.</p>}
          <StartScreen onStorage={(storage) => { setLockedByIdle(false); setPhase({ name: 'unlock', storage }); }} />
        </>
      );
    case 'unlock':
      return <UnlockScreen storage={phase.storage} onUnlocked={(vault) => setPhase({ name: 'open', vault })} onBack={() => setPhase({ name: 'start' })} />;
    case 'open':
      return <BrowserScreen vault={phase.vault} onLock={() => lock(false)} />;
  }
}
