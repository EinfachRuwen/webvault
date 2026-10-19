# WebVault

**Cryptomator-Tresore im Browser** – öffnen, durchsuchen, ansehen, herunterladen und neue Dateien verschlüsselt hinzufügen.
Komplett clientseitig: kein Backend, kein Upload, kein Konto. Als statische Seite auf Vercel hostbar.

## Funktionen

- **Entsperren** von Cryptomator-Tresoren (Format 7 und 8; `SIV_GCM` und `SIV_CTRMAC`) per Passwort
- **Navigieren** durch Ordner (Breadcrumbs, Sortierung nach Name/Größe/Datum)
- **Suchen** im aktuellen Ordner oder – per Index – im gesamten Tresor (nur Dateinamen)
- **Vorschau** direkt im Browser: Bilder, Video, Audio, PDF, Text/Code (←/→ blättert durch den Ordner)
- **Herunterladen** entschlüsselt: einzelne Dateien gestreamt, Ordner/Mehrfachauswahl als ZIP
- **Hochladen** per Dialog oder Drag & Drop (auch ganze Ordner); Dateien werden vor dem Schreiben verschlüsselt
- **Neuer Ordner, Umbenennen, Löschen**
- Automatische **Sperre** nach 15 Minuten Inaktivität

## Datenschutz & Sicherheit

- Passwort, Schlüssel und Klartext verlassen den Tab nie. Die ausgelieferte **Content-Security-Policy** (`vercel.json`) enthält
  `connect-src 'none'` – der Browser verweigert der Seite jede Netzwerkverbindung nach dem Laden, selbst bei einem Fehler im Code.
- Abgeleitete Schlüssel liegen als **nicht exportierbare** WebCrypto-Schlüssel im Speicher; Rohschlüssel werden nach dem Entsperren überschrieben.
- Alle Inhalte sind **authentifiziert** (GCM-Tags bzw. HMAC): Manipulierte oder beschädigte Dateien führen zu einem Fehler statt zu falschen Daten.
  Auch die Signatur von `vault.cryptomator` wird geprüft.
- Namen aus dem Tresor werden beim ZIP-Export gegen „Zip-Slip“ gesäubert, scrypt-Parameter aus `masterkey.cryptomator` werden begrenzt.
- Kryptografie: WebCrypto (AES-CTR/CBC/GCM, HMAC, SHA-1/256, AES-KW), `@noble/hashes` (scrypt). AES-SIV (RFC 5297) ist selbst auf WebCrypto aufgebaut
  und gegen die RFC-Testvektoren geprüft.
- Das Projekt wurde **nicht** von Cryptomator-Entwicklern auditiert. Für besonders sensible Daten gilt: Tresor vor der ersten Nutzung sichern.

## Funktionsweise im Browser

Welche Möglichkeiten es gibt, hängt davon ab, ob der Browser in lokale Ordner **schreiben** darf. Das kann nur die File System Access API
(`showDirectoryPicker`), und die gibt es nur in Chromium-Browsern am Computer. In Firefox und Safari existiert sie nicht – das ist eine Browser-Grenze.

| Browser / Gerät | So öffnest du den Tresor | Was geht |
| --- | --- | --- |
| **Chrome, Edge, Opera** (Desktop) | Tresor-Ordner auswählen | Alles: lesen, hochladen, löschen, umbenennen – direkt im Ordner |
| **Brave** (Desktop) | wie Chrome, aber die File System Access API ist dort standardmäßig aus (`brave://flags/#file-system-access-api`); ohne Flag verhält sich Brave wie Firefox | siehe Chrome bzw. Firefox |
| **Firefox, Safari** (Desktop) | Tresor-Ordner auswählen (`webkitdirectory`) oder per Drag & Drop | Lesen, Vorschau, Suche, Download. Hochladen/Neuer Ordner im **Änderungspaket-Modus** (s. u.) |
| **Handy, Tablet** (iOS, Android) | Tresor in der Dateien-App zu einer **ZIP-Datei** komprimieren und diese öffnen | wie Firefox/Safari; Einspielen der Änderungen am Computer ist am sichersten |

### Änderungspaket-Modus

Wenn der Browser nicht in den Ordner schreiben darf, bleibt der Tresor schreibgeschützt. Neue Dateien und Ordner werden **bereits verschlüsselt** gesammelt und lassen sich als
ZIP („Änderungspaket“) herunterladen. Dessen Ordner `d` kopierst du in den Tresor-Ordner und wählst **„Zusammenführen“** – dort liegen dann ausschließlich neue Dateien.

> **Achtung (Mac):** Der Finder bietet „Zusammenführen“ nur bei gehaltener Wahltaste (⌥) an, sonst nur „Ersetzen“ – das würde Tresor-Inhalte löschen. Mach vorher eine Sicherung.

Weil ein ZIP nichts löschen kann, lassen sich in diesem Modus nur in der Sitzung neu angelegte Einträge löschen oder umbenennen, nicht die Originale.
Beim Sperren bleiben gesammelte Änderungen erhalten (es ist nur Chiffrat), beim Schließen des Tabs gehen sie verloren – der Browser warnt davor.

### ZIP-Modus (Handy/Tablet)

Der ZIP-Tresor wird nicht hochgeladen oder entpackt, sondern nur lokal gelesen (nur das Inhaltsverzeichnis, Inhalte erst bei Bedarf). Unterstützt: gespeichert und Deflate, ZIP64 (> 65.535 Dateien),
Oberordner im ZIP, Mac-Metadaten (`__MACOSX`) werden ignoriert.

Der Tresor-Ordner muss lokal vorliegen (z. B. über Dropbox/iCloud/OneDrive/Nextcloud synchronisiert oder von einem USB-Stick).

## Nicht unterstützt (bisher)

Tresor-Erstellung, Formate ≤ 6, Tresore mit externem Schlüsselspeicher (Cryptomator Hub), Symlinks, Verschieben zwischen Ordnern, Löschen/Umbenennen von Originalen im Änderungspaket-Modus,
Direktzugriff auf Cloud-Speicher (WebDAV, Dropbox …), Dateien > 4 GB im ZIP-Export,
Streaming-Wiedergabe sehr großer Videos (Vorschau lädt bis 256 MB komplett in den Speicher; größere Dateien lassen sich herunterladen).

## Entwicklung

```bash
npm install
npm run dev          # lokaler Dev-Server
npm test             # Unit- & Interop-Tests (Vitest)
npm run build        # Typecheck + Produktions-Build nach dist/
npm run e2e          # Browser-Tests (benötigt: npx playwright install chromium; vorher npm run build)
```

### Tests

- `tests/siv.test.ts` – AES-SIV gegen die RFC-5297-Vektoren
- `tests/reference.test.ts` – liest Tresore (beide Cipher), die mit der **offiziellen Java-Bibliothek** (`cryptofs`) erzeugt wurden, und vergleicht jede Datei bitgenau
- `tests/write.test.ts` – Upload/Ordner/Umbenennen/Löschen und erneutes Lesen; mit `WEBVAULT_KEEP=<dir>` entsteht ein Tresor, den die Java-Referenz gegenlesen kann
  (siehe [`tests/reference/README.md`](tests/reference/README.md)). Dieser Gegenlese-Test wurde mit Ergebnis „bitgenau identisch“ durchgeführt –
  auch für einen Tresor, der von der Browser-Oberfläche selbst geschrieben wurde.
- `tests/zipRead.test.ts` – ZIP-Leser inkl. ZIP64, gegen echte Info-ZIP-Archive eines Tresors (Deflate, `-fz`, gespeichert)
- `tests/staged.test.ts` – Änderungspaket-Modus: schreibgeschützter Tresor + Überlagerung → Export → Einspielen → erneut lesen
- `tests/e2e/` – Chromium-Tests gegen den Produktions-Build, ausgeliefert mit den CSP-Headern aus `vercel.json`

## Deployment auf Vercel

1. Repository bei [Vercel](https://vercel.com/new) importieren – Framework „Vite“ wird erkannt (`vercel.json` enthält Build-Befehl, Ausgabeordner und Sicherheits-Header).
2. Deployen. Es sind keine Umgebungsvariablen und keine Serverfunktionen nötig.

Alternativ per CLI: `npx vercel --prod`.

> Wichtig: Die Header aus `vercel.json` (insbesondere die CSP) sind Teil des Sicherheitskonzepts. Bei einem anderen Hoster müssen sie gleichwertig gesetzt werden.

## Aufbau

```
src/crypto/    Cryptomator-Kryptografie (SIV, Masterkey, Namen, Dateiinhalt) – keine UI-Abhängigkeit
src/storage/   Ordnerzugriff: File System Access API (lesen/schreiben), FileList und ZIP (nur lesen), StagedStorage (Überlagerung für Änderungspakete)
src/vault/     Vault: entsperren, auflisten, lesen, hochladen, anlegen, umbenennen, löschen, indexieren
src/ui/        React-Oberfläche
tests/         Unit-, Interop- und Browser-Tests; fixtures/ = von der Referenzimplementierung erzeugte Tresore
```
