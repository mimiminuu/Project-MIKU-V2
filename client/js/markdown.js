// ChatGPT 스타일 마크다운 + 수식(KaTeX/폴백) 파서 (XSS 방지 포함).
// "보호된 블록" 패턴: 코드/수식/생각 블록을 placeholder로 추출 → 인라인 처리 → 블록 요소(표/목록/인용/문단) → 복원.

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatMathHtml(raw) {
  let s = escapeHtml(raw.trim());
  const symbols = {
    '\\times': '×', '\\div': '÷', '\\pm': '±', '\\mp': '∓',
    '\\cdot': '·', '\\neq': '≠', '\\ne': '≠', '\\leq': '≤', '\\le': '≤',
    '\\geq': '≥', '\\ge': '≥', '\\approx': '≈', '\\infty': '∞',
    '\\rightarrow': '→', '\\to': '→', '\\Rightarrow': '⇒',
    '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\theta': 'θ', '\\pi': 'π', '\\Delta': 'Δ',
  };
  for (const [k, v] of Object.entries(symbols)) {
    s = s.split(k).join(v);
  }
  s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)');
  s = s.replace(/\\sqrt\{([^{}]+)\}/g, '√($1)');
  s = s.replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>');
  s = s.replace(/\^([0-9a-zA-Z+-]+)/g, '<sup>$1</sup>');
  s = s.replace(/_\{([^{}]+)\}/g, '<sub>$1</sub>');
  s = s.replace(/_([0-9a-zA-Z+-]+)/g, '<sub>$1</sub>');
  return s;
}

function renderMath(raw, displayMode = false) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (typeof globalThis.katex?.renderToString === 'function') {
    try {
      // 수식 내부의 한글 구간("x 와 y")은 공백 유지를 위해 \text{...}로 감싸서 KaTeX에 전달
      const katexExpr = trimmed.replace(/(\s*[가-힣]+\s*)/g, (m) => `\\text{${m}}`);
      return globalThis.katex.renderToString(katexExpr, {
        displayMode,
        throwOnError: false,
        strict: false,
      });
    } catch {
      return formatMathHtml(trimmed);
    }
  }
  return formatMathHtml(trimmed);
}

function parseTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isTableSeparator(line) {
  const t = line.trim();
  if (!t.includes('|')) return false;
  const cells = parseTableRow(t);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

export function renderMarkdown(text) {
  if (!text) return '';

  const blocks = []; // 보호된 블록 저장소
  let src = String(text).replace(/\r\n/g, '\n');

  // 0) <think>...</think> 블록 추출 (스트리밍 중 미닫힘 포함)
  src = src.replace(/<think>([\s\S]*?)(?:<\/think>|$)/gi, (_, thought) => {
    const trimmed = thought.trim();
    if (!trimmed) return '';
    const idx = blocks.length;
    blocks.push(
      `<details class="think-details"><summary><span class="think-summary-label">생각 과정 보기</span><span class="think-toggle-icon">▾</span></summary><div class="think-body">${escapeHtml(trimmed)}</div></details>`
    );
    return `\n__BLOCK_${idx}__\n`;
  });

  // 선행 <think> 없이 단독으로 남은 </think> 태그 잔여물 완전 제거
  src = src.replace(/<\/?think>/gi, '');

  // 0-1) Live2D 감정 태그 및 도구 태그 잔여물([close_explanation], [TOOL:...], [smile] 등) 텍스트 노출 방지
  // 태그 및 태그 뒤에 이어지는 완성/미완성 JSON 블록 제거
  src = src.replace(/\[(?:TOOL:\s*)?([a-zA-Z_]\w*)\s*\](?:\s*(?:```(?:json)?\s*)?\{[\s\S]*?(?:\}(?:\s*```)?|$))?/gi, (match, tag) => {
    const lower = tag.toLowerCase();
    const isSpecial = /^(close_explanation|open_explanation|start_quiz|create_flashcards|start_study_timer|plot_function_graph|read_file|search_rag|calculator|python_execute|web_search|set_goal|set_tone|set_emotion|smile|think|cheer|sad|wink|love|neutral|focus|proud|fighting|shy|panic|curious|dozeoff|relieved|pout|whisper|sparkle|spaceout|nod|shake|wave|clap|dance|explain|surprise|joy|angry|sleepy|wakeup|greet)$/i.test(lower);
    return isSpecial ? '' : match;
  });
  src = src.replace(/\[TOOL:[^\]]*\]/gi, '');
  src = src.replace(/\[(close_explanation|open_explanation|start_quiz|create_flashcards|start_study_timer|plot_function_graph|read_file|search_rag|calculator|python_execute|web_search|set_goal|set_tone|set_emotion)\](?!\()/gi, '');
  src = src.replace(/\[(?:smile|think|cheer|sad|wink|love|neutral|focus|proud|fighting|shy|panic|curious|dozeoff|relieved|pout|whisper|sparkle|spaceout|nod|shake|wave|clap|dance|explain|surprise|joy|angry|sleepy|wakeup|greet)\]?(?!\()/gi, '');
  // 태그 없이 단독으로 누출된 도구 파라미터 JSON 잔여물 제거 (예: {"filename":..., {"query":... 등)
  src = src.replace(/\{(?:\s*"(?:filename|query|expression|code|topic|questions|cards|minutes|title|content|style|text)"[\s\S]*?(?:\}|$))/gi, '');

  // 1) 코드 블록 추출 (```...```, ChatGPT 스타일 헤더 + 복사 버튼 포함)
  src = src.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    const idx = blocks.length;
    const cleanLang = escapeHtml(lang || 'text');
    const cleanCode = escapeHtml(code.replace(/\n$/, ''));
    blocks.push(
      `<div class="code-card"><div class="code-card-header"><span class="code-lang">${cleanLang}</span><button type="button" class="btn-copy-code" title="복사">복사</button></div><pre><code class="${cleanLang}">${cleanCode}</code></pre></div>`
    );
    return `\n__BLOCK_${idx}__\n`;
  });

  // 2) 수식 블록 추출 ($$...$$ 및 \[...\], 스트리밍 중 미닫힘 대응)
  src = src.replace(/\$\$([\s\S]*?)(?:\$\$|$)/g, (_, math) => {
    const idx = blocks.length;
    blocks.push(`<div class="math-block">${renderMath(math, true)}</div>`);
    return `\n__BLOCK_${idx}__\n`;
  });
  src = src.replace(/\\\[([\s\S]*?)(?:\\\]|$)/g, (_, math) => {
    const idx = blocks.length;
    blocks.push(`<div class="math-block">${renderMath(math, true)}</div>`);
    return `\n__BLOCK_${idx}__\n`;
  });

  // 3) 인라인 코드 추출 (`` `...` ``) — 수식/강조보다 우선
  src = src.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = blocks.length;
    blocks.push(`<code>${escapeHtml(code)}</code>`);
    return `__BLOCK_${idx}__`;
  });

  // 4) 인라인 수식 ($...$ 및 \(...\)) — "$ x $의"처럼 뒤에 한글 조사가 붙거나 내부 공백이 있어도 정상 변환
  src = src.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => {
    const idx = blocks.length;
    blocks.push(`<span class="math-inline">${renderMath(math, false)}</span>`);
    return `__BLOCK_${idx}__`;
  });
  src = src.replace(/(?<![a-zA-Z0-9\\])\$([^\$\n]+?)\$(?![0-9])/g, (_, math) => {
    const idx = blocks.length;
    blocks.push(`<span class="math-inline">${renderMath(math, false)}</span>`);
    return `__BLOCK_${idx}__`;
  });

  // 4-1) 마크다운 링크 ([텍스트](https://...))
  src = src.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const idx = blocks.length;
    blocks.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    return `__BLOCK_${idx}__`;
  });

  // 5) 인라인 강조 (***bold+italic***, **bold**, *italic*, ~~strike~~)
  src = src.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  src = src.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  src = src.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  src = src.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // 5-1) XSS 방지: 보호된 블록(placeholder)을 제외한 모든 텍스트 이스케이프
  src = escapeHtml(src);
  src = src.replace(/&lt;strong&gt;&lt;em&gt;(.+?)&lt;\/em&gt;&lt;\/strong&gt;/g, '<strong><em>$1</em></strong>');
  src = src.replace(/&lt;strong&gt;(.+?)&lt;\/strong&gt;/g, '<strong>$1</strong>');
  src = src.replace(/&lt;em&gt;(.+?)&lt;\/em&gt;/g, '<em>$1</em>');
  src = src.replace(/&lt;del&gt;(.+?)&lt;\/del&gt;/g, '<del>$1</del>');

  // 6) 블록 요소 처리 — 줄 단위로
  const lines = src.split('\n');
  const htmlLines = [];
  let inList = false, listType = '';
  let quoteBuf = [];

  const closeList = () => {
    if (inList) {
      htmlLines.push(`</${listType}>`);
      inList = false;
      listType = '';
    }
  };

  const flushQuote = () => {
    if (quoteBuf.length) {
      htmlLines.push(`<blockquote>${quoteBuf.join('<br/>')}</blockquote>`);
      quoteBuf = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 빈 줄: 단락/목록/인용 구분
    if (trimmed === '') {
      closeList();
      flushQuote();
      continue;
    }

    // 인용 (이스케이프 후 &gt; 로 변함) — 연속된 인용 줄은 하나의 blockquote로 병합
    if (trimmed.startsWith('&gt; ') || trimmed === '&gt;') {
      closeList();
      quoteBuf.push(trimmed.slice(4).trim());
      continue;
    }
    flushQuote();

    // 독립 블록 placeholder (<div class="code-card">, <div class="math-block">, <details>)
    if (/^__BLOCK_\d+__$/.test(trimmed)) {
      closeList();
      htmlLines.push(trimmed);
      continue;
    }

    // 마크다운 표 (현재 줄에 |가 있고 다음 줄이 구분선 | --- | 인 경우)
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      closeList();
      const headers = parseTableRow(trimmed);
      i += 2; // 헤더 + 구분선 건너뛰기
      const bodyRows = [];
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
        bodyRows.push(parseTableRow(lines[i]));
        i++;
      }
      i--; // 루프 증가 보정
      const thead = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
      const tbody = bodyRows.length
        ? `<tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '';
      htmlLines.push(`<div class="table-wrap"><table class="md-table">${thead}${tbody}</table></div>`);
      continue;
    }

    // 수평선 (---, ***)
    if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
      closeList();
      htmlLines.push('<hr/>');
      continue;
    }

    // 헤더 (# ~ ######)
    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      closeList();
      const level = Math.min(hMatch[1].length, 4);
      htmlLines.push(`<h${level}>${hMatch[2]}</h${level}>`);
      continue;
    }

    // 순서 없는 목록 (-, *, •, +)
    const ulMatch = trimmed.match(/^[-*•+]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        closeList();
        htmlLines.push('<ul>');
        inList = true; listType = 'ul';
      }
      htmlLines.push(`<li>${ulMatch[1]}</li>`);
      continue;
    }

    // 순서 있는 목록 (1. 또는 1))
    const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        closeList();
        htmlLines.push('<ol>');
        inList = true; listType = 'ol';
      }
      htmlLines.push(`<li>${olMatch[1]}</li>`);
      continue;
    }

    // "수식 : 설명" 패턴 (예: "x^2 = 16 : 이 방정식은...") → 수식 배지 카드 행으로 변환
    const eqRowMatch = trimmed.match(/^([0-9a-zA-Z()+\-*/^=\s]{3,28}=[^:\n]{1,16})\s*:\s+(.+)$/);
    if (eqRowMatch) {
      closeList();
      const eqHtml = renderMath(eqRowMatch[1], false);
      htmlLines.push(`<div class="example-row"><span class="math-badge">${eqHtml}</span><span class="example-desc">${eqRowMatch[2]}</span></div>`);
      continue;
    }

    // 일반 텍스트: 단락으로 감싸기
    closeList();
    htmlLines.push(`<p>${line}</p>`);
  }
  closeList();
  flushQuote();

  let result = htmlLines.join('\n');

  // 7) placeholder를 원래 블록으로 복원 (함수 치환으로 $ 특수 패턴 간섭 방지)
  for (let i = 0; i < blocks.length; i++) {
    result = result.replace(`__BLOCK_${i}__`, () => blocks[i]);
  }

  return result;
}
