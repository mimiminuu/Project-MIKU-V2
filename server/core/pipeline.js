// 스트리밍 파이프라인 오케스트레이터.
// LLM 토큰 스트림 → 구두점 기준 청크 → TTS 큐 → 클라이언트 오디오 전송.
// 감정 태그는 스트림 시작부에서 파싱되어 아바타 모션에 연동됩니다.
import fs from 'node:fs';
import path from 'node:path';
import { SentenceChunker } from './sentenceChunker.js';
import { buildSystemPrompt, buildDynamicContext, buildMessages } from '../memory/contextBuilder.js';
import { search } from '../rag/retrieve.js';
import { config } from '../config.js';
import { executeWebSearch, executeCalculator, executePython, executeReadFile, findMaterialFile } from './tools.js';
import { IMAGE_EXTS } from '../rag/ingest.js';
import { localLlmManager } from './localLlmManager.js';
import { TOOL_DEFINITIONS } from './toolDefinitions.js';
import { getVoicePreset, getAvatarDisplayName, getGlobalAvatarModelId } from '../avatarModels.js';
import { recordSessionMeta, recordTurn } from './demoTranscript.js';

function getImageMime(ext) {
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
  };
  return map[ext.toLowerCase()] || 'image/jpeg';
}

const EMOTION_TAG = /^\s*\[([a-zA-Z_]+)\]/;
const TAG_PREFIX = /^\s*\[?[a-zA-Z_]*$/;
const THINK_OPEN_PREFIX = /^\s*<(?:t(?:h(?:i(?:n(?:k(?:>[\s\S]*)?)?)?)?)?)?$/i;
const THINK_COMPLETE_RE = /^\s*<think>([\s\S]*?)<\/think>\s*/i;

export const VALID_EMOTIONS = new Set([
  'smile', 'think', 'cheer', 'sad', 'wink', 'love', 'neutral',
  'focus', 'proud', 'fighting', 'shy', 'panic', 'curious',
  'dozeoff', 'relieved', 'pout', 'whisper', 'sparkle', 'spaceout',
  'nod', 'shake', 'wave', 'clap', 'dance', 'explain', 'surprise', 'joy', 'angry', 'sleepy', 'wakeup', 'greet'
]);
const EMOTION_TAG_INLINE_RE = /\[([a-zA-Z_]{3,20})\]/g;

// ---- 도구 호출 시스템 ----
const VALID_TOOLS = new Set([
  'open_explanation',
  'close_explanation',
  'set_emotion',
  'set_tone',
  'search_rag',
  'read_file',
  'set_goal',
  'web_search',
  'calculator',
  'python_execute',
  'start_quiz',
  'create_flashcards',
  'start_study_timer',
  'plot_function_graph',
]);
const TONE_MAP = { casual:'친근한 구어체로', formal:'조금 격식있는 말투로', concise:'짧고 간결하게', detailed:'자세하고 풍부하게' };
const TOOL_TAG_RE = /\[TOOL:\s*([a-zA-Z_]\w*)\s*\]/gi;

// 모델이 아무 데이터도 보내지 않는 상태가 이보다 길어지면 턴을 중단한다.
// 원격·로컬 구분 없이 3분까지 허용한다.
const REMOTE_STREAM_IDLE_MS = 180000;
const BONSAI_STREAM_IDLE_MS = 180000;
const TOOL_WAIT_TIMEOUT_MS = 20000;
const TTS_SENTENCE_TIMEOUT_MS = 20000;

/**
 * 모델이 도구 태그를 빠뜨리는 경우가 있어, 사용자가 명시적으로 요청한 도구는
 * 서버가 의도를 판별해 지시문을 넣고 필요하면 대신 실행한다.
 */
function detectExplicitToolIntents(text) {
  const t = String(text || '');
  const intents = [];
  if (/(검색(?:해서|해\s*줘|해줘|해|하여)|찾아\s*봐|찾아봐|알아\s*봐|알아봐|확인해\s*봐|확인해봐|최신\s*(?:뉴스|정보|소식)|오늘\s*(?:날씨|경기)|날씨|환율|주가|시세)/.test(t)) {
    intents.push('web_search');
  }
  if (/목표(?:를|는|로|가)?\s*.{0,40}?(?:설정해|정해\s*줘|정해줘|잡아\s*줘|잡아줘|세워\s*줘|세워줘|로\s*할게|로\s*할래|로\s*하자|로\s*정해)/.test(t)) {
    intents.push('set_goal');
  }
  return intents;
}

function extractGoalText(text) {
  let t = String(text || '').trim();
  t = t.replace(/^.*?목표(?:를|는|로|가)?\s*/i, '').trim();
  t = t.replace(/\s*(?:으로|로)?\s*(?:설정해\s*줘?|정해\s*줘?|잡아\s*줘?|세워\s*줘?|해\s*줘?|할게|할래|하자)\s*[.!?]*$/i, '').trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  return (t || String(text || '').trim()).slice(0, 120);
}

function extractSearchQuery(text) {
  let t = String(text || '').trim();
  t = t.replace(/^(?:인터넷(?:에서|으로)?|웹(?:에서)?|구글(?:에서)?)\s*/i, '');
  t = t.replace(/^(?:검색(?:해서|해|하여)\s*|찾아\s*봐\s*|찾아서\s*|알아\s*봐\s*|확인해\s*봐\s*)/, '');
  t = t.replace(/^(?:좀\s*)?(?:알려\s*줘|알려줘)\s*[:：,]?\s*/, '');
  t = t.replace(/^[:：,]\s*/, '');
  return (t || String(text || '')).slice(0, 100);
}

function buildExplicitToolDirective(intents, { searchDone = false } = {}) {
  if (!intents.length) return '';
  const lines = ['[이번 턴 필수 도구]'];
  if (intents.includes('web_search') && !searchDone) {
    lines.push('- 최신/사실 정보를 확인해야 하므로 답변 전에 반드시 [TOOL:web_search]{"query":"핵심 검색어"}를 호출하세요. 호출 없이 "검색해 볼게"라고만 말하고 끝내지 마세요.');
  }
  if (intents.includes('set_goal')) {
    lines.push('- 학습 목표를 실제로 저장해야 하므로 답변 전에 반드시 [TOOL:set_goal]{"text":"목표 내용"}을 호출하세요.');
  }
  return lines.join('\n');
}

function buildSearchObservation(query, result) {
  const list = (result?.results || []).map((r) => `- [${r.title}](${r.url}): ${r.snippet}`).join('\n');
  const answerText = result?.answer ? `[AI 검색 요약]:\n${result.answer}\n\n` : '';
  return `[실시간 웹 검색 결과 ("${query}")]:\n${answerText}${list || result?.error || '검색 결과 없음'}\n\n[답변 지침]: 위 검색 결과에 나온 사실과 출처만 사용해 답하세요. 이미 검색했으므로 [TOOL:web_search]를 다시 호출하지 마세요. 결과가 불충분하면 "검색해 봐도 정확한 정보를 찾기 어려워서 잘 모르겠어"라고 솔직하게 말하세요.`;
}

// 2차 요약 스트림이 빈 답을 내는 경우가 있어, 검색 결과만으로 최소한의 답변을 만든다.
function buildActionFallbackText(actionTools) {
  const search = actionTools.find((t) => t.name === 'web_search');
  if (!search) return '';
  const results = search.result?.results || [];
  if (!results.length) {
    return search.result?.answer || '인터넷에서 검색해 봤는데, 정확한 정보를 찾기 어려웠어. 미안해!';
  }
  const lines = results.slice(0, 3).map((r, i) => {
    const snippet = String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    return `${i + 1}. ${r.title || '검색 결과'}\n${snippet}`;
  });
  const sources = results.slice(0, 3).map((r) => r.url).filter(Boolean).join('\n');
  return `검색 결과를 정리해 줄게:\n${lines.join('\n\n')}\n\n출처:\n${sources}`;
}

class LlmInactivityError extends Error {
  constructor(idleTimeoutMs, model) {
    super(`모델 응답 없음 (${model}, ${Math.round(idleTimeoutMs / 1000)}초)`);
    this.name = 'LlmInactivityError';
    this.code = 'LLM_IDLE_TIMEOUT';
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

/**
 * 스트림의 각 next()가 idleTimeoutMs 안에 끝나지 않으면 턴을 중단한다.
 * onTimeout에서 fetch 취소 신호를 걸어 네트워크 연결도 정리한다.
 */
async function* withIdleTimeout(source, { idleTimeoutMs, label, onTimeout } = {}) {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = iterator.next();
      next.catch(() => {});
      let timer = null;
      let res;
      try {
        res = await Promise.race([
          next,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const err = new LlmInactivityError(idleTimeoutMs, label);
              try { onTimeout?.(err); } catch {}
              reject(err);
            }, idleTimeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (res.done) return;
      yield res.value;
    }
  } finally {
    // 소비자가 중단했을 때도 공급자의 finally(reader.cancel 등)가 실행되게 한다.
    try {
      const closing = iterator.return?.();
      if (closing && typeof closing.catch === 'function') closing.catch(() => {});
    } catch {}
  }
}

/**
 * TTS 발화 전 마크다운 문법, 코드 블록, <think>, 도구 태그 등을 제거하여
 * 어떤 TTS 모델을 사용하든 순수 텍스트만 읽도록 정제합니다.
 */
export function cleanTextForTTS(text) {
  if (!text) return '';
  let s = String(text);

  // 1) <think> 블록 및 잔여 태그 제거
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  s = s.replace(/<\/?think>/gi, ' ');

  // 2) [TOOL:...] 호출 및 잔여 감정/도구 태그 제거
  s = s.replace(/\[TOOL:\s*\w+\s*\]\s*(?:```(?:json)?\s*)?\{[\s\S]*?\}(?:\s*```)?/gi, ' ');
  s = s.replace(/\[TOOL:[^\]]*\]?/gi, ' ');
  s = s.replace(/\[[a-zA-Z_]{2,20}\]/g, ' ');

  // 3) 코드 블록(```...```)은 읽지 않도록 제거, 수식 블록/인라인 수식($$...$$, $...$, \(...\), \[...\])은 내부 공백·기호 정리
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, m) => ` ${m.trim()} `);
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => ` ${m.trim()} `);
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => m.trim());
  s = s.replace(/\$([^\$\n]+?)\$/g, (_, m) => m.trim());

  // 4) 마크다운 이미지/링크/URL 정리
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, ' ');

  // 5) 인라인 코드(`code`), 강조(**bold**, *italic*, __bold__, ~~strike~~)
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  s = s.replace(/_{1,2}([^_]+)_{1,2}/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');

  // 6) 줄 단위 마크다운 기호 (헤더 #, 인용 >, 목록 -, *, +, 구분선 ---)
  s = s.replace(/^\s*#{1,6}\s+/gm, '');
  s = s.replace(/^\s*>\s+/gm, '');
  s = s.replace(/^\s*[-*+•]\s+/gm, '');
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ');

  // 7) HTML 태그 및 청크 경계에 남은 마크다운/수식 기호(*, `, #, ~, $) 제거
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/[*`#~_$]+/g, '');

  // 8) 다중 공백 정리
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 스트리밍 중 미완성된 [TOOL:...] 또는 <think>... 구간이 화면/TTS로 새어나가지 않도록
 * 안전하게 방출 가능한 텍스트 끝 인덱스를 계산합니다.
 */
const ALL_TOOL_NAMES_LIST = [
  'open_explanation',
  'close_explanation',
  'set_emotion',
  'set_tone',
  'search_rag',
  'read_file',
  'set_goal',
  'web_search',
  'calculator',
  'python_execute',
  'start_quiz',
  'create_flashcards',
  'start_study_timer',
  'plot_function_graph',
];

const ALL_TAG_NAMES_LIST = [
  ...ALL_TOOL_NAMES_LIST,
  ...VALID_EMOTIONS,
];

/**
 * 스트리밍 중 미완성된 [TOOL:...], 감정 태그([think] 등) 또는 <think>... 구간이 화면/TTS로 새어나가지 않도록
 * 안전하게 방출 가능한 텍스트 끝 인덱스를 계산합니다.
 */
function getSafeEmitEnd(cleanText) {
  let safeEnd = cleanText.length;
  const thinkIdx = cleanText.search(/<\/?think\b/i);
  if (thinkIdx !== -1) safeEnd = thinkIdx;
  const tailBracket = cleanText.lastIndexOf('[');
  if (tailBracket !== -1) {
    const tail = cleanText.slice(tailBracket).toLowerCase();
    if (!tail.includes(']') && ('[tool:'.startsWith(tail) || tail.startsWith('[tool:') ||
        [...VALID_EMOTIONS].some((tag) => tag.startsWith(tail.slice(1))))) {
      safeEnd = Math.min(safeEnd, tailBracket);
    }
  }
  const tailAngle = cleanText.lastIndexOf('<');
  if (tailAngle !== -1 && '<think>'.startsWith(cleanText.slice(tailAngle).toLowerCase())) {
    safeEnd = Math.min(safeEnd, tailAngle);
  }
  return safeEnd;
}

/**
 * 태그 뒤에 이어지는 JSON 객체 구간을 추출합니다. (공백, 줄바꿈, 마크다운 코드블록 유연 지원)
 */
function extractToolJson(text, offset) {
  let i = offset;
  while (i < text.length && /\s/.test(text[i])) i++;
  const fenced = text.slice(i, i + 3) === '```';
  if (text.slice(i, i + 7).toLowerCase() === '```json') {
    i += 7;
    while (i < text.length && /\s/.test(text[i])) i++;
  } else if (text.slice(i, i + 3) === '```') {
    i += 3;
    while (i < text.length && /\s/.test(text[i])) i++;
  }
  if (text[i] !== '{') return null;
  const jsonStart = i;
  let depth = 0, inStr = false, esc = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          let totalEnd = i + 1;
          while (totalEnd < text.length && /\s/.test(text[totalEnd])) totalEnd++;
          if (fenced) {
            if (text.slice(totalEnd, totalEnd + 3) !== '```') return null;
            totalEnd += 3;
          }
          return {
            jsonStr: text.slice(jsonStart, i + 1),
            totalEnd,
          };
        }
      }
    }
  }
  return null;
}

/**
 * 아직 닫히지 않은 JSON 문자열 조각에서 이스케이프를 안전하게 복원합니다.
 * (스트리밍 중 잘린 \u12, 마지막 백슬래시는 버림)
 */
function decodeJsonStringLoose(raw) {
  if (!raw) return '';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next === 'n') { out += '\n'; i++; }
    else if (next === 't') { out += '\t'; i++; }
    else if (next === 'r') { out += ''; i++; }
    else if (next === '"') { out += '"'; i++; }
    else if (next === '\\') { out += '\\'; i++; }
    else if (next === '/') { out += '/'; i++; }
    else if (next === 'b' || next === 'f') { i++; }
    else if (next === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else { out += next; i++; }
  }
  return out;
}

/**
 * 스트리밍 중인 [TOOL:open_explanation]{...} 블록에서 지금까지 쓰인 title/content를 뽑아냅니다.
 * JSON이 아직 완성되지 않아도 읽힌 만큼 반환합니다.
 */
function extractPartialExplanation(text) {
  const last = scanToolTags(text).filter((tag) => tag.name === 'open_explanation').at(-1);
  if (!last) return null;

  const braceIdx = text.indexOf('{', last.tagEnd);
  if (braceIdx === -1) return { title: '', text: '' };
  const body = text.slice(braceIdx + 1);

  const readStringField = (key, scope) => {
    const km = new RegExp('"' + key + '"\\s*:\\s*"').exec(scope);
    if (!km) return null;
    let i = km.index + km[0].length;
    let raw = '';
    for (; i < scope.length; i++) {
      const c = scope[i];
      if (c === '\\') { raw += c + (scope[i + 1] || ''); i++; continue; }
      if (c === '"') return raw;
      raw += c;
    }
    return raw; // 아직 닫히지 않음
  };

  const contentIdx = body.search(/"content"\s*:\s*"/);
  const titleScope = contentIdx === -1 ? body.slice(0, 400) : body.slice(0, contentIdx);
  const titleRaw = readStringField('title', titleScope);
  const contentRaw = readStringField('content', body);

  return {
    title: titleRaw ? decodeJsonStringLoose(titleRaw) : '',
    text: contentRaw ? decodeJsonStringLoose(contentRaw) : '',
  };
}

/**
 * 텍스트에서 완성된 [TOOL:name]{json} 호출을 파싱합니다.
 */
function scanToolTags(text) {
  const tags = [];
  let code = '', quote = '', blockquote = false;
  for (let i = 0; i < text.length;) {
    const lineStart = i === 0 || text[i - 1] === '\n';
    if (lineStart && !code && !quote) {
      const lineEnd = text.indexOf('\n', i);
      const line = text.slice(i, lineEnd === -1 ? text.length : lineEnd);
      if (!line.trim()) blockquote = false;
      if (/^\s*>/.test(line)) blockquote = true;
      // 인용의 lazy continuation 및 들여쓴 코드도 실행하지 않는다.
      if (blockquote || /^(?: {4}|\t)/.test(line)) {
        i = lineEnd === -1 ? text.length : lineEnd + 1;
        continue;
      }
    }
    if (quote) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === quote) quote = '';
      i++;
      continue;
    }
    const ticks = /^(?:`+|~{3,})/.exec(text.slice(i));
    if (ticks) {
      const marker = ticks[0];
      if (!code) code = marker;
      else if (marker[0] === code[0] && marker.length >= code.length) code = '';
      i += marker.length;
      continue;
    }
    if (code) { i++; continue; }
    const quotes = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' };
    if (quotes[text[i]] && !/[\p{L}\p{N}]/u.test(text[i - 1] || '')) {
      quote = quotes[text[i++]];
      continue;
    }
    TOOL_TAG_RE.lastIndex = i;
    const match = text[i] === '[' ? TOOL_TAG_RE.exec(text) : null;
    if (!match || match.index !== i || !VALID_TOOLS.has(match[1].toLowerCase())) { i++; continue; }
    const tagEnd = i + match[0].length;
    const res = extractToolJson(text, tagEnd);
    const name = match[1].toLowerCase();
    tags.push({ name, start: i, tagEnd, end: res?.totalEnd ?? (name === 'close_explanation' ? tagEnd : text.length), res });
    // 실제 호출의 JSON 전체를 먼저 보호한다. content 안의 코드펜스/태그는 재파싱하지 않는다.
    if (!res && name !== 'close_explanation') break;
    i = res?.totalEnd ?? tagEnd;
  }
  return tags;
}

export function parseToolCalls(text) {
  const calls = [];
  for (const tag of scanToolTags(text)) {
    if (!tag.res && tag.name !== 'close_explanation') continue;
    try {
      const args = tag.res ? JSON.parse(tag.res.jsonStr) : {};
      calls.push({ name: tag.name, args, start: tag.start, end: tag.end });
    } catch { /* 잘못된 JSON은 실행하지 않는다. */ }
  }
  return calls;
}

/**
 * 처리된 도구 호출의 [start, end) 범위를 제외한 텍스트를 조립합니다.
 */
function buildCleanText(fullText) {
  let result = '', lastEnd = 0;
  for (const tag of scanToolTags(fullText)) {
    result += fullText.slice(lastEnd, tag.start);
    lastEnd = tag.end;
  }
  result += fullText.slice(lastEnd);
  // 감정 태그([sparkle], [smile] 등)를 UI 노출 및 텍스트에서 안전하게 제거
  result = result.replace(EMOTION_TAG_INLINE_RE, (match, tag) => {
    return VALID_EMOTIONS.has(tag.toLowerCase()) ? '' : match;
  });
  // 닫히지 않았거나 불완전하게 잘린 감정 태그도 제거 (예: [think너가..., [focus 갈색... 등)
  result = result.replace(/\[(?:smile|think|cheer|sad|wink|love|neutral|focus|proud|fighting|shy|panic|curious|dozeoff|relieved|pout|whisper|sparkle|spaceout|nod|shake|wave|clap|dance|explain|surprise|joy|angry|sleepy|wakeup|greet)\]?/gi, '');
  // 도구 태그 잔여물([close_explanation], [TOOL:...] 등)도 텍스트에서 깨끗이 제거
  // (미완성으로 끝난 JSON 블록이나 마크다운 코드블록까지 포괄 제거)
  result = result.replace(/\[(?:TOOL:\s*)?([a-zA-Z_]\w*)\s*\](?:\s*(?:```(?:json)?\s*)?\{[\s\S]*?(?:\}(?:\s*```)?|$))?/gi, (match, tag) => {
    const lower = tag.toLowerCase();
    if (VALID_TOOLS.has(lower) || VALID_EMOTIONS.has(lower)) return '';
    return match;
  });
  // 닫히지 않은 [TOOL:... 또는 [open_explanation 등 잔여물 및 파라미터 완전 제거
  result = result.replace(/\[TOOL:[^\]\n]*\]?/gi, '');
  result = result.replace(/\[(?:open_explanation|close_explanation|web_search|calculator|python_execute|start_quiz|create_flashcards|start_study_timer|plot_function_graph)[^\]\n]*\]?/gi, '');
  // 태그가 먼저 잘려나간 뒤 단독으로 누출된 도구 파라미터 JSON 잔여물 제거 (예: {"filename":..., {"query":... 등)
  result = result.replace(/\{(?:\s*"(?:filename|query|expression|code|topic|questions|cards|minutes|title|content|style|text)"[\s\S]*?(?:\}|$))/gi, '');
  // 잔여 생각 태그 (<think>, </think>) 완전 제거
  result = result.replace(/<\/?think>/gi, '');
  // 모델이 뱉은 잔여 HTML 태그(<center> 등)는 화면에 글자로 새어나오지 않도록 제거
  result = result.replace(/<\/?(?:center|div|span|p|br|b|i|u|em|strong|font|h[1-6]|table|thead|tbody|tr|td|th|ul|ol|li|a|img)\b[^>]*>/gi, '');
  return result;
}

function parsePageRangeFromText(text) {
  if (!text) return { page: 1, maxPages: 2 };
  const rangeMatch = text.match(/(\d+)\s*(?:~|-|에서|부터)\s*(\d+)\s*(?:쪽|페이지|p\b|page)/i);
  if (rangeMatch) {
    const start = Math.max(1, parseInt(rangeMatch[1], 10));
    const end = Math.max(start, parseInt(rangeMatch[2], 10));
    return { page: start, maxPages: Math.min(10, end - start + 1) };
  }
  const singleMatch = text.match(/(?:p\.|page\s*)?(\d+)\s*(?:쪽|페이지|p\b|page)/i);
  if (singleMatch) {
    const start = Math.max(1, parseInt(singleMatch[1], 10));
    return { page: start, maxPages: 1 };
  }
  return { page: 1, maxPages: 2 };
}

export class Pipeline {
  /**
   * @param {object} deps
   * @param {import('../providers/index.js')} deps.providers
   * @param {object} deps.memory { shortTerm, longTerm }
   * @param {(payloadOrBuffer: any) => void} deps.send  JSON 문자열 또는 ArrayBuffer
   * @param {string} [deps.ttsProvider] 세션별 TTS 프로바이더 (supertonic | gptsovits | msedge)
   */
  constructor({ providers, memory, send, sessionId = 'default', model = 'gemini', avatarModel, userName, ttsProvider = 'supertonic', demoMode = false, accountId = '', intelligence = null } = {}) {
    this.providers = providers;
    this.memory = memory;
    this.send = send;
    this.sessionId = sessionId;
    this.demoMode = Boolean(demoMode); // 시연 계정: 계정 전역 기억에 아무것도 남기지 않는다
    this.accountId = accountId || '';
    this.intelligence = this.demoMode ? null : intelligence;
    this.currentModel = 'gemini'; // 기본값: Gemini
    this.ttsProvider = 'supertonic'; // GPT-SoVITS는 더 이상 사용하지 않는다
    this.think = process.env.NEMOTRON_THINK === 'true'; // 기본값: 추론 꺼짐
    this.busy = false;
    this.cancelled = false;
    this.chunker = null;
    this.ttsQueue = [];
    this.ttsBusy = false;
    this.ttsId = 0;
    this.ttsGeneration = 0;
    this._turnTtsGeneration = 0;
    this._ttsRunId = 0;
    this.abortController = null;
    this.avatarModel = avatarModel || getGlobalAvatarModelId() || 'haru';
    this.userName = userName || (this.demoMode ? 'User' : this.intelligence?.getUserName?.()) || 'User';
  }

  setTTSProvider(_provider) {
    this.ttsProvider = 'supertonic';
  }

  _sessionActive() {
    try {
      return this.memory?.isActive?.() !== false;
    } catch {
      return true;
    }
  }

  _isActive() {
    if (this.cancelled) return false;
    return this._sessionActive();
  }

  getTTSProvider() {
    return this.providers?.ttsProviders?.supertonic || this.providers?.tts;
  }

  setAvatarModel(modelId) {
    this.avatarModel = modelId || 'haru';
  }

  setUserName(name) {
    if (!name || typeof name !== 'string') return;
    // 이름 칸에 인사말/지시문이 들어와도 호칭으로만 쓰이도록, 프롬프트 구조를 깨는 문자와 줄바꿈만 정리한다
    const cleaned = name
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/["'`<>[\]{}]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20);
    if (!cleaned) return;
    this.userName = cleaned;
    // 시연 계정은 참가자 이름이 다음 참가자에게 남지 않도록 계정 전역 저장소에 쓰지 않는다
    if (!this.demoMode) this.intelligence?.setUserName?.(this.userName);
    else recordSessionMeta({ sessionId: this.sessionId, account: this.accountId, participant: cleaned });
  }

  setModel(model) {
    this.currentModel = model || 'gemini';
  }

  setThink(enabled) {
    this.think = Boolean(enabled);
    this.providers.llmProviders?.nemotron?.setThink?.(this.think);
    this.providers.llmProviders?.bonsai?.setThink?.(this.think);
    this.providers.llmProviders?.gpt?.setThink?.(this.think);
  }

  getLlmProvider() {
    const provider = this.providers.llmProviders?.gpt || this.providers.llm;
    if (!provider) throw new Error('Gemini 제공자를 찾을 수 없습니다.');
    return provider;
  }

  _streamIdleTimeoutMs() {
    return this.currentModel === 'bonsai' ? BONSAI_STREAM_IDLE_MS : REMOTE_STREAM_IDLE_MS;
  }

  cancel() {
    this.cancelled = true;
    try { this.abortController?.abort(); } catch {}
    this.abortController = null;
    this.ttsQueue = [];
    this.ttsGeneration += 1;
    if (this.chunker) {
      this.chunker.buffer = '';
      this.chunker._clearTimer?.();
      this.chunker.ended = true;
    }
    this._status('idle');
    this._json({ type: 'tts_end' });
  }

  // 답변 텍스트 생성은 유지하고 현재 턴의 남은 음성만 즉시 끊는다.
  cancelTTS() {
    this.ttsQueue = [];
    this.ttsGeneration += 1;
    this._ttsRunId += 1; // 진행 중인 음성 작업의 완료 처리를 무효화
    this.ttsBusy = false;
    if (this.chunker) {
      this.chunker.buffer = '';
      this.chunker._clearTimer?.();
      this.chunker.ended = true;
    }
    this._status('idle');
    this._json({ type: 'tts_end' });
  }

  _json(payload) {
    // Never stream unreviewed solution text to a student. Hold the entire response
    // until the turn ends, then apply the answer-disclosure guard.
    if (payload.type === 'assistant_text_partial') {
      this._studentOutputBuffer = (this._studentOutputBuffer || '') + (payload.text || '');
      return;
    }
    if (payload.type === 'assistant_think') return; // private reasoning must not leak
    if (payload.type === 'assistant_text_end') {
      const raw = this._studentOutputBuffer || '';
      this._studentOutputBuffer = '';
      const text = this._guardStudentOutput(raw);
      this.send(JSON.stringify({ type: 'assistant_text_partial', text }));
    }
    this.send(JSON.stringify(payload));
  }

  _guardStudentOutput(raw) {
    const text = String(raw || '').trim();
    if (!text) return '어느 부분까지 생각했는지 알려줄래? 거기서부터 함께 살펴보자.';
    // Conservative fail-closed patterns: prevent explicit final answers and
    // fully worked numbered solutions. No regex can guarantee zero leakage.
    const answerPattern = /(?:정답(?:은|:|：|이)?|최종\s*(?:답|결과)(?:은|:|：)?|답\s*[:：]|따라서\s*(?:답|결과)(?:은|:|：)?|\boxed\s*\{|결론적으로\s*[a-zA-Z가-힣]*\s*[=:])/i;
    const fullSolution = /(?:^|\n)\s*(?:1[.)]|①)[\s\S]*(?:\n)\s*(?:2[.)]|②)[\s\S]*(?:\n)\s*(?:3[.)]|③)/;
    if (answerPattern.test(text) || fullSolution.test(text)) {
      return '정답이나 완성된 풀이는 대신 제공하지 않을게. 먼저 네가 시도한 식이나 풀이 단계를 알려줘. 그중 어디서 막혔는지 함께 확인하자.';
    }
    return text;
  }

  _status(state) {
    this._json({ type: 'status', state });
  }

  async handleUserText(text, attachments = [], userName = '') {
    // 이전 턴의 정지는 새 턴 시작을 막지 않는다. 삭제된 세션만 거절한다.
    if (!this._sessionActive()) return;
    if (userName) this.setUserName(userName);
    if (this.busy) {
      this._json({ type: 'notice', text: '잠깐, 지금 말하고 있어! 조금만 기다려 줘.' });
      return;
    }
    this.busy = true;
    this.cancelled = false;
    this.abortController = new AbortController();
    this.ttsGeneration += 1;
    this._turnTtsGeneration = this.ttsGeneration;
    if (this.demoMode) {
      recordTurn({ sessionId: this.sessionId, account: this.accountId, participant: this.userName, role: 'user', text });
    }
    try {
      this._status('thinking');

      const reply = await this._generateReply(text, attachments);

      // 취소·삭제된 턴은 대화 기억과 계정 기억에 확정하지 않는다.
      if (!this._isActive()) return;
      this.memory.shortTerm.addUser(text);
      this.memory.shortTerm.addAssistant(reply);
      this._rememberFacts(text, reply);
      if (this.demoMode) {
        recordTurn({ sessionId: this.sessionId, account: this.accountId, participant: this.userName, role: 'assistant', text: reply });
      }
      this._status('idle');
    } catch (err) {
      // 사용자가 멈췄거나 세션이 지워진 턴은 오류로 표시하지 않는다.
      if (this._isActive()) {
        console.error('응답 생성 오류:', err.message);
        this._json(this._errorNotice(err));
        this._status('idle');
      }
    } finally {
      this.abortController = null;
      this.busy = false;
    }
  }

  // 시연 참가자 등록 직후: 클라이언트가 문구를 만들지 않고 캐릭터가 직접 인사를 만들어 말함
  // (가짜 인사turn은 단기 기억에 넣지 않아서 다음 대화에서 모델이 자기가 인사한 것만 기억함)
  async handleGreeting() {
    if (this.busy || !this._sessionActive()) return;
    this.busy = true;
    this.cancelled = false;
    this.abortController = new AbortController();
    this.ttsGeneration += 1;
    this._turnTtsGeneration = this.ttsGeneration;
    try {
      this._status('thinking');

      const isNamed = this.userName && this.userName !== 'User' && this.userName !== '학생 친구';
      const greetText = isNamed
        ? `안녕! 나랑 대화를 시작하자. 내 이름(${this.userName})을 불러서 반갑게 인사해줘.`
        : '안녕!';
      const reply = await this._generateReply(greetText);

      if (!this._isActive()) return;
      this.memory.shortTerm.addAssistant(reply);
      if (this.demoMode) {
        recordTurn({ sessionId: this.sessionId, account: this.accountId, participant: this.userName, role: 'assistant', text: reply });
      }
      this._status('idle');
    } catch (err) {
      if (this._isActive()) {
        console.error('인사 생성 오류:', err.message);
        this._json(this._errorNotice(err));
        this._status('idle');
      }
    } finally {
      this.busy = false;
    }
  }

  _errorNotice(err) {
    const timedOut = err?.code === 'LLM_IDLE_TIMEOUT'
      || err?.name === 'LlmInactivityError'
      || err?.name === 'LlmIdleTimeoutError';
    return {
      type: 'error_notice',
      code: timedOut ? 'LLM_TIMEOUT' : 'LLM_ERROR',
      text: timedOut
        ? '오류가 발생했습니다.'
        : '답변을 만들다가 문제가 생겼어. 잠시 후 다시 시도해 줘.',
      detail: err?.message ? String(err.message).slice(0, 240) : '',
    };
  }

  async _generateReply(userText, attachments = []) {
    const replyStartTime = Date.now();
    const attachmentNames = (attachments || []).map((a) => a.name).filter(Boolean).join(' ');
    const searchQuery = attachmentNames ? `${userText} ${attachmentNames}`.trim() : userText;
    const explicitIntents = detectExplicitToolIntents(userText);

    // RAG / 장기기억 검색: 단순 인사나 일상 잡담("안녕", "하이", "너 괜찮아?")에서는 임베딩 계산 및 벡터 검색 생략
    const isCasualChat = !attachmentNames && userText.trim().length < 15 && /^(?:안녕|하이|반가워|너\s*괜찮아|뭐해|잘\s*지내|졸려|심심해|누구야)/i.test(userText.trim());

    let retrieved = { ragHits: [], memHits: [] };
    if (!isCasualChat) {
      const retrieve = Promise.race([
        (async () => {
          try {
            const [ragHits, memHits] = await Promise.all([
              search(searchQuery, { topK: 4, sessionId: this.sessionId, accountId: this.accountId }),
              this.memory.longTerm.recall(userText, { topK: 4 }),
            ]);
            return { ragHits, memHits };
          } catch {
            return { ragHits: [], memHits: [] };
          }
        })(),
        new Promise((resolve) => setTimeout(() => resolve({ ragHits: [], memHits: [] }), 400)),
      ]);
      retrieved = await retrieve;
    }

    // 명시적 검색 요청은 모델 호출 전에 먼저 실행한다. 모델이 도구 호출을 잊거나
    // 첫 토큰이 늦어 타임아웃되어도 검색 결과 카드와 요약 답변은 남길 수 있다.
    let preSearch = null;
    let preSearchContext = '';
    if (explicitIntents.includes('web_search') && this._isActive()) {
      const query = extractSearchQuery(userText);
      this._json({ type: 'tool_start', name: 'web_search', args: { query }, message: `웹 검색 중: "${query}"` });
      const res = await executeWebSearch(query);
      if (this._isActive()) {
        this._json({ type: 'tool_call', name: 'web_search', args: { query }, result: res });
        preSearch = { name: 'web_search', args: { query }, result: res };
        preSearchContext = buildSearchObservation(query, res);
      }
    }

    // 시스템 프롬프트는 아바타 정체성과 도구 규칙으로 항상 일정하게 유지하여 Ollama KV 캐시 히트율 극대화
    this._studentOutputBuffer = '';
    const systemPrompt = buildSystemPrompt({
      avatarModel: this.avatarModel,
      userName: this.userName,
    });
    // 사용자 맞춤 동적 기억/RAG 발췌본은 매 턴 변경되므로 사용자 메시지 컨텍스트로 전달
    // 화면에 이미 띄운 퀴즈·칠판·카드도 이어지는 질문에서 근거로 쓸 수 있게 함께 넣는다.
    const toolContext = this.memory.shortTerm?.getToolContext?.() || [];
    let dynamicContext = buildDynamicContext({
      longTerm: this.memory.longTerm,
      ragContext: retrieved.ragHits,
      memContext: retrieved.memHits,
      toolContext,
      userName: this.userName,
      includeIntel: !this.demoMode,
      intelligence: this.intelligence,
    });
    const explicitDirective = buildExplicitToolDirective(explicitIntents, { searchDone: Boolean(preSearch) });
    if (explicitDirective) dynamicContext = `${dynamicContext}\n\n${explicitDirective}`;
    if (preSearchContext) dynamicContext = `${dynamicContext}\n\n${preSearchContext}`;

    let promptUserText = userText;
    const images = [];

    if (attachments && attachments.length > 0) {
      const pageRange = parsePageRangeFromText(userText);
      const attachParts = [];
      for (const a of attachments) {
        const ext = path.extname(a.name || '').toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
          try {
            const matched = findMaterialFile(a.name, this.sessionId, this.accountId);
            if (matched && fs.existsSync(matched.path)) {
              const buf = fs.readFileSync(matched.path);
              const b64 = buf.toString('base64');
              const mime = getImageMime(ext);
              images.push({ base64: b64, mimeType: mime, filename: a.name });
              attachParts.push(`[첨부 이미지: "${a.name}"]`);
              if (!this.demoMode) {
                this.intelligence?.addSessionTopic?.({
                  topic: a.name.replace(/\.[^/.]+$/, ''),
                  summary: `"${a.name}" 이미지를 세션에서 함께 살펴보고 대화함`,
                });
              }
            } else {
              attachParts.push(`[첨부 이미지: ${a.name}]`);
            }
          } catch (err) {
            console.warn(`[pipeline] 이미지 첨부 로드 실패 (${a.name}):`, err.message);
            attachParts.push(`[첨부 이미지: ${a.name}]`);
          }
        } else {
          try {
            const fileInfo = await executeReadFile(a.name, pageRange.page, pageRange.maxPages, this.sessionId, this.accountId);
            if (fileInfo.success && fileInfo.content) {
              attachParts.push(`[첨부 파일 "${a.name}" 원문 발췌 (총 ${fileInfo.totalPages}페이지 중 ${fileInfo.page}페이지부터)]:\n${fileInfo.content}`);
              if (!this.demoMode) {
                this.intelligence?.addSessionTopic?.({
                  topic: a.name.replace(/\.[^/.]+$/, ''),
                  summary: `"${a.name}" 학습 자료를 세션에서 함께 분석하고 공부함`,
                });
              }
            } else {
              attachParts.push(`[첨부 파일: ${a.name}]`);
            }
          } catch {
            attachParts.push(`[첨부 파일: ${a.name}]`);
          }
        }
      }
      const attachDesc = attachParts.join('\n\n');
      promptUserText = promptUserText ? `${attachDesc}\n\n${promptUserText}` : attachDesc;
    }

    // 로컬 Bonsai(27B) 모델은 프리필 지연 최소화를 위해 최근 12개 메시지(6턴) 이력 위주로 최적화
    const rawHistory = this.memory.shortTerm.getHistory();
    const effectiveHistory = this.currentModel === 'bonsai' && rawHistory.length > 12
      ? rawHistory.slice(-12)
      : rawHistory;

    const messages = buildMessages({
      systemPrompt,
      history: effectiveHistory,
      userText: promptUserText,
      images,
      dynamicContext,
    });

    // LLM 스트리밍 시작 (현재 선택 모델에 따라 동적 라우팅, 공용 도구 스키마 전달)
    const llm = this.getLlmProvider();
    if (this.currentModel === 'bonsai') {
      localLlmManager.touch();
    }
    const stream = llm.streamChat({ messages, tools: TOOL_DEFINITIONS, signal: this.abortController?.signal });

    let totalUsage = null;
    const sendEndStats = (textOut) => {
      const totalDurationSec = Number(((Date.now() - replyStartTime) / 1000).toFixed(1));
      const completionTokens = totalUsage?.completion_tokens || Math.max(1, Math.round((textOut || '').length / 2.5));
      const promptTokens = totalUsage?.prompt_tokens || Math.max(1, Math.round(promptUserText.length / 2.5) + 320);
      const totalTokens = totalUsage?.total_tokens || (promptTokens + completionTokens);

      this.chunker?.end();
      this._json({
        type: 'assistant_text_end',
        durationSec: totalDurationSec,
        tokens: {
          total: totalTokens,
          prompt: promptTokens,
          completion: completionTokens,
        },
      });
    };

    let firstRes;
    try {
      firstRes = await this._consumeStream(stream);
    } catch (err) {
      // 검색을 미리 실행해 둔 턴은 모델 지연으로 실패해도 검색 결과 요약을 답변으로 남긴다.
      if (preSearch && this._isActive() && (err.code === 'LLM_IDLE_TIMEOUT' || err.name === 'LlmInactivityError')) {
        const fallbackText = buildActionFallbackText([preSearch]);
        if (fallbackText) {
          this._showText(fallbackText);
          this.chunker?.push(fallbackText);
          sendEndStats(fallbackText);
          await this._ttsIdle();
          return fallbackText;
        }
      }
      throw err;
    }
    let fullText = firstRes.text;
    let emotion = firstRes.emotion;
    let toolResults = firstRes.toolResults || [];
    totalUsage = firstRes.usage || null;

    // 모델이 도구 호출을 빠뜨려도 명시적 요청은 서버가 보정한다.
    if (this._isActive() && explicitIntents.length) {
      const executed = new Set(toolResults.map((t) => t?.name));
      if (explicitIntents.includes('set_goal') && !executed.has('set_goal')) {
        const goalText = extractGoalText(userText);
        if (goalText) {
          this._json({ type: 'tool_start', name: 'set_goal', args: { text: goalText }, message: `목표 저장 중: "${goalText}"` });
          await this.setGoal(goalText);
          this._json({ type: 'tool_call', name: 'set_goal', args: { text: goalText }, result: { success: true } });
          toolResults.push({ name: 'set_goal', args: { text: goalText }, result: { success: true } });
        }
      }
      if (explicitIntents.includes('web_search') && !executed.has('web_search') && !preSearch && this._isActive()) {
        const query = extractSearchQuery(userText);
        this._json({ type: 'tool_start', name: 'web_search', args: { query }, message: `웹 검색 중: "${query}"` });
        const res = await executeWebSearch(query);
        if (this._isActive()) {
          this._json({ type: 'tool_call', name: 'web_search', args: { query }, result: res });
          toolResults.push({ name: 'web_search', args: { query }, result: res });
        }
      }
    }

    // ReAct 보강: 외부 데이터 검색/실행형 도구가 실행되었다면,
    // 결과 관측값을 LLM에 제공하여 최종 답변(해설, 출처, 그래프 설명 등)을 생성하도록 2차 스트림 실행
    const actionTools = (toolResults || []).filter((tr) =>
      ['read_file', 'web_search', 'calculator', 'python_execute', 'search_rag', 'plot_function_graph', 'start_quiz', 'create_flashcards', 'start_study_timer', 'open_explanation'].includes(tr.name)
    );

    if (actionTools.length > 0 && !this.cancelled) {
      const avatarName = getAvatarDisplayName(this.avatarModel);
      const observationText = actionTools.map((tr) => {
        if (tr.name === 'read_file') {
          if (tr.result?.isScanned || !tr.result?.success) {
            return `[첨부 파일/학습 자료 ("${tr.args?.filename || ''}") 읽기 결과]:\n${tr.result?.error || '해당 PDF는 스캔된 이미지 전자책으로 내부 텍스트 레이어가 없습니다.'}\n[주의]: 파일 원문 텍스트가 비어있으므로 더 이상 read_file을 호출하지 마세요. 대신 교재명("${tr.args?.filename || ''}")과 해당 과목/분야의 표준 교육과정 및 전문 지식을 활용하여 사용자의 질문에 친절하고 상세하게 직접 설명해 주세요.`;
          }
          return `[첨부 파일/학습 자료 ("${tr.args?.filename || ''}") 원문 읽기 결과 (총 ${tr.result?.totalPages || 1}페이지 중 ${tr.result?.page || 1}페이지)]:\n${tr.result?.content || tr.result?.error || '내용 없음'}`;
        }
        if (tr.name === 'open_explanation') {
          return `[칠판(개념 설명 패널) 판서 완료]:\n[칠판 제목]: "${tr.args?.title || '핵심 개념 정리'}"\n[칠판 본문 내용]:\n${tr.args?.content || ''}\n\n[발화 지침]:\n방금 화면 우측 칠판에 핵심 정리를 시각적으로 띄웠습니다. 사용자가 칠판을 함께 보면서 들을 수 있도록, 칠판 내용을 앵무새처럼 그대로 읽지 마세요! 칠판의 핵심 포인트와 흐름을 짚어가며, 귀로 듣기 좋고 이해하기 쉬운 다정한 친구(${avatarName}) 말투로 차근차근 풀어서 한국어로 설명해 주세요.`;
        }
        if (tr.name === 'web_search') {
          const answerText = tr.result?.answer ? `[AI 검색 요약]:\n${tr.result.answer}\n\n[출처 및 세부 검색 결과]:\n` : '';
          const list = (tr.result?.results || []).map((r) => `- [${r.title}](${r.url}): ${r.snippet}`).join('\n');
          const isFound = Boolean(tr.result?.answer || (tr.result?.results && tr.result.results.length > 0));
          const guideText = isFound
            ? `[답변 지침]:\n1. 위 검색 결과의 팩트와 출처를 기반으로 신뢰감 있게 설명하세요.\n2. 검색 결과를 종합해도 사용자의 질문에 대한 답이 불확실하거나 알 수 없다면, 절대 지어내지 말고 "검색해 봐도 정확한 사실을 찾기 어려워서 잘 모르겠어"라고 솔직하게 모른다고 답하세요.`
            : `[답변 지침 - 필수]:\n검색 결과에서 유의미한 정보를 찾지 못했습니다. 절대로 내용을 추측하여 지어내지 마세요! "인터넷으로 검색해 봤는데, 정확한 정보를 찾기 어려워서 잘 모르겠어. 미안해!"라고 솔직하게 모른다고 인정하세요.`;
          return `[웹 검색 및 실시간 사실 검증 결과 ("${tr.args?.query || ''}")]:\n${answerText}${list || tr.result?.error || '검색 결과 없음'}\n\n${guideText}`;
        }
        if (tr.name === 'calculator') {
          return `[계산 결과]:\n${tr.result?.expression} = ${tr.result?.result}`;
        }
        if (tr.name === 'python_execute') {
          return `[Python 실행 결과]:\n출력: ${tr.result?.stdout || '없음'}\n에러: ${tr.result?.stderr || '없음'}${tr.result?.imageUrl ? '\n(그래프 이미지가 성공적으로 생성되어 클라이언트에 표시되었습니다.)' : ''}`;
        }
        if (tr.name === 'search_rag') {
          const list = (tr.result || []).map((r) => `- ${r.document}`).join('\n');
          return `[학습자료 검색 결과 ("${tr.args?.query || ''}")]:\n${list || '관련 자료 없음'}`;
        }
        if (tr.name === 'start_quiz') {
          return `[인터랙티브 퀴즈 출제 완료]: "${tr.args?.topic || '학습'}" 주제의 ${tr.args?.questions?.length || 1}문제 4지선다형 퀴즈가 학생 대화창에 직접 누를 수 있는 인터랙티브 버튼 카드로 출제되었습니다. 학생에게 퀴즈를 버튼을 눌러 풀어보라고 다정하게 권유하세요.`;
        }
        if (tr.name === 'create_flashcards') {
          return `[암기 카드 생성 완료]: "${tr.args?.topic || '학습'}" 주제의 암기 카드 ${tr.args?.cards?.length || 4}장이 3D 카드 모달에 생성되었습니다. 카드를 넘겨가며 복습해보라고 안내하세요.`;
        }
        if (tr.name === 'start_study_timer') {
          return `[집중 타이머 시작]: ${tr.args?.minutes || 25}분 집중 공부 타이머가 작동하기 시작했습니다. 학생이 딴짓하지 않고 몰입할 수 있도록 응원해주세요.`;
        }
        if (tr.name === 'plot_function_graph') {
          return `[함수 그래프 캔버스 렌더링 완료]: f(x) = ${tr.args?.expression} 그래프가 화면에 그려졌습니다. 앞선 답변에서 이미 설명한 점·기울기·대칭 같은 내용은 절대 반복하지 말고, 그래프를 보며 짚어줄 새 포인트만 1~2문장으로 짧게 말하세요.`;
        }
        return '';
      }).filter(Boolean).join('\n\n');

      if (observationText) {
        const avatarName = getAvatarDisplayName(this.avatarModel);
        const secondMessages = [
          ...messages,
          { role: 'assistant', content: fullText || '요청하신 도구를 실행했습니다.' },
          { role: 'user', content: `${observationText}\n\n위 도구 실행 결과를 바탕으로 핵심 내용과 출처(또는 그래프 설명)를 사용자에게 친절하고 다정한 친구(${avatarName}) 말투로 한국어로 최종 답변해줘. (도구 태그나 JSON 코드는 절대 출력하지 말고 친절한 한국어 설명으로만 답해줘.)` },
        ];
        // 2차 요약 스트림은 추가 도구 호출 없이 순수 해설 생성을 위해 tools 전달 생략 및 allowTools: false
        this._status('thinking');
        const secondStream = llm.streamChat({ messages: secondMessages, signal: this.abortController?.signal });
        const secondRes = await this._consumeStream(secondStream, { allowTools: false });
        if (secondRes.usage) {
          if (!totalUsage) totalUsage = secondRes.usage;
          else {
            totalUsage = {
              prompt_tokens: (totalUsage.prompt_tokens || 0) + (secondRes.usage.prompt_tokens || 0),
              completion_tokens: (totalUsage.completion_tokens || 0) + (secondRes.usage.completion_tokens || 0),
              total_tokens: (totalUsage.total_tokens || 0) + (secondRes.usage.total_tokens || 0),
            };
          }
        }
        const secondText = String(secondRes.text || '').trim();
        const fallbackText = secondText ? '' : buildActionFallbackText(actionTools);
        if (fallbackText) {
          const fallbackChunk = `${fullText ? '\n' : ''}${fallbackText}`;
          this._showText(fallbackChunk);
          this.chunker?.push(fallbackChunk);
        }
        const combinedReply = (fullText ? fullText + '\n' : '') + (secondText || fallbackText);
        sendEndStats(combinedReply);
        await this._ttsIdle();
        return combinedReply;
      }
    }

    // 도구만 실행되어 본문 발화가 없었던 경우 2차 응답 생성 (가볍고 빠른 발화 유도)
    if (!fullText.trim() && (toolResults || []).length > 0 && !this.cancelled) {
      const avatarName = getAvatarDisplayName(this.avatarModel);
      const expTool = toolResults.find((t) => t.name === 'open_explanation');
      const isExplanation = Boolean(expTool);
      const expTitle = expTool?.args?.title;
      const followUpPrompt = isExplanation
        ? `방금 우측 칠판에 "${expTitle || '핵심 개념'}" 정리를 시각적으로 띄웠어. 사용자가 칠판을 함께 보면서 들을 수 있도록, 칠판 내용을 앵무새처럼 그대로 읽지 말고 칠판의 핵심 포인트와 흐름을 짚어가며 보면서 듣기 좋은 다정한 친구(${avatarName}) 말투로 2~3문장으로 간결하고 다정하게 한국어로 설명해줘. (도구 태그나 JSON 코드는 절대 출력하지 마.)`
        : `방금 요청한 작업을 잘 마쳤어. 이제 사용자에게 다정하고 친절한 어투로 한국어로 완료 안내 또는 다음 공부 대화를 친구(${avatarName}) 말투로 자연스럽게 말해줘. (도구 태그나 JSON 코드는 절대 출력하지 마.)`;

      const secondMessages = [
        ...messages,
        { role: 'assistant', content: '칠판에 정리를 완료했습니다.' },
        { role: 'user', content: followUpPrompt },
      ];
      this._status('thinking');
      const secondStream = llm.streamChat({ messages: secondMessages, signal: this.abortController?.signal });
      const secondRes = await this._consumeStream(secondStream, { allowTools: false });
      if (secondRes.usage) {
        if (!totalUsage) totalUsage = secondRes.usage;
        else {
          totalUsage = {
            prompt_tokens: (totalUsage.prompt_tokens || 0) + (secondRes.usage.prompt_tokens || 0),
            completion_tokens: (totalUsage.completion_tokens || 0) + (secondRes.usage.completion_tokens || 0),
            total_tokens: (totalUsage.total_tokens || 0) + (secondRes.usage.total_tokens || 0),
          };
        }
      }
      sendEndStats(secondRes.text);
      await this._ttsIdle();
      return secondRes.text;
    }

    // 발화가 완전히 비어있는 경우 기본 대화 폴백
    if (!fullText.trim() && !this.cancelled) {
      const fallback = '응, 듣고 있어! 오늘 어떤 걸 같이 공부해 볼까?';
      fullText = fallback;
      this._json({ type: 'assistant_text_partial', text: fallback });
      // TTS disabled
    }

    sendEndStats(fullText);
    await this._ttsIdle();
    return fullText;
  }

  async _consumeStream(stream, { allowTools = true } = {}) {
    const chunker = new SentenceChunker({
      flushTimeoutMs: config.chunker.flushTimeoutMs,
      maxChunkChars: config.chunker.maxChunkChars,
      onChunk: () => {},
    });
    this.chunker = chunker;

    let fullText = '';
    let emotion = null;
    let stage = 'head'; // head: 태그 파싱 중 / body: 본문
    let head = '';
    let emittedThinkLen = 0;
    let streamUsage = null;
    let streamDurationMs = null;
    const processedTools = new Set(); // 매 호출 초기화
    const processedEmotions = new Set(); // 본문 내 감정 태그 중복 트리거 방지
    const nativeToolMap = new Map(); // 네이티브 스트리밍 툴콜 누적 맵 (index -> { id, name, arguments })
    const toolPromises = [];
    let lastCleanLen = 0;
    // 칠판(open_explanation)은 JSON이 완성되기 전에도 판서 내용을 실시간으로 흘려보낸다
    let partialExpDone = false;
    let partialExpLen = 0;

    const dispatchedToolKeys = new Set();
    const dispatchTool = (name, args) => {
      if (!name || !this._isActive()) return null;
      const lower = name.toLowerCase();
      const serialized = args && typeof args === 'object' ? JSON.stringify(args) : String(args || '');
      const key = `${lower}::${serialized}`;
      if (dispatchedToolKeys.has(key)) {
        return null; // 중복 호출 방지 (텍스트 태그 + 네이티브 스트림 툴콜 중복 차단)
      }
      dispatchedToolKeys.add(key);
      return this._handleToolCall(lower, args);
    };

    const guardedStream = withIdleTimeout(stream, {
      idleTimeoutMs: this._streamIdleTimeoutMs(),
      label: this.currentModel === 'bonsai' ? 'Bonsai' : 'LLM',
      onTimeout: (err) => { try { this.abortController?.abort(err); } catch {} },
    });

    for await (const chunk of guardedStream) {
      if (!this._isActive()) break;
      if (chunk.usage) {
        streamUsage = chunk.usage;
      }
      if (chunk.total_duration_ms) {
        streamDurationMs = chunk.total_duration_ms;
      }
      if (chunk.thinking && this.think) {
        this._json({ type: 'assistant_think', text: chunk.thinking });
      }

      // 1) 네이티브 툴콜 델타 누적 (OpenAI / Oxion 스트리밍 규격)
      if (chunk.tool_call_delta) {
        for (const tc of chunk.tool_call_delta) {
          const idx = tc.index ?? 0;
          if (!nativeToolMap.has(idx)) {
            nativeToolMap.set(idx, {
              id: tc.id || `call_${idx}`,
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || '',
            });
          } else {
            const existing = nativeToolMap.get(idx);
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          }
        }
      }

      // 2) 완성형 툴콜 누적 (Ollama / 호환 규격)
      if (chunk.tool_calls) {
        for (let i = 0; i < chunk.tool_calls.length; i++) {
          const tc = chunk.tool_calls[i];
          nativeToolMap.set(i, {
            id: tc.id || `call_${i}`,
            name: tc.function?.name || '',
            arguments: typeof tc.function?.arguments === 'object'
              ? JSON.stringify(tc.function.arguments)
              : (tc.function?.arguments || '{}'),
          });
        }
      }

      const token = chunk.token || '';
      if (!token) continue;

      fullText += token;

      if (stage === 'head') {
        let combined = head + token;

        // 선행 <think>...</think> 블록이 완료된 경우: 생각 내용만 분리 후 본문/감정 태그 파싱으로 진행
        const thinkDone = combined.match(THINK_COMPLETE_RE);
        if (thinkDone) {
          const fullThink = thinkDone[1];
          const restThink = fullThink.slice(emittedThinkLen);
          if (restThink) {
            this._json({ type: 'assistant_think', text: restThink });
          }
          emittedThinkLen = 0;
          combined = combined.slice(thinkDone[0].length);
          fullText = combined;
          head = '';
        } else if (THINK_OPEN_PREFIX.test(combined)) {
          // <think> 태그가 아직 닫히지 않은 상태
          const openTagMatch = combined.match(/^\s*<think>/i);
          if (openTagMatch) {
            const inner = combined.slice(openTagMatch[0].length);
            // 끝에 '</think>' 일부가 걸려 있을 수 있으므로 최대 8자 유보
            const safeInnerEnd = Math.max(0, inner.length - 8);
            if (safeInnerEnd > emittedThinkLen) {
              this._json({ type: 'assistant_think', text: inner.slice(emittedThinkLen, safeInnerEnd) });
              emittedThinkLen = safeInnerEnd;
            }
          }
          head = combined;
          continue;
        }

        if (!combined) {
          head = '';
          continue;
        }

        const m = combined.match(EMOTION_TAG);
        if (m) {
          stage = 'body';
          emotion = m[1];
          this._json({ type: 'emotion', tag: emotion });
          // fullText에서 감정 태그 제거 → body 단계에서 정제 텍스트가 태그를 포함하지 않음
          fullText = combined.slice(m[0].length);
          head = '';
          lastCleanLen = 0;
        } else if (TAG_PREFIX.test(combined) && combined.length < 32) {
          head = combined; // 태그로 시작될 가능성이 있어 대기
          continue;
        } else {
          stage = 'body';
          emotion = 'neutral';
          fullText = combined;
          head = '';
          lastCleanLen = 0;
        }
      }

      // body 단계: 중간 <think>...</think> 제거, 감정 태그 스캔 및 도구 호출 스캔
      fullText = fullText.replace(/<think>([\s\S]*?)<\/think>/gi, (_, thought) => {
        if (thought.trim()) this._json({ type: 'assistant_think', text: thought });
        return '';
      });

      // 선행 <think> 없이 단독으로 나타난 </think> 분리 (생각 내용이 본문에 섞여 중복되는 현상 방지)
      if (fullText.search(/<\/think>/i) !== -1) {
        const thinkEndIdx = fullText.search(/<\/think>/i);
        const thinkStartIdx = fullText.search(/<think>/i);
        if (thinkStartIdx === -1 || thinkStartIdx > thinkEndIdx) {
          const thoughtPart = fullText.slice(0, thinkEndIdx).trim();
          if (thoughtPart) {
            this._json({ type: 'assistant_think', text: thoughtPart });
          }
          fullText = fullText.slice(thinkEndIdx + 8).trimStart();
          lastCleanLen = 0;
        }
      }

      // 본문 중간 감정 태그 감지 시 실시간 아바타 모션/표정 반영
      let emotionMatch;
      EMOTION_TAG_INLINE_RE.lastIndex = 0;
      while ((emotionMatch = EMOTION_TAG_INLINE_RE.exec(fullText)) !== null) {
        const tag = emotionMatch[1].toLowerCase();
        if (VALID_EMOTIONS.has(tag) && !processedEmotions.has(emotionMatch.index)) {
          processedEmotions.add(emotionMatch.index);
          emotion = tag;
          this._json({ type: 'emotion', tag });
        }
      }

      const calls = parseToolCalls(fullText);
      for (const call of calls) {
        if (!processedTools.has(call.start)) {
          processedTools.add(call.start);
          if (call.name === 'open_explanation') partialExpDone = true;
          if (allowTools) {
            const p = dispatchTool(call.name, call.args);
            if (p) toolPromises.push(p);
          }
        }
      }

      // 정제 텍스트 빌드: 처리된 도구 호출 제거 + 미완성 [TOOL:...]/<think> 유보
      const cleanText = buildCleanText(fullText, processedTools);
      const safeEnd = getSafeEmitEnd(cleanText, allowTools);
      if (lastCleanLen > safeEnd) {
        lastCleanLen = safeEnd;
      }
      if (safeEnd > lastCleanLen) {
        const newPart = cleanText.slice(lastCleanLen, safeEnd);
        if (newPart) {
          this._showText(newPart);
          chunker.push(newPart);
          lastCleanLen = safeEnd;
        }
      }

      // 칠판 판서 진행 과정 실시간 전송 (JSON 완성 전까지 title/content를 조각내어 흘려보냄)
      if (allowTools && !partialExpDone) {
        const pe = extractPartialExplanation(fullText);
        if (pe) {
          const grown = (pe.text?.length || 0) + (pe.title?.length || 0);
          if (grown > partialExpLen + 8) {
            partialExpLen = grown;
            this._json({ type: 'tool_partial', name: 'open_explanation', title: pe.title || '', text: pe.text || '' });
          }
        }
      }
    }

    // 스트림이 태그 도중에 끝난 경우 남은 head를 표시 (<think> 잔여물 제외)
    if (stage === 'head' && head) {
      const cleanedHead = head.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
      if (cleanedHead) {
        this._showText(cleanedHead);
        chunker.push(cleanedHead);
      }
    }

    // 스트림 종료 시:
    // A) 텍스트 태그 기반 도구 호출 최종 스캔
    const finalCalls = parseToolCalls(fullText);
    for (const call of finalCalls) {
      if (!processedTools.has(call.start)) {
        processedTools.add(call.start);
        if (allowTools && this._isActive()) {
          const p = dispatchTool(call.name, call.args);
          if (p) toolPromises.push(p);
        }
      }
    }

    // B) 네이티브 도구 호출(Function Call) 실행 (allowTools가 true일 때만)
    if (allowTools && this._isActive()) {
      for (const [, call] of nativeToolMap) {
        if (!call.name) continue;
        const lowerName = call.name.toLowerCase();
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(call.arguments || '{}');
        } catch (err) {
          console.warn('[pipeline] 네이티브 도구 인자 JSON 파싱 실패:', call.arguments);
        }
        const p = dispatchTool(lowerName, parsedArgs);
        if (p) toolPromises.push(p);
      }
    }

    if (stage === 'body') {
      const finalClean = buildCleanText(fullText, processedTools)
        .replace(/\[TOOL:[^\]]*\][\s\S]*$/g, '')
        .replace(/<think>[\s\S]*$/gi, '');
      if (lastCleanLen > finalClean.length) {
        lastCleanLen = finalClean.length;
      }
      if (finalClean.length > lastCleanLen) {
        const tailPart = finalClean.slice(lastCleanLen);
        if (tailPart) {
          this._showText(tailPart);
          chunker.push(tailPart);
        }
      }
    }

    const toolResults = await this._awaitToolResults(toolPromises);
    if (this._isActive()) {
      for (const tr of toolResults) {
        try { this.memory.shortTerm?.rememberTool?.(tr.name, tr.args, tr.result); } catch {}
      }
    }
    // 이 스트림의 로컬 청커는 반드시 여기서 닫는다. 다음 스트림이 시작된 뒤
    // 이전 청커의 타임아웃이 늦게 발화해 순서가 뒤집히는 것을 막는다.
    if (this.chunker === chunker) {
      if (this._isActive()) chunker.end();
      else {
        chunker.buffer = '';
        chunker._clearTimer?.();
        chunker.ended = true;
      }
    }
    const cleanedOutput = buildCleanText(fullText, processedTools)
      .replace(/\[TOOL:[^\]]*\]?/gi, '')
      .replace(/<think>[\s\S]*$/gi, '')
      .trim();
    return { text: cleanedOutput, emotion, toolResults, usage: streamUsage, durationMs: streamDurationMs };
  }

  // 도구 하나가 멈춰도 턴 전체가 무한 대기하지 않도록 결과 수집에 상한을 둔다.
  async _awaitToolResults(promises, timeoutMs = TOOL_WAIT_TIMEOUT_MS) {
    if (!promises.length) return [];
    let timer = null;
    try {
      const results = await Promise.race([
        Promise.all(promises).catch(() => []),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (results === null) {
        console.warn(`[pipeline] 도구 결과 대기 시간 초과 (${Math.round(timeoutMs / 1000)}초)`);
        return [];
      }
      return results.filter(Boolean);
    } finally {
      clearTimeout(timer);
    }
  }

  async _handleToolCall(name, args) {
    if (!this._isActive()) return null;
    if (name === 'set_tone') {
      // 서버 내부 처리: 톤 오버라이드 저장 (클라이언트 미전송)
      this.toneOverride = TONE_MAP[args?.style] || null;
      return null;
    }
    if (!VALID_TOOLS.has(name)) {
      // 미등록 도구
      this._json({ type: 'tool_call', name, args, error: '알 수 없는 도구: ' + name });
      return null;
    }

    try {
      if (name === 'read_file') {
        const reqPage = Number(args?.page) || 1;
        const reqMax = Math.max(1, Math.min(Number(args?.maxPages) || 3, 10));
        const pageLabel = reqMax > 1 ? `${reqPage}~${reqPage + reqMax - 1}쪽` : `${reqPage}쪽`;
        this._json({ type: 'tool_start', name, args, message: `학습 자료 읽는 중: "${args?.filename || ''}" (${pageLabel})` });
        const res = await executeReadFile(args?.filename, reqPage, reqMax, this.sessionId, this.accountId);
        this._json({ type: 'tool_call', name, args, result: res });
        return { name, args, result: res };
      }
      if (name === 'web_search') {
        const query = (args?.query || '').trim();
        this._json({ type: 'tool_start', name, args: { query }, message: `웹 검색 중: "${query}"` });
        const res = await executeWebSearch(query);
        this._json({ type: 'tool_call', name, args: { query }, result: res });
        return { name, args: { query }, result: res };
      }
      if (name === 'calculator') {
        this._json({ type: 'tool_start', name, args, message: `계산 중: ${args?.expression || ''}` });
        const res = await executeCalculator(args?.expression);
        this._json({ type: 'tool_call', name, args, result: res });
        return { name, args, result: res };
      }
      if (name === 'python_execute') {
        const code = (args?.code && String(args.code).trim())
          ? String(args.code)
          : 'import sys\nprint("Python 3 실행 환경 준비 완료! (v" + sys.version.split()[0] + ")")';
        this._json({ type: 'tool_start', name, args: { code }, message: 'Python 코드 실행 중...' });
        const res = await executePython(code);
        this._json({ type: 'tool_call', name, args: { code }, result: res });
        return { name, args: { code }, result: res };
      }
      if (name === 'search_rag') {
        this._json({ type: 'tool_start', name, args, message: `학습 자료 검색 중: "${args?.query || ''}"` });
        const hits = await search(args?.query || '', { topK: 3, sessionId: this.sessionId, accountId: this.accountId });
        this._json({ type: 'tool_call', name, args, result: hits });
        return { name, args, result: hits };
      }
      if (name === 'start_quiz') {
        this._json({ type: 'tool_start', name, args, message: `맞춤 퀴즈 출제 중: "${args?.topic || '학습 주제'}"` });
        this._json({ type: 'tool_call', name, args, result: { success: true, count: args?.questions?.length || 0 } });
        return { name, args, result: { success: true, topic: args?.topic, count: args?.questions?.length || 0 } };
      }
      if (name === 'create_flashcards') {
        this._json({ type: 'tool_start', name, args, message: `암기 카드 생성 중: "${args?.topic || '핵심 개념'}"` });
        this._json({ type: 'tool_call', name, args, result: { success: true, count: args?.cards?.length || 0 } });
        return { name, args, result: { success: true, topic: args?.topic, count: args?.cards?.length || 0 } };
      }
      if (name === 'start_study_timer') {
        const mins = Number(args?.minutes) || 25;
        this._json({ type: 'tool_start', name, args, message: `집중 타이머 시작: ${mins}분` });
        this._json({ type: 'tool_call', name, args, result: { success: true, minutes: mins } });
        return { name, args, result: { success: true, minutes: mins } };
      }
      if (name === 'plot_function_graph') {
        this._json({ type: 'tool_start', name, args, message: `함수 그래프 시각화: f(x) = ${args?.expression || 'x^2'}` });
        this._json({ type: 'tool_call', name, args, result: { success: true, expression: args?.expression } });
        return { name, args, result: { success: true, expression: args?.expression } };
      }
      if (name === 'open_explanation') {
        const titleStr = args?.title ? `"${args.title}"` : '핵심 개념 정리';
        this._json({ type: 'tool_start', name, args, message: `개념 칠판 정리 판서 중: ${titleStr}` });
        this._json({ type: 'tool_call', name, args, result: { success: true, title: args?.title } });
        return { name, args, result: { success: true, title: args?.title } };
      }
    } catch (err) {
      console.error(`[pipeline] 도구 실행 예외 (${name}):`, err);
      const errRes = { error: err.message || '도구 실행 실패' };
      this._json({ type: 'tool_call', name, args, result: errRes });
      return { name, args, result: errRes };
    }

    // 나머지 도구(open_explanation, close_explanation 등)는 클라이언트로 방출
    this._json({ type: 'tool_call', name, args });
    return { name, args, result: { success: true } };
  }

  _showText(text) {
    if (!text || !this._isActive()) return;
    this._json({ type: 'assistant_text_partial', text });
  }

  _enqueueTTS() {} // TTS removed
  async _processTTS() {} // TTS removed
  async _ttsIdle() {} // TTS removed

  async testTTS() {} // TTS removed

  async testStream(text = '이것은 스트리밍 텍스트 테스트입니다. 감정 태그와 토큰 흐름을 확인해 보세요. 잘 작동하고 있어요!') {
    this._json({ type: 'emotion', tag: 'cheer' });
    let i = 0;
    while (i < text.length) {
      const step = 1 + Math.floor(Math.random() * 4);
      this._json({ type: 'assistant_text_partial', text: text.slice(i, i + step) });
      i += step;
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 45));
    }
    this._json({ type: 'assistant_text_end' });
  }

  async ragDemo(query) {
    const hits = await search(query, { topK: 5, sessionId: this.sessionId });
    this._json({ type: 'rag_result', query, hits });
    return hits;
  }

  _rememberFacts(userText, reply) {
    // 1) 계정별 개인 인텔리전스 누적 분석 (시연 계정은 계정 전역에 남기지 않음)
    try {
      if (!this.demoMode && this.intelligence) {
        this.intelligence.inspectTurn(userText, reply);
        if (/헷갈|어렵|모르|이해가 안/i.test(userText)) {
          this.intelligence.addFact(`취약 단원/개념: ${userText.slice(0, 40).trim()}`);
        }
      }
    } catch {}

    // 2) 규칙 기반 세션 장기 기억 추출
    const longTerm = this.memory.longTerm;
    if (/헷갈|어렵|모르|이해가 안/i.test(userText)) {
      const content = userText.replace(/헷갈.*/, '').slice(0, 60) || userText.slice(0, 60);
      longTerm.add({ type: 'weak_concept', content: `헷갈리는 개념: ${content.trim()}`, tags: ['취약개념'], importance: 3.5 });
    }
    if (/틀렸|오답|실수/i.test(userText)) {
      longTerm.add({ type: 'mistake', content: userText.slice(0, 60), tags: ['오답'], importance: 4 });
    }
    if (/완전히 이해|이제 알겠|마스터|정복/i.test(userText)) {
      const recent = longTerm.all().find((i) => i.type === 'weak_concept' && !i.mastered);
      if (recent) longTerm.setMastered(recent.id, true);
    }
  }
}