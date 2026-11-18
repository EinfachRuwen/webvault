# CLAUDE.md

WebVault: Cryptomator-Tresore komplett im Browser (React + Vite + TypeScript, statisch auf Vercel, kein Backend). Sprache von UI, Doku und Commit-Nachrichten: Deutsch. Vor einem Commit `npm run build` und `npm test`; Browser-Tests mit `npm run e2e` (siehe README).

Grundsätze: keine Netzwerkzugriffe nach dem Laden, keine Tracker, keine Drittanbieter-Ressourcen, Systemschrift. Die Header in `vercel.json` (insbesondere die CSP mit `connect-src 'none'`) sind Teil des Sicherheitskonzepts und dürfen nicht aufgeweicht werden.

## Datenschutz

- Die Datenschutzerklärung liegt in `datenschutz/index.html` (statische Seite ohne JavaScript, als zweiter Vite-Einstieg in `vite.config.ts`, ausgeliefert unter `/datenschutz/`). Die technische Dokumentation ist `docs/PRIVACY-TECHNICAL.md`.
- **Bei jeder datenschutzrelevanten Codeänderung** (neue externe Ressource, Skript, Schrift, Bild oder Einbettung; Analytics; Cookies, localStorage, sessionStorage, IndexedDB, Service Worker, Cache, gespeicherte Dateisystem-Handles; fetch/Beacon/WebSocket/Worker; Formulare oder mailto; Response-Header/CSP in `vercel.json`; Hosting, Domains, Weiterleitungen oder Rewrites; Vercel Analytics/Speed Insights/Functions/Middleware) beide Dateien prüfen und im selben Commit anpassen, einschließlich Stand-Datum und Datei:Zeile-Angaben.
- `/datenschutz/` muss direkt erreichbar bleiben: kein Catch-all-Rewrite und keine SPA-Weiterleitung darf die Seite verschlucken.
- Impressum (`https://fcrw.cc/imprint`) und Datenschutz (`/datenschutz/`) bleiben auf Start-, Entsperr- und Dateiansicht verlinkt (`src/ui/LegalLinks.tsx`) und öffnen sich in einem neuen Tab, damit ein geöffneter Tresor nicht verloren geht.
- `docs/` und diese Datei werden nicht ausgeliefert (nur `dist/` wird veröffentlicht; zusätzlich `.vercelignore`).
