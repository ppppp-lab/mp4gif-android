import { minify } from 'terser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 网页端加固：从 www-backup 可读源码生成混淆压缩版到 www
// 以后改前端逻辑先改 www-backup 里的源码，再运行 npm run build:www
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'www-backup');
const outDir = path.join(root, 'www');
const files = ['renderer.js', 'meme.js', 'android-bridge.js', 'estimate.js', 'commands.js'];

for (const file of files) {
  const src = fs.readFileSync(path.join(srcDir, file), 'utf8');
  const result = await minify(src, {
    compress: true,
    mangle: true,
    format: { comments: false },
  });
  fs.writeFileSync(path.join(outDir, file), result.code + '\n', 'utf8');
  console.log('minified', file, result.code.length, 'bytes');
}

// 非 JS 文件直接同步（HTML/CSS 等）
for (const file of fs.readdirSync(srcDir)) {
  if (files.includes(file)) continue;
  fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
  console.log('copied', file);
}
