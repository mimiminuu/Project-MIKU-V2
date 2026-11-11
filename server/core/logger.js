// 로거 모듈: 클라이언트 IP 식별, HTTP/WebSocket 요청 추적, 파일 저장 및 실시간 조회 지원
import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from '../config.js';

// ANSI 색상 코드 (터미널 가독성 향상)
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * IP 주소 문자열 정규화 (IPv6 매핑, 루프백 등 정리)
 */
export function normalizeIp(ip) {
  if (!ip) return 'unknown';
  const raw = String(ip).trim();

  // CRLF나 제어 문자 포함 시 로그 주입 공격으로 간주하고 차단
  if (/[\r\n\x00-\x1f\x7f-\x9f]/.test(raw)) {
    return 'unknown';
  }

  let clean = raw;

  // IPv4 포트가 붙어 있는 경우 (예: 192.168.0.1:54321) 포트 제거
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(clean)) {
    clean = clean.split(':')[0];
  }

  // IPv6 mapped IPv4 변환 (::ffff:192.168.0.1 -> 192.168.0.1)
  if (clean.startsWith('::ffff:')) {
    clean = clean.slice(7);
  }

  // IPv6 루프백 및 로컬호스트 변환
  if (clean === '::1' || clean === 'localhost') {
    return '127.0.0.1';
  }

  // 표준 IPv4 또는 IPv6 형식 검증
  const isIpv4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(clean);
  const isIpv6 = /^[a-fA-F0-9:]+$/.test(clean) && clean.includes(':');

  if (!isIpv4 && !isIpv6) {
    return 'unknown';
  }

  return clean;
}

/**
 * Express req 또는 WebSocket handshake req에서 실제 클라이언트 IP 추출
 */
export function getClientIp(req) {
  if (!req) return 'unknown';

  // 1. 프록시 / 로드밸런서 헤더 우선 탐색
  const xForwardedFor = req.headers?.['x-forwarded-for'];
  if (xForwardedFor) {
    const raw = typeof xForwardedFor === 'string' ? xForwardedFor : xForwardedFor[0];
    const client = raw.split(',')[0].trim();
    if (client) return normalizeIp(client);
  }

  // 2. Cloudflare 전용 헤더
  const cfIp = req.headers?.['cf-connecting-ip'];
  if (cfIp) return normalizeIp(cfIp);

  // 3. Nginx / 리버스 프록시 헤더
  const realIp = req.headers?.['x-real-ip'];
  if (realIp) return normalizeIp(realIp);

  // 4. Express req.ip (trust proxy 설정 시 활성화)
  if (req.ip) return normalizeIp(req.ip);

  // 5. 소켓 원격 주소
  const remote = req.socket?.remoteAddress || req.connection?.remoteAddress;
  if (remote) return normalizeIp(remote);

  return 'unknown';
}

/**
 * 타임스탬프 포맷터: YYYY-MM-DD HH:mm:ss.SSS
 */
function formatTimestamp(d = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);
  return `${y}-${m}-${day} ${h}:${min}:${s}.${ms}`;
}

/**
 * 오늘 날짜 문자열: YYYY-MM-DD
 */
function getTodayString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 서버 종료 시각 기반 파일명 생성: YYYY-MM-DD_HH-mm-ss.log (Windows 파일명 허용 문자)
 */
export function formatShutdownFileName(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}-${m}-${day}_${h}-${min}-${s}.log`;
}

class Logger {
  constructor(options = {}) {
    this.logsDir = options.logsDir || LOGS_DIR;
    this.maxMemoryLogs = options.maxMemoryLogs || 1000;
    this.memoryLogs = [];
    this.sessionLogLines = []; // 이번 서버 실행 동안 누적된 전체 로그
    this.hasSavedShutdownLog = false;
    this.lastSavedShutdownFile = null;
    this.logSeq = 0;
    this.writeQueue = [];
    this.isFlushing = false;

    // 디렉터리 준비
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
    } catch {}

    // 주기적 파일 쓰기 플러시 (150ms 배치)
    this.flushTimer = setInterval(() => this._flushQueue(), 150);
    if (this.flushTimer.unref) this.flushTimer.unref();

    // 프로세스 종료 시 자동 저장 핸들러 바인딩
    this._bindExitHandlers();
  }

  /**
   * 서버 종료(Ctrl+C, SIGINT, SIGTERM, exit 등) 감지 및 핸들러 등록
   */
  _bindExitHandlers() {
    const handleSignal = (signal) => {
      this.saveShutdownLog(signal);
    };

    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));
    if (process.platform === 'win32') {
      process.once('SIGBREAK', () => handleSignal('SIGBREAK'));
    }
    process.once('exit', () => this.saveShutdownLog('exit'));
    process.on('beforeExit', () => this._flushQueueSync());
  }

  /**
   * 서버 종료 시점의 시간 파일명(시간.log)으로 이번 세션의 전체 로그 저장
   */
  saveShutdownLog(reason = 'shutdown') {
    if (this.hasSavedShutdownLog) return this.lastSavedShutdownFile;
    this.hasSavedShutdownLog = true;

    try {
      const now = new Date();
      const timestamp = formatTimestamp(now);
      const closeMsg = `[${timestamp}] [INFO ] [-] 서버 종료 (${reason}) - 세션 로그 파일 저장 완료`;
      this.sessionLogLines.push(closeMsg);

      const fileName = formatShutdownFileName(now);
      const filePath = path.join(this.logsDir, fileName);

      fs.mkdirSync(this.logsDir, { recursive: true });
      fs.writeFileSync(filePath, this.sessionLogLines.join('\n') + '\n', 'utf8');

      console.log(`\n${ANSI.green}[서버 종료]${ANSI.reset} 세션 로그가 저장되었습니다: ${ANSI.cyan}${filePath}${ANSI.reset} (총 ${this.sessionLogLines.length}건)`);
      this.lastSavedShutdownFile = filePath;
      return filePath;
    } catch (err) {
      console.error('[logger] 서버 종료 로그 저장 실패:', err.message);
      return null;
    }
  }

  /**
   * 내부 코어 로깅 메서드
   */
  log(level, message, { ip = '-', meta = {}, consoleMuted = false, isAccess = false } = {}) {
    const now = new Date();
    const timestamp = formatTimestamp(now);
    const dateStr = getTodayString(now);
    const cleanIp = normalizeIp(ip);

    // 1. 메모리 링 버퍼에 추가 (최신 로그 쿼리용)
    const logItem = {
      id: ++this.logSeq,
      timestamp,
      timeMs: now.getTime(),
      level: level.toUpperCase(),
      ip: cleanIp,
      message,
      meta,
    };

    this.memoryLogs.push(logItem);
    if (this.memoryLogs.length > this.maxMemoryLogs) {
      this.memoryLogs.shift();
    }

    // 2. 터미널 콘솔 출력 (consoleMuted 가 false일 때만 터미널에 표시)
    if (!consoleMuted) {
      this._printConsole(logItem);
    }

    // 3. 이번 세션 전체 로그에 누적 및 비동기 쓰기 큐에 적재 (CRLF 로그 분리 주입 방어)
    const sanitizedMsg = String(message ?? '').replace(/[\r\n]+/g, ' ').trim();
    const fileLine = `[${timestamp}] [${logItem.level.padEnd(5)}] [${cleanIp}] ${sanitizedMsg}`;
    const fullLine = fileLine + (Object.keys(meta).length > 0 && !isAccess ? ` | ${JSON.stringify(meta)}` : '');
    this.sessionLogLines.push(fullLine);

    this.writeQueue.push({
      dateStr,
      level: logItem.level,
      isAccess,
      line: fullLine + '\n',
    });
  }

  // 레벨별 헬퍼 메서드
  http(message, meta = {}) {
    this.log('HTTP', message, {
      ip: meta.ip || '-',
      meta,
      consoleMuted: meta.consoleMuted ?? false,
      isAccess: true,
    });
  }

  ws(message, meta = {}) {
    this.log('WS', message, {
      ip: meta.ip || '-',
      meta,
      consoleMuted: false,
      isAccess: true,
    });
  }

  info(message, meta = {}) {
    this.log('INFO', message, { ip: meta.ip || '-', meta });
  }

  warn(message, meta = {}) {
    this.log('WARN', message, { ip: meta.ip || '-', meta });
  }

  error(message, errorOrMeta = {}) {
    let meta = errorOrMeta;
    let text = message;
    if (errorOrMeta instanceof Error) {
      meta = { stack: errorOrMeta.stack, name: errorOrMeta.name };
      text = `${message} - ${errorOrMeta.message}`;
    }
    this.log('ERROR', text, { ip: meta?.ip || '-', meta });
  }

  debug(message, meta = {}) {
    if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
      this.log('DEBUG', message, { ip: meta.ip || '-', meta });
    }
  }

  /**
   * 터미널 색상 포맷팅 출력
   */
  _printConsole({ level, timestamp, ip, message }) {
    let color = ANSI.reset;
    let labelColor = ANSI.bright;

    switch (level) {
      case 'HTTP':
        color = ANSI.cyan;
        labelColor = ANSI.cyan + ANSI.bold;
        break;
      case 'WS':
        color = ANSI.magenta;
        labelColor = ANSI.magenta + ANSI.bold;
        break;
      case 'INFO':
        color = ANSI.green;
        labelColor = ANSI.green;
        break;
      case 'WARN':
        color = ANSI.yellow;
        labelColor = ANSI.yellow + ANSI.bold;
        break;
      case 'ERROR':
        color = ANSI.red;
        labelColor = ANSI.red + ANSI.bold;
        break;
      case 'DEBUG':
        color = ANSI.gray;
        labelColor = ANSI.gray;
        break;
    }

    const ipFormatted = ip && ip !== '-' ? `${ANSI.cyan}[${ip}]${ANSI.reset}` : `${ANSI.gray}[-]${ANSI.reset}`;
    const line = `${ANSI.gray}[${timestamp}]${ANSI.reset} ${labelColor}[${level.padEnd(5)}]${ANSI.reset} ${ipFormatted} ${color}${message}${ANSI.reset}`;

    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  /**
   * 파일 쓰기 큐 비동기 플러시
   */
  async _flushQueue() {
    if (this.isFlushing || this.writeQueue.length === 0) return;
    this.isFlushing = true;

    const batch = this.writeQueue.splice(0, 100);
    const groups = {};

    for (const item of batch) {
      const appFile = path.join(this.logsDir, `app-${item.dateStr}.log`);
      groups[appFile] = (groups[appFile] || '') + item.line;

      if (item.isAccess) {
        const accessFile = path.join(this.logsDir, `access-${item.dateStr}.log`);
        groups[accessFile] = (groups[accessFile] || '') + item.line;
      }

      if (item.level === 'WARN' || item.level === 'ERROR') {
        const errFile = path.join(this.logsDir, `error-${item.dateStr}.log`);
        groups[errFile] = (groups[errFile] || '') + item.line;
      }
    }

    try {
      await Promise.all(
        Object.entries(groups).map(([filePath, content]) =>
          fs.promises.appendFile(filePath, content, 'utf8')
        )
      );
    } catch (err) {
      // 로깅 실패로 메인 프로세스가 중단되지 않도록 방어
    } finally {
      this.isFlushing = false;
      if (this.writeQueue.length > 0) {
        setImmediate(() => this._flushQueue());
      }
    }
  }

  /**
   * 프로세스 종료 시 동기식 플러시
   */
  _flushQueueSync() {
    if (this.writeQueue.length === 0) return;
    const batch = this.writeQueue.splice(0, this.writeQueue.length);
    const groups = {};

    for (const item of batch) {
      const appFile = path.join(this.logsDir, `app-${item.dateStr}.log`);
      groups[appFile] = (groups[appFile] || '') + item.line;
      if (item.isAccess) {
        const accessFile = path.join(this.logsDir, `access-${item.dateStr}.log`);
        groups[accessFile] = (groups[accessFile] || '') + item.line;
      }
      if (item.level === 'WARN' || item.level === 'ERROR') {
        const errFile = path.join(this.logsDir, `error-${item.dateStr}.log`);
        groups[errFile] = (groups[errFile] || '') + item.line;
      }
    }

    for (const [filePath, content] of Object.entries(groups)) {
      try {
        fs.appendFileSync(filePath, content, 'utf8');
      } catch {}
    }
  }

  /**
   * 최근 메모리 로그 필터링 및 조회
   */
  getRecentLogs({ limit = 100, level, ip, search } = {}) {
    let result = this.memoryLogs;

    if (level && level !== 'ALL') {
      const targetLevel = level.toUpperCase();
      result = result.filter((item) => item.level === targetLevel);
    }

    if (ip) {
      const targetIp = normalizeIp(ip).toLowerCase();
      result = result.filter((item) => item.ip.toLowerCase().includes(targetIp));
    }

    if (search) {
      const q = String(search).toLowerCase();
      result = result.filter(
        (item) =>
          item.message.toLowerCase().includes(q) ||
          JSON.stringify(item.meta || {}).toLowerCase().includes(q)
      );
    }

    return result.slice(-Math.min(limit, this.maxMemoryLogs)).reverse();
  }

  /**
   * 지정한 날짜/타입의 로그 파일 경로 반환
   */
  getLogFilePath(type = 'app', dateStr = getTodayString()) {
    const validTypes = ['app', 'access', 'error'];
    const safeType = validTypes.includes(type) ? type : 'app';
    const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : getTodayString();
    return path.join(this.logsDir, `${safeType}-${safeDate}.log`);
  }

  /**
   * 메모리 로그 비우기
   */
  clearMemory() {
    this.memoryLogs = [];
    return true;
  }

  /**
   * Express HTTP 요청 로깅 미들웨어 생성
   */
  middleware({ logStatic = false } = {}) {
    return (req, res, next) => {
      const startTime = Date.now();
      const ip = getClientIp(req);
      req.clientIp = ip;

      res.on('finish', () => {
        const duration = Date.now() - startTime;
        const status = res.statusCode;
        const method = req.method;
        const url = req.originalUrl || req.url;
        const isApi = url.startsWith('/api') || url.startsWith('/ws');
        const isPage = url === '/' || url.startsWith('/?') || url.endsWith('.html');
        const contentLength = res.get('content-length') || '-';
        const userAgent = req.get('user-agent') || '-';

        const meta = {
          ip,
          method,
          url,
          status,
          durationMs: duration,
          contentLength,
          userAgent,
          type: isApi ? 'api' : (isPage ? 'page' : 'static'),
        };

        const logMsg = `${method} ${url} ${status} - ${duration}ms (${contentLength} bytes)`;

        // HTML 페이지나 API 호출은 항상 콘솔에 선명하게 출력하고,
        // 번들 자산(.png, .css, .js 등)은 logStatic 옵션이 켜져 있을 때만 콘솔에 출력 (터미널 시인성 보호)
        const consoleMuted = !isApi && !isPage && !logStatic;

        this.http(logMsg, {
          ip,
          ...meta,
          consoleMuted,
        });
      });

      next();
    };
  }
}

// 싱글톤 인스턴스 export
export const logger = new Logger();
