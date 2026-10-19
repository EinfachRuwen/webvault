// Browser-Test (Chromium) gegen den Produktions-Build, ausgeliefert mit den CSP-Headern aus vercel.json.
//   npm run build && npm run e2e         (benötigt: npx playwright install chromium)
// Der Ordner-Dialog wird durch ein echtes FileSystemDirectoryHandle aus OPFS ersetzt, damit der
// komplette Schreib-/Lesepfad der File System Access API real durchlaufen wird.
import { chromium } from 'playwright';
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { serve } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? path.join(os.tmpdir(), 'webvault-e2e');
mkdirSync(OUT, { recursive: true });
const FIX = path.join(HERE, '../fixtures/vault-SIV_GCM');
const PW = 'correct horse battery staple';
const server = await serve(4173);

function walk(dir, base = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name), `${base}${d.name}/`) : [{ path: `${base}${d.name}`, b64: readFileSync(path.join(dir, d.name)).toString('base64') }]);
}
const seed = walk(FIX);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

// Ordner-Dialog durch OPFS-Handle ersetzen; Speichern-Dialog durch OPFS-Datei
await page.addInitScript(() => {
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('vault', { create: true });
  };
  window.showSaveFilePicker = async ({ suggestedName }) => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle('downloads', { create: true });
    return d.getFileHandle(suggestedName, { create: true });
  };
});
await page.goto('http://localhost:4173/');
await page.evaluate(async (files) => {
  const root = await navigator.storage.getDirectory();
  const v = await root.getDirectoryHandle('vault', { create: true });
  for (const f of files) {
    const parts = f.path.split('/');
    let d = v;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
    await w.close();
  }
}, seed);

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const names = async () => (await page.locator('.files tbody .name-text').allTextContents());
const check = (cond, msg) => { console.log(cond ? '  ✓' : '  ✗ FEHLER:', msg); if (!cond) process.exitCode = 1; };

console.log('Start & Entsperren');
await shot('01-start');
await page.getByRole('button', { name: 'Tresor-Ordner auswählen' }).click();
await page.getByLabel('Tresor-Passwort').fill('falsch');
await page.getByRole('button', { name: 'Entsperren' }).click();
await page.getByText('Falsches Passwort.').waitFor();
check(true, 'falsches Passwort wird abgelehnt');
await shot('02-wrong-password');
await page.getByLabel('Tresor-Passwort').fill(PW);
await page.getByRole('button', { name: 'Entsperren' }).click();
await page.locator('.files tbody tr').first().waitFor();
let list = await names();
check(list.includes('docs') && list.includes('hello.txt') && list.includes('Ünïcödé – 日本語.txt'), `Wurzel zeigt entschlüsselte Namen: ${list.slice(0, 6).join(' | ')}`);
check(list.indexOf('docs') < list.indexOf('empty.bin'), 'Ordner stehen vor Dateien');
await shot('03-root');

console.log('Navigation & Vorschau');
await page.locator('.name-btn', { hasText: /^docs$/ }).click();
await page.locator('.crumb', { hasText: 'docs' }).waitFor();
await page.locator('.name-btn', { hasText: 'readme.md' }).click();
await page.locator('.preview-body pre').waitFor();
check((await page.locator('.preview-body pre').textContent()).includes('# Readme'), 'Textvorschau zeigt entschlüsselten Inhalt');
await shot('04-preview-text');
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Tresor', exact: true }).click();

console.log('Suche');
await page.getByLabel('Suche').fill('hello');
await page.waitForFunction(() => document.querySelectorAll('.files tbody tr').length === 1);
check((await names()).join() === 'hello.txt', 'Suche im Ordner filtert');
await page.getByLabel('Suche').fill('file.bin');
await page.getByText('ganzer Tresor').click();
await page.locator('.path-btn', { hasText: 'docs / nested / deep' }).waitFor();
check(true, 'Suche im ganzen Tresor findet Datei in docs/nested/deep');
await shot('05-search-all');
await page.locator('.path-btn').click();
await page.locator('.crumb', { hasText: 'deep' }).waitFor();
check((await names()).includes('file.bin'), 'Klick auf Pfad springt in den Ordner');
await page.getByRole('button', { name: 'Tresor', exact: true }).click();
await page.getByText('ganzer Tresor').click();

console.log('Upload (verschlüsselt in den Ordner schreiben)');
const bigName = 'upload-test.bin';
const big = randomBytes(300_000);
await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name: bigName, mimeType: 'application/octet-stream', buffer: big });
await page.locator('.files .name-text', { hasText: bigName }).waitFor();
check(true, 'hochgeladene Datei erscheint');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name: 'bild.png', mimeType: 'image/png', buffer: png });
await page.locator('.files .name-text', { hasText: 'bild.png' }).waitFor();
await page.locator('.name-btn', { hasText: 'bild.png' }).click();
await page.locator('.preview-body img').waitFor();
const imgOk = await page.locator('.preview-body img').evaluate((i) => i.complete && i.naturalWidth === 10);
check(imgOk, 'Bildvorschau rendert (10×10 PNG)');
await shot('06-preview-image');
await page.keyboard.press('Escape');

console.log('Ordner, Umbenennen, Löschen');
await page.getByRole('button', { name: 'Neuer Ordner' }).click();
await page.getByLabel('Name des Ordners').fill('Meine Ablage');
await page.getByRole('button', { name: 'Anlegen' }).click();
await page.locator('.files .name-text', { hasText: 'Meine Ablage' }).waitFor();
check(true, 'Ordner angelegt');
await page.getByRole('button', { name: 'bild.png umbenennen' }).click();
await page.getByLabel('Neuer Name').fill('umbenannt.png');
await page.getByRole('button', { name: 'Umbenennen', exact: true }).click();
await page.locator('.files .name-text', { hasText: 'umbenannt.png' }).waitFor();
check(!(await names()).includes('bild.png'), 'Umbenennen funktioniert');
await page.getByRole('button', { name: 'empty.bin löschen' }).click();
await shot('07-delete-dialog');
await page.getByRole('button', { name: 'Löschen', exact: true }).click();
await page.waitForFunction(() => ![...document.querySelectorAll('.name-text')].some((e) => e.textContent === 'empty.bin'));
check(true, 'Löschen funktioniert');

console.log('Download (entschlüsselt)');
await page.getByRole('button', { name: 'Erledigte entfernen' }).click().catch(() => {});
await page.getByRole('button', { name: `${bigName} herunterladen` }).click();
await page.locator('.transfer-done, .transfer-error').first().waitFor();
const dl = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const d = await root.getDirectoryHandle('downloads');
  const f = await (await d.getFileHandle('upload-test.bin')).getFile();
  const buf = new Uint8Array(await f.arrayBuffer());
  const h = await crypto.subtle.digest('SHA-256', buf);
  return { size: buf.length, sha: [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('') };
});
check(dl.size === big.length && dl.sha === createHash('sha256').update(big).digest('hex'), `Download ist bitgleich zum Original (${dl.size} B)`);
await page.getByRole('button', { name: 'Erledigte entfernen' }).click();
// Ordner als ZIP
await page.getByRole('button', { name: 'Meine Ablage herunterladen' }).click();
await page.locator('.transfer-done, .transfer-error').first().waitFor();
await shot('08-after-ops');

console.log('Sperren');
await page.getByRole('button', { name: 'Sperren' }).click();
await page.getByRole('heading', { name: 'WebVault' }).waitFor();
check(true, 'Sperren führt zurück zum Startbildschirm');

// Zustand des OPFS-Tresors exportieren → später von der Java-Referenz gegenlesen
const dump = await page.evaluate(async () => {
  const out = [];
  async function rec(dir, base) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') await rec(h, `${base}${name}/`);
      else { const b = new Uint8Array(await (await h.getFile()).arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); out.push({ path: `${base}${name}`, b64: btoa(s) }); }
    }
  }
  const root = await navigator.storage.getDirectory();
  await rec(await root.getDirectoryHandle('vault'), '');
  return out;
});
for (const f of dump) { const p = path.join(OUT, 'vault-after', f.path); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, Buffer.from(f.b64, 'base64')); }
writeFileSync(path.join(OUT, 'expect.json'), JSON.stringify({ sha: createHash('sha256').update(big).digest('hex'), size: big.length }));

console.log(problems.length ? `\nKonsole/CSP-Meldungen:\n${problems.join('\n')}` : '\nKeine Konsolenfehler / CSP-Verstöße');
if (problems.length) process.exitCode = 1;
await browser.close();
server.close();
console.log(`Screenshots und Tresor-Zustand: ${OUT}`);
