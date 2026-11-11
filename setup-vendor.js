// 클라이언트에서 사용할 외부 JS 라이브러리를 로컬로 복사/다운로드합니다.
// - pixi.min.js            : PIXI v6 브라우저 번들 (node_modules)
// - cubism4.min.js         : pixi-live2d-display Cubism4 플러그인 (node_modules)
// - live2dcubismcore.min.js: Live2D 공식 Cubism Core (외부 다운로드)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'client', 'vendor');

fs.mkdirSync(VENDOR, { recursive: true });

function copy(name, relPath) {
  const target = path.join(VENDOR, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return;
  const src = path.join(ROOT, 'node_modules', relPath);
  if (!fs.existsSync(src)) throw new Error(`파일 없음: ${src}`);
  const buf = fs.readFileSync(src);
  fs.writeFileSync(target, buf);
  console.log(`  ok  ${name} (${(buf.length / 1024).toFixed(1)} KB)`);
}

async function download(name, url) {
  const target = path.join(VENDOR, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  console.log(`  ok  ${name} (${(buf.length / 1024).toFixed(1)} KB)`);
}

console.log(`클라이언트 vendor 준비: ${VENDOR}`);
copy('pixi.min.js', 'pixi.js/dist/browser/pixi.min.js');
copy('cubism4.min.js', 'pixi-live2d-display/dist/cubism4.min.js');
await download(
  'live2dcubismcore.min.js',
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'
);
console.log('완료.');