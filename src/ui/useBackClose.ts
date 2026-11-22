import { useEffect, useRef } from 'react';

/**
 * Zurück-Geste (Android-Zurück, iOS-Randwischen, Browser-Zurück) schließt die oberste Ansicht statt die Seite zu verlassen –
 * sonst wäre der entsperrte Tresor weg. `onBack` darf `true` zurückgeben, um offen zu bleiben (z. B. Feed → Menü).
 */
export function useBackClose(onBack: () => boolean | void): void {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    const id = Math.random().toString(36).slice(2);
    const push = () => history.pushState({ overlay: id }, '');
    // leicht verzögert: React StrictMode (Entwicklung) bindet Effekte doppelt ein – so entsteht kein Geister-Eintrag
    const timer = window.setTimeout(push, 0);
    let popped = false;
    const onPop = () => {
      if (ref.current() === true) push();
      else popped = true;
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('popstate', onPop);
      if (!popped && (history.state as { overlay?: string } | null)?.overlay === id) history.back();
    };
  }, []);
}
