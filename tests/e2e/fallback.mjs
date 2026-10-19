// Browser-Test (Chromium) gegen den Produktions-Build, ausgeliefert mit den CSP-Headern aus vercel.json.
//   npm run build && npm run e2e         (benötigt: npx playwright install chromium)
// Ohne File System Access API (Firefox/Safari-Pfad): schreibgeschützter Modus, Mobil- und Dark-Mode-Ansicht.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? path.join(os.tmpdir(), 'webvault-e2e');
mkdirSync(OUT, { recursive: true });
const server = await serve(4174);
const check = (c, m) => { console.log(c ? '  ✓' : '  ✗ FEHLER:', m); if (!c) process.exitCode = 1; };
const browser = await chromium.launch();

console.log('Fallback ohne File System Access API (schreibgeschützt)');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  await page.addInitScript(() => { delete window.showDirectoryPicker; delete window.showSaveFilePicker; });
  await page.goto('http://localhost:4174/');
  check(await page.getByText('nur lesen').isVisible(), 'Hinweis auf fehlenden Schreibzugriff auf der Startseite');
  await page.screenshot({ path: `${OUT}/10-fallback-start.png` });
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(path.join(HERE, '../fixtures/vault-SIV_CTRMAC'));
  await page.getByLabel('Tresor-Passwort').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await page.locator('.files tbody tr').first().waitFor();
  const names = await page.locator('.files tbody .name-text').allTextContents();
  check(names.includes('docs') && names.includes('hello.txt'), 'SIV_CTRMAC-Tresor lässt sich über <input webkitdirectory> öffnen');
  check((await page.getByText('Format 8 · AES-CTR + HMAC').count()) === 1, 'Format-/Cipher-Anzeige');
  check((await page.getByRole('button', { name: 'Dateien hochladen' }).count()) === 0, 'Upload-Buttons sind im Lesemodus ausgeblendet');
  check((await page.getByLabel('hello.txt löschen').count()) === 0, 'Löschen ist im Lesemodus ausgeblendet');
  await page.locator('.name-btn', { hasText: 'hello.txt' }).click();
  await page.locator('.preview-body pre').waitFor();
  check((await page.locator('.preview-body pre').textContent()).includes('Hallo Welt ☺'), 'Vorschau entschlüsselt (CTR+HMAC)');
  await page.keyboard.press('Escape');
  // Download über Blob-Fallback
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'hello.txt herunterladen' }).click()]);
  const dlPath = await dl.path();
  const { readFileSync } = await import('node:fs');
  check(readFileSync(dlPath, 'utf8') === 'Hallo Welt ☺\n', `Download per Blob-Fallback (${dl.suggestedFilename()})`);
  // Ordner als ZIP über Fallback
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'docs herunterladen' }).click()]);
  console.log('  ZIP:', zipDl.suggestedFilename());
  const { copyFileSync } = await import('node:fs');
  copyFileSync(await zipDl.path(), `${OUT}/docs.zip`);
  await page.screenshot({ path: `${OUT}/11-fallback-browser.png` });
  check(problems.length === 0, `keine Konsolenfehler ${problems.join('; ')}`);
  await ctx.close();
}

console.log('Mobil + Dark Mode');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(() => { delete window.showDirectoryPicker; });
  await page.goto('http://localhost:4174/');
  await page.screenshot({ path: `${OUT}/12-mobile-dark-start.png` });
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(path.join(HERE, '../fixtures/vault-SIV_GCM'));
  await page.getByLabel('Tresor-Passwort').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await page.locator('.files tbody tr').first().waitFor();
  await page.screenshot({ path: `${OUT}/13-mobile-dark-browser.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, 'kein horizontaler Seiten-Overflow auf 390 px');
  await ctx.close();
}
await browser.close();
server.close();
