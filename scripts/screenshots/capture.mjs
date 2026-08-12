import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const workspaceRoot = path.resolve(projectRoot, '..', '..');
const wwwRoot = path.join(projectRoot, 'www');
const assetsRoot = path.join(workspaceRoot, '06_Output', 'exports', '华为上架资料', '_raw');
const outDir = path.join(workspaceRoot, '06_Output', 'exports', '华为上架资料', 'screenshots');
const PORT = 8765;

fs.mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.gif': 'image/gif',
};

function resolveFile(urlPath) {
  let root = wwwRoot;
  let relative = decodeURIComponent(urlPath);
  if (relative.startsWith('/assets/')) {
    root = assetsRoot;
    relative = relative.slice('/assets/'.length);
  }
  if (relative === '/' || relative === '') relative = '/index.html';
  const filePath = path.normalize(path.join(root, relative));
  if (!filePath.startsWith(path.normalize(root))) return null;
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
  args: [
    '--disable-gpu',
    '--no-sandbox',
    '--allow-file-access-from-files',
    '--disable-web-security',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=1080,1920`,
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });

async function shot(name, delay = 500) {
  await new Promise((r) => setTimeout(r, delay));
  await page.screenshot({ path: path.join(outDir, name) });
  console.log('saved', name);
}

// 1. 首页
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle0' });
await shot('01-首页.png');

// 2. 隐私政策
await page.goto(`http://127.0.0.1:${PORT}/privacy.html`, { waitUntil: 'networkidle0' });
await shot('02-隐私政策.png');

// 3. MP4 转 GIF（注入浏览器预览用的 API 模拟，不进入应用包）
await page.evaluateOnNewDocument(() => {
  window.api = {
    gifskiCheck: async () => ({ available: true, version: 'Gifski 1.4.4' }),
    benchmark: async () => 1.2,
    openVideoDialog: async () => ['http://127.0.0.1:8765/assets/sample.mp4'],
    probeVideo: async () => ({ width: 640, height: 360, duration: 10, fps: 24, sizeBytes: 788493 }),
    saveGifDialog: async () => '',
    startConversion: async () => 1,
    cancelConversion: async () => true,
    keepScreenOn: async () => {},
    releaseScreenOn: async () => {},
    onProgress: () => {},
    onLog: () => {},
    onDone: () => {},
    onError: () => {},
  };
  const origDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    get() {
      return origDesc.get.call(this);
    },
    set(v) {
      let value = String(v);
      if (value.startsWith('file:///http:')) value = value.slice('file:///'.length);
      origDesc.set.call(this, value);
    },
  });
});
await page.goto(`http://127.0.0.1:${PORT}/converter.html`, { waitUntil: 'networkidle0' });
await page.waitForSelector('#btnSelectFile:not([disabled])', { timeout: 8000 });
await page.click('#btnSelectFile');
await page.waitForFunction(() => {
  const info = document.getElementById('fileInfo');
  return info && info.style.display !== 'none';
}, { timeout: 12000 });
await shot('03-MP4转GIF-导入视频.png', 1200);

// 4. 表情包工坊：导入素材
await page.goto(`http://127.0.0.1:${PORT}/meme.html?gif=http://127.0.0.1:${PORT}/assets/meme-base.jpg`, {
  waitUntil: 'networkidle0',
});
await page.waitForFunction(() => {
  const wrap = document.getElementById('canvasWrap');
  return wrap && !wrap.classList.contains('hidden');
}, { timeout: 12000 });
await shot('04-表情包工坊-导入素材.png', 1200);

// 5. 表情包工坊：文字编辑
await page.evaluate(() => {
  document.querySelector('.meme-sidebar-btn[data-tool="text"]').click();
});
await page.waitForFunction(() => {
  const el = document.getElementById('textFullscreen');
  return el && !el.classList.contains('hidden') && el.style.display !== 'none';
}, { timeout: 8000 });
await page.evaluate(() => {
  const input = document.getElementById('textFsInput');
  input.value = '哈哈哈哈';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const range = document.getElementById('textFsSizeRange');
  range.value = 48;
  range.dispatchEvent(new Event('input', { bubbles: true }));
});
await shot('05-表情包工坊-文字编辑.png', 800);

// 6. 表情包工坊：贴纸效果
await page.evaluate(() => {
  document.querySelector('#textFsDone').click();
});
await new Promise((r) => setTimeout(r, 300));
await page.evaluate(() => {
  document.querySelector('.meme-sidebar-btn[data-tool="sticker"]').click();
});
await page.waitForSelector('.sticker-item', { timeout: 8000 });
await page.evaluate(() => {
  document.querySelector('.sticker-item').click();
});
await shot('06-表情包工坊-贴纸效果.png', 1000);

await browser.close();
server.close();
console.log('done');
