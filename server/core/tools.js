import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { CLIENT_DIR, MATERIALS_DIR } from '../config.js';
import { materialDir } from './sessions.js';

const GENERATED_DIR = path.join(CLIENT_DIR, 'assets', 'generated');

function getPythonRunner(subArgs = []) {
  if (process.env.PYTHON_BIN) {
    return { cmd: process.env.PYTHON_BIN, args: subArgs };
  }
  if (process.platform === 'win32') {
    return { cmd: 'py', args: ['-3', ...subArgs] };
  }
  return { cmd: 'python3', args: subArgs };
}

async function cleanupOldPlots(dir, maxFiles = 30) {
  try {
    const list = await fs.readdir(dir);
    const pngs = list.filter((f) => f.startsWith('plot_') && f.endsWith('.png'));
    if (pngs.length <= maxFiles) return;
    const stats = await Promise.all(
      pngs.map(async (name) => {
        const p = path.join(dir, name);
        const s = await fs.stat(p).catch(() => null);
        return { name, path: p, mtime: s?.mtimeMs || 0 };
      })
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    const toRemove = stats.slice(maxFiles);
    for (const item of toRemove) {
      await fs.unlink(item.path).catch(() => {});
    }
  } catch {}
}

/**
 * 1) web_search: 최신 정보 검색 및 출처 확인 (Tavily Search API 우선, DuckDuckGo 폴백)
 * @param {string} query
 * @returns {Promise<{ success: boolean, query: string, answer?: string, results: Array<{ title: string, url: string, snippet: string }>, error?: string }>}
 */
export async function executeWebSearch(query) {
  const tavilyApiKey = process.env.TAVILY_API_KEY?.trim();

  // 1순위: Tavily Search API (빠른 속도, 풍부한 본문 요약, 높은 한국어 검색 품질)
  if (tavilyApiKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyApiKey,
          query: query || '',
          search_depth: 'basic',
          include_answer: true,
          max_results: 5,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`Tavily HTTP ${resp.status}: ${errorText}`);
      }

      const data = await resp.json();
      const formatted = (data.results || []).map((r) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.content || '',
      }));

      return {
        success: true,
        query: query || '',
        answer: data.answer || '',
        results: formatted,
      };
    } catch (err) {
      console.warn(`[tools:web_search] Tavily 검색 실패 (${err.message}), DuckDuckGo로 폴백합니다.`);
    }
  }

  // 2순위: DuckDuckGo 검색 (API 키 미설정 또는 네트워크 오류 시 폴백)
  const pyCode = [
    'import json, sys, re',
    'try:',
    '    from duckduckgo_search import DDGS',
    '    q = sys.argv[1]',
    '    is_ko = bool(re.search(r"[가-힣]", q))',
    '    reg = "kr-kr" if is_ko else "wt-wt"',
    '    ddgs = DDGS()',
    '    try:',
    '        results = list(ddgs.text(q, region=reg, max_results=5))',
    '    except Exception:',
    '        results = []',
    '    if not results and reg != "wt-wt":',
    '        try:',
    '            results = list(ddgs.text(q, region="wt-wt", max_results=5))',
    '        except Exception:',
    '            results = []',
    '    formatted = [{"title": r.get("title", ""), "url": r.get("href", ""), "snippet": r.get("body", "")} for r in results]',
    '    print(json.dumps({"success": True, "query": q, "results": formatted}, ensure_ascii=False))',
    'except Exception as e:',
    '    print(json.dumps({"success": False, "query": sys.argv[1] if len(sys.argv) > 1 else "", "error": str(e), "results": []}, ensure_ascii=False))'
  ].join('\n');

  return new Promise((resolve) => {
    const runner = getPythonRunner(['-c', pyCode, query || '']);
    const p = spawn(runner.cmd, runner.args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
    p.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });

    p.on('error', (err) => {
      resolve({ success: false, query, error: err.message || '프로세스 실행 실패', results: [] });
    });

    p.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (err) {
        resolve({ success: false, query, error: stderr.trim() || err.message, results: [] });
      }
    });
  });
}

/**
 * 2) calculator: 고정밀 수치 계산 및 대수/방정식/분수 해석 (SymPy + Math)
 * @param {string} expression
 * @returns {Promise<{ success: boolean, expression: string, result?: string, error?: string }>}
 */
export async function executeCalculator(expression) {
  const pyCode = [
    'import json, sys, math, re',
    'try:',
    '    raw = sys.argv[1].strip()',
    '    expr = raw.replace("×", "*").replace("÷", "/").replace("^", "**")',
    '    expr = re.sub(r"(\\d+)%", r"(\\1/100)", expr)',
    '    expr = re.sub(r"(?<=\\d),(?=\\d)", "", expr)',
    '    expr = re.sub(r"(\\d)\\s*([a-zA-Z(])", r"\\1 * \\2", expr)',
    '    expr = re.sub(r"\\)\\s*([a-zA-Z0-9(])", r") * \\1", expr)',
    '    expr = re.sub(r"\\b([xyzabckmnXYZABCKMN])\\s*\\(", r"\\1 * (", expr)',
    '',
    '    res_str = ""',
    '    try:',
    '        import sympy as sp',
    '        x, y, z, t = sp.symbols("x y z t")',
    '        if "=" in expr:',
    '            left, right = expr.split("=", 1)',
    '            eq = sp.Eq(sp.sympify(left), sp.sympify(right))',
    '            sol = sp.solve(eq)',
    '            res_str = f"방정식 해: {sol}"',
    '        else:',
    '            sym_res = sp.sympify(expr)',
    '            if sym_res.is_number and not sym_res.is_Integer:',
    '                try:',
    '                    val = float(sym_res.evalf())',
    '                    res_str = f"{sym_res} (≈ {val:.6g})"',
    '                except Exception:',
    '                    res_str = str(sym_res)',
    '            else:',
    '                res_str = str(sym_res)',
    '    except Exception:',
    '        allowed = {k: getattr(math, k) for k in dir(math) if not k.startswith("_")}',
    '        allowed.update({"abs": abs, "round": round, "pi": math.pi, "e": math.e})',
    '        res_str = str(eval(expr, {"__builtins__": {}}, allowed))',
    '',
    '    print(json.dumps({"success": True, "expression": raw, "result": res_str}, ensure_ascii=False))',
    'except Exception as e:',
    '    print(json.dumps({"success": False, "expression": sys.argv[1] if len(sys.argv) > 1 else "", "error": str(e)}, ensure_ascii=False))'
  ].join('\n');

  return new Promise((resolve) => {
    const runner = getPythonRunner(['-c', pyCode, expression || '']);
    const p = spawn(runner.cmd, runner.args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      try { p.kill(); } catch {}
      resolve({ success: false, expression, error: '계산 시간 초과 (10초)' });
    }, 10000);

    p.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
    p.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });

    p.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, expression, error: err.message || '프로세스 실행 실패' });
    });

    p.on('close', () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (err) {
        resolve({ success: false, expression, error: stderr.trim() || err.message });
      }
    });
  });
}

/**
 * 3) python_execute: 수학 풀이, 데이터 분석 및 고품질 한글 차트 시각화
 * @param {string} code
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, imageUrl?: string }>}
 */
export async function executePython(code) {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  void cleanupOldPlots(GENERATED_DIR);
  const filename = `plot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`;
  const plotPath = path.join(GENERATED_DIR, filename).replace(/\\/g, '/');

  const wrapperCode = [
    'import sys, os, warnings, logging',
    'warnings.filterwarnings("ignore")',
    'logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)',
    'import matplotlib',
    'matplotlib.use("Agg")',
    'import matplotlib.pyplot as plt',
    '',
    '# 1. 한글 폰트 및 마이너스 부호 깨짐 방지',
    'matplotlib.rcParams["font.family"] = ["Malgun Gothic", "NanumGothic", "AppleGothic", "sans-serif"]',
    'matplotlib.rcParams["axes.unicode_minus"] = False',
    '',
    '# 2. 다크 모드에 최적화된 세련된 그래프 스타일',
    'plt.style.use("dark_background")',
    'matplotlib.rcParams["figure.facecolor"] = "#1e1e1e"',
    'matplotlib.rcParams["axes.facecolor"] = "#171717"',
    'matplotlib.rcParams["axes.edgecolor"] = "#444444"',
    'matplotlib.rcParams["grid.color"] = "#333333"',
    'matplotlib.rcParams["grid.alpha"] = 0.5',
    'matplotlib.rcParams["text.color"] = "#ececec"',
    'matplotlib.rcParams["axes.labelcolor"] = "#ececec"',
    '',
    '_plot_saved = False',
    '_orig_show = plt.show',
    '_orig_savefig = plt.savefig',
    '',
    'def _custom_savefig(*args, **kwargs):',
    '    global _plot_saved',
    '    _plot_saved = True',
    `    return _orig_savefig(r"${plotPath}", *args, **kwargs)`,
    '',
    'def _custom_show(*args, **kwargs):',
    '    global _plot_saved',
    '    _plot_saved = True',
    '    plt.tight_layout()',
    `    _orig_savefig(r"${plotPath}", dpi=140)`,
    '    plt.close("all")',
    '',
    'plt.savefig = _custom_savefig',
    'plt.show = _custom_show',
    '',
    '# 사용자 코드 시작',
    (code && code.trim()) ? code : 'import sys\nprint("Python 3 실행 환경 준비 완료! (v" + sys.version.split()[0] + ")")',
    '# 사용자 코드 종료',
    '',
    'if not _plot_saved and plt.get_fignums():',
    '    plt.tight_layout()',
    `    _orig_savefig(r"${plotPath}", dpi=140)`,
    '    plt.close("all")',
    '    _plot_saved = True',
    '',
    'if _plot_saved:',
    `    print("__PLOT_SAVED__:${filename}")`,
  ].join('\n');

  return new Promise((resolve) => {
    const runner = getPythonRunner(['-c', wrapperCode]);
    const p = spawn(runner.cmd, runner.args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      try { p.kill(); } catch {}
      resolve({ success: false, stdout: '', stderr: 'Python 코드 실행 시간 초과 (15초)', imageUrl: null });
    }, 15000);

    p.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
    p.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });

    p.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        stdout: '',
        stderr: err.message || 'Python 프로세스 시작 실패',
        imageUrl: null,
      });
    });

    p.on('close', (exitCode) => {
      clearTimeout(timeout);
      let imageUrl = null;
      if (stdout.includes('__PLOT_SAVED__:')) {
        imageUrl = `/assets/generated/${filename}`;
        stdout = stdout.replace(/__PLOT_SAVED__:[^\n]*\n?/g, '');
      }
      resolve({
        success: exitCode === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        imageUrl,
      });
    });
  });
}

/**
 * 4) read_file: 업로드/첨부된 학습 자료(PDF, TXT, MD) 직접 읽기
 * @param {string} filename
 * @param {number} [page=1]
 * @param {number} [maxPages=3]
 * @returns {Promise<{ success: boolean, filename: string, totalPages: number, page: number, content: string, error?: string }>}
 */
export function findMaterialFile(query, sessionId = null, accountId = 'anonymous') {
  let targetDir = MATERIALS_DIR;
  if (sessionId) {
    const sessionDir = materialDir(MATERIALS_DIR, accountId, sessionId);
    if (!fsSync.existsSync(sessionDir)) return null;
    targetDir = sessionDir;
  } else {
    if (!fsSync.existsSync(targetDir)) return null;
  }

  const files = fsSync.readdirSync(targetDir)
    .filter((f) => {
      try {
        return fsSync.statSync(path.join(targetDir, f)).isFile();
      } catch {
        return false;
      }
    })
    .map((f) => ({
      name: f,
      path: path.join(targetDir, f),
      mtime: fsSync.statSync(path.join(targetDir, f)).mtimeMs,
    })).sort((a, b) => b.mtime - a.mtime);

  if (!files.length) return null;
  if (!query) return files[0];

  const q = String(query).toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
  for (const f of files) {
    const stripped = f.name.replace(/^\d+-/, '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
    if (stripped && (stripped.includes(q) || q.includes(stripped))) return f;
  }
  const words = String(query).toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  let best = null;
  let maxScore = 0;
  for (const f of files) {
    const fn = f.name.toLowerCase();
    let score = 0;
    for (const w of words) if (fn.includes(w)) score++;
    if (score > maxScore) {
      maxScore = score;
      best = f;
    }
  }
  return best || files[0];
}

export async function executeReadFile(filename, page = 1, maxPages = 3, sessionId = null, accountId = 'anonymous') {
  const matched = findMaterialFile(filename, sessionId, accountId);
  if (!matched) {
    return {
      success: false,
      filename: filename || '',
      error: '해당 대화 세션에 업로드된 학습 자료 파일을 찾을 수 없습니다.',
      content: '',
      totalPages: 0,
      page: 1,
    };
  }

  const ext = path.extname(matched.name).toLowerCase();
  const displayName = matched.name.replace(/^\d+-/, '');

  try {
    if (ext === '.pdf') {
      const mod = await import('pdf-parse/lib/pdf-parse.js');
      const pdfParse = mod.default || mod;
      const buf = await fs.readFile(matched.path);

      const pageTexts = [];
      const renderPage = (pageData) => {
        return pageData.getTextContent().then((tc) => {
          let lastY;
          let text = '';
          for (const item of tc.items) {
            if (lastY === item.transform[5] || !lastY) {
              text += item.str;
            } else {
              text += '\n' + item.str;
            }
            lastY = item.transform[5];
          }
          pageTexts.push(text.trim());
          return text;
        });
      };

      let res;
      try {
        res = await pdfParse(buf, { pagerender: renderPage });
      } catch {
        res = await pdfParse(buf);
      }

      const totalPages = res?.numpages || pageTexts.length || 1;
      const reqPage = Math.max(1, Math.min(Number(page) || 1, totalPages));
      const reqMax = Math.max(1, Math.min(Number(maxPages) || 3, 10));

      // 문서 전체에 추출된 텍스트가 0글자인지 검사 (스캔된 이미지 교과서 등)
      const allExtractedLength = pageTexts.reduce((acc, t) => acc + (t ? t.trim().length : 0), 0) + (res?.text || '').trim().length;
      if (allExtractedLength === 0) {
        return {
          success: false,
          isScanned: true,
          filename: displayName,
          totalPages,
          page: reqPage,
          content: '',
          error: `이 PDF("${displayName}")는 스캔된 이미지/그림으로 구성된 전자책 문서여서 텍스트 레이어가 없습니다. 파일명과 교육과정 지식을 활용하여 직접 상세히 설명해 주세요.`,
        };
      }

      let content = '';
      let hasPageText = false;
      if (pageTexts.length > 0) {
        const startIdx = reqPage - 1;
        const endIdx = Math.min(startIdx + reqMax, totalPages);
        const selectedParts = [];
        for (let i = startIdx; i < endIdx; i++) {
          const pt = (pageTexts[i] || '').trim();
          if (pt) hasPageText = true;
          selectedParts.push(`--- [${displayName} - 페이지 ${i + 1}/${totalPages}] ---\n${pt || '(해당 페이지 텍스트 없음)'}`);
        }
        content = selectedParts.join('\n\n');
      } else {
        content = (res?.text || '').trim();
        hasPageText = Boolean(content);
      }

      if (!hasPageText) {
        content = `(해당 ${reqPage}~${Math.min(reqPage + reqMax - 1, totalPages)}쪽은 표지, 간지 또는 빈 페이지여서 텍스트가 없습니다. 목차나 본문은 대략 6~10쪽부터 시작합니다.)`;
      }

      return {
        success: true,
        filename: displayName,
        totalPages,
        page: reqPage,
        content: content.slice(0, 10000),
      };
    }

    const textExts = new Set([
      '.txt', '.md', '.markdown', '.json', '.csv', '.tsv',
      '.py', '.js', '.mjs', '.cjs', '.ts', '.html', '.htm',
      '.css', '.c', '.cpp', '.h', '.java', '.xml', '.yaml',
      '.yml', '.sql', '.sh', '.bat', '.ps1'
    ]);

    if (textExts.has(ext)) {
      const text = await fs.readFile(matched.path, 'utf8');
      return {
        success: true,
        filename: displayName,
        totalPages: 1,
        page: 1,
        content: text.trim().slice(0, 10000),
      };
    }

    return {
      success: false,
      filename: displayName,
      error: `지원하지 않는 파일 형식입니다: ${ext}`,
      content: '',
      totalPages: 0,
      page: 1,
    };
  } catch (err) {
    return {
      success: false,
      filename: displayName,
      error: `파일 읽기 오류: ${err.message}`,
      content: '',
      totalPages: 0,
      page: 1,
    };
  }
}
