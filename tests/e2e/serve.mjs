// Statischer Server für dist/ mit den Headern aus vercel.json
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.join(repo, 'dist');
const cfg = JSON.parse(readFileSync(path.join(repo, 'vercel.json'), 'utf8'));
const headers = Object.fromEntries(cfg.headers[0].headers.map((h) => [h.key, h.value]));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
export function serve(port) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) p = path.join(root, 'index.html');
      res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(p)] ?? 'application/octet-stream' });
      res.end(readFileSync(p));
    }).listen(port, () => resolve(s));
  });
}
