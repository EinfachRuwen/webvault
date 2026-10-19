// Browser-Test (Chromium) für Browser OHNE File System Access API (Firefox-/Safari-/Handy-Pfad):
// Ordner über <input webkitdirectory> bzw. ZIP-Datei öffnen, Änderungspaket-Modus, Mobil- und Dark-Mode-Ansicht.
//   npm run build && node tests/e2e/fallback.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? path.join(os.tmpdir(), 'webvault-e2e');
mkdirSync(OUT, { recursive: true });
const FIX = path.join(HERE, '../fixtures');
const PW = 'correct horse battery staple';
const server = await serve(4174);
const check = (c, m) => { console.log(c ? '  ✓' : '  ✗ FEHLER:', m); if (!c) process.exitCode = 1; };
const browser = await chromium.launch();

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  await page.addInitScript(() => { delete window.showDirectoryPicker; delete window.showSaveFilePicker; });
  await page.goto('http://localhost:4174/');
  return { ctx, page, problems };
}
const unlock = async (page) => {
  await page.getByLabel('Tresor-Passwort').fill(PW);
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await page.locator('.files tbody tr').first().waitFor();
};
const names = (page) => page.locator('.files tbody .name-text').allTextContents();

console.log('Ordner über <input webkitdirectory> (Firefox/Safari-Desktop) → Änderungspaket-Modus');
{
  const { ctx, page, problems } = await newPage();
  check(await page.getByText('kann nicht direkt in Ordner schreiben').isVisible(), 'Startseite erklärt den fehlenden Schreibzugriff');
  await page.screenshot({ path: `${OUT}/10-fallback-start.png` });
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(path.join(FIX, 'vault-SIV_CTRMAC'));
  await unlock(page);
  check((await names(page)).includes('hello.txt'), 'SIV_CTRMAC-Tresor lässt sich öffnen');
  check(await page.getByText('Änderungspaket-Modus').isVisible(), 'Banner „Änderungspaket-Modus“');
  check(await page.getByRole('button', { name: 'Dateien hochladen' }).isVisible(), 'Hochladen ist möglich');
  check(await page.getByRole('button', { name: 'hello.txt löschen' }).isDisabled(), 'Löschen von Originalen ist deaktiviert');
  check(await page.getByRole('button', { name: 'hello.txt umbenennen' }).isDisabled(), 'Umbenennen von Originalen ist deaktiviert');

  await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name: 'neu.txt', mimeType: 'text/plain', buffer: Buffer.from('Hallo aus dem Browser') });
  await page.locator('.files .name-text', { hasText: 'neu.txt' }).waitFor();
  await page.getByRole('button', { name: 'Neuer Ordner' }).click();
  await page.getByLabel('Name des Ordners').fill('Fotos');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await page.locator('.files .name-text', { hasText: 'Fotos' }).waitFor();
  check(await page.getByRole('button', { name: 'neu.txt löschen' }).isEnabled(), 'Neu hochgeladene Dateien sind löschbar');
  await page.locator('.name-btn', { hasText: 'neu.txt' }).click();
  await page.locator('.preview-body pre').waitFor();
  check((await page.locator('.preview-body pre').textContent()) === 'Hallo aus dem Browser', 'Neue Datei lässt sich (entschlüsselt) ansehen');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /Änderungspaket \(\d+\)/ }).click();
  await page.getByText('Niemals „Ersetzen“ wählen!').waitFor();
  await page.screenshot({ path: `${OUT}/11-export-dialog.png` });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Paket herunterladen' }).click()]);
  check(dl.suggestedFilename() === 'WebVault-Aenderungen.zip', `Paket heißt ${dl.suggestedFilename()}`);
  const pkg = path.join(OUT, 'paket.zip');
  copyFileSync(await dl.path(), pkg);
  const listing = execFileSync('unzip', ['-Z1', pkg]).toString().trim().split('\n');
  check(listing.length === 3 && listing.every((p) => p.startsWith('d/')), `Paket enthält nur Neues unter d/ (${listing.length} Dateien)`);
  check(!listing.some((p) => p.includes('hello')), 'keine Originaldateien im Paket');
  execFileSync('unzip', ['-tq', pkg]);
  // Einspielen wie der Nutzer: ZIP in Kopie des Tresor-Ordners entpacken (Zusammenführen)
  const merged = path.join(mkdtempSync(path.join(os.tmpdir(), 'webvault-merge-')), 'vault-SIV_CTRMAC');
  cpSync(path.join(FIX, 'vault-SIV_CTRMAC'), merged, { recursive: true });
  execFileSync('unzip', ['-oq', pkg, '-d', merged]);
  cpSync(merged, path.join(OUT, 'merged-vault'), { recursive: true });
  await page.screenshot({ path: `${OUT}/12-fallback-browser.png` });
  check(problems.length === 0, `keine Konsolenfehler ${problems.join('; ')}`);

  console.log('  Sperren behält gesammelte Änderungen');
  await page.getByRole('button', { name: 'Sperren' }).click();
  check(await page.getByText(/nicht exportierte Änderungen/).isVisible(), 'Entsperr-Seite weist auf nicht exportierte Änderungen hin');
  await unlock(page);
  check((await names(page)).includes('neu.txt'), 'Nach erneutem Entsperren ist neu.txt noch da');
  await ctx.close();
}

console.log('ZIP-Datei (Handy-Pfad), erzeugt mit Info-ZIP');
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'webvault-e2e-zip-'));
  const zipPath = path.join(tmp, 'Mein Tresor.zip');
  cpSync(path.join(FIX, 'vault-SIV_GCM'), path.join(tmp, 'Mein Tresor'), { recursive: true });
  execFileSync('zip', ['-q', '-r', zipPath, 'Mein Tresor'], { cwd: tmp });
  const { ctx, page, problems } = await newPage({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, colorScheme: 'dark', deviceScaleFactor: 2 });
  const primary = await page.locator('.start-buttons .btn-primary').textContent();
  check(primary.includes('ZIP'), `Auf Touchgeräten ist ZIP der Hauptweg („${primary}“)`);
  await page.screenshot({ path: `${OUT}/13-mobile-start.png` });
  await page.locator('input[type=file][accept*=zip]').setInputFiles(zipPath);
  await page.getByText('Mein Tresor', { exact: true }).waitFor();
  await unlock(page);
  const list = await names(page);
  check(list.includes('docs') && list.includes('hello.txt'), 'ZIP-Tresor lässt sich öffnen und durchsuchen');
  await page.locator('.name-btn', { hasText: 'hello.txt' }).click();
  await page.locator('.preview-body pre').waitFor();
  check((await page.locator('.preview-body pre').textContent()).includes('Hallo Welt ☺'), 'Vorschau aus dem ZIP entschlüsselt');
  await page.keyboard.press('Escape');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'hello.txt herunterladen' }).click()]);
  check(readFileSync(await dl2.path(), 'utf8') === 'Hallo Welt ☺\n', 'Download aus dem ZIP ist bitgleich');
  await page.screenshot({ path: `${OUT}/14-mobile-browser.png` });
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'kein horizontaler Overflow auf 390 px');
  check(problems.length === 0, `keine Konsolenfehler ${problems.join('; ')}`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(`Screenshots und Pakete: ${OUT}`);
