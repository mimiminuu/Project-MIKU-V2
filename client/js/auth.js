// 시연용 프론트엔드 인증 및 계정 관리 모듈
export const AUTH_STORAGE_KEY = 'miku_demo_auth';

// 로컬 전용 모드: 로그인 화면 없이 하나의 고정 사용자로 사용합니다.
// 인터넷에 공개된 서버의 접근 통제를 제공하지 않습니다.
export function getAuthenticatedUser() {
  return { id: 'local-miku', name: '사용자', role: 'local' };
}

export async function loginUser(username, password) {
  const cleanId = (username || '').trim();
  const cleanPass = (password || '').trim();

  if (!cleanId || !cleanPass) {
    return { success: false, message: '아이디와 비밀번호를 모두 입력해 주세요.' };
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cleanId, password: cleanPass }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, message: data.message || '아이디 또는 비밀번호가 일치하지 않습니다.' };
    }

    const sessionData = {
      id: data.user.id,
      name: data.user.name,
      role: data.user.role,
      loggedInAt: Date.now(),
    };
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionData));
    return { success: true, user: sessionData };
  } catch (err) {
    // 오프라인이거나 서버 API 호출 실패 시 어드민 기본값 지원
    if (cleanId === 'admin' && cleanPass === '1212') {
      const fallbackUser = { id: 'admin', name: '관리자', role: 'admin', loggedInAt: Date.now() };
      sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(fallbackUser));
      return { success: true, user: fallbackUser };
    }
    return { success: false, message: '서버 인증 실패: ' + err.message };
  }
}

// 인증은 기존 방식 그대로 두고, 개인 데이터 요청/저장 범위만 명시한다.
export function getAccountScope() {
  const user = getAuthenticatedUser();
  return { account: String(user?.id || 'anonymous'), isDemo: user?.role === 'demo' };
}

export function scopedUrl(path, { scope = getAccountScope(), sessionId } = {}) {
  const url = new URL(path, window.location.href);
  url.searchParams.set('account', scope.account);
  if (scope.isDemo) url.searchParams.set('demo', '1');
  else url.searchParams.delete('demo');
  if (sessionId !== undefined) url.searchParams.set('sessionId', sessionId);
  return url.href;
}

export function sessionWsUrl(sessionId, scope = getAccountScope()) {
  const url = new URL(scopedUrl('/ws', { scope, sessionId }));
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('tts', 'supertonic');
  return url.href;
}

export async function apiFetch(path, init = {}, options = {}) {
  // scope/URL은 await 전에 고정한다. 응답 도착 때 로그인 계정으로 다시 계산하지 않는다.
  const scope = options.scope || getAccountScope();
  const url = scopedUrl(path, { ...options, scope });
  const res = await fetch(url, init);
  if (res.status === 410 && init.method?.toUpperCase() !== 'DELETE') {
    const parsed = new URL(url);
    const sessionId = options.sessionId || parsed.searchParams.get('sessionId');
    window.dispatchEvent(new CustomEvent('miku:session-deleted', { detail: { scope, sessionId } }));
    const error = new Error('삭제된 세션입니다. 새 대화를 시작해 주세요.');
    error.status = 410;
    throw error;
  }
  return res;
}

export function createAccountStorage(scope = getAccountScope()) {
  const storage = scope.isDemo ? sessionStorage : localStorage;
  const prefix = `miku:account:${encodeURIComponent(scope.account)}:`;
  const sessionPrefix = (sid) => `session:${encodeURIComponent(sid)}:`;
  const removePrefix = (suffix = '') => {
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix + suffix)) keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
  };
  const view = (suffix = '') => ({
    getItem: (key) => storage.getItem(prefix + suffix + key),
    setItem: (key, value) => storage.setItem(prefix + suffix + key, value),
    removeItem: (key) => storage.removeItem(prefix + suffix + key),
  });
  return {
    ...view(),
    forSession: (sid) => view(sessionPrefix(sid)),
    removeSession: (sid) => removePrefix(sessionPrefix(sid)),
    clearAccount: () => removePrefix(),
  };
}

export function logoutUser() {
  window.dispatchEvent(new Event('miku:logout'));
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  window.location.reload();
}
