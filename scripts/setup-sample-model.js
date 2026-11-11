// 기본 Live2D 모델(Haru) + 대체 모델(Senko)을 로컬로 다운로드합니다.
// - 기본:  Haru  (공식 샘플, 표정 8종 + 모션 다수)  -> client/assets/models/live2d/haru/
// - 대체:  Senko (라이선스 유연 모델)              -> client/assets/models/live2d/senko/
// 출처:
//   Haru   -> https://github.com/suppayami/pixijs-live2d (Live2D Free Material License)
//   Senko  -> https://github.com/Eikanya/Live2d-model  (MIT 라이선스 참고)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'client', 'assets', 'models', 'live2d');

const HARU_BASE = 'https://raw.githubusercontent.com/suppayami/pixijs-live2d/master';
const HARU_FILES = [
  'assets/Haru/Haru.model3.json',
  'assets/Haru/Haru.moc3',
  'assets/Haru/Haru.pose3.json',
  'assets/Haru/Haru.userdata3.json',
  'assets/Haru/Haru.2048/texture_00.png',
  'assets/Haru/Haru.2048/texture_01.png',
  'assets/Haru/expressions/F01.exp3.json',
  'assets/Haru/expressions/F02.exp3.json',
  'assets/Haru/expressions/F03.exp3.json',
  'assets/Haru/expressions/F04.exp3.json',
  'assets/Haru/expressions/F05.exp3.json',
  'assets/Haru/expressions/F06.exp3.json',
  'assets/Haru/expressions/F07.exp3.json',
  'assets/Haru/expressions/F08.exp3.json',
  'assets/Haru/motions/haru_g_idle.motion3.json',
  'assets/Haru/motions/haru_g_m06.motion3.json',
  'assets/Haru/motions/haru_g_m09.motion3.json',
  'assets/Haru/motions/haru_g_m15.motion3.json',
  'assets/Haru/motions/haru_g_m20.motion3.json',
  'assets/Haru/motions/haru_g_m26.motion3.json',
];

const SENKO_BASE = 'https://raw.githubusercontent.com/Eikanya/Live2d-model/master';
const SENKO_FILES = [
  'Live2D/Senko_Normals/senko.model3.json',
  'Live2D/Senko_Normals/senko.physics3.json',
  'Live2D/Senko_Normals/senko_normal.moc3',
  'Live2D/Senko_Normals/senko_normal.4096/texture_00.png',
  'Live2D/Senko_Normals/motions/Idle.motion3.json',
  'Live2D/Senko_Normals/motions/Anim_1.motion3.json',
  'Live2D/Senko_Normals/motions/Singing.motion3.json',
  'Live2D/Senko_Normals/motions/Sleeping.motion3.json',
];

async function download(base, relPath, destDir) {
  const outPath = path.join(destDir, relPath.split('/').slice(2).join('/'));
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    return; // 이미 존재하는 경우 다운로드 생략
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const url = `${base}/${relPath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  console.log(`  ok  ${path.relative(DEST, outPath)} (${(buf.length / 1024).toFixed(1)} KB)`);
}

// 레거시(모델 루트 직배치) 파일 정리 - 하위 폴더 구조로 이동됨.
// 주의: 이 머신에서 node의 fs.rmSync/unlink는 한글 경로에서 네이티브 크래시(0xC0000409)가
// 발생하므로 삭제는 PowerShell에 위임한다.
function safeRemove(p) {
  if (!fs.existsSync(p)) return;
  const ps = `Remove-Item -LiteralPath '${p}' -Recurse -Force`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`레거시 파일 삭제 실패: ${p} (${r.stderr || r.stdout})`);
  }
}
const LEGACY = ['senko.model3.json', 'senko.physics3.json', 'senko_normal.moc3', 'motions', 'senko_normal.4096'];
for (const name of LEGACY) safeRemove(path.join(DEST, name));

console.log('== 기본 모델: Haru ==');
const haruDir = path.join(DEST, 'haru');
for (const f of HARU_FILES) await download(HARU_BASE, f, haruDir);

console.log('== 대체 모델: Senko ==');
const senkoDir = path.join(DEST, 'senko');
for (const f of SENKO_FILES) await download(SENKO_BASE, f, senkoDir);

console.log('완료. 기본: client/assets/models/live2d/haru/Haru.model3.json');
console.log('      대체: client/assets/models/live2d/senko/senko.model3.json');