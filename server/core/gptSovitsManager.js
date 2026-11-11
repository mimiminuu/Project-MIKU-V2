import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from '../config.js';

const DEFAULT_BASE_URL = process.env.GPTSOVITS_API_URL || 'http://127.0.0.1:9880';
const SHUTDOWN_GRACE_MS = 25000; // 기기/세션 연결 해제 후 25초 유예 후 종료

export class GptSovitsManager {
  constructor({ baseUrl = DEFAULT_BASE_URL } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.port = 9880;
    try {
      const u = new URL(this.baseUrl);
      this.port = Number(u.port) || 9880;
    } catch {}

    this.isLoaded = false;
    this.isLoading = false;
    this.activeHolders = new Set(); // gptsovits를 사용하는 활성 connection ID 목록
    this.shutdownTimer = null;
    this.process = null;
    this.startPromise = null;
    this.onStateChange = null; // (state) => void
  }

  _notify() {
    try {
      this.onStateChange?.({
        isLoaded: this.isLoaded,
        isLoading: this.isLoading,
        holderCount: this.activeHolders.size,
      });
    } catch (err) {
      console.warn('[gpt-sovits] 상태 알림 전송 실패:', err.message);
    }
  }

  /**
   * GPT-SoVITS API 서버 생존 확인
   */
  async checkProcess() {
    try {
      const res = await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(1500) });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  /**
   * GPT-SoVITS 프로세스 기동 (api_v2.py)
   */
  async startServer() {
    if (this.isLoaded) return true;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      // 1. 이미 포트가 열려있는지 확인 (재기동 방지)
      const alreadyRunning = await this.checkProcess();
      if (alreadyRunning) {
        this.isLoaded = true;
        this.isLoading = false;
        console.log(`[gpt-sovits] GPT-SoVITS 서버(${this.baseUrl}) 이미 실행 중 확인 완료`);
        this._notify();
        return true;
      }

      const toolsDir = path.resolve(ROOT, 'tools', 'gpt_sovits');
      const apiScript = path.join(toolsDir, 'api_v2.py');
      const configFile = 'GPT_SoVITS/configs/tts_infer.yaml';

      if (!fs.existsSync(apiScript)) {
        console.warn(`[gpt-sovits] api_v2.py를 찾을 수 없습니다: ${apiScript}`);
        this.isLoading = false;
        this._notify();
        return false;
      }

      this.isLoading = true;
      this._notify();
      console.log(`[gpt-sovits] GPT-SoVITS API 서버 백그라운드 기동 시작... (Port: ${this.port})`);

      const pyCmd = process.env.PYTHON_BIN || 'py';
      const pyArgs = pyCmd === 'py'
        ? ['-3.11', 'api_v2.py', '-a', '127.0.0.1', '-p', String(this.port), '-c', configFile]
        : ['api_v2.py', '-a', '127.0.0.1', '-p', String(this.port), '-c', configFile];

      const env = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
        CUDA_MODULE_LOADING: 'LAZY',
      };

      try {
        const child = spawn(pyCmd, pyArgs, {
          cwd: toolsDir,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (d) => {
          const s = d.toString();
          if (s.includes('Uvicorn running') || s.includes('Application startup complete') || s.includes('Warmup') || s.includes('Ready')) {
            console.log('[gpt-sovits-proc]', s.trim());
          }
        });

        child.stderr.on('data', (d) => {
          const s = d.toString();
          if (s.includes('Error') || s.includes('Traceback') || s.includes('Exception')) {
            console.error('[gpt-sovits-proc-err]', s.trim());
          }
        });

        child.on('exit', (code, sig) => {
          console.log(`[gpt-sovits] 프로세스 종료됨 (코드: ${code}, 시그널: ${sig})`);
          this.isLoaded = false;
          this.isLoading = false;
          this.process = null;
          this._notify();
        });

        this.process = child;

        // 최대 45초 동안 기동 완료 폴링 (가중치 로딩 시간 고려)
        const maxWaitMs = 45000;
        const intervalMs = 700;
        const start = Date.now();

        while (Date.now() - start < maxWaitMs) {
          await new Promise((r) => setTimeout(r, intervalMs));
          if (await this.checkProcess()) {
            this.isLoaded = true;
            this.isLoading = false;
            console.log(`[gpt-sovits] GPT-SoVITS API 서버 준비 완료: ${this.baseUrl}`);
            this._notify();
            return true;
          }
        }

        throw new Error('GPT-SoVITS 기동 타임아웃 (45초 초과)');
      } catch (err) {
        console.error('[gpt-sovits] 기동 실패:', err.message);
        this.isLoaded = false;
        this.isLoading = false;
        this._notify();
        return false;
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  /**
   * GPT-SoVITS 프로세스 종료 (VRAM 완전 반환)
   */
  async stopServer() {
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }

    console.log('[gpt-sovits] GPT-SoVITS 서버 종료 진행 (VRAM 반환)...');

    // 1. HTTP Graceful Shutdown 호출
    try {
      await fetch(`${this.baseUrl}/control?command=exit`, { signal: AbortSignal.timeout(2000) });
    } catch {}

    // 2. Node 자식 프로세스 kill
    if (this.process) {
      try {
        this.process.kill();
      } catch {}
      this.process = null;
    }

    // 포트에 연결된 다른 프로세스(서버·클라이언트)를 건드리지 않는다.
    // 이 매니저가 직접 spawn한 자식만 위에서 종료한다.

    this.isLoaded = false;
    this.isLoading = false;
    this._notify();
    console.log('[gpt-sovits] GPT-SoVITS 서버 종료 완료');
  }

  /**
   * 기기/세션이 GPT-SoVITS를 TTS로 선택했을 때 등록 및 서버 상시 가동 유지
   */
  acquire(holderId) {
    if (!holderId) return;
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }
    this.activeHolders.add(holderId);
    console.log(`[gpt-sovits] GPT 모델 선택 기기/세션 등록 [${holderId}] (현재 활성 세션 수: ${this.activeHolders.size})`);
    if (!this.isLoaded && !this.isLoading) {
      void this.startServer();
    } else {
      this._notify();
    }
  }

  /**
   * 기기/세션이 다른 TTS로 전환하거나 연결 종료 시 해제
   */
  release(holderId) {
    if (!holderId) return;
    this.activeHolders.delete(holderId);
    console.log(`[gpt-sovits] GPT 모델 선택 기기/세션 해제 [${holderId}] (남은 세션 수: ${this.activeHolders.size})`);
    this._notify();

    if (this.activeHolders.size === 0) {
      if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
      this.shutdownTimer = setTimeout(() => {
        if (this.activeHolders.size === 0 && (this.isLoaded || this.isLoading)) {
          console.log('[gpt-sovits] GPT 모델을 사용하는 연결된 기기/세션이 없어 서버를 종료합니다 (VRAM 반환).');
          void this.stopServer();
        }
      }, SHUTDOWN_GRACE_MS);
    }
  }
}

export const gptSovitsManager = new GptSovitsManager();
