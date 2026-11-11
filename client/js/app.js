// TTS disabled: preserve the existing client event interface without audio playback.
class DisabledAudioPlayer {
  constructor() {}
  enqueue() {}
  isPlaying() { return false; }
  play() {}
  stop() {}
  clear() {}
  setVolume() {}
  destroy() {}
  handleMeta() {}
  handleChunk() {}
  handleEnd() {}
}
// 앱 진입점: 아바타/오디오/WS/UI를 연결합니다.
import { Live2DStage } from './avatar/live2dStage.js';
import { WSClient } from './agent/wsClient.js';

import { MicManager } from './audio/micManager.js';
import { onLipVolume, ensureResumed, setMasterVolume } from './audio/audioBus.js';
import { renderMarkdown } from './markdown.js';
import { StudyToolsManager, drawGraphOnCanvas } from './studyTools.js';
import {
  getAuthenticatedUser,
  loginUser,
  logoutUser,
  AUTH_STORAGE_KEY,
  getAccountScope,
  createAccountStorage,
  scopedUrl,
  sessionWsUrl,
  apiFetch,
} from './auth.js';

const $ = (sel) => document.querySelector(sel);

const chatLog = $('#chat-log');
const chatInput = $('#chat-input');
const micBtn = $('#btn-mic');
const sendBtn = $('#btn-send');
const goalCurrent = $('#goal-current');
const goalInput = $('#goal-input');
const goalBtn = $('#btn-goal-edit');
const sessionListEl = $('#session-list');
const boardBody = $('#board-body');
const explanationPanel = $('#explanation-panel');
const explanationContent = $('#explanation-content');
const explanationTitle = $('#explanation-title');
const explanationToolBadge = $('#explanation-tool-badge');

let curBubble = null;
let curRawText = '';
let curThinkText = '';
let curThinkStartTime = null;
let curThinkDurationSec = null;
let curThinkTimerId = null;
let curCards = [];
let curToolAction = null;
let explanationStreaming = false; // 칠판 판서 실시간 표시 중 여부
let autoCollapsedLeftSidebar = false; // 우측 칠판 열림 시 자동 접힘된 왼쪽 사이드바 복원용 플래그
let isAutoScrollLocked = true; // 답변 생성 중 하단 자동스크롤 고정 여부 (위로 스크롤 시 해제, 다시 하단 근처로 오면 고정)
const SCROLL_BOTTOM_THRESHOLD = 50; // px
let curHasAttachments = false;
let isBusy = false;
let isTtsActive = false;
let isServerTtsDone = true;
let turnWatchdogId = null; // 서버가 응답 없이 멈춘 턴을 화면에서 풀어주는 감시 타이머
let sessionEpoch = 0; // 비동기 요청 결과가 다른 세션 화면에 적용되지 않게 하는 세대 번호
let appMic = null;
let resettingForNextVisitor = false;
let bonsaiSleepEnabled = (() => {
  try {
    const saved = localStorage.getItem('miku_bonsai_sleep_mode');
    return saved !== null ? saved === 'true' : true;
  } catch {
    return true;
  }
})();
let pendingTtsMeta = null;
let lastRagQuery = null;
let curGenStartTime = null;

// ---- 프롬프트 첨부파일 관리 (ChatGPT / Gemini 스타일) ----
let activeAttachments = [];

function getFileExtension(filename) {
  const parts = (filename || '').split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

const IMAGE_FILE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

function isImageFile(filename, mimeType = '') {
  if (mimeType && mimeType.startsWith('image/')) return true;
  const ext = getFileExtension(filename).toLowerCase();
  return IMAGE_FILE_EXTS.has(ext);
}

function renderPromptAttachments() {
  const containers = document.querySelectorAll('.prompt-attachments');
  if (!containers.length) return;
  if (!activeAttachments.length) {
    containers.forEach((c) => {
      c.innerHTML = '';
      c.hidden = true;
      c.style.display = 'none';
    });
    return;
  }
  containers.forEach((container) => {
    container.hidden = false;
    container.style.display = 'flex';
    container.innerHTML = '';

    activeAttachments.forEach((att) => {
      const card = document.createElement('div');
      card.className = 'attachment-card' + (att.previewUrl ? ' attachment-card-image' : '');
      card.dataset.id = att.id;

      if (att.previewUrl) {
        card.innerHTML = `
          <div class="attachment-thumb-box">
            <img src="${escapeHtml(att.previewUrl)}" alt="${escapeHtml(att.name)}" class="attachment-thumb-img" />
            <button type="button" class="attachment-remove-btn" title="첨부 취소">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <div class="attachment-card-body">
            <span class="attachment-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
          </div>
        `;
        card.querySelector('.attachment-remove-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          removeAttachment(att.id);
        });
      } else {
        const header = document.createElement('div');
        header.className = 'attachment-card-header';

        const badge = document.createElement('span');
        const ext = (att.ext || 'file').toLowerCase();
        badge.className = `attachment-badge ${ext}`;
        badge.textContent = (att.ext || 'FILE').toUpperCase();
        header.appendChild(badge);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'attachment-remove-btn';
        removeBtn.title = '첨부 취소';
        removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeAttachment(att.id);
        });
        header.appendChild(removeBtn);

        const body = document.createElement('div');
        body.className = 'attachment-card-body';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'attachment-name';
        nameSpan.title = att.name;
        nameSpan.textContent = att.name;
        body.appendChild(nameSpan);

        card.appendChild(header);
        card.appendChild(body);
      }

      if (att.status === 'uploading') {
        const overlay = document.createElement('div');
        overlay.className = 'attachment-loading-overlay';
        overlay.innerHTML = '<span class="attachment-spinner"></span>';
        card.appendChild(overlay);
      } else if (att.status === 'error') {
        const errBadge = document.createElement('div');
        errBadge.className = 'attachment-error-badge';
        errBadge.textContent = '실패';
        card.appendChild(errBadge);
      }

      container.appendChild(card);
    });
  });
}

function removeAttachment(id) {
  const target = activeAttachments.find((a) => a.id === id);
  if (target?.previewUrl) {
    try { URL.revokeObjectURL(target.previewUrl); } catch {}
  }
  activeAttachments = activeAttachments.filter((a) => a.id !== id);
  renderPromptAttachments();
  const fileInput = $('#prompt-file-input');
  if (fileInput) fileInput.value = '';
}

async function uploadAttachment(att) {
  const fd = new FormData();
  fd.append('file', att.file);
  fd.append('sessionId', sessionId);
  try {
    const res = await fetch(scopedUrl('/api/materials', { sessionId, scope: accountScope }), { method: 'POST', body: fd });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`서버 응답 오류 (HTTP ${res.status}: ${res.statusText || '알 수 없는 응답'})`);
    }
    if (!res.ok) throw new Error(data.error || '업로드 실패');
    att.status = 'ready';
    att.url = scopedUrl(`/api/materials/file/${encodeURIComponent(att.name)}`, { sessionId, scope: accountScope });
  } catch (err) {
    att.status = 'error';
    addNotice(`자료 업로드 실패 (${att.name}): ${err.message}`);
  }
  renderPromptAttachments();
}

function handleFilesSelected(files) {
  if (!files || !files.length) return;
  const isHero = Boolean(chatLog.querySelector('.hero-empty-state'));
  if (!isHero) {
    const inputFooter = $('#input-area-footer');
    if (inputFooter) inputFooter.style.display = '';
  }
  for (const file of files) {
    const ext = getFileExtension(file.name);
    const isImg = isImageFile(file.name, file.type);
    let previewUrl = '';
    if (isImg && typeof URL !== 'undefined' && URL.createObjectURL) {
      try {
        previewUrl = URL.createObjectURL(file);
      } catch {}
    }
    const item = {
      id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      file,
      name: file.name,
      size: file.size,
      ext,
      isImage: isImg,
      previewUrl,
      url: previewUrl,
      status: 'uploading',
    };
    activeAttachments.push(item);
    uploadAttachment(item);
  }
  renderPromptAttachments();
}

function renderBubbleAttachments(attachments) {
  if (!attachments || !attachments.length) return '';
  const cards = attachments.map((att) => {
    const ext = (att.ext || getFileExtension(att.name || '') || 'FILE').toLowerCase();
    const isImg = IMAGE_FILE_EXTS.has(ext);
    const imgUrl = att.url || att.previewUrl || scopedUrl(`/api/materials/file/${encodeURIComponent(att.name)}`, { sessionId, scope: accountScope });
    if (isImg) {
      return `
        <a class="bubble-attachment-card bubble-attachment-img-card" href="${escapeHtml(imgUrl)}" target="_blank" rel="noopener noreferrer">
          <img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(att.name || '')}" class="bubble-attachment-thumb" />
          <span class="bubble-attachment-name" title="${escapeHtml(att.name || '')}">${escapeHtml(att.name || '')}</span>
        </a>
      `;
    }
    return `
      <div class="bubble-attachment-card">
        <span class="attachment-badge ${ext}">${ext.toUpperCase()}</span>
        <span class="bubble-attachment-name" title="${escapeHtml(att.name || '')}">${escapeHtml(att.name || '')}</span>
      </div>
    `;
  }).join('');
  return `<div class="bubble-attachments">${cards}</div>`;
}

function handleClipboardPaste(e) {
  const target = e.target;
  const isExcluded = target && target.tagName === 'INPUT' && target.id !== 'chat-input' && target.id !== 'hero-chat-input';
  if (isExcluded) return;

  const clipboardData = e.clipboardData || window.clipboardData;
  if (!clipboardData) return;

  const files = [];

  // 1) files 프로퍼티 확인 (파일 탐색기 복사 파일 또는 스크린샷)
  if (clipboardData.files && clipboardData.files.length > 0) {
    for (let i = 0; i < clipboardData.files.length; i++) {
      const f = clipboardData.files[i];
      if (f) files.push(f);
    }
  } else if (clipboardData.items && clipboardData.items.length > 0) {
    // 2) items 컬렉션 폴백
    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item && item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }

  if (files.length > 0) {
    e.preventDefault();
    e.stopPropagation();

    const renamedFiles = files.map((f, idx) => {
      let name = f.name || '';
      if (!name || name === 'image.png' || name === 'blob') {
        const ext = f.type ? f.type.split('/')[1] || 'png' : 'png';
        name = `screenshot_${Date.now()}_${idx + 1}.${ext}`;
      }
      return new File([f], name, { type: f.type || 'image/png' });
    });

    handleFilesSelected(renamedFiles);
  }
}

function setupFileAttachment() {
  const btn = $('#btn-open-materials-2');
  const fileInput = $('#prompt-file-input');
  if (!btn || !fileInput) return;

  btn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) {
      handleFilesSelected(files);
    }
    fileInput.value = '';
  });

  // 붙여넣기 (Ctrl + V): 문서 파일 / 이미지 스크린샷 프롬프트 자동 첨부
  window.addEventListener('paste', handleClipboardPaste);
}

// ---- 테마 (다크 모드 / 화이트 모드) ----
function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('agy_theme', next); } catch {}
  document.querySelectorAll('.theme-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeValue === next);
  });
  const toggle = $('#theme-switch-toggle');
  if (toggle) toggle.checked = next === 'light';
  const sunIcon = $('#theme-icon-sun');
  const moonIcon = $('#theme-icon-moon');
  if (sunIcon && moonIcon) {
    sunIcon.hidden = next === 'light';
    moonIcon.hidden = next === 'dark';
  }
}

applyTheme(localStorage.getItem('agy_theme') || 'dark');

// ---- 다중 대화 세션 관리 (로컬 목록 + 세션별 대화 내역 보존) ----
// "새 대화"는 빈 초안(draft) 화면만 띄우고, 첫 메시지(또는 목표 설정) 시점에 목록에 등록합니다.
const newSessionId = () => Math.random().toString(36).substring(2, 10);

// 대화·프로필·목표·학습 도구는 계정별 저장 영역에만 둔다. (기기 설정은 기존 localStorage 유지)
let accountScope = getAccountScope();
let accountStore = createAccountStorage(accountScope);
const pget = (key) => accountStore.getItem(key);
const pset = (key, value) => accountStore.setItem(key, value);
const premove = (key) => accountStore.removeItem(key);

function rebindAccountScope() {
  accountScope = getAccountScope();
  accountStore = createAccountStorage(accountScope);
  const saved = pget('agy_session_id');
  sessionId = saved || newSessionId();
  pset('agy_session_id', sessionId);
  sessions = loadSessions();
  isDraft = !sessions.some((s) => s.id === sessionId);
}

let sessionId = pget('agy_session_id');
if (!sessionId) {
  sessionId = newSessionId();
  pset('agy_session_id', sessionId);
}

const SESSIONS_KEY = 'agy_sessions';
const chatHistoryKey = (sid = sessionId) => `agy_chat_${sid}`;
const goalKey = (sid = sessionId) => `agy_goal_${sid}`;

function hasSessionContent(sid) {
  try {
    const raw = pget(chatHistoryKey(sid));
    const history = raw ? JSON.parse(raw) : [];
    return (Array.isArray(history) && history.length > 0) || Boolean(pget(goalKey(sid)));
  } catch {
    return false;
  }
}

function loadSessions() {
  let list = [];
  try {
    const raw = pget(SESSIONS_KEY);
    list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) list = [];
  } catch {}
  // 이전 방식(+ 즉시 생성)으로 쌓인 빈 세션 정리
  list = list.filter((s) => s?.id && hasSessionContent(s.id));
  // 목록에 없지만 기록이 남아 있는 현재 세션은 복구
  if (!list.some((s) => s.id === sessionId) && hasSessionContent(sessionId)) {
    list.unshift({ id: sessionId, title: '이전 대화', updatedAt: Date.now() });
  }
  try { pset(SESSIONS_KEY, JSON.stringify(list)); } catch {}
  return list;
}

function saveSessions(list) {
  try { pset(SESSIONS_KEY, JSON.stringify(list)); } catch {}
}

let sessions = loadSessions();
let isDraft = !sessions.some((s) => s.id === sessionId);

// 초안 세션을 실제 세션으로 확정 (첫 메시지/목표 설정 시 호출)
function commitDraft() {
  if (!isDraft) return;
  isDraft = false;
  sessions.unshift({ id: sessionId, title: '새 대화', updatedAt: Date.now() });
  saveSessions(sessions);
  renderSessionList();
}

function loadChatHistory(sid = sessionId) {
  try {
    const raw = pget(chatHistoryKey(sid));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveChatHistory(history, sid = sessionId) {
  try {
    pset(chatHistoryKey(sid), JSON.stringify(history.slice(-80)));
  } catch {}
}

function appendChatHistoryItem(item, sid = sessionId) {
  const history = loadChatHistory(sid);
  history.push(item);
  saveChatHistory(history, sid);
}

function updateSessionTitleIfNeeded(userText) {
  const cur = sessions.find((s) => s.id === sessionId);
  if (!cur) return;
  cur.updatedAt = Date.now();
  if (!cur.title || cur.title === '새 대화') {
    const trimmed = userText.trim().replace(/\s+/g, ' ');
    cur.title = trimmed.length > 22 ? trimmed.slice(0, 22) + '…' : trimmed;
  }
  saveSessions(sessions);
  renderSessionList();
}

function renderSessionList() {
  if (!sessionListEl) return;
  sessionListEl.innerHTML = '';
  if (!sessions.length) {
    const hint = document.createElement('div');
    hint.className = 'session-empty-hint';
    hint.textContent = '대화를 시작하면 여기에 표시돼요';
    sessionListEl.appendChild(hint);
    return;
  }
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = `session-item${!isDraft && s.id === sessionId ? ' active' : ''}`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session-select-btn';
    btn.textContent = s.title || '새 대화';
    btn.title = s.title || '새 대화';
    btn.addEventListener('click', () => {
      if (s.id !== sessionId || isDraft) void switchSession(s.id);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'session-delete-btn';
    del.title = '세션 삭제';
    del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    });

    row.appendChild(btn);
    row.appendChild(del);
    sessionListEl.appendChild(row);
  }
}

// ---- AI 모델 & 아바타 드롭다운 선택기 바인딩 함수 ----
function bindModelDropdown(wrapper, btnSelect, dropdown, ws = null) {
  if (!wrapper || !btnSelect || !dropdown) return;

  const toggleDropdown = () => {
    const isHidden = dropdown.hidden;
    document.querySelectorAll('.model-selector-wrapper, .avatar-selector-wrapper').forEach((w) => {
      if (w !== wrapper) {
        w.classList.remove('menu-open');
        const d = w.querySelector('.model-dropdown-menu');
        if (d) d.hidden = true;
        const b = w.querySelector('.model-pill-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      }
    });
    dropdown.hidden = !isHidden;
    wrapper.classList.toggle('menu-open', isHidden);
    btnSelect.setAttribute('aria-expanded', String(isHidden));
  };

  const closeDropdown = () => {
    dropdown.hidden = true;
    wrapper.classList.remove('menu-open');
    btnSelect.setAttribute('aria-expanded', 'false');
  };

  btnSelect.onclick = (e) => {
    e.stopPropagation();
    toggleDropdown();
  };

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) {
      closeDropdown();
    }
  });

  dropdown.querySelectorAll('.model-dropdown-item[data-model]').forEach((item) => {
    item.onclick = () => {
      const targetModel = item.dataset.model || 'nemotron';
      closeDropdown();

      activeModel = targetModel;
      saveLastLlmModel(targetModel);
      updateModelUI();
      const socket = ws || window._ws;
      if (socket && typeof socket.send === 'function') {
        socket.send({ type: 'set_model', model: targetModel });
      }
    };
  });

  // 추론 모드 토글 행 바인딩 (드롭다운 내부)
  const thinkRow = dropdown.querySelector('.model-dropdown-think-row');
  if (thinkRow) {
    thinkRow.onclick = (e) => {
      e.stopPropagation();
      if (e.target.tagName !== 'INPUT') {
        const input = thinkRow.querySelector('input');
        if (input) {
          input.checked = !input.checked;
          setThinkMode(input.checked);
        }
      }
    };
    const thinkInput = thinkRow.querySelector('input');
    if (thinkInput) {
      thinkInput.checked = isThinkEnabled;
      thinkInput.onchange = (e) => {
        e.stopPropagation();
        setThinkMode(e.target.checked);
      };
    }
  }
}
window._bindModelDropdown = bindModelDropdown;

function bindAvatarDropdown(wrapper, btnSelect, dropdown) {
  if (!wrapper || !btnSelect || !dropdown) return;

  const toggleDropdown = () => {
    const isHidden = dropdown.hidden;
    document.querySelectorAll('.model-selector-wrapper, .avatar-selector-wrapper').forEach((w) => {
      if (w !== wrapper) {
        w.classList.remove('menu-open');
        const d = w.querySelector('.model-dropdown-menu');
        if (d) d.hidden = true;
        const b = w.querySelector('.model-pill-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      }
    });
    dropdown.hidden = !isHidden;
    wrapper.classList.toggle('menu-open', isHidden);
    btnSelect.setAttribute('aria-expanded', String(isHidden));
  };

  const closeDropdown = () => {
    dropdown.hidden = true;
    wrapper.classList.remove('menu-open');
    btnSelect.setAttribute('aria-expanded', 'false');
  };

  btnSelect.onclick = (e) => {
    e.stopPropagation();
    toggleDropdown();
  };

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) {
      closeDropdown();
    }
  });

  dropdown.querySelectorAll('.model-dropdown-item[data-avatar]').forEach((item) => {
    item.onclick = async () => {
      const avatarId = item.dataset.avatar;
      closeDropdown();
      await switchAvatar(avatarId);
    };
  });
}
window._bindAvatarDropdown = bindAvatarDropdown;

// 이름 등록 전에는 사이드바의 참가자/새 채팅 버튼을 숨긴다.
function syncSidebarActionsVisibility(hidden) {
  const actions = $('.sidebar-actions');
  if (actions) actions.style.display = hidden ? 'none' : '';
}

// 빈 대화 화면 (레퍼런스 스타일 히어로 캡슐 및 추천 칩)
function refreshEmptyState() {
  let empty = chatLog.querySelector('.hero-empty-state');
  const hasMessages = Boolean(chatLog.querySelector('.msg:not(.notice)'));
  const inputFooter = $('#input-area-footer');

  if (hasMessages) {
    empty?.remove();
    if (inputFooter) inputFooter.style.display = '';
    syncSidebarActionsVisibility(false);
    return;
  }

  // 메시지가 없는 빈 상태: 하단 바를 숨겨 중복 노출 방지하고 중앙 캡슐창만 표시
  if (inputFooter) inputFooter.style.display = 'none';

  const currentUser = getAuthenticatedUser();
  const isDemo = currentUser?.role === 'demo';
  const isDemoNeedName = isDemo && !pget('miku_demo_visitor_active');
  syncSidebarActionsVisibility(isDemoNeedName);

  if (empty) {
    const isCurrentDemo = empty.dataset.mode === 'demo';
    if (isCurrentDemo !== isDemoNeedName) {
      empty.remove();
      empty = null;
    }
  }

  if (!empty) {
    empty = document.createElement('div');
    empty.className = 'hero-empty-state';
    empty.dataset.mode = isDemoNeedName ? 'demo' : 'normal';

    if (isDemoNeedName) {
      empty.innerHTML = `
        <h1 class="hero-title demo-name-hero-title"><span class="brand-title hero-brand-logo">Project - MIKU</span> <span class="brand-preview-tag hero-brand-preview-tag">for Preview</span></h1>
        <p class="hero-subtitle" style="font-size: 14.5px; color: var(--text-dim); margin: 0 0 24px; text-align: center; line-height: 1.5;">
          체험하실 분의 <strong>이름(또는 닉네임)</strong>을 입력해 주세요.
        </p>

        <div class="hero-capsule-box demo-name-capsule-box">
          <input type="text" id="demo-visitor-name" class="hero-capsule-input" placeholder="예: 민우, 하랑" maxlength="15" autocomplete="off" style="height: 38px; font-size: 15.5px;" required />
          <button type="button" id="btn-hero-demo-start" class="hero-send-btn demo-hero-start-btn" title="이름 등록 및 대화 시작">
            <span>이름 등록 및 대화 시작</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
        <div class="hero-disclaimer-bottom">AI는 실수할 수 있어요. 중요한 내용은 선생님이나 교과서로 꼭 확인하세요</div>
      `;

      chatLog.appendChild(empty);

      const demoInput = empty.querySelector('#demo-visitor-name');
      const demoSubmitBtn = empty.querySelector('#btn-hero-demo-start');

      const submitDemoName = () => {
        const newName = (demoInput?.value || '').trim() || '참가자';

        try {
          pset(PROFILE_NAME_KEY, newName);
          pset('miku_demo_visitor_active', '1');
          // 프로필 표시는 참가자 세션 단위 저장소를 읽으므로 함께 기록한다.
          accountStore.forSession(sessionId).setItem(PROFILE_NAME_KEY, newName);
        } catch {}
        renderUserProfile();
        syncSidebarActionsVisibility(false);
        refreshEmptyState(); // 이름 등록 즉시 일반 새 대화 프롬프트로 전환

        if (demoSubmitBtn) {
          demoSubmitBtn.disabled = true;
          demoSubmitBtn.style.opacity = '0.7';
          demoSubmitBtn.innerHTML = `<span>대화 준비 중...</span>`;
        }

        if (window._ws) {
          window._ws.send({ type: 'set_user_profile', name: newName });
          window._ws.send({ type: 'demo_greet' });
        }
      };

      demoInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitDemoName();
        }
      });
      demoSubmitBtn?.addEventListener('click', submitDemoName);

      setTimeout(() => demoInput?.focus(), 60);
      return;
    }

    const charName = getAvatarDisplayName(currentModelId);
    const modelText = getModelDisplayName(activeModel);

    empty.innerHTML = `
      <h1 class="hero-title">무엇을 같이 공부해 볼까요?</h1>

      <div id="hero-prompt-attachments" class="prompt-attachments hero-attachments-area" hidden style="display: none; max-width: 640px; margin: 0 auto 12px; justify-content: center;"></div>

      <div class="hero-capsule-box">
        <!-- 프롬프트창 내부 모델 선택기 -->
        <div class="model-selector-wrapper hero-capsule-model-selector" id="hero-model-selector-wrapper">
          <button id="btn-hero-model-select" class="model-pill-btn hero-capsule-model-pill" type="button" aria-haspopup="true" aria-expanded="false" title="AI 모델 변경">
            <span class="model-status-dot" id="hero-bonsai-indicator" title="Bonsai 상태" style="display: none;"></span>
            <span id="hero-current-model-label">${modelText}</span>
            <svg class="chevron-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div id="hero-model-dropdown-menu" class="model-dropdown-menu" hidden>
            <div class="model-dropdown-header">AI 모델</div>
            <button type="button" class="model-dropdown-item active" data-model="gemini">
              <div class="model-item-text">
                <div class="model-item-title">
                  <span>Gemini 2.5 Flash</span>
                </div>
              </div>
              <svg class="model-check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            </button>
            <div class="model-dropdown-divider"></div>
            <div class="model-dropdown-think-row" id="hero-row-dropdown-think">
              <div class="model-dropdown-think-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                <span>추론 (Thinking) 과정</span>
              </div>
              <label class="toggle-switch-sm" title="추론 과정 켜기/끄기">
                <input type="checkbox" id="hero-toggle-dropdown-think" ${isThinkEnabled ? 'checked' : ''} />
                <span class="toggle-slider-sm"></span>
              </label>
            </div>
          </div>
        </div>

        <button type="button" id="btn-hero-attach" class="icon-btn ghost hero-sub-attach" title="파일 첨부">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>

        <textarea id="hero-chat-input" class="hero-capsule-input" rows="1" placeholder="${charName}에게 물어보세요..." autocomplete="off"></textarea>
        <button type="button" id="btn-hero-mic" class="icon-btn ghost hero-sub-mic" title="음성 입력">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
        </button>
        <button type="button" id="btn-hero-send" class="hero-send-btn" title="보내기">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
          <span>보내기</span>
        </button>
      </div>
      <div class="hero-disclaimer-bottom">AI는 실수할 수 있어요. 중요한 내용은 선생님이나 교과서로 꼭 확인하세요</div>
    `;

    const heroCapsuleBox = empty.querySelector('.hero-capsule-box');
    const heroInput = empty.querySelector('#hero-chat-input');
    const heroSend = empty.querySelector('#btn-hero-send');
    const heroMic = empty.querySelector('#btn-hero-mic');
    const heroAttach = empty.querySelector('#btn-hero-attach');

    const resizeHeroInput = () => {
      if (!heroInput) return;
      heroInput.style.height = 'auto';
      const scrollH = heroInput.scrollHeight;
      const targetH = Math.min(Math.max(scrollH, 34), 180);
      heroInput.style.height = `${targetH}px`;
      heroInput.classList.toggle('has-scroll', scrollH > 180);
      heroCapsuleBox?.classList.toggle('multiline', targetH > 42);
    };

    heroInput?.addEventListener('input', resizeHeroInput);

    heroAttach?.addEventListener('click', () => {
      $('#prompt-file-input')?.click();
    });

    const handleSend = () => {
      const text = heroInput?.value.trim() || '';
      const currentAttachments = activeAttachments.map((a) => ({
        name: a.name,
        size: a.size,
        ext: a.ext,
        url: a.url || a.previewUrl || '',
      }));
      if (!text && currentAttachments.length === 0) return;

      const stillUploading = activeAttachments.some((a) => a.status === 'uploading');
      if (stillUploading) {
        addNotice('파일 업로드 중입니다. 잠시만 기다려 주세요...');
        return;
      }

      activeAttachments = [];
      renderPromptAttachments();

      sendUserText(text, currentAttachments);
      if (heroInput) {
        heroInput.value = '';
        resizeHeroInput();
      }
    };

    heroSend?.addEventListener('click', handleSend);

    heroInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.shiftKey) {
          setTimeout(resizeHeroInput, 0);
        } else {
          if (e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          handleSend();
        }
      }
    });

    heroMic?.addEventListener('click', () => {
      micBtn?.click();
    });

    // 드롭다운 바인딩
    const heroModelWrapper = empty.querySelector('#hero-model-selector-wrapper');
    const btnHeroModel = empty.querySelector('#btn-hero-model-select');
    const heroModelDropdown = empty.querySelector('#hero-model-dropdown-menu');
    bindModelDropdown(heroModelWrapper, btnHeroModel, heroModelDropdown, window._ws);

    chatLog.prepend(empty);
    updateModelUI();
    heroInput?.focus();
  }
}

function renderUserBubble(div, text, attachments = []) {
  div.dataset.rawText = text || '';
  div._attachments = attachments || [];

  let bubbleHtml = '<div class="user-bubble-capsule">';
  if (attachments && attachments.length > 0) {
    bubbleHtml += renderBubbleAttachments(attachments);
  }
  if (text) {
    bubbleHtml += `<div class="user-bubble-text">${escapeHtml(text)}</div>`;
  }
  bubbleHtml += `
    </div>
    <div class="msg-actions user-actions">
      <button type="button" class="action-icon-btn btn-copy-msg" title="메시지 복사" aria-label="메시지 복사">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      </button>
      <button type="button" class="action-icon-btn btn-edit-msg" title="메시지 수정" aria-label="메시지 수정">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
      </button>
    </div>
  `;
  div.innerHTML = bubbleHtml;
  bindUserBubbleActions(div);
}

function bindUserBubbleActions(div) {
  const btnCopy = div.querySelector('.btn-copy-msg');
  const btnEdit = div.querySelector('.btn-edit-msg');

  btnCopy?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const raw = div.dataset.rawText || '';
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(raw);
      btnCopy.classList.add('copied');
      btnCopy.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
      setTimeout(() => {
        btnCopy.classList.remove('copied');
        btnCopy.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
      }, 1500);
    } catch {}
  });

  btnEdit?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isBusy) {
      addNotice('답변 생성 중에는 메시지를 수정할 수 없습니다.');
      return;
    }
    openUserBubbleEdit(div);
  });
}

function openUserBubbleEdit(div) {
  const currentText = div.dataset.rawText || '';
  const attachments = div._attachments || [];
  const capsuleEl = div.querySelector('.user-bubble-capsule');
  const actionsEl = div.querySelector('.user-actions');

  div.classList.add('is-editing');
  if (capsuleEl) capsuleEl.style.display = 'none';
  if (actionsEl) actionsEl.style.display = 'none';

  let editBox = div.querySelector('.msg-edit-box');
  if (editBox) editBox.remove();

  editBox = document.createElement('div');
  editBox.className = 'msg-edit-box';
  editBox.innerHTML = `
    <textarea class="msg-edit-textarea" rows="2">${escapeHtml(currentText)}</textarea>
    <div class="msg-edit-actions">
      <button type="button" class="btn-cancel-edit">취소</button>
      <button type="button" class="btn-save-edit">전송</button>
    </div>
  `;

  div.appendChild(editBox);

  const textarea = editBox.querySelector('.msg-edit-textarea');
  const btnCancel = editBox.querySelector('.btn-cancel-edit');
  const btnSave = editBox.querySelector('.btn-save-edit');

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  const adjustHeight = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  };
  textarea.addEventListener('input', adjustHeight);
  adjustHeight();

  const cancel = () => {
    editBox.remove();
    div.classList.remove('is-editing');
    if (capsuleEl) capsuleEl.style.display = '';
    if (actionsEl) actionsEl.style.display = '';
  };

  const submit = () => {
    const newText = textarea.value.trim();
    if (!newText) {
      textarea.focus();
      return;
    }
    editBox.remove();
    div.classList.remove('is-editing');

    // 1) 이 사용자 버블 이후의 DOM 요소들 제거
    let next = div.nextElementSibling;
    while (next) {
      const toRemove = next;
      next = next.nextElementSibling;
      toRemove.remove();
    }

    // 2) localStorage 히스토리에서 해당 턴 이후 절삭 및 본문 갱신
    const history = loadChatHistory(sessionId);
    const allUserBubbles = Array.from(chatLog.querySelectorAll('.msg.user'));
    const targetUserIdx = allUserBubbles.indexOf(div);

    let seenUsers = -1;
    let turnIndex = -1;
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'user') {
        seenUsers++;
        if (seenUsers === targetUserIdx) {
          turnIndex = i;
          break;
        }
      }
    }

    if (turnIndex >= 0) {
      history[turnIndex].text = newText;
      history.splice(turnIndex + 1);
      saveChatHistory(history, sessionId);
    }

    // 3) 사용자 버블 다시 렌더링
    renderUserBubble(div, newText, attachments);

    // 4) AI에게 수정된 텍스트 전송 및 답변 재발행
    commitDraft();
    isTtsActive = false;
    isServerTtsDone = true;
    window._ws?.send({ type: 'user_text', text: newText, attachments });
    closeExplanationPanel();
    updateSessionTitleIfNeeded(newText || attachments[0]?.name || '자료 질문');
    showThinkingBubble(window._stage, attachments);
  };

  btnCancel.addEventListener('click', cancel);
  btnSave.addEventListener('click', submit);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
}

function renderAssistantBubble(div, item) {
  let html = '';
  if (item.think) {
    const labelText = item.thinkDuration ? `${item.thinkDuration}초 동안 생각함` : '생각 과정 보기';
    html += `<details class="think-details"><summary><span class="think-summary-label">${labelText}</span><span class="think-toggle-icon">▾</span></summary><div class="think-body">${escapeHtml(item.think)}</div></details>`;
  }
  if (item.cardsHtml) {
    html += `<div class="tool-cards-wrapper">${item.cardsHtml}</div>`;
  }
  if (item.text) {
    html += `<div class="msg-markdown">${renderMarkdown(item.text)}</div>`;
  }
  div.innerHTML = `<div class="assistant-bubble-capsule">${html}</div>`;
  attachAssistantActions(div, item.text, { durationSec: item.durationSec, tokens: item.tokens });
}

function attachAssistantActions(div, rawText, meta = null) {
  if (!div || div.querySelector('.assistant-actions')) return;
  const actionsEl = document.createElement('div');
  actionsEl.className = 'msg-actions assistant-actions';

  // 생성 소요 시간 및 토큰 수 뱃지 (호버 시 표시)
  if (meta && (meta.durationSec !== undefined && meta.durationSec !== null || meta.tokens)) {
    const dur = meta.durationSec !== null && meta.durationSec !== undefined ? `${meta.durationSec}초` : '';
    // 뱃지에는 실제 답변(출력) 토큰만 보여준다. 입력에는 고정 지침·도구 정의·대화 기록이 모두 포함된다.
    const answerTokens = meta.tokens?.completion ?? meta.tokens?.total ?? meta.tokens ?? 0;
    const tokText = answerTokens ? `답변 ${Number(answerTokens).toLocaleString()} 토큰` : '';

    let tooltip = '';
    if (meta.tokens?.prompt && meta.tokens?.completion) {
      const sum = meta.tokens.total ?? (meta.tokens.prompt + meta.tokens.completion);
      tooltip = `소요 시간: ${dur || '0초'} | 입력(지침·도구·대화): ${meta.tokens.prompt.toLocaleString()} 토큰, 출력(답변): ${meta.tokens.completion.toLocaleString()} 토큰, 합계: ${Number(sum).toLocaleString()} 토큰`;
    } else if (dur && tokText) {
      tooltip = `생성 시간: ${dur} · 토큰: ${tokText}`;
    } else {
      tooltip = dur ? `생성 시간: ${dur}` : `사용된 토큰: ${tokText}`;
    }

    if (dur || tokText) {
      const statsBadge = document.createElement('div');
      statsBadge.className = 'msg-gen-stats';
      statsBadge.title = tooltip;
      statsBadge.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        ${dur ? `<span class="stat-duration">${dur}</span>` : ''}
        ${dur && tokText ? '<span class="stat-sep">·</span>' : ''}
        ${tokText ? `<span class="stat-tokens">${tokText}</span>` : ''}
      `;
      actionsEl.appendChild(statsBadge);
    }
  }

  const isErrorText = rawText && (
    rawText.includes('오류가 발생') ||
    rawText.includes('생성 실패') ||
    rawText.includes('에러가 발생') ||
    rawText.startsWith('[오류]')
  );

  let actionsHtml = '';
  if (isErrorText) {
    actionsHtml += `
      <button type="button" class="action-icon-btn btn-loopback-msg" title="다시 시도" aria-label="다시 시도">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
      </button>
    `;
  }
  actionsHtml += `
    <button type="button" class="action-icon-btn btn-copy-msg" title="답변 복사" aria-label="답변 복사">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
    </button>
    <button type="button" class="action-icon-btn btn-speak-msg" title="음성 재생" aria-label="음성 재생">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
    </button>
  `;
  const btnsWrap = document.createElement('div');
  btnsWrap.className = 'assistant-btn-group';
  btnsWrap.innerHTML = actionsHtml;
  actionsEl.appendChild(btnsWrap);

  actionsEl.querySelector('.btn-loopback-msg')?.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerLoopback(div);
  });

  actionsEl.querySelector('.btn-copy-msg')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = actionsEl.querySelector('.btn-copy-msg');
    const textToCopy = rawText || div.querySelector('.msg-markdown')?.textContent || '';
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      btn.classList.add('copied');
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
      }, 1500);
    } catch {}
  });

  actionsEl.querySelector('.btn-speak-msg')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const textToSpeak = rawText || div.querySelector('.msg-markdown')?.textContent || '';
    if (!textToSpeak) return;
    // TTS는 서버 엔진에서 만들므로 이 문장을 다시 읽어 달라고 요청한다.
    ensureResumed();
    window._ws?.send({ type: 'test_tts', text: textToSpeak });
  });

  div.appendChild(actionsEl);
}

function triggerLoopback(targetEl) {
  if (isBusy) {
    addNotice('답변 생성 중에는 다시 시도할 수 없습니다.');
    return;
  }

  // 1) 앞선 사용자 질문 버블 탐색
  let prev = targetEl.previousElementSibling;
  while (prev && !prev.classList.contains('user')) {
    prev = prev.previousElementSibling;
  }

  if (!prev) {
    const history = loadChatHistory(sessionId);
    const lastUser = [...history].reverse().find((h) => h.role === 'user');
    if (lastUser) {
      sendUserText(lastUser.text, lastUser.attachments);
    }
    return;
  }

  const userText = prev.dataset.rawText || prev.querySelector('.user-bubble-text')?.textContent || '';
  const attachments = prev._attachments || [];

  // 2) 사용자 버블 이후의 DOM 버블(답변/알림 등) 제거
  let next = prev.nextElementSibling;
  while (next) {
    const toRemove = next;
    next = next.nextElementSibling;
    toRemove.remove();
  }

  // 3) history에서 해당 사용자 턴 이후 항목 제거
  const allUserBubbles = Array.from(chatLog.querySelectorAll('.msg.user'));
  const targetUserIdx = allUserBubbles.indexOf(prev);
  const history = loadChatHistory(sessionId);

  let seenUsers = -1;
  let turnIndex = -1;
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user') {
      seenUsers++;
      if (seenUsers === targetUserIdx) {
        turnIndex = i;
        break;
      }
    }
  }

  if (turnIndex >= 0) {
    history.splice(turnIndex + 1);
    saveChatHistory(history, sessionId);
  }

  // 4) AI에게 재전송 (루프백)
  commitDraft();
  isTtsActive = false;
  isServerTtsDone = true;
  window._ws?.send({ type: 'user_text', text: userText, attachments });
  closeExplanationPanel();
  showThinkingBubble(window._stage, attachments);
}

function restoreChatLog(sid = sessionId) {
  chatLog.innerHTML = '';
  const history = loadChatHistory(sid);
  for (const item of history) {
    if (item.role === 'user') {
      const div = addBubble('user');
      renderUserBubble(div, item.text, item.attachments || []);
    } else if (item.role === 'assistant') {
      const div = addBubble('assistant');
      renderAssistantBubble(div, item);
    }
  }
  refreshEmptyState();
  isAutoScrollLocked = true;
  chatLog.scrollTop = chatLog.scrollHeight;
}

// "새 대화": 세션을 바로 만들지 않고 빈 초안 화면으로 전환
async function startNewChat() {
  // 아직 아무 메시지도 없는 초안이면 화면만 유지하고 입력창에 포커스한다.
  if (isDraft && !chatLog.querySelector('.msg:not(.notice)')) {
    const heroInput = $('#hero-chat-input');
    if (heroInput) heroInput.focus();
    else chatInput?.focus();
    return;
  }

  const nextId = newSessionId();
  // 시연 참가자는 새 채팅에서도 같은 이름으로 이어서 대화한다.
  if (getAuthenticatedUser()?.role === 'demo') {
    const participantName = getUserProfile().name;
    if (participantName && participantName !== DEFAULT_USER_NAME) {
      accountStore.forSession(nextId).setItem(PROFILE_NAME_KEY, participantName);
    }
  }
  await switchSession(nextId);
  const heroInput = $('#hero-chat-input');
  if (heroInput) heroInput.focus();
  else chatInput?.focus();
}

function removeSessionData(sid) {
  try {
    premove(chatHistoryKey(sid));
    premove(goalKey(sid));
    premove(`miku_avatar_${sid}`);
    accountStore.removeSession(sid);
  } catch {}
}

function deleteSession(targetId) {
  sessions = sessions.filter((s) => s.id !== targetId);
  removeSessionData(targetId);
  saveSessions(sessions);
  // 이 계정의 해당 세션만 서버에서 지운다.
  apiFetch(`/api/sessions/${encodeURIComponent(targetId)}`, { method: 'DELETE' }).catch(() => {});
  if (targetId === sessionId) {
    void switchSession(newSessionId());
  } else {
    renderSessionList();
  }
}

async function deleteAllSessions() {
  if (!confirm('이 계정의 세션 데이터(대화 기록, 프로필, 학습 도구 데이터, 업로드 자료)를 초기화할까요? 되돌릴 수 없어요.')) return false;
  stopGeneration();
  stopTts();
  appMic?.stop?.();
  const sessionIds = [...new Set([
    ...sessions.map((s) => s.id),
    sessionId,
  ].filter(Boolean))];
  if (sessionIds.length) {
    await apiFetch('/api/sessions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds, resetAccount: true }),
    }).catch(() => {});
  }
  accountStore.clearAccount();
  accountScope = getAccountScope();
  accountStore = createAccountStorage(accountScope);
  sessionId = newSessionId();
  pset('agy_session_id', sessionId);
  sessions = [];
  saveSessions(sessions);
  window.location.reload();
  return true;
}

async function switchSession(nextId) {
  sessionEpoch += 1; // 이전 세션의 늦은 응답·인식 결과를 모두 무효화
  stopGeneration();
  stopTts();
  appMic?.stop?.(); // 이전 참가자의 마이크 입력이 다음 세션으로 넘어가지 않게 중단
  closeExplanationPanel();
  activeAttachments = []; // 세션 전환 시 이전 세션의 미전송 첨부파일 비우기
  renderPromptAttachments();
  const chatInput = $('#chat-input');
  if (chatInput) {
    chatInput.value = '';
    chatInput.style.height = 'auto';
    $('#input-bar')?.classList.remove('multiline');
  }
  sessionId = nextId;
  isDraft = !sessions.some((s) => s.id === sessionId);
  try { pset('agy_session_id', sessionId); } catch {}
  studyToolsManager?.onSessionChanged?.();
  renderSessionList();
  restoreChatLog(sessionId);
  renderUserProfile();

  // WS 재연결 (이전 연결 이벤트는 WSClient에서 무시됨)
  window._ws?.reconnect(sessionWsUrl(sessionId, accountScope));
  syncTtsButtons?.('supertonic');

  // 세션별 목표 복원 (아바타 모델은 전역 통합이므로 세션 전환 시 모델을 바꾸지 않음)
  await loadGoal();
}

// ---- 아바타 모델 선택 (전역 통합: 세션 무관 유지) ----
let avatarModels = [];
let defaultAvatarModelId = 'yinlang';
let currentModelId = null;
const GLOBAL_AVATAR_KEY = 'miku_avatar_global_model';

async function fetchAvatarModels() {
  try {
    const res = await fetch('/api/avatar-models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { models: data.models || [], defaultModelId: data.defaultModelId || 'yinlang' };
  } catch {
    return { models: [], defaultModelId: 'yinlang' };
  }
}

// 서버 프로바이더 설정 조회 (서버 STT 사용 여부 판단용)
async function fetchServerConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return { providers: {} };
  }
}

async function loadSavedAvatarModel(fallbackId) {
  // 1순위: 전역 로컬 저장소, 2순위: 서버 전역 저장, 3순위: 기본 모델
  try {
    const local = localStorage.getItem(GLOBAL_AVATAR_KEY) || localStorage.getItem('miku_avatar_default');
    if (local) return local;
  } catch {}
  try {
    const res = await fetch('/api/avatar-model');
    if (res.ok) {
      const data = await res.json();
      if (data.modelId) return data.modelId;
    }
  } catch {}
  return fallbackId;
}

async function saveAvatarModel(modelId) {
  try { localStorage.setItem(GLOBAL_AVATAR_KEY, modelId); } catch {}
  try {
    await fetch('/api/avatar-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId }),
    });
  } catch {}
  try {
    window._ws?.send({ type: 'set_avatar', modelId });
  } catch {}
}

function renderAvatarSelect(selectEl) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  const list = avatarModels.length
    ? avatarModels
    : [{ id: 'yinlang', name: '은랑', modelUrl: '/assets/models/live2d/yinlang/yinlang.model3.json' }];
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    selectEl.appendChild(opt);
  }
  if (currentModelId) selectEl.value = currentModelId;
}

// ---- 아바타 모델 전환 시 상단에 잠깐 나타났다 사라지는 토스트 알림 ----
function showAvatarToast(name, isError = false) {
  document.querySelectorAll('.avatar-toast-container').forEach((el) => el.remove());

  const container = document.createElement('div');
  container.className = 'avatar-toast-container';
  const iconHtml = isError ? '<span class="avatar-toast-icon">⚠️</span>' : '';
  const content = isError
    ? `<span>${escapeHtml(name)}</span>`
    : `<span><strong>${escapeHtml(name)}</strong>(으)로 아바타가 변경되었습니다</span>`;

  container.innerHTML = `
    <div class="avatar-toast ${isError ? 'error' : ''}">
      ${iconHtml}
      ${content}
    </div>
  `;
  document.body.appendChild(container);

  setTimeout(() => {
    try { container.remove(); } catch {}
  }, 2200);
}

async function switchAvatar(nextId) {
  if (!nextId || nextId === currentModelId) return;
  const prevId = currentModelId;
  const avatarSelect = $('#avatar-select');
  if (avatarSelect) avatarSelect.disabled = true;
  try {
    const stage = window._stage;
    if (stage?.switchModel) {
      const result = await stage.switchModel(nextId, { availableModels: avatarModels });
      currentModelId = result.id || nextId;
    } else {
      currentModelId = nextId;
    }
    if (avatarSelect) avatarSelect.value = currentModelId;
    await saveAvatarModel(currentModelId);
    updateAvatarBadge(currentModelId);

    const heroAvatarLabel = $('#hero-current-avatar-label');
    if (heroAvatarLabel) {
      heroAvatarLabel.textContent = getAvatarDisplayName(currentModelId);
    }
    document.querySelectorAll('.model-dropdown-item[data-avatar]').forEach((item) => {
      item.classList.toggle('active', item.dataset.avatar === currentModelId);
    });

    const label = avatarModels.find((m) => m.id === currentModelId)?.name || currentModelId;
    const cleanName = getAvatarDisplayName(currentModelId);
    const heroInput = $('#hero-chat-input');
    if (heroInput) {
      heroInput.placeholder = `${cleanName || label}에게 물어보세요...`;
    }
    showAvatarToast(cleanName || label);
  } catch (err) {
    console.error(err);
    if (avatarSelect) avatarSelect.value = prevId;
    showAvatarToast(`아바타 전환 실패: ${err.message}`, true);
  } finally {
    if (avatarSelect) avatarSelect.disabled = false;
  }
}
window.switchAvatar = switchAvatar;

async function boot() {
  // 로그인 계정이 확정된 뒤 그 계정의 저장 영역으로 다시 묶는다.
  rebindAccountScope();
  renderSessionList();
  restoreChatLog(sessionId);
  renderUserProfile();

  const avatarSelect = $('#avatar-select');
  const { models, defaultModelId } = await fetchAvatarModels();
  avatarModels = models;
  defaultAvatarModelId = defaultModelId;
  currentModelId = await loadSavedAvatarModel(defaultModelId);

  const stage = new Live2DStage(document.getElementById('avatar-canvas'));
  window._stage = stage; // 도구 호출에서 감정 제어용
  onLipVolume((vol) => stage.setLipVolume(vol));
  try {
    await stage.init({ modelId: currentModelId, availableModels: avatarModels });
    currentModelId = stage.modelId || currentModelId;
  } catch (err) {
    console.error(err);
    addNotice('아바타 모델을 불러오지 못했습니다. (setup-sample-model 실행 여부 확인)');
  }
  renderAvatarSelect(avatarSelect);
  updateAvatarBadge(currentModelId);
  updateViewToggleUI(stage.getViewMode());
  stage.onViewModeChange = (mode) => updateViewToggleUI(mode);

  // 서버 STT(Whisper) 활성 시: Web Speech API 대신 마이크 PCM을 WS로 전송
  const serverConfig = await fetchServerConfig();
  const useServerStt = Boolean(serverConfig.providers?.stt) && serverConfig.providers.stt !== 'mock';
  const mic = new MicManager({
    // 세션 전환·TTS 차단으로 마이크를 멈춘 뒤 늦게 도착한 인식 결과는 보내지 않는다.
    onTranscript: (text) => {
      if (!mic.listening) return;
      sendUserText(text);
    },
    onListeningChange: (on) => {
      micBtn.classList.toggle('listening', on);
      if (on) {
        setAvatarStatus('듣고 있어요...');
      } else {
        setAvatarStatus(isBusy ? '생각 중...' : '준비 완료');
      }
    },
    ...(useServerStt
      ? {
          mode: 'server',
          onServerChunk: (buf) => ws.sendBinary(buf),
          onServerReset: () => ws.send({ type: 'stt_reset' }),
        }
      : {}),
  });

  const player = new DisabledAudioPlayer({
    onPlayStateChange: (speaking) => {
      // 초점: TTS 재생 중에만 마이크 인식 차단 (음성 간섭 방지) 및 아바타 립싱크 발화 상태 동기화
      mic.setSpeechBlocked(speaking);
      stage.setSpeaking(speaking);
      updateTtsUiState();
    },
    onPlaybackEnd: () => {
      if (isServerTtsDone && !player.isPlaying()) {
        isTtsActive = false;
      }
      updateTtsUiState();
    },
  });
  window._ttsPlayer = player;
  appMic = mic;

  const ws = new WSClient({
    url: sessionWsUrl(sessionId, accountScope),
    onMessage: (msg, isBinary) => {
      if (isBinary) {
        if (pendingTtsMeta) player.enqueue(pendingTtsMeta, msg);
        return;
      }
      handleMessage(msg, stage);
    },
    onOpen: () => {
      ws.send({ type: 'set_model', model: activeModel });
      ws.send({ type: 'set_think', enabled: isThinkEnabled });
      ws.send({ type: 'set_tts_provider', provider: 'supertonic' });
      if (activeModel === 'bonsai') {
        ws.send({ type: 'start_local_llm' });
      }
      if (currentModelId) ws.send({ type: 'set_avatar', modelId: currentModelId });
      const profile = getUserProfile();
      if (profile?.name && profile.name !== DEFAULT_USER_NAME) {
        ws.send({ type: 'set_user_profile', name: profile.name, avatar: profile.avatar });
      }
    },
    onClose: () => {
      if (isBusy || isTtsActive) {
        clearTurnWatchdog();
        stopGeneration();
        addNotice('서버 연결이 끊겨 답변이 중단됐습니다. 자동으로 다시 연결할게요.');
      }
    },
  });
  ws.connect();
  window._ws = ws; // 디버그용
  window._player = player;

  // ---- 프롬프트 입력창 자동 높이 조절 & 엔터 전송 바인딩 ----
  function resizePromptInput() {
    if (!chatInput) return;
    chatInput.style.height = 'auto';
    const scrollH = chatInput.scrollHeight;
    const targetH = Math.min(Math.max(scrollH, 32), 180);
    chatInput.style.height = `${targetH}px`;
    chatInput.classList.toggle('has-scroll', scrollH > 180);
    $('#input-bar')?.classList.toggle('multiline', targetH > 40);
  }

  chatInput?.addEventListener('input', resizePromptInput);

  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) {
        // Shift + Enter: 줄바꿈 허용 후 높이 자동 갱신
        setTimeout(resizePromptInput, 0);
      } else {
        // 한글 조합 중(isComposing) 엔터 입력 시 조기 전송 방지
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        $('#chat-form')?.requestSubmit();
      }
    }
  });

  // ---- UI 바인딩 ----
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    // 답변/음성 중 전송은 "멈추고 바로 새 질문"으로 처리한다. 입력을 버리지 않는다.
    if (isBusy || isTtsActive) {
      stopGeneration();
      if (!chatInput.value.trim() && activeAttachments.length === 0) return;
    }
    const text = chatInput.value.trim();
    if (!text && activeAttachments.length === 0) return;

    // 끊긴 소켓에 보내면 메시지가 조용히 사라지므로, 입력을 남겨두고 안내한다.
    if (window._ws && !window._ws.canSend?.()) {
      addNotice('서버 연결이 끊겼습니다. 자동으로 다시 연결하는 중이니 잠시 후 전송해 주세요.');
      return;
    }

    const stillUploading = activeAttachments.some((a) => a.status === 'uploading');
    if (stillUploading) {
      addNotice('파일 업로드 중입니다. 잠시만 기다려 주세요...');
      return;
    }

    const currentAttachments = activeAttachments.map((a) => ({
      name: a.name,
      size: a.size,
      ext: a.ext,
      url: a.url || a.previewUrl || '',
    }));
    activeAttachments = [];
    renderPromptAttachments();

    chatInput.value = '';
    resizePromptInput();
    sendUserText(text, currentAttachments);
  });

  micBtn.addEventListener('click', () => {
    ensureResumed();
    mic.toggle();
  });
  if (!mic.supported) {
    micBtn.disabled = true;
    micBtn.title = '이 브라우저는 음성 인식을 지원하지 않습니다.';
  }

  $('#goal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = goalInput.value.trim();
    if (!text) return;
    commitDraft(); // 목표 설정도 대화 시작으로 간주
    // 현재 계정·세션 전용 목표 저장
    pset(goalKey(), text);
    updateGoalDisplay(text);
    ws.send({ type: 'set_goal', text });
    goalInput.value = '';
    closeModal('goal-modal-overlay');
  });

  $('#btn-recenter')?.addEventListener('click', () => stage.resetPosition());

  // 크기 슬라이더 ↔ 스테이지 줌 동기화
  const zoomSlider = $('#avatar-zoom');
  const zoomLabel = $('#avatar-zoom-label');
  const paintZoom = (z) => {
    if (zoomSlider) zoomSlider.value = String(Math.round(z * 100));
    if (zoomLabel) zoomLabel.textContent = `${Math.round(z * 100)}%`;
  };
  if (zoomSlider) {
    zoomSlider.addEventListener('input', () => {
      stage.setZoom(Number(zoomSlider.value) / 100);
    });
    stage.onZoomChange = paintZoom;
    paintZoom(stage.getZoom());
  }

  // 아바타 모델 전환 (이 세션에만 저장, 다른 세션에 영향 없음)
  if (avatarSelect) {
    avatarSelect.addEventListener('change', () => void switchAvatar(avatarSelect.value));
  }

  // ---- 사이드바 / 첨부파일 / 모달 / 도구 바인딩 ----
  setupSidebar();
  setupResizers();
  setupFileAttachment();
  setupGoalModal();
  setupSettingsModal();
  setupProfileModal();
  setupToolsGuideModal();
  setupModelSelector(ws);
  setupTopControls();
  setupStudyTools(ws);
  renderUserProfile();

  // 설명 패널 닫기 버튼
  $('#btn-close-explanation')?.addEventListener('click', closeExplanationPanel);

  // 코드 블록 복사 버튼 위임 이벤트
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-copy-code');
    if (!btn) return;
    const codeEl = btn.closest('.code-card')?.querySelector('pre code');
    if (!codeEl) return;
    try {
      await navigator.clipboard.writeText(codeEl.textContent || '');
      const prev = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = prev; }, 1400);
    } catch {}
  });

  // <details class="think-details"> 토글 시 사용자 수동 상호작용 기록 (스트리밍 중 강제 닫힘 방지)
  // 스마트 오토스크롤: 답변 스트리밍 중 사용자가 위로 스크롤하면 하단 고정 해제, 다시 하단 근처로 오면 고정
  chatLog.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) {
      isAutoScrollLocked = false;
    } else if (e.deltaY > 0) {
      const distance = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight;
      if (distance <= SCROLL_BOTTOM_THRESHOLD) {
        isAutoScrollLocked = true;
      }
    }
  }, { passive: true });

  let chatTouchStartY = 0;
  chatLog.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length === 1) {
      chatTouchStartY = e.touches[0].clientY;
    }
  }, { passive: true });

  chatLog.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length === 1) {
      const deltaY = e.touches[0].clientY - chatTouchStartY;
      if (deltaY > 10) {
        isAutoScrollLocked = false;
      }
    }
  }, { passive: true });

  chatLog.addEventListener('scroll', () => {
    const distance = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight;
    if (distance <= SCROLL_BOTTOM_THRESHOLD) {
      isAutoScrollLocked = true;
    } else {
      isAutoScrollLocked = false;
    }
  }, { passive: true });

  chatLog.addEventListener('toggle', (e) => {
    if (e.target && e.target.classList.contains('think-details')) {
      e.target.dataset.userToggled = 'true';
    }
  }, true);

  // 자동재생 정책 대응: 첫 상호작용 시 오디오 컨텍스트 재개
  document.addEventListener('pointerdown', ensureResumed, { once: true });

  // Ctrl+Alt+T: 기능별 독립 테스트 페이지 열기 (브라우저 충돌 및 일반 입력 오발동 방지)
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      window.open('/test.html', '_blank');
    }
  });

  await loadGoal();
}

// ---- 메시지 처리 ----
function handleMessage(msg, stage) {
  switch (msg.type) {
    case 'welcome': {
      // 서버가 다른 기기에서 초기화했더라도 이 브라우저의 로그인·다른 계정 저장소는 건드리지 않는다.
      const serverEpoch = Number(msg.resetEpoch) || 0;
      if (serverEpoch > 0) {
        try { localStorage.setItem('miku_reset_epoch', String(serverEpoch)); } catch {}
      }
      break;
    }
    case 'session_deleted': {
      // 다른 탭에서 지운 세션이면 자동 재접속하지 않고 새 대화를 발급한다.
      if (String(msg.sessionId || '') !== sessionId) break;
      removeSessionData(sessionId);
      sessions = sessions.filter((s) => s.id !== sessionId);
      saveSessions(sessions);
      if (resettingForNextVisitor) break;
      const fresh = newSessionId();
      void switchSession(fresh);
      break;
    }
    case 'status':
      if (msg.state === 'speaking') {
        isTtsActive = true;
        isServerTtsDone = false;
        updateTtsUiState();
      }
      handleStatus(msg.state, stage);
      break;
    case 'tts_state':
      updateTtsStateUi(msg);
      break;
    case 'user_text': {
      // 서버 STT로 인식된 발화 — 표시만 하고 재전송하지 않음 (무한 루프 방지)
      const text = msg.text || '';
      if (text) commitDraft();
      const div = addBubble('user');
      renderUserBubble(div, text, msg.attachments || []);
      if (text) {
        appendChatHistoryItem({ role: 'user', text, attachments: msg.attachments || [] });
        updateSessionTitleIfNeeded(text);
      }
      showThinkingBubble(stage);
      break;
    }
    case 'emotion':
      if (stage) stage.setEmotion(msg.tag);
      break;
    case 'assistant_think':
      appendAssistantThink(msg.text);
      break;
    case 'assistant_text_partial':
      clearTurnWatchdog();
      appendAssistant(msg.text);
      break;
    case 'assistant_text_end':
      clearTurnWatchdog();
      finalizeAssistant(msg);
      break;
    case 'tts_meta':
      isTtsActive = true;
      isServerTtsDone = false;
      pendingTtsMeta = msg;
      updateTtsUiState();
      break;
    case 'tts_end':
      isServerTtsDone = true;
      if (!window._player?.isPlaying()) {
        isTtsActive = false;
      }
      updateTtsUiState();
      break;
    case 'memory_update':
      addNotice('장기 기억에 저장했어! 🧠');
      loadGoal();
      break;
    case 'recall_result':
      renderRecall(msg);
      break;
    case 'rag_result':
      renderRagResult(msg);
      break;
    case 'tool_start':
      handleToolStart(msg.name, msg.args, msg.message);
      break;
    case 'tool_partial':
      handleToolPartial(msg.name, msg.title, msg.text);
      break;
    case 'tool_call':
      handleToolCall(msg.name, msg.args, msg.result);
      break;
    case 'notice':
      // LLM 도구/동작 관련 메시지는 시스템 알림이 아니라 정식 말풍선 내부로 이전
      if (msg.text && (msg.text.includes('코드 실행 중') || msg.text.includes('검색 중') || msg.text.includes('계산 중'))) {
        handleToolStartNotice(msg.text);
      } else {
        addNotice(msg.text);
      }
      break;
    case 'error_notice':
      clearTurnWatchdog();
      showErrorNotice(msg.text, msg.detail);
      break;
    case 'llm_state':
      handleLlmState(msg);
      break;
    default:
      break;
  }
}

// ---- 대화 / 스트리밍 및 음성(TTS) 제어 ----
function updateTtsUiState() {
  const isPlaying = Boolean(window._player?.isPlaying());
  const isSpeakingOrQueued = isTtsActive && (!isServerTtsDone || isPlaying);
  const stopTtsBtn = $('#btn-stop-tts');
  if (stopTtsBtn) {
    stopTtsBtn.style.display = isSpeakingOrQueued ? 'inline-flex' : 'none';
  }
  if (sendBtn) {
    const isStopping = isBusy || isSpeakingOrQueued;
    sendBtn.classList.toggle('stopping', isStopping);
    sendBtn.title = isStopping ? '정지' : '전송';
    sendBtn.setAttribute('aria-label', isStopping ? '정지' : '전송');
  }
  if (isSpeakingOrQueued) {
    setAvatarStatus('답변 중...');
  } else {
    setAvatarStatus(isBusy ? '생각 중...' : '준비 완료');
  }
}
window.updateTtsUiState = updateTtsUiState;

function setBusyState(busy) {
  isBusy = busy;
  updateTtsUiState();
}

function stopTts() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  window._ws?.send({ type: 'cancel_tts' });
  window._player?.stop();
  pendingTtsMeta = null;
  isTtsActive = false;
  isServerTtsDone = true;
  window._stage?.setSpeaking(false);
  updateTtsUiState();
}
window.stopTts = stopTts;

function stopGeneration() {
  window._ws?.send({ type: 'cancel' });
  window._player?.stop();
  pendingTtsMeta = null;
  curToolAction = null;
  isTtsActive = false;
  isServerTtsDone = true;
  finalizeAssistant();
  setBusyState(false);
  updateTtsUiState();
}
window.stopGeneration = stopGeneration;

function sendUserText(text, attachments = []) {
  const epoch = sessionEpoch;
  setTimeout(() => {
    if (epoch !== sessionEpoch) return; // 전환 전에 발생한 입력은 버린다
    sendUserTextForEpoch(text, attachments, epoch);
  }, 0);
}

function sendUserTextForEpoch(text, attachments, epoch) {
  if (epoch !== sessionEpoch) return;
  const profile = getUserProfile();
  const sent = window._ws?.send({ type: 'user_text', text, attachments, userName: profile?.name || '' });
  if (!sent) {
    addNotice('서버 연결이 끊겨 메시지를 보내지 못했습니다. 다시 연결한 뒤 전송해 주세요.');
    return;
  }
  curGenStartTime = Date.now();
  commitDraft();
  isTtsActive = false;
  isServerTtsDone = true;
  closeExplanationPanel();
  const div = addBubble('user');
  renderUserBubble(div, text, attachments);
  appendChatHistoryItem({ role: 'user', text, attachments });
  updateSessionTitleIfNeeded(text || attachments[0]?.name || '자료 질문');
  showThinkingBubble(window._stage, attachments);
  const chatInput = $('#chat-input');
  if (chatInput) chatInput.focus();
}
window.sendUserText = sendUserText;

function addBubble(role) {
  chatLog.querySelector('.hero-empty-state')?.remove();
  chatLog.querySelector('.empty-state')?.remove();
  const inputFooter = $('#input-area-footer');
  if (inputFooter) inputFooter.style.display = '';
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  chatLog.appendChild(div);
  isAutoScrollLocked = true;
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function clearTurnWatchdog() {
  if (turnWatchdogId) {
    clearTimeout(turnWatchdogId);
    turnWatchdogId = null;
  }
}

function armTurnWatchdog() {
  clearTurnWatchdog();
  // 서버 스트림 무응답 상한(모델 공통 3분)보다 여유 있게 잡는다.
  const limitMs = 190000;
  turnWatchdogId = setTimeout(() => {
    turnWatchdogId = null;
    if (!isBusy) return;
    stopGeneration();
    showErrorNotice('오류가 발생했습니다.', `서버 응답이 ${Math.round(limitMs / 1000)}초 동안 없었습니다.`);
  }, limitMs);
}

function handleStatus(state, stage) {
  if (state === 'thinking') {
    armTurnWatchdog();
    showThinkingBubble(stage);
  } else if (state === 'speaking') {
    // 응답이 도착했으므로 무응답 감시는 해제한다.
    clearTurnWatchdog();
    setBusyState(true);
  } else if (state === 'idle') {
    clearTurnWatchdog();
    setBusyState(false);
    if (curBubble && !curRawText.trim() && !curThinkText.trim() && !curCards.length && !curToolAction) {
      finalizeAssistant();
    }
  }
}

function showThinkingBubble(stage, attachments = []) {
  setBusyState(true);
  if (attachments && attachments.length > 0) curHasAttachments = true;
  if (!curBubble) {
    curBubble = addBubble('assistant');
    curBubble.classList.add('streaming', 'thinking');
    curRawText = '';
    curThinkText = '';
    curThinkStartTime = Date.now();
    curThinkDurationSec = null;
    curCards = [];
    curToolAction = null;
    renderCurrentBubble();
  }
  // 본문이 나오기 전까지 1초마다 "생각 중 (N초)"를 갱신한다.
  if (!curThinkTimerId) {
    curThinkTimerId = setInterval(() => {
      if (curBubble && isBusy && !curRawText.trim()) {
        renderCurrentBubble();
      } else if (curThinkTimerId) {
        clearInterval(curThinkTimerId);
        curThinkTimerId = null;
      }
    }, 1000);
  }
  if (stage) stage.setEmotion('think');
}

function appendAssistantThink(text) {
  if (!text) return;
  setBusyState(true);
  if (!curBubble) {
    curBubble = addBubble('assistant');
    curBubble.classList.add('streaming', 'thinking');
    curCards = [];
  }
  if (!curThinkStartTime) {
    curThinkStartTime = Date.now();
    curThinkDurationSec = null;
  }
  curThinkText += text;

  // 실시간 생각 초 타이머 (1초마다 UI 업데이트)
  if (!curThinkTimerId) {
    curThinkTimerId = setInterval(() => {
      if (curBubble && isBusy && !curRawText.trim()) {
        renderCurrentBubble();
      } else if (curThinkTimerId) {
        clearInterval(curThinkTimerId);
        curThinkTimerId = null;
      }
    }, 1000);
  }

  renderCurrentBubble();
}

function appendAssistant(text) {
  if (!text) return;
  if (!curRawText && !text.trim()) return; // §11: 선행 공백만으로 빈 답변 시작 방지
  setBusyState(true);
  if (!curBubble) {
    curBubble = addBubble('assistant');
    curBubble.classList.add('streaming');
    curCards = [];
  }
  curBubble.classList.remove('thinking');

  // 본문 답변 스트리밍이 시작되는 순간 생각 타이머 정지 및 소요 시간 확정
  if (curThinkTimerId) {
    clearInterval(curThinkTimerId);
    curThinkTimerId = null;
  }
  if (curThinkStartTime && curThinkDurationSec === null) {
    curThinkDurationSec = Math.max(1, Math.round((Date.now() - curThinkStartTime) / 1000));
  }

  curRawText += text;
  renderCurrentBubble();
}

function getToolStatusSvg(name) {
  switch (name) {
    case 'python_execute':
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
    case 'web_search':
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;
    case 'calculator':
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 11h10"/><path d="M12 7v8"/></svg>`;
    case 'search_rag':
    case 'read_file':
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>`;
    default:
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  }
}

function renderCurrentBubble() {
  if (!curBubble) return;
  let html = '';
  const thinkTrimmed = curThinkText.trim();
  const hasAnswer = Boolean(curRawText.trim());
  const hasCards = curCards.length > 0;
  const isStreaming = isBusy || curBubble.classList.contains('streaming');

  // 1) 생각 과정 (<think>) - 기본적으로 항상 닫힘(closed by default)
  if (thinkTrimmed) {
    const isThinkingNow = !hasAnswer && !hasCards && !curToolAction && isStreaming;
    const prevDetails = curBubble.querySelector('.think-details');
    const userToggled = prevDetails?.dataset?.userToggled === 'true';
    const isOpen = userToggled ? prevDetails.hasAttribute('open') : false;

    let summaryHtml = '';
    if (isThinkingNow) {
      const elapsed = curThinkStartTime ? Math.max(1, Math.round((Date.now() - curThinkStartTime) / 1000)) : 1;
      summaryHtml = `<span class="thinking-indicator"><span class="thinking-icon">${getToolStatusSvg('think')}</span><span>생각 중 (${elapsed}초)</span><span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></span>`;
    } else {
      const sec = curThinkDurationSec || (curThinkStartTime ? Math.max(1, Math.round((Date.now() - curThinkStartTime) / 1000)) : null);
      const labelText = sec ? `${sec}초 동안 생각함` : '생각 과정 보기';
      summaryHtml = `<span class="think-summary-label">${labelText}</span><span class="think-toggle-icon">▾</span>`;
    }

    const openAttr = isOpen ? ' open' : '';
    const userToggledAttr = userToggled ? ' data-user-toggled="true"' : '';
    html += `<details class="think-details"${openAttr}${userToggledAttr}><summary>${summaryHtml}</summary><div class="think-body">${escapeHtml(thinkTrimmed)}</div></details>`;
  }

  // 2) 실행 완료된 도구 카드 (웹 검색 결과, 계산기, 파이썬 그래프 등)
  if (hasCards) {
    html += `<div class="tool-cards-wrapper">${curCards.join('')}</div>`;
  }

  // 3) 답변 마크다운 본문
  if (hasAnswer) {
    const sanitizedText = curRawText
      .replace(/\[(?:TOOL:\s*)?[a-zA-Z_]+\s*\{[\s\S]*?\}\s*\]?/gi, '')
      .replace(/\[TOOL:[^\]\n]*\]?/gi, '')
      .replace(/\[(?:open_explanation|close_explanation|web_search|calculator|python_execute|start_quiz|create_flashcards|start_study_timer|plot_function_graph)[^\]\n]*\]?/gi, '')
      .replace(/\[(?:smile|think|cheer|sad|wink|love|neutral|focus|proud|fighting|shy|panic|curious|dozeoff|relieved|pout|whisper|sparkle|spaceout|nod|shake|wave|clap|dance|explain|surprise|joy|angry|sleepy|wakeup|greet)\]?/gi, '')
      .replace(/^\s*\[(?:TOOL:\s*)?[a-zA-Z_]+(?:\s*\.{3})?\s*/i, '');
    html += `<div class="msg-markdown">${renderMarkdown(sanitizedText)}</div>`;
  }

  // 4) 현재 실행 중인 도구 또는 스트리밍/생각 중 인디케이터 (ChatGPT 스타일 무채색)
  if (isStreaming) {
    if (curToolAction) {
      const icon = getToolStatusSvg(curToolAction.name);
      const margin = (hasCards || hasAnswer) ? 'style="margin-top: 8px;"' : '';
      html += `<div class="action-running-indicator" ${margin}><span class="action-running-icon">${icon}</span><span>${escapeHtml(curToolAction.message)}</span><span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
    } else if (hasCards && !hasAnswer) {
      html += `<div class="action-running-indicator" style="margin-top: 8px;"><span class="action-running-icon">${getToolStatusSvg('think')}</span><span>결과를 분석하여 답변 작성 중</span><span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
    } else if (hasCards && hasAnswer) {
      html += `<div class="thinking-indicator streaming-tail"><span class="thinking-icon">${getToolStatusSvg('think')}</span><span>답변 작성 중</span><span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
    } else if (!hasCards && !hasAnswer && !thinkTrimmed) {
      const elapsed = curThinkStartTime ? Math.max(1, Math.round((Date.now() - curThinkStartTime) / 1000)) : 0;
      const label = `${curHasAttachments ? '첨부자료 분석 및 생각 중' : '생각 중'}${elapsed ? ` (${elapsed}초)` : ''}`;
      html += `<div class="thinking-indicator"><span class="thinking-icon">${getToolStatusSvg('think')}</span><span>${label}</span><span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
    } else if (!hasCards && hasAnswer) {
      html += `<span class="streaming-dots thinking-dots"><span>.</span><span>.</span><span>.</span></span>`;
    }
  }

  let capsule = curBubble.querySelector('.assistant-bubble-capsule');
  if (!capsule) {
    capsule = document.createElement('div');
    capsule.className = 'assistant-bubble-capsule';
    curBubble.prepend(capsule);
  }
  capsule.innerHTML = html;
  if (isAutoScrollLocked) {
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

function attachQuickQuizChoicesIfDetected(bubble, text) {
  if (!bubble || !text) return;
  if (bubble.querySelector('.quick-quiz-choices')) return;

  const lines = text.split('\n');
  const optionMatches = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(/^(?:([1-4])\s*[\)\.\:]|([\u2460-\u2463]))\s*(.+)$/);
    if (m) {
      const num = m[1] ? parseInt(m[1], 10) : (m[2].charCodeAt(0) - 0x2460 + 1);
      optionMatches.push({ num, text: m[3] });
    }
  }

  if (optionMatches.length >= 2 && optionMatches.length <= 5) {
    const capsule = bubble.querySelector('.assistant-bubble-capsule');
    if (!capsule) return;
    const bar = document.createElement('div');
    bar.className = 'quick-quiz-choices';
    bar.innerHTML = '<span style="font-size:11.5px; color:var(--text-dim); width:100%; margin-bottom:2px;">👆 정답 선택 버튼:</span>';
    optionMatches.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quick-quiz-btn';
      btn.innerHTML = `<span><strong>${opt.num}번</strong> ${escapeHtml(opt.text.slice(0, 18))}</span>`;
      btn.onclick = () => {
        if (window.sendUserText) {
          window.sendUserText(`${opt.num}번이(가) 정답인 것 같아! 맞아?`);
        }
      };
      bar.appendChild(btn);
    });
    capsule.appendChild(bar);
  }
}

function speakMiku(text) {
  if (!document.querySelector('#miku-voice-toggle')?.checked || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(String(text).replace(/[`*_#]/g, '').slice(0, 3000));
  utterance.lang = 'ko-KR';
  utterance.rate = 1;
  utterance.volume = Number(document.querySelector('#tts-volume-slider')?.value || 70) / 100;
  speechSynthesis.speak(utterance);
}
function finalizeAssistant(meta = null) {
  setBusyState(false);
  if (curThinkTimerId) {
    clearInterval(curThinkTimerId);
    curThinkTimerId = null;
  }
  if (curThinkStartTime && curThinkDurationSec === null && curThinkText.trim()) {
    curThinkDurationSec = Math.max(1, Math.round((Date.now() - curThinkStartTime) / 1000));
  }
  if (curBubble) {
    curBubble.classList.remove('streaming', 'thinking');
    if (!curRawText.trim() && !curThinkText.trim() && !curCards.length && !curToolAction) {
      curBubble.remove();
      refreshEmptyState();
    } else {
      const durationSec = meta?.durationSec !== undefined && meta?.durationSec !== null
        ? meta.durationSec
        : (curGenStartTime ? Number(((Date.now() - curGenStartTime) / 1000).toFixed(1)) : null);
      const tokens = meta?.tokens || (curRawText.trim() ? { total: Math.max(1, Math.round(curRawText.length / 2.5) + 60) } : null);

      curRawText = curRawText
        .replace(/\[(?:TOOL:\s*)?[a-zA-Z_]+\s*\{[\s\S]*?\}\s*\]?/gi, '')
        .replace(/\[TOOL:[^\]\n]*\]?/gi, '')
        .replace(/\[(?:open_explanation|close_explanation|web_search|calculator|python_execute|start_quiz|create_flashcards|start_study_timer|plot_function_graph)[^\]\n]*\]?/gi, '')
        .replace(/\[(?:smile|think|cheer|sad|wink|love|neutral|focus|proud|fighting|shy|panic|curious|dozeoff|relieved|pout|whisper|sparkle|spaceout|nod|shake|wave|clap|dance|explain|surprise|joy|angry|sleepy|wakeup|greet)\]?/gi, '')
        .replace(/^\s*\[(?:TOOL:\s*)?[a-zA-Z_]+(?:\s*\.{3})?\s*/i, '')
        .trim();
      renderCurrentBubble();
      speakMiku(curRawText);
      if (!curCards.some((c) => c.includes('quiz-card')) && curRawText) {
        attachQuickQuizChoicesIfDetected(curBubble, curRawText);
      }
      attachAssistantActions(curBubble, curRawText, { durationSec, tokens });
      appendChatHistoryItem({
        role: 'assistant',
        text: curRawText,
        think: curThinkText.trim(),
        thinkDuration: curThinkDurationSec,
        cardsHtml: curCards.join(''),
        durationSec,
        tokens,
      });
    }
    curBubble = null;
    curRawText = '';
    curThinkText = '';
    curThinkStartTime = null;
    curThinkDurationSec = null;
    curGenStartTime = null;
    curCards = [];
    curToolAction = null;
    curHasAttachments = false;
  }
}

function showErrorNotice(text, detail) {
  if (!text) return;
  // 오류 시점에 진행 중이던 말풍선을 확정한다(빈 말풍선은 제거, 부분 답변은 보존).
  finalizeAssistant();
  window._stage?.setSpeaking(false);

  const div = document.createElement('div');
  div.className = 'msg assistant error-notice';
  div.innerHTML = `
    <div class="error-notice-card" role="alert">
      <span class="error-notice-icon" aria-hidden="true">!</span>
      <div class="error-notice-body">
        <div class="error-notice-text">${escapeHtml(text)}</div>
        ${detail ? `<div class="error-notice-detail">${escapeHtml(detail)}</div>` : ''}
      </div>
      <button type="button" class="error-notice-retry" title="다시 시도">다시 시도</button>
    </div>
  `;
  div.querySelector('.error-notice-retry')?.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerLoopback(div);
  });

  chatLog.appendChild(div);
  if (isAutoScrollLocked) {
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}
window.showErrorNotice = showErrorNotice;

function addNotice(text) {
  window.addNotice = addNotice;
  const div = document.createElement('div');
  div.className = 'msg assistant notice';

  const isErrorNotice = text.includes('오류') || text.includes('실패') || text.includes('에러') || text.includes('점검') || text.includes('시도');

  div.innerHTML = `
    <div class="notice-content">${escapeHtml(text)}</div>
    ${isErrorNotice ? `
      <div class="notice-actions">
        <button type="button" class="notice-loopback-btn" title="이전 질문 다시 시도">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
          <span>다시 시도</span>
        </button>
      </div>
    ` : ''}
  `;

  div.querySelector('.notice-loopback-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerLoopback(div);
  });

  chatLog.appendChild(div);
  if (isAutoScrollLocked) {
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

// ---- 목표 / 자료 / 검색 결과 ----
function updateGoalDisplay(text) {
  const clean = (text || '').trim();
  if (goalCurrent) goalCurrent.textContent = clean ? `🚩 ${clean}` : '설정된 목표가 없습니다.';
  // 목표가 있으면 깃발 아이콘을 채워서 표시 + 툴팁에 목표 노출
  if (goalBtn) {
    goalBtn.classList.toggle('has-goal', Boolean(clean));
    goalBtn.title = clean ? `오늘의 목표: ${clean}` : '오늘의 목표 설정';
  }
}

async function loadGoal() {
  const requestSession = sessionId;
  const localGoal = pget(goalKey(requestSession)) || '';
  updateGoalDisplay(localGoal);
  try {
    const res = await apiFetch('/api/goal', {}, { sessionId: requestSession, scope: accountScope });
    const data = await res.json();
    if (requestSession !== sessionId) return; // 응답 도중 세션이 바뀌면 다른 세션 화면을 덮지 않는다
    if (data.goal?.content) {
      updateGoalDisplay(data.goal.content);
      pset(goalKey(requestSession), data.goal.content);
    } else {
      updateGoalDisplay('');
      premove(goalKey(requestSession));
    }
  } catch {
    if (requestSession === sessionId && !localGoal) {
      updateGoalDisplay('');
    }
  }
}

function renderRecall(msg) {
  if (!msg.hits.length) return;
  addNotice(`기억 검색 결과: ${msg.hits.map((h) => h.content).join(' / ')}`);
}

function renderRagResult(msg) {
  const ragResults = $('#rag-results');
  if (!ragResults) return;
  ragResults.innerHTML = '';
  if (!msg.hits.length) {
    ragResults.innerHTML = '<div class="note">검색 결과 없음 (Chroma 서버 실행 필요: chroma run --path ./chroma)</div>';
    return;
  }
  for (const hit of msg.hits) {
    const div = document.createElement('div');
    div.className = 'hit';
    div.innerHTML = `<strong>${hit.metadata?.source || '자료'}</strong> (유사도 ${(hit.score ?? 0).toFixed(2)})<br/>${escapeHtml(hit.document)}`;
    ragResults.appendChild(div);
  }
}

// ---- 모달 제어 ----
function openModal(overlayId) {
  const overlay = $(`#${overlayId}`);
  if (overlay) overlay.classList.add('open');
}

// ---- Live2D 상태 배지 & 시점 토글 ----
function setAvatarStatus(statusText, isPulse = true) {
  const el = $('#avatar-status-text');
  const dot = $('#status-pulse-dot');
  if (el) el.textContent = statusText;
  if (dot) {
    dot.style.display = isPulse ? 'inline-block' : 'none';
    if (statusText === '생각 중...') {
      dot.style.background = '#f59e0b';
      dot.style.boxShadow = '0 0 6px #f59e0b';
    } else if (statusText === '답변 중...') {
      dot.style.background = '#3b82f6';
      dot.style.boxShadow = '0 0 6px #3b82f6';
    } else if (statusText === '듣고 있어요...') {
      dot.style.background = '#8b5cf6';
      dot.style.boxShadow = '0 0 6px #8b5cf6';
    } else {
      dot.style.background = '#10a37f';
      dot.style.boxShadow = '0 0 6px #10a37f';
    }
  }
}

function getAvatarDisplayName(modelId) {
  const id = (modelId || '').toLowerCase();
  if (id === 'haru') return '하루';
  if (id.includes('hiyori')) return '히요리';
  if (id.includes('yinlang') || id.includes('silverwolf')) return '은랑';
  if (id.includes('senko')) return '센코';
  if (id.includes('miku')) return '미쿠';
  const found = avatarModels.find((m) => m.id === modelId);
  return found?.name ? found.name.split('(')[0].trim() : '미쿠';
}

function updatePromptPlaceholder(name) {
  const charName = name || getAvatarDisplayName(currentModelId);
  const placeholder = `${charName}에게 물어보세요...`;
  const chatInput = $('#chat-input');
  if (chatInput) chatInput.placeholder = placeholder;
  const heroInput = $('#hero-chat-input');
  if (heroInput) heroInput.placeholder = placeholder;
}

function updateAvatarBadge(modelId) {
  const nameText = $('#avatar-name-text');
  const displayName = getAvatarDisplayName(modelId);
  if (nameText) nameText.textContent = displayName;
  updatePromptPlaceholder(displayName);
}

function updateViewToggleUI(mode) {
  const isBust = mode === 'bust';
  const icon = $('#view-toggle-icon');
  const text = $('#view-toggle-text');
  if (icon) {
    icon.innerHTML = isBust
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/></svg>`;
  }
  if (text) text.textContent = isBust ? '상반신' : '전신';
}

// ---- 상단 유틸리티 바 (음량 슬라이더 & 원클릭 테마 전환) ----
function setupTopControls() {
  const volumeSlider = $('#tts-volume-slider');
  $('#miku-stop-voice')?.addEventListener('click', () => speechSynthesis.cancel());
  $('#miku-avatar-toggle')?.addEventListener('change', e => { const col = $('#avatar-column'); if (col) col.style.display = e.target.checked ? '' : 'none'; });
  $('#miku-voice-toggle')?.addEventListener('change', e => { if (!e.target.checked && 'speechSynthesis' in window) speechSynthesis.cancel(); });
  if (volumeSlider) {
    const savedVol = localStorage.getItem('miku_tts_volume');
    if (savedVol !== null) {
      volumeSlider.value = savedVol;
      setMasterVolume(Number(savedVol) / 100);
    }
    volumeSlider.addEventListener('input', () => {
      const val = Number(volumeSlider.value);
      setMasterVolume(val / 100);
      try { localStorage.setItem('miku_tts_volume', String(val)); } catch {}
    });
  }

  $('#theme-switch-toggle')?.addEventListener('change', (e) => {
    applyTheme(e.target.checked ? 'light' : 'dark');
  });

  $('#btn-theme-quick-toggle')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  $('#btn-view-toggle')?.addEventListener('click', () => {
    if (window._stage) {
      const next = window._stage.toggleViewMode();
      updateViewToggleUI(next);
    }
  });

  $('#btn-stop-tts')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopTts();
  });
}

// ---- 좌측 사이드바 & 히어로: 공부 도구 5종 실제 대화형 인터랙션 ----
let studyToolsManager = null;
function setupStudyTools(ws) {
  studyToolsManager = new StudyToolsManager({
    wsClient: ws,
    stageGetter: () => window._stage,
    sessionIdGetter: () => sessionId,
    chatHistoryGetter: () => loadChatHistory(sessionId),
  });
  window._studyTools = studyToolsManager;
  studyToolsManager.init();
}

function triggerSmoothResize(durationMs = 350) {
  const start = performance.now();
  const step = (now) => {
    window.dispatchEvent(new Event('resize'));
    if (now - start < durationMs) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

// ---- 좌측 사이드바 제어 ----
function setSidebarCollapsed(collapsed) {
  const layoutEl = $('#main-layout');
  const expandBtn = $('#btn-sidebar-expand');
  layoutEl?.classList.toggle('sidebar-collapsed', collapsed);
  if (expandBtn) expandBtn.hidden = !collapsed;
  triggerSmoothResize(350);
}

function setupSidebar() {
  const collapseBtn = $('#btn-sidebar-collapse');
  const expandBtn = $('#btn-sidebar-expand');
  const newBtn = $('#btn-new-session');
  const nextDemoBtn = $('#btn-next-demo-user');

  collapseBtn?.addEventListener('click', () => {
    autoCollapsedLeftSidebar = false;
    setSidebarCollapsed(true);
  });
  // 칠판이 열린 상태에서 직접 펼치면 둘을 공존시킨다.
  expandBtn?.addEventListener('click', () => {
    autoCollapsedLeftSidebar = false;
    setSidebarCollapsed(false);
  });
  newBtn?.addEventListener('click', () => void startNewChat());
  nextDemoBtn?.addEventListener('click', (e) => window._handleNextVisitor?.(e));
}

// ---- 사이드바 / Live2D / 채팅창 크기 조절 (Resizer) ----
function setupResizers() {
  const resizerSidebar = $('#resizer-sidebar');
  const resizerAvatar = $('#resizer-avatar');
  const avatarColEl = $('.avatar-column');

  // 로컬 스토리지에 저장된 너비 복원
  try {
    const savedSidebar = localStorage.getItem('miku_sidebar_width');
    if (savedSidebar) {
      const w = parseInt(savedSidebar, 10);
      if (w >= 160 && w <= 600) {
        document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
      }
    }
    const savedAvatar = localStorage.getItem('miku_avatar_width');
    if (savedAvatar) {
      const w = parseInt(savedAvatar, 10);
      if (w >= 200 && w <= 1400) {
        document.documentElement.style.setProperty('--avatar-col', `${w}px`);
      }
    }
    const savedExp = localStorage.getItem('miku_explanation_width');
    if (savedExp) {
      const w = parseInt(savedExp, 10);
      if (w >= 280 && w <= 1400) {
        document.documentElement.style.setProperty('--explanation-width', `${w}px`);
      }
    }
  } catch {}

  let rafId = null;
  const notifyResize = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      window.dispatchEvent(new Event('resize'));
    });
  };

  // 1. 사이드바 너비 조절기
  if (resizerSidebar) {
    let isDragging = false;

    resizerSidebar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      isDragging = true;
      resizerSidebar.setPointerCapture(e.pointerId);
      resizerSidebar.classList.add('resizing');
      document.body.classList.add('resizing-col');
    });

    resizerSidebar.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const maxSidebar = Math.min(500, window.innerWidth - 550);
      const clamped = Math.max(160, Math.min(Math.round(e.clientX), Math.max(160, maxSidebar)));
      document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
      notifyResize();
    });

    const endSidebarDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      try { resizerSidebar.releasePointerCapture(e.pointerId); } catch {}
      resizerSidebar.classList.remove('resizing');
      document.body.classList.remove('resizing-col');
      const val = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10);
      if (!isNaN(val)) {
        try { localStorage.setItem('miku_sidebar_width', String(val)); } catch {}
      }
      notifyResize();
    };

    resizerSidebar.addEventListener('pointerup', endSidebarDrag);
    resizerSidebar.addEventListener('pointercancel', endSidebarDrag);

    // 더블클릭 시 기본값 (260px) 복원
    resizerSidebar.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--sidebar-width', '260px');
      try { localStorage.removeItem('miku_sidebar_width'); } catch {}
      notifyResize();
    });
  }

  // 2. 아바타 / 대화창 너비 조절기
  if (resizerAvatar && avatarColEl) {
    let isDragging = false;

    resizerAvatar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      isDragging = true;
      resizerAvatar.setPointerCapture(e.pointerId);
      resizerAvatar.classList.add('resizing');
      document.body.classList.add('resizing-col');
    });

    resizerAvatar.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const curLeft = avatarColEl.getBoundingClientRect().left;
      const newWidth = Math.round(e.clientX - curLeft);
      // 최소 200px, 우측 대화창 최소 320px 확보
      const maxAvatar = Math.max(200, window.innerWidth - curLeft - 320);
      const clamped = Math.max(200, Math.min(newWidth, maxAvatar));
      document.documentElement.style.setProperty('--avatar-col', `${clamped}px`);
      notifyResize();
    });

    const endAvatarDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      try { resizerAvatar.releasePointerCapture(e.pointerId); } catch {}
      resizerAvatar.classList.remove('resizing');
      document.body.classList.remove('resizing-col');
      const val = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--avatar-col'), 10);
      if (!isNaN(val)) {
        try { localStorage.setItem('miku_avatar_width', String(val)); } catch {}
      }
      notifyResize();
    };

    resizerAvatar.addEventListener('pointerup', endAvatarDrag);
    resizerAvatar.addEventListener('pointercancel', endAvatarDrag);

    // 더블클릭 시 기본값 (380px) 복원
    resizerAvatar.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--avatar-col', '380px');
      try { localStorage.removeItem('miku_avatar_width'); } catch {}
      notifyResize();
    });
  }

  // 3. 우측 칠판 / 도구 결과 사이드바 너비 조절기
  const resizerExplanation = $('#resizer-explanation');
  const boardBodyEl = $('#board-body');

  if (resizerExplanation && boardBodyEl) {
    let isDragging = false;

    resizerExplanation.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      isDragging = true;
      resizerExplanation.setPointerCapture(e.pointerId);
      resizerExplanation.classList.add('resizing');
      document.body.classList.add('resizing-col');
    });

    resizerExplanation.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const boardRect = boardBodyEl.getBoundingClientRect();
      const newWidth = Math.round(boardRect.right - e.clientX);
      // 최소 280px, 좌측 대화창 최소 320px 공간 보장
      const maxExp = Math.max(280, boardRect.width - 320);
      const clamped = Math.max(280, Math.min(newWidth, maxExp));
      document.documentElement.style.setProperty('--explanation-width', `${clamped}px`);
      notifyResize();
    });

    const endExpDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      try { resizerExplanation.releasePointerCapture(e.pointerId); } catch {}
      resizerExplanation.classList.remove('resizing');
      document.body.classList.remove('resizing-col');
      const val = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--explanation-width'), 10);
      if (!isNaN(val)) {
        try { localStorage.setItem('miku_explanation_width', String(val)); } catch {}
      }
      notifyResize();
    };

    resizerExplanation.addEventListener('pointerup', endExpDrag);
    resizerExplanation.addEventListener('pointercancel', endExpDrag);

    // 더블클릭 시 기본값 (460px) 복원
    resizerExplanation.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--explanation-width', '460px');
      try { localStorage.removeItem('miku_explanation_width'); } catch {}
      notifyResize();
    });
  }
}


// ---- 목표 모달 ----
function setupGoalModal() {
  const overlay = $('#goal-modal-overlay');
  const openBtns = [$('#btn-goal-edit')];
  const closeBtn = $('#btn-close-goal');

  const open = () => {
    overlay.classList.add('open');
    goalInput?.focus();
  };
  const close = () => {
    overlay.classList.remove('open');
  };

  openBtns.forEach((btn) => btn?.addEventListener('click', open));
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}

// ---- TTS 프로바이더 설정 (기기/세션별 독립 설정 & GPT-SoVITS 백그라운드 상시 가동 연동) ----
const TTS_DEVICE_KEY = 'miku_tts_provider';
const sessionTtsKey = (sid = sessionId) => `miku_tts_provider_${sid}`;

// GPT-SoVITS 사용을 중단해 TTS는 Supertonic 단일 엔진으로 고정한다.
function getActiveTtsProvider(_sid = sessionId) {
  return 'supertonic';
}

function setActiveTtsProvider(_provider, notifyServer = true) {
  const clean = 'supertonic';
  try {
    localStorage.setItem(TTS_DEVICE_KEY, clean);
  } catch {}

  syncTtsButtons(clean);

  if (notifyServer && window._ws) {
    window._ws.send({ type: 'set_tts_provider', provider: clean });
  }
}

function syncTtsButtons(cur = getActiveTtsProvider()) {
  document.querySelectorAll('.tts-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.ttsValue === cur);
  });
}

function updateTtsStateUi(state) {
  if (!state) return;
  const statusEl = $('#tts-engine-status-text');
  syncTtsButtons('supertonic');
  if (!statusEl) return;
  statusEl.className = 'tts-status-badge running';
  statusEl.textContent = '● Supertonic-3 활성화됨 (기본 초경량 온디바이스 음성)';
}

// ---- 설정 모달 (테마 전환, TTS 모델 변경, Bonsai 절전 토글 및 전체 세션 삭제) ----
function setupSettingsModal() {
  const overlay = $('#settings-modal-overlay');
  const openBtn = $('#btn-open-settings');
  const closeBtn = $('#btn-close-settings');
  const deleteAllBtn = $('#btn-delete-all-sessions');
  const resetRow = $('#setting-row-reset-session');

  syncBonsaiSleepToggles(bonsaiSleepEnabled);
  syncTtsButtons(getActiveTtsProvider());

  const syncResetRowVisibility = () => {
    const authUser = getAuthenticatedUser();
    if (resetRow) {
      resetRow.style.display = authUser?.role === 'demo' ? 'none' : 'flex';
    }
  };
  syncResetRowVisibility();

  const open = () => {
    syncBonsaiSleepToggles(bonsaiSleepEnabled);
    syncTtsButtons(getActiveTtsProvider());
    syncResetRowVisibility();
    if (window._ws) {
      window._ws.send({ type: 'get_tts_state' });
    }
    overlay?.classList.add('open');
  };
  const close = () => overlay?.classList.remove('open');

  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.querySelectorAll('.theme-opt').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeValue));
  });

  document.querySelectorAll('.tts-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      setActiveTtsProvider(btn.dataset.ttsValue, true);
    });
  });

  $('#btn-test-current-tts')?.addEventListener('click', () => {
    if (window._ws) {
      window._ws.send({
        type: 'test_tts',
        text: '안녕하세요! 현재 설정된 음성 모델 테스트입니다.',
      });
    }
  });

  $('#toggle-bonsai-sleep')?.addEventListener('change', (e) => {
    setBonsaiSleep(e.target.checked);
  });

  deleteAllBtn?.addEventListener('click', async () => {
    if (await deleteAllSessions()) close();
  });
}

// ---- 사용자 프로필 설정 (이름 & 아바타 사진) ----
const PROFILE_NAME_KEY = 'agy_user_name';
const PROFILE_AVATAR_KEY = 'agy_user_avatar';
const DEFAULT_USER_NAME = 'User';

const DEFAULT_AVATAR_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
const DEFAULT_AVATAR_SVG_LARGE = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

function getUserProfile() {
  let name = DEFAULT_USER_NAME;
  let avatar = '';
  try {
    // 시연 참가자 이름은 그 참가자의 세션에만 남긴다.
    const profileScope = getAuthenticatedUser()?.role === 'demo'
      ? accountStore.forSession(sessionId)
      : accountStore;
    const savedName = profileScope.getItem(PROFILE_NAME_KEY);
    if (savedName && savedName.trim()) {
      name = savedName.trim();
    } else {
      const authUser = getAuthenticatedUser();
      // 시연 계정은 계정 이름 기본값이 아이디라서, 이름 등록 전까지는 호칭으로 쓰지 않는다
      if (authUser?.name && authUser.role !== 'demo') name = authUser.name;
    }
    avatar = profileScope.getItem(PROFILE_AVATAR_KEY) || '';
  } catch {}
  return { name, avatar };
}

function renderUserProfile() {
  const { name, avatar } = getUserProfile();
  const nameEl = $('#sidebar-profile-name');
  const avatarEl = $('#sidebar-profile-avatar');
  if (nameEl) nameEl.textContent = name;
  if (avatarEl) {
    if (avatar) {
      avatarEl.innerHTML = `<img src="${avatar}" alt="${escapeHtml(name)}" class="profile-img" />`;
    } else {
      avatarEl.innerHTML = DEFAULT_AVATAR_SVG;
    }
  }
}

function resizeImageToDataUrl(file, maxWidth = 256, maxHeight = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function setupProfileModal() {
  const overlay = $('#profile-modal-overlay');
  const openBtn = $('#btn-open-profile');
  const closeBtn = $('#btn-close-profile');
  const form = $('#profile-form');
  const nameInput = $('#profile-name-input');
  const previewEl = $('#profile-modal-avatar-preview');
  const fileInput = $('#profile-avatar-file');
  const resetAvatarBtn = $('#btn-reset-avatar');

  let pendingAvatar = '';

  const updatePreview = (dataUrl) => {
    if (!previewEl) return;
    if (dataUrl) {
      previewEl.innerHTML = `<img src="${dataUrl}" alt="미리보기" class="profile-img" />`;
    } else {
      previewEl.innerHTML = DEFAULT_AVATAR_SVG_LARGE;
    }
  };

  const open = () => {
    const current = getUserProfile();
    pendingAvatar = current.avatar;
    if (nameInput) {
      nameInput.value = current.name === DEFAULT_USER_NAME ? '' : current.name;
      nameInput.placeholder = DEFAULT_USER_NAME;
    }
    updatePreview(pendingAvatar);

    // 시연 계정 여부 확인하여 폼 잠금 및 안내 표시
    const user = getAuthenticatedUser();
    const isDemo = user?.role === 'demo';
    const profileModal = $('#profile-modal');
        const saveBtn = form?.querySelector('.save-btn');

    if (isDemo) {
      profileModal?.classList.add('demo-locked');
      if (nameInput) nameInput.disabled = true;
      if (fileInput) fileInput.disabled = true;
      if (resetAvatarBtn) resetAvatarBtn.disabled = true;
      if (saveBtn) saveBtn.disabled = true;
    } else {
      profileModal?.classList.remove('demo-locked');
      if (nameInput) nameInput.disabled = false;
      if (fileInput) fileInput.disabled = false;
      if (resetAvatarBtn) resetAvatarBtn.disabled = false;
      if (saveBtn) saveBtn.disabled = false;
    }

    overlay?.classList.add('open');
    if (!isDemo) nameInput?.focus();
  };

  const close = () => {
    overlay?.classList.remove('open');
    if (fileInput) fileInput.value = '';
  };

  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const resized = await resizeImageToDataUrl(file, 256, 256);
      pendingAvatar = resized;
      updatePreview(pendingAvatar);
    } catch (err) {
      console.error('이미지 읽기 실패:', err);
      alert('이미지를 불러오지 못했습니다.');
    } finally {
      fileInput.value = '';
    }
  });

  resetAvatarBtn?.addEventListener('click', () => {
    pendingAvatar = '';
    updatePreview('');
  });

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const user = getAuthenticatedUser();
    if (user?.role === 'demo') {
      close();
      return;
    }
    const rawName = nameInput?.value?.trim() || '';
    const finalName = rawName || DEFAULT_USER_NAME;
    try {
      pset(PROFILE_NAME_KEY, finalName);
      if (pendingAvatar) {
        pset(PROFILE_AVATAR_KEY, pendingAvatar);
      } else {
        premove(PROFILE_AVATAR_KEY);
      }
      window._ws?.send({ type: 'set_user_profile', name: finalName, avatar: pendingAvatar });
    } catch (err) {
      console.error('프로필 저장 실패:', err);
    }
    renderUserProfile();
    close();
  });
}

function closeModal(overlayId) {
  const overlay = $(`#${overlayId}`);
  if (overlay) overlay.classList.remove('open');
}

// ---- GPT 스타일 도구 및 사용 가이드 모달 ----
function showGuideToast(msg) {
  document.querySelectorAll('.guide-toast-container').forEach((el) => el.remove());
  const toast = document.createElement('div');
  toast.className = 'guide-toast-container';
  toast.innerHTML = `
    <div class="guide-toast">
      <span class="guide-toast-icon">✨</span>
      <span>${escapeHtml(msg)}</span>
    </div>
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    try { toast.remove(); } catch {}
  }, 2500);
}

function setupToolsGuideModal() {
  const overlay = $('#tools-guide-modal-overlay');
  const openBtn = $('#btn-open-tools-guide');
  const viewAllBtn = $('#btn-sidebar-view-all-tools');
  const guideBanner = $('#btn-open-tools-guide-banner');
  const closeBtn = $('#btn-close-tools-guide');

  const open = () => {
    overlay?.classList.add('open');
  };
  const close = () => {
    overlay?.classList.remove('open');
  };

  openBtn?.addEventListener('click', open);
  viewAllBtn?.addEventListener('click', open);
  guideBanner?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);

  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // ESC 키로 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay?.classList.contains('open')) {
      close();
    }
  });

  // 탭 전환
  const tabs = overlay?.querySelectorAll('.tools-guide-tab');
  const panes = overlay?.querySelectorAll('.tools-guide-tab-pane');
  tabs?.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      panes?.forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      const targetPane = $(`#pane-${tab.dataset.tab}`);
      targetPane?.classList.add('active');
    });
  });

  // 카테고리 필터
  const filterPills = overlay?.querySelectorAll('.filter-pill');
  const cards = overlay?.querySelectorAll('.tool-guide-card');
  filterPills?.forEach((pill) => {
    pill.addEventListener('click', () => {
      filterPills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      const filter = pill.dataset.filter;
      cards?.forEach((card) => {
        if (filter === 'all' || card.dataset.category === filter) {
          card.classList.remove('hidden');
        } else {
          card.classList.add('hidden');
        }
      });
    });
  });

  // 추천 질문 칩 클릭 시 질문 입력창 자동 입력 & 포커스
  overlay?.querySelectorAll('.prompt-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.dataset.prompt || chip.textContent.trim();
      const chatInput = $('#chat-input');
      if (chatInput) {
        chatInput.value = prompt;
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
        close();
        chatInput.focus();
        showGuideToast(`"${prompt}" 질문이 입력되었습니다! 전송(Enter)을 눌러보세요.`);
      }
    });
  });

  // 도구 바로 실행 버튼
  overlay?.querySelectorAll('.tool-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.directTool;
      close();
      if (tool === 'goal') {
        $('#goal-modal-overlay')?.classList.add('open');
      } else if (window._studyTools) {
        window._studyTools.openTool(tool);
      }
    });
  });
}

// ---- ChatGPT 스타일 모델 선택기 & Bonsai 라이프사이클 제어 ----
const LAST_LLM_KEY = 'miku_last_llm_model';
const THINK_ENABLED_KEY = 'miku_llm_think_mode';

function loadSavedThinkMode() {
  try {
    const saved = localStorage.getItem(THINK_ENABLED_KEY);
    if (saved !== null) return saved === 'true';
  } catch {}
  return false; // 기본값: 추론 꺼짐 (reasoning: { enabled: false })
}

let isThinkEnabled = loadSavedThinkMode();

function syncThinkToggles(enabled) {
  document.querySelectorAll('#toggle-dropdown-think, #hero-toggle-dropdown-think').forEach((t) => {
    if (t.checked !== enabled) t.checked = enabled;
  });
}

function setThinkMode(enabled) {
  isThinkEnabled = Boolean(enabled);
  try {
    localStorage.setItem(THINK_ENABLED_KEY, String(isThinkEnabled));
  } catch {}
  syncThinkToggles(isThinkEnabled);
  window._ws?.send({ type: 'set_think', enabled: isThinkEnabled });
}
window.setThinkMode = setThinkMode;

function getModelDisplayName(model) {
  return 'Gemini 2.5 Flash';
}

function getInitialLlmModel() {
  return 'gemini';
}

function saveLastLlmModel(model) {
  try {
    localStorage.setItem(LAST_LLM_KEY, 'gemini');
  } catch {}
}

let activeModel = getInitialLlmModel();
let isBonsaiRunning = false;
let isBonsaiLoading = false;

// Bonsai 자동 절전 설정 동기화 (설정 모달로 통합)
function syncBonsaiSleepToggles(enabled) {
  const toggleSettings = $('#toggle-bonsai-sleep');
  if (toggleSettings && toggleSettings.checked !== enabled) toggleSettings.checked = enabled;
}

function setBonsaiSleep(enabled) {
  bonsaiSleepEnabled = Boolean(enabled);
  try {
    localStorage.setItem('miku_bonsai_sleep_mode', String(bonsaiSleepEnabled));
  } catch {}
  syncBonsaiSleepToggles(bonsaiSleepEnabled);
  updateModelUI();
  window._ws?.send({ type: 'set_bonsai_sleep', enabled: bonsaiSleepEnabled, manual: true });
}
window.setBonsaiSleep = setBonsaiSleep;

function updateModelUI() {
  const modelText = getModelDisplayName(activeModel);

  // 모든 라벨 업데이트 (하단 바, 상단 헤더, 새 대화 히어로)
  document.querySelectorAll('#current-model-label, #hero-current-model-label, #header-current-model-label').forEach((el) => {
    el.textContent = modelText;
  });

  // AI 모델 드롭다운 active 체크 표시
  document.querySelectorAll('.model-dropdown-item[data-model]').forEach((item) => {
    item.classList.toggle('active', item.dataset.model === activeModel);
  });

  // 아바타 캐릭터 드롭다운 active 체크 표시
  document.querySelectorAll('.model-dropdown-item[data-avatar]').forEach((item) => {
    item.classList.toggle('active', item.dataset.avatar === currentModelId);
  });

  // 히어로 아바타 라벨 업데이트
  const heroAvatarLabel = $('#hero-current-avatar-label');
  if (heroAvatarLabel) {
    heroAvatarLabel.textContent = getAvatarDisplayName(currentModelId);
  }

  // 인디케이터 (초록색 점) 및 뱃지 업데이트
  let dotClass = 'model-status-dot';
  let text = '로컬';

  if (isBonsaiLoading) {
    dotClass = 'model-status-dot loading';
    text = '로딩중';
  } else if (isBonsaiRunning) {
    dotClass = 'model-status-dot active-green';
    text = '켜짐';
  } else {
    dotClass = 'model-status-dot';
    text = '꺼짐';
  }

  const shouldShowMainDot = activeModel === 'bonsai';
  document.querySelectorAll('#bonsai-indicator, #hero-bonsai-indicator, #header-bonsai-indicator').forEach((mainDot) => {
    mainDot.className = dotClass;
    mainDot.style.display = shouldShowMainDot ? 'inline-block' : 'none';
  });

  document.querySelectorAll('#bonsai-menu-dot, #hero-bonsai-menu-dot, #header-bonsai-menu-dot').forEach((menuDot) => {
    menuDot.className = dotClass;
  });

  document.querySelectorAll('#bonsai-badge-text, #hero-bonsai-badge-text, #header-bonsai-badge-text').forEach((badge) => {
    badge.textContent = text;
  });

  // 추론 토글 스위치 동기화
  syncThinkToggles(isThinkEnabled);
}

function handleLlmState(msg) {
  if (msg.activeModel) {
    activeModel = msg.activeModel;
    saveLastLlmModel(activeModel);
  }
  if (typeof msg.thinkEnabled === 'boolean') {
    isThinkEnabled = msg.thinkEnabled;
    try {
      localStorage.setItem(THINK_ENABLED_KEY, String(isThinkEnabled));
    } catch {}
    syncThinkToggles(isThinkEnabled);
  }
  isBonsaiRunning = Boolean(msg.bonsaiRunning);
  isBonsaiLoading = Boolean(msg.bonsaiLoading);
  if (typeof msg.bonsaiSleepEnabled === 'boolean') {
    bonsaiSleepEnabled = msg.bonsaiSleepEnabled;
    try {
      localStorage.setItem('miku_bonsai_sleep_mode', String(bonsaiSleepEnabled));
    } catch {}
    syncBonsaiSleepToggles(bonsaiSleepEnabled);
  }

  if (msg.reason === 'idle_timeout') {
    addNotice('Bonsai가 5분 동안 사용되지 않아 절전 모드(VRAM 반환)로 자동 전환되었습니다.');
  }

  updateModelUI();
}

function setupModelSelector(ws) {
  // 하단 바 모델 선택기 바인딩
  bindModelDropdown($('#model-selector-wrapper'), $('#btn-model-select'), $('#model-dropdown-menu'), ws);

  // 빈 대화 히어로 프롬프트 모델 선택기도 바인딩
  bindModelDropdown($('#hero-model-selector-wrapper'), $('#btn-hero-model-select'), $('#hero-model-dropdown-menu'), ws);

  // 초기 렌더링
  updateModelUI();
}

// ---- 설명 패널(칠판) 제어 ----
function setExplanationToolBadge(badge) {
  if (!explanationToolBadge) return;
  explanationToolBadge.textContent = badge || '';
  explanationToolBadge.hidden = !badge;
}

function openExplanationPanel(title, content, options = {}) {
  const wasHidden = explanationPanel.hasAttribute('hidden') || !boardBody.classList.contains('split-mode');

  // 칠판이 새로 열릴 때만 좌측 사이드바를 자동으로 접어 공간을 확보한다.
  if (wasHidden) {
    if ($('#main-layout')?.classList.contains('sidebar-collapsed')) {
      autoCollapsedLeftSidebar = false;
    } else {
      autoCollapsedLeftSidebar = true;
      setSidebarCollapsed(true);
    }
  }

  explanationPanel.removeAttribute('hidden');
  $('#resizer-explanation')?.removeAttribute('hidden');
  requestAnimationFrame(() => {
    boardBody.classList.add('split-mode');
  });

  setExplanationToolBadge(options.badge === undefined ? '칠판 판서' : options.badge);
  if (title) explanationTitle.textContent = title;
  explanationContent.innerHTML = options.html !== undefined ? options.html : renderMarkdown(content || '');
  if (wasHidden) explanationContent.scrollTop = 0;
  triggerSmoothResize(350);
}

function closeExplanationPanel() {
  explanationStreaming = false;
  boardBody.classList.remove('split-mode');

  setTimeout(() => {
    if (!boardBody.classList.contains('split-mode')) {
      explanationPanel.setAttribute('hidden', '');
      $('#resizer-explanation')?.setAttribute('hidden', '');
      explanationContent.innerHTML = '';
    }
  }, 320);

  // 자동으로 접혔던 좌측 사이드바만 되돌린다. (사용자가 직접 접은 경우는 유지)
  if (autoCollapsedLeftSidebar) {
    autoCollapsedLeftSidebar = false;
    setSidebarCollapsed(false);
  } else {
    triggerSmoothResize(350);
  }
}

// 채팅 요약 카드 + 칠판 본문을 함께 만드는 공통 카드 빌더
function buildBoardCard({
  cardClass = '',
  badge,
  title,
  icon = '',
  summaryHtml = '',
  boardHtml = '',
  extraAttrs = '',
  reopen = true,
}) {
  return `
    <div class="tool-card ${cardClass}" data-board-badge="${escapeHtml(badge)}" data-board-title="${escapeHtml(title)}"${extraAttrs}>
      <div class="tool-card-header tool-card-board-header">
        <div class="tool-card-title-group">
          ${icon}
          <span class="tool-badge">${escapeHtml(badge)}</span>
          <strong>${escapeHtml(title)}</strong>
        </div>
        ${reopen ? `<button type="button" class="btn-reopen-explanation" onclick="window.openBoardFromCard(this)" title="우측 칠판에 펼쳐보기">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          <span>칠판에 띄우기</span>
        </button>` : ''}
      </div>
      ${summaryHtml ? `<div class="tool-card-summary">${summaryHtml}</div>` : ''}
      <template class="board-view-payload">${boardHtml}</template>
    </div>
  `;
}

function pushToolCard(cardHtml) {
  curToolAction = null;
  getOrCreateAssistantContainer();
  curCards.push(cardHtml);
  renderCurrentBubble();
}

// 칠판을 닫아도 채팅 카드의 [칠판에 띄우기]로 언제든 다시 연다.
window.openBoardFromCard = function(btn) {
  const card = btn?.closest('.tool-card');
  if (!card) return;
  const title = card.dataset.boardTitle || '';
  const badge = card.dataset.boardBadge || '';

  if (card.dataset.boardKind === 'quiz') {
    const quizId = card.dataset.quizId;
    const quiz = window._activeQuizzes?.get(quizId);
    if (quiz) {
      openExplanationPanel(title, '', {
        badge,
        html: `<div class="board-tool-view"><div class="tool-card quiz-card" id="${escapeHtml(quizId)}">${buildQuizCardHtml(quizId, quiz.currentIndex)}</div></div>`,
      });
      return;
    }
  }

  const tpl = card.querySelector('template.board-view-payload');
  openExplanationPanel(title, '', { badge, html: tpl ? tpl.innerHTML : '' });
};

function renderExplanationCard(args) {
  const title = args?.title || '핵심 정리';
  const content = args?.content || '';
  const boardHtml = `<div class="board-tool-view">${renderMarkdown(content)}</div>`;
  const icon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="14" x="3" y="3" rx="2"/><path d="M7 21h10M12 17v4"/></svg>`;

  pushToolCard(buildBoardCard({
    cardClass: 'explanation-card',
    badge: '칠판 판서',
    title,
    icon,
    summaryHtml: '칠판에 정리한 내용을 펼쳐 볼 수 있어요.',
    boardHtml,
  }));

  openExplanationPanel(title, content, { badge: '칠판 판서' });
}

// 이전 버전 대화 기록에 남아 있는 칠판 카드도 계속 동작하도록 유지
window.reopenExplanation = function(btn) {
  const card = btn?.closest('.explanation-card');
  if (!card) return;
  const title = card.querySelector('.tool-card-title-group strong')?.textContent || '칠판 정리';
  const body = card.querySelector('.explanation-card-body');
  if (body) {
    openExplanationPanel(title, '', { badge: '칠판 판서', html: body.innerHTML });
  }
};

// ---- 도구 호출 처리 ----
const VALID_EMOTION_TAGS = new Set(['smile','think','cheer','sad','wink','neutral','love','focus','proud','fighting','shy','panic','curious','relieved','pout','whisper','sparkle','explain','surprise','joy','angry','sleepy','wakeup','greet','nod','shake','wave','clap','dance','dozeoff','spaceout']);

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getOrCreateAssistantContainer() {
  if (curBubble) return curBubble;
  curBubble = addBubble('assistant');
  curBubble.classList.add('streaming');
  return curBubble;
}

function handleToolStart(name, args, message) {
  setBusyState(true);
  getOrCreateAssistantContainer();
  if (curThinkTimerId) {
    clearInterval(curThinkTimerId);
    curThinkTimerId = null;
  }
  if (curThinkStartTime && curThinkDurationSec === null) {
    curThinkDurationSec = Math.max(1, Math.round((Date.now() - curThinkStartTime) / 1000));
  }
  curToolAction = { name, message: message || `${name} 실행 중...` };
  renderCurrentBubble();
}

function handleToolStartNotice(text) {
  let name = 'tool';
  if (text.includes('Python') || text.includes('파이썬') || text.includes('코드')) name = 'python_execute';
  else if (text.includes('검색')) name = 'web_search';
  else if (text.includes('계산')) name = 'calculator';
  handleToolStart(name, {}, text);
}

// 칠판 판서 스트리밍: JSON이 완성되기 전에도 들어오는 만큼 칠판에 바로 그린다
function handleToolPartial(name, title, text) {
  if (name !== 'open_explanation') return;
  if (!explanationStreaming) {
    explanationStreaming = true;
    handleToolStart('open_explanation', {}, '개념 칠판 정리 판서 중...');
    openExplanationPanel(title || '개념 정리', text || '', { badge: '칠판 판서' });
    return;
  }
  if (title) explanationTitle.textContent = title;
  if (text) explanationContent.innerHTML = renderMarkdown(text);
}

function renderWebSearchCard(args, result) {
  const query = args?.query || result?.query || '';
  if (query && curCards.some((c) => c.includes(`<strong>${escapeHtml(query)}</strong>`))) {
    return;
  }

  const results = result?.results || [];

  let summary = '';
  if (results.length > 0) {
    const hosts = [...new Set(results.map((r) => {
      try { return new URL(r.url).hostname; } catch { return ''; }
    }).filter(Boolean))].slice(0, 3);
    summary = `<strong>${results.length}건</strong>의 검색 결과${hosts.length ? ` · ${hosts.map(escapeHtml).join(', ')}` : ''}`;
  } else if (result?.error) {
    summary = `검색 오류: ${escapeHtml(result.error)}`;
  } else {
    summary = '검색 결과가 없습니다.';
  }

  let board = '<div class="board-tool-view">';
  if (results.length > 0) {
    board += '<ul class="search-result-list">';
    for (const item of results) {
      let hostname = '';
      try { hostname = new URL(item.url).hostname; } catch {}
      board += `
        <li class="search-result-item">
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="search-result-title">
            <span>${escapeHtml(item.title || item.url)}</span>
            ${hostname ? `<span class="search-result-host">${escapeHtml(hostname)}</span>` : ''}
          </a>
          <p class="search-result-snippet">${escapeHtml(item.snippet || '')}</p>
        </li>
      `;
    }
    board += '</ul>';
  } else if (result?.error) {
    board += `<div class="tool-card-error">검색 오류: ${escapeHtml(result.error)}</div>`;
  } else {
    board += `<div class="tool-card-empty">검색 결과가 없습니다.</div>`;
  }
  board += '</div>';

  const title = query || '웹 검색';
  pushToolCard(buildBoardCard({
    cardClass: 'web-search-card',
    badge: '웹 검색',
    title,
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
    summaryHtml: summary,
    boardHtml: board,
  }));

  openExplanationPanel(title, '', { badge: '웹 검색', html: board });
}

function renderCalculatorCard(args, result) {
  const expr = args?.expression || result?.expression || '';
  const res = result?.result !== undefined ? result.result : (result?.error || '계산 오류');
  const title = expr || '수식 계산';

  const board = `
    <div class="board-tool-view">
      <div class="board-calc-block">
        <div class="board-calc-expr">${escapeHtml(expr)}</div>
        <div class="board-calc-result">= ${escapeHtml(String(res))}</div>
      </div>
    </div>
  `;

  pushToolCard(buildBoardCard({
    cardClass: 'calculator-card',
    badge: '수식 계산기',
    title,
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 11h10"/><path d="M12 7v8"/></svg>',
    summaryHtml: `<strong>= ${escapeHtml(String(res))}</strong>`,
    boardHtml: board,
  }));

  openExplanationPanel(title, '', { badge: '수식 계산기', html: board });
}

function renderPythonExecuteCard(args, result) {
  const code = args?.code || '';
  if (code && curCards.some((c) => c.includes(escapeHtml(code.trim())))) {
    return;
  }

  const stdout = result?.stdout || '';
  const stderr = result?.stderr || '';
  const imageUrl = result?.imageUrl || '';

  let board = '<div class="board-tool-view">';
  if (code) {
    board += `<pre class="python-code-box"><code>${escapeHtml(code.trim())}</code></pre>`;
  }
  if (stdout) {
    board += `<div class="python-out-label">출력:</div><pre class="python-out-box"><code>${escapeHtml(stdout)}</code></pre>`;
  }
  if (stderr) {
    board += `<div class="python-err-box">${escapeHtml(stderr)}</div>`;
  }
  if (imageUrl) {
    board += `
      <div class="python-plot-box">
        <a href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener noreferrer">
          <img src="${escapeHtml(imageUrl)}" alt="생성된 그래프" class="python-plot-img">
        </a>
        <div class="python-plot-hint">그래프를 클릭하면 새 탭에서 원본 크기로 볼 수 있습니다.</div>
      </div>
    `;
  }
  board += '</div>';

  const outLines = stdout.trim() ? stdout.trim().split('\n').length : 0;
  let summary = 'Python 코드를 실행했어요.';
  if (outLines) summary += ` 출력 ${outLines}줄`;
  if (imageUrl) summary += ' · 그래프 생성';
  if (stderr) summary += ' · 오류 메시지 있음';

  const title = '수학 풀이 및 데이터 시각화';
  pushToolCard(buildBoardCard({
    cardClass: 'python-card',
    badge: 'Python 실행',
    title,
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
    summaryHtml: summary,
    boardHtml: board,
  }));

  openExplanationPanel(title, '', { badge: 'Python 실행', html: board });
}


function renderFunctionGraphCard(args, result) {
  const expr = args?.expression || result?.expression || 'x^2';
  const cleanExpr = String(expr).trim();
  if (curCards.some((c) => c.includes(`data-graph-expr="${escapeHtml(cleanExpr)}"`))) {
    return;
  }

  // 고해상도 오프스크린 캔버스에 2D 그래프 렌더링 후 dataURL 추출
  let dataUrl = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 520;
    drawGraphOnCanvas(canvas, cleanExpr);
    dataUrl = canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('[graph] 인라인 그래프 렌더링 실패:', err);
  }

  const board = `
    <div class="board-tool-view">
      ${dataUrl ? `
        <div class="graph-card-plot-box">
          <a href="${dataUrl}" target="_blank" rel="noopener noreferrer" title="새 탭에서 원본 크기로 보기">
            <img src="${dataUrl}" alt="f(x) = ${escapeHtml(cleanExpr)} 그래프" class="graph-card-img" />
          </a>
        </div>
      ` : `<div class="tool-card-empty">그래프를 렌더링할 수 없습니다.</div>`}
      <div class="graph-card-footer">
        <span class="graph-formula-pill">y = ${escapeHtml(cleanExpr)}</span>
        <button type="button" class="graph-action-btn" data-graph-expr-btn="${escapeHtml(cleanExpr)}" onclick="window.openGraphModalForCard(this)" title="전체 모달에서 인터랙티브 조작">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          <span>자세히 보기</span>
        </button>
      </div>
    </div>
  `;

  const title = `f(x) = ${cleanExpr}`;
  pushToolCard(buildBoardCard({
    cardClass: 'graph-card',
    badge: '함수 그래프',
    title,
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/></svg>',
    summaryHtml: `<span class="graph-formula-pill">y = ${escapeHtml(cleanExpr)}</span> 그래프를 칠판에 그렸어요.`,
    boardHtml: board,
    extraAttrs: ` data-graph-expr="${escapeHtml(cleanExpr)}"`,
  }));

  openExplanationPanel(title, '', { badge: '함수 그래프', html: board });
}

window.openGraphModalForExpr = function(expr) {
  studyToolsManager?.openAndPlotGraph?.(expr || 'x^2');
};

window.openGraphModalForCard = function(btn) {
  window.openGraphModalForExpr?.(btn?.dataset.graphExprBtn || 'x^2');
};

function renderRagCard(args, result) {
  const query = args?.query || '';
  const hits = Array.isArray(result) ? result : (result?.hits || []);

  let board = '<div class="board-tool-view">';
  if (hits.length > 0) {
    board += '<ul class="search-result-list">';
    for (const h of hits) {
      board += `
        <li class="search-result-item">
          <div class="search-result-title"><span>${escapeHtml(h.metadata?.source || '자료')}</span></div>
          <p class="search-result-snippet">${escapeHtml(h.document || '')}</p>
        </li>
      `;
    }
    board += '</ul>';
  } else {
    board += `<div class="tool-card-empty">일치하는 자료가 없습니다.</div>`;
  }
  board += '</div>';

  const title = query || '참고 문서 검색';
  pushToolCard(buildBoardCard({
    cardClass: 'rag-card',
    badge: '교재 참고자료',
    title,
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>',
    summaryHtml: hits.length > 0 ? `<strong>${hits.length}건</strong>의 교재 발췌문을 찾았어요.` : '일치하는 자료가 없습니다.',
    boardHtml: board,
  }));

  openExplanationPanel(title, '', { badge: '교재 참고자료', html: board });
}

function renderReadFileCard(args, result) {
  const fn = result?.filename || args?.filename || '학습 자료';
  const totalPages = result?.totalPages || 1;
  const page = result?.page || 1;
  const content = result?.content || '';
  const error = result?.error || '';
  const pageBadge = totalPages > 1 ? `<span class="page-count-badge">총 ${totalPages}페이지 중 ${page}페이지</span>` : '';

  let board = '<div class="board-tool-view">';
  let summary = '';
  if (result?.success) {
    board += `
      <div class="read-file-meta">${pageBadge}</div>
      <pre class="read-file-snippet board-read-file"><code>${escapeHtml(content.slice(0, 3000))}${content.length > 3000 ? '\n...' : ''}</code></pre>
    `;
    summary = totalPages > 1 ? `총 ${totalPages}페이지 중 ${page}페이지 · 발췌 ${content.length.toLocaleString()}자` : `발췌 ${content.length.toLocaleString()}자`;
  } else {
    const isScanned = Boolean(result?.isScanned);
    const msg = isScanned
      ? '<strong>스캔·이미지 기반 문서</strong>: 텍스트 레이어가 없어 교육과정 지식을 토대로 직접 설명합니다.'
      : escapeHtml(error || '자료를 읽을 수 없습니다.');
    board += `<div class="tool-card-empty">${msg}</div>`;
    summary = isScanned ? '스캔·이미지 기반 문서' : escapeHtml(error || '자료를 읽을 수 없습니다.');
  }
  board += '</div>';

  pushToolCard(buildBoardCard({
    cardClass: 'read-file-card',
    badge: '교재 참고자료',
    title: fn,
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M12 6v14"/><path d="m9 9 3-3 3 3"/></svg>',
    summaryHtml: summary,
    boardHtml: board,
  }));

  openExplanationPanel(fn, '', { badge: '교재 참고자료', html: board });
}

let quizCardCounter = 0;
window._activeQuizzes = window._activeQuizzes || new Map();

function buildQuizCardHtml(quizId, qIdx) {
  const quiz = window._activeQuizzes?.get(quizId);
  if (!quiz) return '';
  const q = quiz.questions[qIdx];
  if (!q) return '';
  const total = quiz.questions.length;
  const answered = quiz.userAnswers[qIdx] !== undefined;
  const chosenIdx = quiz.userAnswers[qIdx];
  const isCorrect = answered && chosenIdx === q.ans;

  let optionsHtml = '<div class="quiz-card-options">';
  (q.options || []).forEach((opt, idx) => {
    let btnClass = 'quiz-card-opt-btn';
    let iconHtml = '';
    if (answered) {
      if (idx === q.ans) {
        btnClass += ' correct';
        iconHtml = '<span class="opt-badge correct">✓</span>';
      } else if (idx === chosenIdx) {
        btnClass += ' wrong';
        iconHtml = '<span class="opt-badge wrong">✗</span>';
      }
    }
    const disabledAttr = answered ? 'disabled' : '';
    optionsHtml += `
      <button type="button" class="${btnClass}" ${disabledAttr} onclick="window.handleQuizOptionSelect('${quizId}', ${qIdx}, ${idx})">
        <span class="quiz-opt-num">${idx + 1}</span>
        <span class="quiz-opt-text">${escapeHtml(opt)}</span>
        ${iconHtml}
      </button>
    `;
  });
  optionsHtml += '</div>';

  let feedbackHtml = '';
  if (answered) {
    const feedbackTitle = isCorrect
      ? '<div class="quiz-card-feedback correct">🎉 정답입니다! 아주 잘 맞혔어!</div>'
      : `<div class="quiz-card-feedback wrong">💡 아쉽지만 정답은 ${q.ans + 1}번이야!</div>`;

    let nextBtnHtml = '';
    if (qIdx + 1 < total) {
      nextBtnHtml = `
        <button type="button" class="quiz-card-next-btn" onclick="window.handleQuizNextQuestion('${quizId}', ${qIdx + 1})">
          다음 문제 풀기 (${qIdx + 2}/${total}) &rarr;
        </button>
      `;
    } else {
      nextBtnHtml = `
        <div class="quiz-card-complete-badge">✨ 모든 퀴즈를 완료했습니다! 궁금한 점은 대화로 물어보세요.</div>
      `;
    }

    feedbackHtml = `
      <div class="quiz-card-exp-box">
        ${feedbackTitle}
        <div class="quiz-card-exp-text"><strong>해설:</strong> ${escapeHtml(q.exp || '해설이 제공되지 않았습니다.')}</div>
        <div class="quiz-card-actions">${nextBtnHtml}</div>
      </div>
    `;
  }

  return `
    <div class="tool-card-header quiz-header">
      <div class="tool-card-title-group">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
        <span>맞춤 퀴즈: <strong>${escapeHtml(quiz.topic)}</strong></span>
        <span class="quiz-card-progress">${qIdx + 1} / ${total}</span>
      </div>
      <button type="button" class="btn-open-quiz-modal" onclick="window.openFullQuizModal('${quizId}')" title="전체화면 모달로 열기">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18M3 9h18"/></svg>
        <span>모달로 풀기</span>
      </button>
    </div>
    <div class="quiz-card-body">
      <div class="quiz-card-question">${escapeHtml(q.q)}</div>
      ${optionsHtml}
      ${feedbackHtml}
    </div>
  `;
}

function renderQuizCard(args) {
  const quizId = `quiz-${Date.now()}-${++quizCardCounter}`;
  const topic = args?.topic || '맞춤 퀴즈';
  const questions = Array.isArray(args?.questions) && args.questions.length > 0 ? args.questions : [];
  const icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>';

  if (!questions.length) {
    pushToolCard(buildBoardCard({
      cardClass: 'quiz-card',
      badge: 'AI 퀴즈',
      title: topic,
      icon,
      summaryHtml: '출제된 문제가 없습니다.',
      reopen: false,
    }));
    return;
  }

  window._activeQuizzes.set(quizId, {
    topic,
    questions,
    currentIndex: 0,
    userAnswers: {},
  });

  const board = `<div class="board-tool-view"><div class="tool-card quiz-card" id="${quizId}">${buildQuizCardHtml(quizId, 0)}</div></div>`;

  pushToolCard(buildBoardCard({
    cardClass: 'quiz-card',
    badge: 'AI 퀴즈',
    title: topic,
    icon,
    summaryHtml: `<strong>${questions.length}문제</strong>가 칠판에서 출제되었어요. 칠판에서 문제를 풀어보세요.`,
    boardHtml: board,
    extraAttrs: ` data-board-kind="quiz" data-quiz-id="${quizId}"`,
  }));

  openExplanationPanel(topic, '', { badge: 'AI 퀴즈', html: board });
}

window.handleQuizOptionSelect = function(quizId, qIdx, chosenIdx) {
  const quiz = window._activeQuizzes?.get(quizId);
  if (!quiz) return;
  if (quiz.userAnswers[qIdx] !== undefined) return;

  quiz.userAnswers[qIdx] = chosenIdx;
  const q = quiz.questions[qIdx];
  const isCorrect = chosenIdx === q.ans;

  if (window._stage) {
    if (isCorrect) {
      window._stage.playTapMotion?.() || window._stage.setEmotion?.('cheer');
    } else {
      window._stage.setEmotion?.('focus');
    }
  }

  const cardEl = document.getElementById(quizId);
  if (cardEl) {
    cardEl.innerHTML = buildQuizCardHtml(quizId, qIdx);
  }
};

window.handleQuizNextQuestion = function(quizId, nextQIdx) {
  const quiz = window._activeQuizzes?.get(quizId);
  if (!quiz) return;
  quiz.currentIndex = nextQIdx;

  const cardEl = document.getElementById(quizId);
  if (cardEl) {
    cardEl.innerHTML = buildQuizCardHtml(quizId, nextQIdx);
  }
};

window.openFullQuizModal = function(quizId) {
  const quiz = window._activeQuizzes?.get(quizId);
  if (!quiz || !studyToolsManager) return;
  studyToolsManager.loadQuizFromAI(quiz.topic, quiz.questions);
};

function renderFlashcardCard(args) {
  const topic = args?.topic || '핵심 개념 암기 카드';
  const cards = Array.isArray(args?.cards) ? args.cards.filter((c) => c?.q && c?.a) : [];
  const icon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="14" x="2" y="5" rx="2"/><path d="M6 12h8"/><path d="M6 15h5"/></svg>';

  if (!cards.length) {
    pushToolCard(buildBoardCard({
      cardClass: 'flashcard-card',
      badge: '플래시카드',
      title: topic,
      icon,
      summaryHtml: '생성된 카드가 없습니다.',
      reopen: false,
    }));
    return;
  }

  studyToolsManager?.setCachedCards?.(topic, cards);

  const board = `
    <div class="board-tool-view">
      <div class="board-section-label">카드를 누르면 정답이 보여요 · ${cards.length}장</div>
      <div class="board-flashcard-list">
        ${cards.map((c, i) => `
          <button type="button" class="board-flashcard" onclick="window.toggleBoardFlashcard(this)">
            <span class="board-flashcard-index">${i + 1}</span>
            <span class="board-flashcard-body">
              <span class="board-flashcard-q">${escapeHtml(c.q)}</span>
              <span class="board-flashcard-a" hidden>${escapeHtml(c.a)}</span>
            </span>
          </button>
        `).join('')}
      </div>
    </div>
  `;

  pushToolCard(buildBoardCard({
    cardClass: 'flashcard-card',
    badge: '플래시카드',
    title: topic,
    icon,
    summaryHtml: `<strong>${cards.length}장</strong>의 암기 카드가 칠판에 준비되었어요.`,
    boardHtml: board,
  }));

  openExplanationPanel(topic, '', { badge: '플래시카드', html: board });
}

window.toggleBoardFlashcard = function(btn) {
  const answer = btn?.querySelector('.board-flashcard-a');
  if (!answer) return;
  answer.hidden = !answer.hidden;
  btn.classList.toggle('is-open', !answer.hidden);
};

function handleToolCall(name, args, result) {
  switch (name) {
    case 'read_file':
      renderReadFileCard(args, result);
      break;
    case 'open_explanation':
      explanationStreaming = false;
      renderExplanationCard(args);
      break;
    case 'close_explanation':
      closeExplanationPanel();
      break;
    case 'set_emotion':
      if (args?.tag && VALID_EMOTION_TAGS.has(args.tag)) {
        window._stage?.setEmotion(args.tag);
      }
      break;
    case 'search_rag':
      if (result !== undefined) {
        renderRagCard(args, result);
      } else if (args?.query) {
        const now = Date.now();
        if (!lastRagQuery || lastRagQuery.text !== args.query || now - lastRagQuery.time > 3000) {
          lastRagQuery = { text: args.query, time: now };
          window._ws?.send({ type: 'rag_search', query: args.query });
        }
      }
      break;
    case 'set_goal':
      if (args?.text) window._ws?.send({ type: 'set_goal', text: args.text });
      break;
    case 'set_tone':
      // 서버 처리, 클라이언트 무시
      break;
    case 'web_search':
      renderWebSearchCard(args, result);
      break;
    case 'calculator':
      renderCalculatorCard(args, result);
      break;
    case 'python_execute':
      renderPythonExecuteCard(args, result);
      break;
    case 'start_quiz':
      renderQuizCard(args);
      if (args?.questions?.length) {
        studyToolsManager?.setCachedQuiz?.(args.topic, args.questions);
      }
      break;
    case 'create_flashcards':
      renderFlashcardCard(args);
      break;
    case 'start_study_timer':
      studyToolsManager?.startTimerWithMinutes(args?.minutes || 25);
      break;
    case 'plot_function_graph':
      renderFunctionGraphCard(args, result);
      break;
    default:
      console.warn('알 수 없는 tool_call:', name);
  }
}

// 시연 계정용 전체 세션 자동 초기화 (서버 DB, 벡터, 로컬 대화 내역 완전 삭제 후 새 세션 준비)
async function resetEntireSessionsForDemo() {
  // 이 참가자의 현재 세션만 서버에서 지운다. 다른 계정·다른 탭의 세션은 건드리지 않는다.
  const previousSessionId = sessionId;
  sessionEpoch += 1;
  stopGeneration();
  stopTts();
  appMic?.stop?.();
  studyToolsManager?.onSessionChanged?.();
  closeExplanationPanel();
  resettingForNextVisitor = true;

  try {
    await apiFetch(`/api/sessions/${encodeURIComponent(previousSessionId)}`, { method: 'DELETE' }, { scope: accountScope });
  } catch (err) {
    console.warn('[DemoReset] 서버 세션 삭제 경고:', err);
  }

  // 이 참가자의 브라우저 저장만 정리하고, 기기 설정(테마·음량·아바타 모델)은 보존한다.
  removeSessionData(previousSessionId);
  accountStore.clearAccount();
  accountScope = getAccountScope();
  accountStore = createAccountStorage(accountScope);
  sessionId = newSessionId();
  pset('agy_session_id', sessionId);
  sessions = [];
  saveSessions(sessions);
  renderSessionList();
  chatLog.innerHTML = '';
  refreshEmptyState();
  resettingForNextVisitor = false;
}

// 시연 전용 계정 모드 제어 (로그인은 유지된 채 다음 참가자로 이름 변경 & 전체 세션 자동 초기화)
function setupDemoModeIfNeeded(user) {
  const nextDemoBtn = $('#btn-next-demo-user');
  const resetSettingRow = $('#setting-row-reset-session');
  const previewTag = $('#brand-preview-tag');
  const isDemo = user?.role === 'demo';

  if (resetSettingRow) resetSettingRow.style.display = isDemo ? 'none' : 'flex';
  if (nextDemoBtn) nextDemoBtn.style.display = isDemo ? 'inline-flex' : 'none';
  if (previewTag) previewTag.style.display = isDemo ? 'inline-block' : 'none';

  if (!isDemo) return;

  const handleNextVisitor = async (e) => {
    e?.preventDefault();
    if (resettingForNextVisitor) return; // 중복 클릭으로 두 번 초기화하지 않는다

    // 1. 대화창 즉시 비우기 (이전 참가자 대화 노출 즉시 차단)
    chatLog.innerHTML = '';

    // 2. 이 참가자의 세션만 삭제하고 새 세션 발급 (reset함수 안에서 sessionId 교체)
    await resetEntireSessionsForDemo();
    premove(PROFILE_NAME_KEY);
    premove('miku_demo_visitor_active');

    // 3. 새 세션으로 WS 연결
    await switchSession(sessionId);

    // 4. 빈 대화창 렌더링 (이름 등록 프롬프트가 표시됨)
    refreshEmptyState();
    setTimeout(() => {
      const input = $('#demo-visitor-name');
      input?.focus();
    }, 60);
  };

  window._handleNextVisitor = handleNextVisitor;
  // 새 대화 버튼은 setupSidebar의 한 곳에서만 이 핸들러를 호출한다 (중복 바인딩 금지).

  // 시연 계정 최초 진입 시 이름이 미설정 상태이면 프롬프트 렌더링 및 포커스
  const savedName = pget(PROFILE_NAME_KEY);
  if (!savedName || savedName === DEFAULT_USER_NAME || savedName === '시연 체험자') {
    premove('miku_demo_visitor_active');
    refreshEmptyState();
    setTimeout(() => {
      const input = $('#demo-visitor-name');
      input?.focus();
    }, 60);
  }
}

function setupAuthGate(onSuccess) {
  // 로컬 모드: 로그인 게이트를 건너뛰고 즉시 채팅 화면을 엽니다.
  document.getElementById('login-overlay')?.classList.add('hidden');
  const logoutButton = document.getElementById('btn-logout');
  if (logoutButton) logoutButton.style.display = 'none';
  const adminButton = document.getElementById('btn-go-admin');
  if (adminButton) adminButton.style.display = 'none';
  onSuccess();
  return;
  const overlay = $('#login-overlay');
  const form = $('#login-form');
  const userInput = $('#login-username');
  const passInput = $('#login-password');
  const errEl = $('#login-error');
  const logoutBtn = $('#btn-logout');
  const demoLogoutOverlay = $('#demo-logout-modal-overlay');
  const demoLogoutForm = $('#demo-logout-form');
  const demoLogoutPwInput = $('#demo-logout-password');
  const demoLogoutErr = $('#demo-logout-error');
  const closeDemoLogoutBtn = $('#btn-close-demo-logout-modal');
  const cancelDemoLogoutBtn = $('#btn-cancel-demo-logout');

  const closeDemoLogoutModal = () => {
    demoLogoutOverlay?.classList.remove('open');
    if (demoLogoutPwInput) demoLogoutPwInput.value = '';
    if (demoLogoutErr) demoLogoutErr.style.display = 'none';
  };

  closeDemoLogoutBtn?.addEventListener('click', closeDemoLogoutModal);
  cancelDemoLogoutBtn?.addEventListener('click', closeDemoLogoutModal);

  demoLogoutForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (demoLogoutErr) demoLogoutErr.style.display = 'none';

    const enteredPw = (demoLogoutPwInput?.value || '').trim();
    if (!enteredPw) return;

    const user = getAuthenticatedUser();
    if (!user) {
      logoutUser();
      return;
    }

    try {
      // 1. 현재 시연 계정 비밀번호 검증
      let checkRes = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.id, password: enteredPw })
      });
      let checkData = await checkRes.json();

      // 2. 불일치 시 관리자(admin) 마스터 비밀번호도 검증 허용
      if (!checkData.success) {
        checkRes = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: enteredPw })
        });
        checkData = await checkRes.json();
      }

      if (checkData.success) {
        closeDemoLogoutModal();
        logoutUser();
      } else {
        if (demoLogoutErr) {
          demoLogoutErr.textContent = '비밀번호가 일치하지 않습니다.';
          demoLogoutErr.style.display = 'block';
        }
        demoLogoutPwInput?.focus();
        demoLogoutPwInput?.select();
      }
    } catch (err) {
      if (demoLogoutErr) {
        demoLogoutErr.textContent = '검증 오류: ' + err.message;
        demoLogoutErr.style.display = 'block';
      }
    }
  });

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      const user = getAuthenticatedUser();
      if (user?.role === 'demo') {
        // 시연 계정은 분탕 방지를 위해 비밀번호 확인 모달 표시
        if (demoLogoutErr) demoLogoutErr.style.display = 'none';
        if (demoLogoutPwInput) demoLogoutPwInput.value = '';
        demoLogoutOverlay?.classList.add('open');
        setTimeout(() => demoLogoutPwInput?.focus(), 60);
      } else {
        // 일반 및 관리자 계정은 즉시 로그아웃
        logoutUser();
      }
    });
  }

  const adminBtn = $('#btn-go-admin');

  const currentUser = getAuthenticatedUser();
  if (currentUser) {
    overlay?.classList.add('hidden');
    if (currentUser.role === 'admin' && adminBtn) {
      adminBtn.style.display = 'flex';
    }
    if (currentUser.role !== 'demo' && currentUser.name) {
      try { pset(PROFILE_NAME_KEY, currentUser.name); } catch {}
    }
    setupDemoModeIfNeeded(currentUser);
    onSuccess();
    return;
  }

  // 비로그인 상태: 로그인 화면 표시 및 입력 포커스
  overlay?.classList.remove('hidden');
  userInput?.focus();

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errEl) errEl.style.display = 'none';

    const username = userInput?.value || '';
    const password = passInput?.value || '';

    const res = await loginUser(username, password);
    if (!res.success) {
      if (errEl) {
        errEl.textContent = res.message;
        errEl.style.display = 'block';
      }
      if (passInput) passInput.value = '';
      return;
    }

    if (res.user?.role === 'admin' && adminBtn) {
      adminBtn.style.display = 'flex';
    }
    if (res.user?.role !== 'demo' && res.user?.name) {
      try { pset(PROFILE_NAME_KEY, res.user.name); } catch {}
    }
    setupDemoModeIfNeeded(res.user);

    // 로그인 성공 시 페이드아웃 후 앱 부트 및 뷰포트 크기 재동기화
    overlay?.classList.add('hidden');
    onSuccess();
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 380);
  });
}

let isBooted = false;
function startApp() {
  if (isBooted) return;
  isBooted = true;
  boot().catch((err) => {
    console.error('부트 실패:', err);
    addNotice('앱 초기화 실패: ' + err.message);
  });
}

setupAuthGate(() => {
  startApp();
});
