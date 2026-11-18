/** Links auf Impressum und Datenschutzerklärung.
 *  Beide öffnen sich in einem neuen Tab, damit ein geöffneter Tresor oder gesammelte Änderungen nicht verloren gehen. */
export const IMPRESSUM_URL = 'https://fcrw.cc/imprint';
export const DATENSCHUTZ_PATH = '/datenschutz/';

export function LegalLinks({ className = 'hint center legal-links' }: { className?: string }) {
  return (
    <p className={className}>
      <a href={IMPRESSUM_URL} target="_blank" rel="noopener">Impressum</a>
      {' · '}
      <a href={DATENSCHUTZ_PATH} target="_blank" rel="noopener">Datenschutz</a>
    </p>
  );
}
