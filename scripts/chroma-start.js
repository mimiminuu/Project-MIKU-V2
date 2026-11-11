// Chroma 벡터 DB 서버를 로컬에서 실행합니다.
// 사전 요구: Python이 설치되어 있고 `pip install chromadb` 완료 상태
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'server', 'store', 'chroma');

function findChroma() {
  // 1) PATH에서 탐색
  try {
    if (process.platform === 'win32') {
      execFileSync('where', ['chroma'], { stdio: 'ignore' });
    } else {
      execFileSync('which', ['chroma'], { stdio: 'ignore' });
    }
    return 'chroma';
  } catch {}

  // 2) Python Scripts 디렉토리에서 탐색
  try {
    const pyDir = execFileSync('python', ['-c', 'import sys,os;print(os.path.dirname(sys.executable))'], { encoding: 'utf8' }).trim();
    const ext = process.platform === 'win32' ? '.exe' : '';
    const candidate = path.join(pyDir, 'Scripts', `chroma${ext}`);
    if (existsSync(candidate)) return candidate;
  } catch {}

  return null;
}

const chromaCmd = findChroma();
if (!chromaCmd) {
  console.error('[chroma-start] chroma를 찾을 수 없습니다. pip install chromadb 실행 필요');
  process.exit(1);
}

console.log(`[chroma-start] 실행: ${chromaCmd}`);
const child = spawn(chromaCmd, ['run', '--host', '127.0.0.1', '--port', '8000', '--path', DATA_DIR], {
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
