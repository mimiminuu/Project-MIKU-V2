// WebSocket 클라이언트 래퍼: JSON/바이너리 메시지 및 자동 재연결.
export class WSClient {
  constructor({ url, onMessage, onOpen, onClose } = {}) {
    this.url = url;
    this.onMessage = onMessage || (() => {});
    this.onOpen = onOpen || (() => {});
    this.onClose = onClose || (() => {});
    this.ws = null;
    this.retryTimer = null;
    this.closed = false;
    this.pending = []; // 연결 중(CONNECTING)에 보낸 JSON 메시지 임시 보관
  }

  connect() {
    this.closed = false;
    this.open();
  }

  // 세션 전환 시: 이전 연결을 버리고 새 URL로 즉시 재연결
  reconnect(url) {
    if (url) this.url = url;
    this.closed = false;
    clearTimeout(this.retryTimer);
    const old = this.ws;
    this.ws = null;
    this.pending = [];
    if (old) old.close();
    this.open();
  }

  open() {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    // 교체된 이전 연결의 이벤트는 무시 (중복 재연결/다른 세션 메시지 유입 방지)
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const queued = this.pending;
      this.pending = [];
      for (const msg of queued) ws.send(msg);
      this.onOpen();
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onClose();
      if (!this.closed) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.open(), 2000);
      }
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      if (typeof e.data === 'string') {
        try {
          this.onMessage(JSON.parse(e.data), false);
        } catch {
          this.onMessage(e.data, false);
        }
      } else {
        this.onMessage(e.data, true);
      }
    };
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // 연결 중이면 잠시 보관 후 전송되므로 보낼 수 있는 상태로 본다.
  canSend() {
    return this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING;
  }

  send(obj) {
    if (!this.ws) return false;
    const payload = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return true;
    }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.pending.push(payload);
      return true;
    }
    return false;
  }

  sendBinary(buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close();
  }
}
