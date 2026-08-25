import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const workspaceRoot = path.resolve(projectRoot, '..', '..');
const wwwRoot = path.join(projectRoot, 'www');
const outDir = path.join(workspaceRoot, '06_Output', 'exports', '华为上架资料', 'screenshots');
const PORT = 8772;

fs.mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const filePath = path.normalize(path.join(wwwRoot, decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)));
  if (!filePath.startsWith(path.normalize(wwwRoot)) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--disable-gpu', '--no-sandbox'],
});
const page = await browser.newPage();
// 真实手机：1080x2340，密度 540 → CSS 逻辑宽 320，DPR 3.375
await page.setViewport({ width: 320, height: 694, deviceScaleFactor: 3.375 });

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.setItem('mp4gif_privacy_consent', '1'));
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: path.join(outDir, '主界面-1080x2340.png') });

await browser.close();
server.close();
console.log('saved 主界面-1080x2340.png');
