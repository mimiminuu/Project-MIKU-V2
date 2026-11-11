import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from '../config.js';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const BONSAI_MODEL = process.env.OLLAMA_MODEL || 'bonsai-2:27b';
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5분 미사용 시 절전
const SETTINGS_FILE = path.join(STORE_DIR, 'global_settings.json');

function loadPersistedSleepSetting() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (typeof data.bonsaiSleepEnabled === 'boolean') {
        return data.bonsaiSleepEnabled;
      }
    }
  } catch (err) {
    console.warn('[local-llm] 절전 설정 로드 중 경고:', err.message);
  }
  return true; // 기본값
}

function savePersistedSleepSetting(enabled) {
  try {
    let data = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      try {
        data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      } catch {}
    }
    data.bonsaiSleepEnabled = Boolean(enabled);
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[local-llm] 절전 설정 DB 저장 실패:', err.message);
  }
}

export class LocalLlmManager {
  constructor({ baseUrl = OLLAMA_BASE_URL, model = BONSAI_MODEL, onStateChange = null } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.onStateChange = onStateChange; // (state) => void

    this.isLoaded = false;
    this.isLoading = false;
    this.idleTimer = null;
    this.expiresAt = null;
    this.sleepEnabled = loadPersistedSleepSetting(); // DB(설정 파일)에서 영구 저장된 설정 로드
    console.log(`[local-llm] Bonsai 절전 모드 DB 설정 로드: ${this.sleepEnabled ? 'ON (5분 절전)' : 'OFF (상시 유지)'}`);
    this._process = null;
  }

  /**
   * Ollama 프로세스 생존 확인
   */
  async checkProcess() {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Ollama 프로세스 기동 (미기동 시)
   */
  async startOllamaProcess() {
    const isAlive = await this.checkProcess();
    if (isAlive) return true;

    try {
      console.log('[local-llm] Ollama 백그라운드 프로세스 기동 시작...');
      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      this._process = child;

      // 최대 8초간 포트 대기
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await this.checkProcess()) {
          console.log('[local-llm] Ollama 프로세스 응답 확인 완료');
          return true;
        }
      }
      throw new Error('Ollama 프로세스 기동 시간 초과');
    } catch (err) {
      console.error('[local-llm] Ollama 기동 실패:', err.message);
      throw err;
    }
  }

  /**
   * Bonsai 모델 VRAM 로드 (온디맨드 실행)
   */
  async startBonsai() {
    if (this.isLoaded) {
      this.touch();
      return true;
    }
    if (this.isLoading) {
      // 이미 로딩 중이면 대기
      while (this.isLoading) {
        await new Promise((r) => setTimeout(r, 300));
      }
      return this.isLoaded;
    }

    this.isLoading = true;
    this._notifyState();

    try {
      await this.startOllamaProcess();

      const keepAliveParam = this.sleepEnabled ? '5m' : -1;
      const numCtx = parseInt(process.env.OLLAMA_NUM_CTX || '16384', 10);
      console.log(`[local-llm] Bonsai(${this.model}) VRAM 로드 시작 (keep_alive: ${keepAliveParam}, num_ctx: ${numCtx})...`);
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          keep_alive: keepAliveParam,
          options: {
            num_ctx: numCtx,
          },
        }),
        signal: AbortSignal.timeout(30000), // 30초 대기
      });

      if (!res.ok) {
        throw new Error(`모델 로드 실패 (${res.status})`);
      }

      this.isLoaded = true;
      this.touch();
      console.log(`[local-llm] Bonsai(${this.model}) VRAM 로드 완료 – 초록불 점등`);
      return true;
    } catch (err) {
      console.error(`[local-llm] Bonsai 로드 오류:`, err.message);
      this.isLoaded = false;
      throw err;
    } finally {
      this.isLoading = false;
      this._notifyState();
    }
  }

  /**
   * 절전 기능 토글 (true: 5분 미사용 시 절전, false: VRAM 상주 유지)
   */
  setSleepEnabled(enabled) {
    this.sleepEnabled = Boolean(enabled);
    savePersistedSleepSetting(this.sleepEnabled);
    console.log(`[local-llm] Bonsai 절전 기능 설정 변경 및 DB 저장: ${this.sleepEnabled ? 'ON (5분 절전)' : 'OFF (상시 유지)'}`);

    if (!this.sleepEnabled) {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      this.expiresAt = null;
      if (this.isLoaded) {
        // Ollama 백엔드에 keep_alive: -1 전송하여 자체 언로드도 방지
        fetch(`${this.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, keep_alive: -1 }),
        }).catch(() => {});
      }
    } else {
      if (this.isLoaded) {
        fetch(`${this.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, keep_alive: '5m' }),
        }).catch(() => {});
        this.touch();
        return;
      }
    }
    this._notifyState();
  }

  /**
   * 발화 발생 시 5분 타이머 갱신 (절전 모드 활성화 시에만 동작)
   */
  touch() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.sleepEnabled) {
      this.expiresAt = null;
      this._notifyState();
      return;
    }
    this.expiresAt = Date.now() + IDLE_TIMEOUT_MS;

    this.idleTimer = setTimeout(() => {
      void this.unloadBonsai('idle_timeout');
    }, IDLE_TIMEOUT_MS);

    this._notifyState();
  }

  /**
   * Bonsai 모델 VRAM 해제 (절전)
   */
  async unloadBonsai(reason = 'manual') {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.expiresAt = null;

    if (!this.isLoaded) {
      this._notifyState();
      return;
    }

    try {
      console.log(`[local-llm] Bonsai(${this.model}) VRAM 절전 요청 (사유: ${reason})...`);
      // Windows Ollama에서 keep_alive: 0은 llamacpp runner 언로드 데드락(Stopping... 고착)을 유발할 수 있으므로
      // 짧은 keep_alive('1m')로 자연스럽게 VRAM이 회수되도록 안전하게 요청합니다.
      await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          keep_alive: '1m',
        }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});

      this.isLoaded = false;
      console.log(`[local-llm] Bonsai VRAM 절전 모드 전환 완료`);
    } catch (err) {
      console.warn(`[local-llm] VRAM 해제 중 경고:`, err.message);
      this.isLoaded = false;
    } finally {
      this._notifyState({ reason });
    }
  }

  getStatus() {
    return {
      isLoaded: this.isLoaded,
      isLoading: this.isLoading,
      expiresAt: this.expiresAt,
      model: this.model,
      sleepEnabled: this.sleepEnabled,
    };
  }

  _notifyState(extra = {}) {
    if (typeof this.onStateChange === 'function') {
      try {
        this.onStateChange({
          ...this.getStatus(),
          ...extra,
        });
      } catch (err) {
        console.error('[local-llm] 상태 알림 실패:', err);
      }
    }
  }
}

// 싱글톤 인스턴스
export const localLlmManager = new LocalLlmManager();
