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
const PORT = 8765;

fs.mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

function resolveFile(urlPath) {
  let relative = decodeURIComponent(urlPath);
  if (relative === '/' || relative === '') relative = '/index.html';
  const filePath = path.normalize(path.join(wwwRoot, relative));
  if (!filePath.startsWith(path.normalize(wwwRoot))) return null;
  return filePath;
}

const server = http.createServer((req, res) => {
  const filePath = resolveFile(new URL(req.url, 'http://127.0.0.1').pathname);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const executablePath = fs.existsSync(edgePath) ? edgePath : chromePath;

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--disable-gpu', '--no-sandbox', '--window-size=360,640'],
});

const page = await browser.newPage();
// 手机逻辑分辨率 360x640，3x 缩放出片 = 1080x1920（华为推荐竖屏截图尺寸）
await page.setViewport({ width: 360, height: 640, deviceScaleFactor: 3 });

async function shot(name, delay = 400) {
  await new Promise((r) => setTimeout(r, delay));
  await page.screenshot({ path: path.join(outDir, name) });
  console.log('saved', name);
}

// 1. 首页默认
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle0' });
await shot('01-首页.png');

// 2. MP4转GIF 默认（进入页面即选择视频的空状态）
await page.evaluateOnNewDocument(() => {
  window.api = {
    gifskiCheck: async () => ({ available: true, version: 'Gifski 1.4.4' }),
    benchmark: async () => 1.2,
    onProgress: () => {},
    onLog: () => {},
    onDone: () => {},
    onError: () => {},
  };
});
await page.goto(`http://127.0.0.1:${PORT}/converter.html`, { waitUntil: 'networkidle0' });
await shot('02-MP4转GIF-默认.png');

// 3. 表情包工坊默认（导入素材的空状态）
await page.goto(`http://127.0.0.1:${PORT}/meme.html`, { waitUntil: 'networkidle0' });
await shot('03-表情包工坊-默认.png');

// 4. 隐私政策
await page.goto(`http://127.0.0.1:${PORT}/privacy.html`, { waitUntil: 'networkidle0' });
await shot('04-隐私政策.png');

await browser.close();
server.close();
console.log('done');
