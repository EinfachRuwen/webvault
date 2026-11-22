# Technische Datenschutz-Dokumentation

Stand: 22.11.2026 · gehört zu `datenschutz/index.html` (öffentlich unter `/datenschutz/`).
Diese Datei wird nicht ausgeliefert: Vercel veröffentlicht nur `dist/` (`vercel.json` → `outputDirectory`), zusätzlich steht `docs/` in `.vercelignore`.

Grundlage war die zentrale Erklärung `https://fcrw.cc/privacy` → `https://focusonruwen.com/datenschutz/` (Stand 15.11.2026, Abschnitte 1–4, 11–13). Übernommen wurden Verantwortlicher, Geltungsbereich-Formulierung, Rechte, Hosting-Absatz und Kontakt; jede Aussage wurde gegen den Code dieses Repos (Branch `claude/webvault-cryptomator-web`, das Default-Branch; einen Branch `main` gibt es nicht) und die Live-Seite geprüft. Abweichungen stehen unten.

## Hosting und Auslieferung (ermittelt, nicht aus dem Repo ableitbar)

| Punkt | Befund | Beleg |
|---|---|---|
| Hoster | Vercel Inc. (Git-Integration; Commit-Status „Vercel“ mit Link auf `vercel.com/ruwens-projekte/webvault/…`; `vercel[bot]` kommentiert PRs mit Preview-URL) | GitHub-API `commits/b25d4a3/status`, PR #1-Kommentare; Antwort-Header `server: Vercel`, `x-vercel-id`, `x-vercel-cache` |
| Produktiv-Domain | `vault.deploy.by0.link` (200) | `curl -I https://vault.deploy.by0.link/` am 18.11.2026 |
| DNS | `vault.deploy.by0.link` ist ein CNAME auf `ac2ea4a384adc94b.vercel-dns-017.com` (A: 216.198.79.1, 64.29.17.1). Die Zone `by0.link` liegt bei Cloudflare-DNS (`chip`/`adaline.ns.cloudflare.com`), der Eintrag ist aber **nicht** über Cloudflare geproxied | DNS-over-HTTPS-Abfrage (dns.google) am 18.11.2026; keine `cf-ray`/`server: cloudflare`-Header bei der Subdomain |
| Proxy/CDN davor | keiner außer der Vercel-Edge | Header-Auswertung |
| Weiterleitungen | `http://vault.deploy.by0.link/` → 308 → `https://…/` (Vercel) | `curl -I http://…` → `server: Vercel` |
| Unbekannte Pfade | Vercel liefert eigenes `NOT_FOUND` (404, text/plain). Kein Catch-all/Rewrite in `vercel.json` → `/datenschutz/` wird nicht verschluckt. Vor dieser Änderung war `/datenschutz` live 404 | `curl -I https://vault.deploy.by0.link/datenschutz` am 18.11.2026 |
| Konfiguration | `vercel.json`: Framework Vite, `npm run build`, Ausgabe `dist`, Sicherheits-Header für alle Pfade, `Cache-Control` für `/assets/*`. Keine Functions (`api/`), keine Middleware, keine Umgebungsvariablen | `vercel.json:1-28` |
| Response-Header | CSP `default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; media-src blob:; frame-src blob:; font-src 'self'; connect-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, HSTS, `X-Frame-Options: DENY`, COOP, Permissions-Policy | `vercel.json:11-19`, live identisch |
| Live = Repo | Live-Bundle `index-lygbF4ey.js` ist hash-gleich mit dem lokalen Build von `b25d4a3` → keine von Vercel eingefügten Skripte (kein Analytics/Speed Insights/Toolbar) | lokaler `npm run build` vs. Live-HTML |

## Verarbeitungen

| # | Verarbeitung | Daten | Fundstelle | Rechtsgrundlage | Speicherdauer |
|---|---|---|---|---|---|
| 1 | Auslieferung durch Vercel, Request-/Server-Logs | IP, Zeit, Host, Pfad, Status, Bytes, User-Agent, ggf. Referrer des ersten Aufrufs, aus IP abgeleiteter Ort | Hosting (s. o.) | Art. 6 Abs. 1 lit. f DSGVO | Dashboard: Hobby 1 h, Pro 1 Tag (Runtime Logs; statische Requests nur teilweise sichtbar, https://vercel.com/docs/logs/runtime). Vercel-intern: nicht konkret veröffentlicht |
| 2 | HTTP→HTTPS-Weiterleitung | wie 1 | Vercel-Plattform | wie 1 | wie 1 |
| 3 | Drittlandübermittlung USA | wie 1 | – | Art. 45 DSGVO (DPF, Vercel „Active“, nächste Rezertifizierung 29.04.2027, https://www.dataprivacyframework.gov/participant/6847) | – |
| 4 | Tresor-Ordner/ZIP auswählen | Dateisystem-Handle bzw. `FileList`/`File` der gewählten Dateien | `src/storage/fsAccess.ts:107-110` (`showDirectoryPicker`, `id: 'webvault'`), `src/ui/StartScreen.tsx:37-63` (Ordnerwahl, Drag & Drop, `requestPermission`), `:103-126` (`webkitdirectory`, ZIP-Input), `src/storage/zipRead.ts`, `src/storage/fileList.ts` | rein lokal, keine Übertragung | Arbeitsspeicher des Tabs |
| 5 | Passwort → Schlüssel | Passwort, scrypt-KEK, Master-Keys | `src/ui/UnlockScreen.tsx:20-34` (State, nach Erfolg/Fehlpasswort geleert, `autoComplete="off"` `:56`), `src/crypto/masterkey.ts:71-79` (scrypt, KEK genullt), `src/crypto/keys.ts:20-22` (nicht exportierbar), `src/vault/vault.ts:118-119` (Rohschlüssel genullt), `src/crypto/content.ts:82,100-101` | rein lokal | Arbeitsspeicher; freigegeben bei Sperre (`src/App.tsx:18-28`) |
| 6 | Entschlüsseln, Vorschau, Suche | Klartextnamen, Dateiinhalte, Suchindex | `src/vault/vault.ts`, `src/ui/Preview.tsx:39-74` (Blob-URL, beim Schließen freigegeben), `src/ui/BrowserScreen.tsx` (Index im State) | rein lokal | Arbeitsspeicher |
| 7 | Herunterladen | entschlüsselte Datei/ZIP | `src/ui/download.ts:39-72` (`showSaveFilePicker` oder Blob-Download) | rein lokal; Speicherort wählt der Nutzer | beim Nutzer |
| 8 | Hochladen/Ändern | neue Dateien (vor dem Schreiben verschlüsselt) | `src/ui/upload.ts`, `src/storage/fsAccess.ts:75-104` (direkt in den Ordner), `src/storage/staged.ts` + `src/ui/download.ts:138-164` (Änderungspaket) | rein lokal | im Tresor-Ordner bzw. bis Export/Tab-Schließen im Speicher |
| 9 | Auto-Sperre | Eingabe-Ereignisse nur als Timer-Reset | `src/App.tsx:12`, `:30-43` | lokal, nichts gespeichert | – |
| 10 | Warnung vor Schließen | nur bei ungespeicherten Änderungen | `src/ui/BrowserScreen.tsx:131-137` (`beforeunload`) | lokal | – |
| 11 | Browser-eigener Speicher bei Ordnerwahl (Chromium) | zuletzt gewählter Ort je `id` (`'webvault'`), erteilte Dateisystem-Erlaubnis | `src/storage/fsAccess.ts:108` | § 25 Abs. 2 Nr. 2 TDDDG (vom Nutzer ausdrücklich gewünschte Ordnerauswahl); von der Seite nicht auslesbar | vom Browser verwaltet; Erlaubnis in den Website-Einstellungen widerrufbar |
| 12 | `matchMedia('(pointer: coarse)')` | Zeigertyp, um ZIP als Hauptweg anzubieten | `src/ui/StartScreen.tsx:22` | lokal | – |
| 13 | Externe Links | nur `<a href>`; Impressum `https://fcrw.cc/imprint` (Cloudflare, 302 → `focusonruwen.com/impressum/`), Vercel-Datenschutzhinweis | `src/ui/LegalLinks.tsx`, verwendet in `src/ui/StartScreen.tsx:155`, `src/ui/UnlockScreen.tsx:78`, `src/ui/BrowserScreen.tsx:449`; `datenschutz/index.html` | – (Cloudflare DPF „Active“, https://www.dataprivacyframework.gov/participant/5666) | – |
| 15 | Speicherplatz-Manager | Ordnerbaum mit Klartextgrößen und Änderungsdaten (`listDir` mit `stat`); nur bei „Inhalte vergleichen“ werden Dateien gleicher Größe entschlüsselt und mit `@noble/hashes` SHA-256 gehasht; nichts gespeichert, Löschen nur nach Bestätigung | `src/space/scan.ts` (`scanTree`, `hashDuplicates`), `src/space/SpaceScreen.tsx` | rein lokal | Arbeitsspeicher, bis die Ansicht geschlossen wird |
| 16 | HEIC-Anzeige, versteckte Dateien | HEIC-Container lokal zerlegt, HEVC-Kacheln mit WebCodecs `VideoDecoder` dekodiert (kein WASM, kein Worker, keine Verbindung), Ergebnis als JPEG-`blob:`; Punkt-Dateien werden nur ausgeblendet | `src/media/heif.ts`, `src/media/heic.ts`, `src/ui/Preview.tsx`; `src/ui/fileTypes.ts` (`isHiddenName`), `src/ui/BrowserScreen.tsx` | rein lokal | Arbeitsspeicher |
| 14 | E-Mail-Kontakt | `mailto:` auf der Datenschutzseite | `datenschutz/index.html` (Abschnitte 01, 09) | Art. 6 Abs. 1 lit. f DSGVO | bis Anfrage erledigt |

Nicht vorhanden (per `grep` über `src/`, `index.html`, `public/` und Live-Prüfung mit Headless-Chromium am 18.11.2026 bestätigt): Cookies, `localStorage`, `sessionStorage`, IndexedDB, Service Worker/Cache API/Manifest, `fetch`/XHR/WebSocket/`sendBeacon`, Worker, Analytics (kein Umami, keine Vercel Web Analytics/Speed Insights), externe Skripte/Fonts/Bilder/CDNs (Systemschrift, `src/styles.css:39`), iframes außer der lokalen PDF-Vorschau aus `blob:`-URL, Formulare mit Versand (`form-action 'none'`; Formulare in `UnlockScreen`/`Modal` werden nur per JS ausgewertet). Live-Requests der Startseite: nur `/`, `/assets/*.js`, `/assets/*.css`, `/favicon.svg` vom eigenen Host.

**Was der Server sieht:** ausschließlich die Abrufe der statischen Dateien (#1). Kein Tresor-Inhalt, kein Passwort, kein Dateiname, nicht einmal, ob ein Tresor geöffnet wurde. Abgesichert durch `connect-src 'none'`, `form-action 'none'`, `worker-src 'none'`, `default-src 'none'`. Einschränkung: Same-Origin-Laden von Skripten/Styles/Bildern/Fonts und das Navigieren über Links bleiben technisch erlaubt; der Code nutzt das nach dem Start nicht.

## Abgleich mit der zentralen Erklärung (focusonruwen.com/datenschutz, Stand 15.11.2026)

| Aussage dort | Befund im Code | Umgang |
|---|---|---|
| Abschn. 11: „Passwort, Schlüssel und Dateien verlassen deinen Browser nicht“ | stimmt | übernommen (Abschn. 02/04) |
| Abschn. 11: „die Seite darf nach dem Laden technisch keine Verbindungen mehr aufbauen“ | **leicht überzeichnet**: CSP verbietet fetch/XHR/WebSocket/Beacon, Formulare, Worker und fremde Hosts; Same-Origin-Laden von Skript/Style/Bild/Font sowie Navigation über Links bleiben erlaubt (werden nach dem Start nicht genutzt) | präzisiert (Abschn. 02) |
| Abschn. 11: „Statistik findet nicht statt“; Abschn. 5: Umami „außer Passnote und WebVault“ | stimmt (kein Skript, live hash-gleich) | übernommen (Abschn. 06) |
| Abschn. 3: Vercel als Hoster für WebVault, DPF/Art. 45 | stimmt | übernommen (Abschn. 03) |
| Abschn. 3: „Serverfunktionen können in den USA ausgeführt werden“ | **trifft auf WebVault nicht zu**: keine Functions/Middleware | weggelassen; stattdessen „statische Seite ohne Server-Funktionen“ |
| Abschn. 3: „Die Logs werden vom jeweiligen Anbieter nach kurzer Zeit gelöscht“ | für Vercel intern **nicht belegt** (nur Dashboard-Sichtbarkeit 1 h/1 Tag dokumentiert) | vorsichtiger formuliert |
| Abschn. 3: Datenliste ohne Statuscode/Datenmenge/Ort | Vercel-Logs enthalten diese Felder (Region, Status) | ergänzt |
| Abschn. 4: Cookies/Speicher „z. B. für die Anmeldung oder Einstellungen“ | WebVault nutzt **keinerlei** Cookies/Browserspeicher; fehlt dort: browser-eigener Speicher der Ordnerwahl/Erlaubnis | konkretisiert und ergänzt (Abschn. 05) |
| Abschn. 2: Widerruf von Einwilligungen (Art. 7 Abs. 3) | keine Einwilligungen bei WebVault | weggelassen |
| Abschn. 2: Beschwerde „etwa bei der LfD Niedersachsen“ | Zuständigkeit noch offen (LfD Niedersachsen vs. LDI NRW) | nur Art. 77 allgemein |
| Abschn. 6: Kontakt lit. f bzw. lit. b | WebVault hat kein Vertragsverhältnis/Konto | nur lit. f |
| fehlt dort | HTTP→HTTPS-Weiterleitung, Beschreibung der lokalen Verarbeitung (Abschn. 04), Referrer-Policy `no-referrer`, Impressum-Link über fcrw.cc/Cloudflare, Art. 21 hervorgehoben, Art. 22, Bereitstellungspflicht | ergänzt |
| alte Links in der App | zeigten direkt auf `focusonruwen.com/impressum` und `focusonruwen.com/datenschutz` (nur Startseite) | ersetzt durch `https://fcrw.cc/imprint` und internes `/datenschutz/`, jetzt auch auf Entsperr- und Dateiansicht |

## Rechtliches Gerüst der Erklärung

- Verantwortlicher: wie Impressum (`https://fcrw.cc/imprint` → 302 → `https://focusonruwen.com/impressum/`) und zentrale Erklärung; beide stimmen überein (Ruwen Hohnholz, c/o Autorenglück #45094, Albert-Einstein-Str. 47, 02977 Hoyerswerda, info@focusonruwen.com).
- Betroffenenrechte Art. 15–18, 20; Widerspruch Art. 21 hervorgehoben (Callout); Beschwerde Art. 77 ohne konkrete Behörde.
- Keine automatisierte Entscheidung (Art. 22); keine Bereitstellungspflicht (IP technisch nötig).
- Keine Einwilligungen → kein Cookie-Banner, kein Widerruf nach Art. 7 Abs. 3 nötig.
- Lokale Verarbeitung (#4–#12): erfolgt allein unter Kontrolle der nutzenden Person auf ihrem Gerät; der Betreiber erhält nichts. Die Erklärung beschreibt sie aus Transparenzgründen, ohne eine eigene Rechtsgrundlage zu behaupten.

## Offene Punkte

1. **Vercel-Tarif / AVV:** Das Vercel-DPA gilt laut Vercel nur für Pro- und Enterprise-Kunden (https://vercel.com/legal/dpa, Stand 31.03.2026). Läuft das Projekt im Hobby-Tarif, besteht kein Auftragsverarbeitungsvertrag nach Art. 28 DSGVO. Tarif im Dashboard (Team „ruwens-projekte“) prüfen. Die Erklärung formuliert deshalb neutral („verarbeitet Vercel“), nicht „im Auftrag“.
2. **Log-Aufbewahrung bei Vercel intern:** nicht konkret veröffentlicht; Erklärung verweist auf Vercels Angaben.
3. **Aufsichtsbehörde:** zentrale Erklärung nennt die LfD Niedersachsen; Entscheidung zwischen LfD Niedersachsen und LDI NRW steht aus → hier nur Art. 77 allgemein.
4. **Cloudflare bei fcrw.cc:** Ob die Weiterleitung als Cloudflare-Redirect-Regel oder über einen Origin hinter Cloudflare läuft, ist von außen nicht unterscheidbar; in beiden Fällen verarbeitet Cloudflare die Verbindungsdaten beim Klick.
5. **Browser-eigener Speicher (#11):** Ob und wie lange Chromium den „zuletzt gewählten Ort“ und erteilte Erlaubnisse persistiert, ist Browser-Verhalten und kann sich ändern; die Erklärung formuliert „unter Umständen“.
6. **Zentrale Erklärung:** sollte für WebVault auf `https://vault.deploy.by0.link/datenschutz/` verweisen und die oben genannten Abweichungen (Serverfunktionen, „keine Verbindungen“) angleichen.
7. **Preview-Deployments:** Vercel-Previews können die Vercel-Toolbar einblenden (nur für eingeloggte Teammitglieder); die CSP blockt deren Skripte. Für Produktion ohne Bedeutung.
8. **Swipe-Modus (nur Info):** Ein früher entwickelter Swipe-Modus (lokaler Branch `swipe-mode`, Commit `1696b96`, nicht gepusht) würde IndexedDB und – in Chromium – ein in IndexedDB gespeichertes Ordner-Handle sowie eine verschlüsselte Merkdatei außerhalb des Tresors nutzen. Wird er gemergt, müssen Abschn. 05 der Erklärung und diese Datei angepasst werden (§ 25 Abs. 2 Nr. 2 TDDDG, Speicherdauer, Löschweg).

## Pflege

Bei jeder Änderung, die Daten oder den Browser berührt (neue externe Ressource, Analytics, Storage, Header, Hosting/Domain, Weiterleitungen, Formulare), diese Datei **und** `datenschutz/index.html` (inkl. Stand-Datum) prüfen und anpassen. Siehe `CLAUDE.md`.
