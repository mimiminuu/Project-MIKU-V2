// Project MIKU - 공부 도구 5종 실제 상호작용 인터랙티브 시스템 (LLM 및 채팅 세션 연동)
// 1) 퀴즈 풀기 (Interactive Quiz with LLM On-demand Generation & Session Integration)
// 2) 집중 타이머 (Pomodoro Study Timer with Session Check-in)
// 3) 암기 카드 (3D Flip Flashcards with LLM Keyword Extraction)
// 4) 그래프 그리기 (Canvas Function Plotter with AI Explanation)
// 5) 기분 체크 (Mood Check-in & Avatar Reaction with Chat Pacing Adjustment)

import { getAuthenticatedUser, getAccountScope, scopedUrl } from './auth.js';

const $ = (s) => document.querySelector(s);

// 기본 플래시카드 프리셋 (오프라인/첫 시작용)
const DEFAULT_CARDS = [
  { q: '미분의 정의', a: "함수 f(x)에서 x의 변화량에 대한 y의 변화량의 극한값 (순간 변화율)\nf'(x) = lim(h->0) [f(x+h) - f(x)] / h" },
  { q: '피타고라스 정리', a: '직각삼각형에서 빗변의 길이의 제곱은 나머지 두 변의 길이의 제곱의 합과 같다.\na² + b² = c²' },
  { q: '주기율표 1번~3번', a: '1번: H (수소)\n2번: He (헬륨)\n3번: Li (리튬)' },
  { q: '한글 창제 연도', a: '조선 세종대왕 25년 (1443년 창제, 1446년 훈민정음 반포)' },
];

export class StudyToolsManager {
  constructor({ wsClient, stageGetter, sessionIdGetter, chatHistoryGetter }) {
    this.ws = wsClient;
    this.getStage = stageGetter;
    this.getSessionId = sessionIdGetter;
    this.getHistory = chatHistoryGetter;

    // 타이머 상태
    this.timerInterval = null;
    this.timerSeconds = 25 * 60;
    this.timerTotal = 25 * 60;
    this.timerRunning = false;

    // 플래시카드 상태
    this.cards = this._loadCards();
    this.cardIndex = 0;
    this.cardFlipped = false;

    // 퀴즈 상태
    this.quizQuestions = [];
    this.quizIndex = 0;
    this.quizScore = 0;
    this.quizAnswered = false;
    this.quizTopic = '기본 퀴즈';

    // 그래프 상태
    this.graphCanvas = null;
    this.graphCtx = null;

    // 세션별 학습 도구 상태는 메모리에 분리 보관하고, 세션을 떠나면 타이머를 멈춘다.
    this.sessionStates = new Map();
    this.boundSessionId = this.getSessionId?.() || 'default';
    this.timerSessionId = null;
  }

  _accountStorageKey() {
    const user = getAuthenticatedUser();
    const account = user?.id || 'anonymous';
    const scope = user?.role === 'demo' ? `demo:${this.boundSessionId}` : 'account';
    return `miku_study_cards:${account}:${scope}`;
  }

  onSessionChanged() {
    const next = this.getSessionId?.() || 'default';
    if (next === this.boundSessionId) return;
    // 떠나는 세션의 도구 상태 보관
    this.sessionStates.set(this.boundSessionId, {
      quizQuestions: this.quizQuestions,
      quizIndex: this.quizIndex,
      quizScore: this.quizScore,
      quizAnswered: this.quizAnswered,
      quizTopic: this.quizTopic,
      cards: this.cards,
      cardIndex: this.cardIndex,
      cardFlipped: this.cardFlipped,
    });
    clearInterval(this.timerInterval);
    this.timerInterval = null;
    this.timerRunning = false;
    this.timerSessionId = null;
    this.boundSessionId = next;

    const saved = this.sessionStates.get(next);
    if (saved) {
      Object.assign(this, saved);
    } else {
      this.quizQuestions = [];
      this.quizIndex = 0;
      this.quizScore = 0;
      this.quizAnswered = false;
      this.quizTopic = '기본 퀴즈';
      this.cards = this._loadCards();
      this.cardIndex = 0;
      this.cardFlipped = false;
    }
    this.resetTimer(25);
  }

  init() {
    this._bindSidebarButtons();
    this._bindModalEvents();
  }

  _bindSidebarButtons() {
    document.querySelectorAll('.study-tool-btn, .hero-chip-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tool = btn.dataset.tool;
        if (!tool) return;
        this.openTool(tool);
      });
    });
  }

  openTool(tool) {
    switch (tool) {
      case 'quiz':
        this.openQuizModal();
        break;
      case 'timer':
        this.openTimerModal();
        break;
      case 'flashcard':
        this.openFlashcardModal();
        break;
      case 'graph':
        this.openGraphModal();
        break;
      case 'mood':
        this.openMoodModal();
        break;
      case 'concept':
        // 개념 설명은 채팅창으로 자연스럽게 안내
        if (window.sendUserText) {
          window.sendUserText('오늘 배울 주요 개념을 차근차근 알기 쉽게 설명해 줘!');
        }
        break;
    }
  }

  // ============================================================
  // 1. 퀴즈 풀기 (Interactive Quiz)
  // ============================================================
  openQuizModal() {
    this._showModal('#quiz-modal-overlay');
    if (!this.quizQuestions.length) {
      // 대화 내역이 있으면 자동으로 대화 기반 퀴즈 생성 시도
      const history = this.getHistory?.() || [];
      if (history.length >= 2) {
        this.generateQuizFromAI('');
      } else {
        this._generateDefaultQuiz();
        this._renderQuizQuestion();
      }
    } else {
      this._renderQuizQuestion();
    }
  }

  _generateDefaultQuiz() {
    this.quizTopic = '수학 및 기초 과학';
    this.quizQuestions = [
      {
        q: '1. 다음 중 직각삼각형에서 빗변의 길이 c와 두 직각변 a, b 사이의 관계식으로 옳은 것은?',
        options: ['a² + b² = c²', 'a + b = c', 'a² - b² = c²', 'a × b = c²'],
        ans: 0,
        exp: '피타고라스 정리에 의해 직각삼각형에서 직각을 낀 두 변의 제곱의 합은 빗변의 제곱과 같습니다 (a² + b² = c²).'
      },
      {
        q: '2. 함수 y = x²의 도함수 y\'로 옳은 것은?',
        options: ['x', '2x', '2', 'x² / 2'],
        ans: 1,
        exp: '거듭제곱의 미분법 d/dx (x^n) = n·x^(n-1)에 의해 d/dx (x²) = 2x입니다.'
      },
      {
        q: '3. 화학 원소 기호 중 "H"가 나타내는 원소는 무엇일까요?',
        options: ['헬륨 (He)', '수소 (H)', '탄소 (C)', '산소 (O)'],
        ans: 1,
        exp: 'H는 원자 번호 1번인 수소(Hydrogen)의 원소 기호입니다.'
      }
    ];
    this.quizIndex = 0;
    this.quizScore = 0;
    this.quizAnswered = false;
  }

  async generateQuizFromAI(topic = '') {
    const loadingEl = $('#quiz-loading-bar');
    const loadingText = $('#quiz-loading-text');
    const topicInput = $('#input-quiz-topic');
    const userTopic = topic !== undefined ? topic : (topicInput?.value?.trim() || '');

    if (loadingEl) {
      loadingEl.hidden = false;
      if (loadingText) {
        loadingText.textContent = userTopic
          ? `AI가 "${userTopic}" 맞춤 퀴즈를 출제 중입니다...`
          : 'AI가 현재 대화 세션을 분석하여 맞춤 퀴즈를 출제 중입니다...';
      }
    }

    try {
      const sessionId = this.getSessionId?.() || 'default';
      const history = this.getHistory?.() || [];

      const res = await fetch(scopedUrl('/api/tools/generate-quiz', { sessionId, scope: getAccountScope() }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, topic: userTopic, history, count: 3 })
      });

      if (!res.ok) throw new Error('퀴즈 생성 서버 오류 (' + res.status + ')');
      const data = await res.json();
      if (!data.questions || !data.questions.length) throw new Error('퀴즈 문제 데이터가 비어 있습니다.');
      if (sessionId !== (this.getSessionId?.() || 'default')) return; // 세션이 바뀐 뒤 도착한 결과는 버린다

      this.quizTopic = data.topic || userTopic || '대화 기반 맞춤 퀴즈';
      this.quizQuestions = data.questions;
      this.quizIndex = 0;
      this.quizScore = 0;
      this.quizAnswered = false;
      this._renderQuizQuestion();

      if (window.addNotice) {
        window.addNotice(`✨ 맞춤 퀴즈가 출제되었습니다: "${this.quizTopic}" (${this.quizQuestions.length}문제)`);
      }
    } catch (err) {
      console.error('AI 퀴즈 생성 실패:', err);
      // 실패 시 기본 퀴즈 렌더링
      if (!this.quizQuestions.length) this._generateDefaultQuiz();
      this._renderQuizQuestion();
      if (window.addNotice) {
        window.addNotice('퀴즈 생성 실패: ' + err.message);
      }
    } finally {
      if (loadingEl) loadingEl.hidden = true;
    }
  }

  setCachedQuiz(topic, questions) {
    if (!questions || !questions.length) return;
    this.quizTopic = topic || 'AI 출제 퀴즈';
    this.quizQuestions = questions;
    this.quizIndex = 0;
    this.quizScore = 0;
    this.quizAnswered = false;
  }

  loadQuizFromAI(topic, questions) {
    if (!questions || !questions.length) return;
    this.quizTopic = topic || 'AI 출제 퀴즈';
    this.quizQuestions = questions;
    this.quizIndex = 0;
    this.quizScore = 0;
    this.quizAnswered = false;
    this.openQuizModal();
    if (window.addNotice) {
      window.addNotice(`💡 맞춤 퀴즈가 출제되었습니다: "${this.quizTopic}" (${questions.length}문제)`);
    }
  }

  _renderQuizQuestion() {
    const qEl = $('#quiz-question-text');
    const optionsEl = $('#quiz-options-container');
    const progressEl = $('#quiz-progress-text');
    const expEl = $('#quiz-explanation-box');
    const nextBtn = $('#btn-quiz-next');

    if (!qEl || !optionsEl) return;

    if (this.quizIndex >= this.quizQuestions.length) {
      // 퀴즈 완료 화면
      const pct = Math.round((this.quizScore / this.quizQuestions.length) * 100);
      qEl.textContent = `🎉 퀴즈 완료! (${this.quizScore} / ${this.quizQuestions.length} 문제 정답)`;
      optionsEl.innerHTML = `
        <div class="quiz-result-box" style="text-align:center; padding:16px 0;">
          <div class="quiz-score-circle" style="display:inline-flex; align-items:center; justify-content:center; width:64px; height:64px; border-radius:50%; background:linear-gradient(135deg, #10b981 0%, #059669 100%); color:#fff; font-size:20px; font-weight:800; margin-bottom:12px; box-shadow:0 4px 12px rgba(16,185,129,0.3);">${pct}점</div>
          <p style="margin:6px 0 14px; font-size:14px; color:var(--text);">${this.quizScore === this.quizQuestions.length ? '완벽해요! 모든 문제를 정확히 맞혔습니다. 대단해요!' : '수고 많으셨어요! 부족한 부분을 대화창에서 AI와 함께 복습해 볼까요?'}</p>
          <div class="quiz-result-actions" style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
            <button type="button" class="secondary-btn" id="btn-quiz-restart">다시 풀기</button>
            <button type="button" class="primary-btn ai-sparkle-btn" id="btn-quiz-share-chat">💬 대화창에 결과 공유 & 오답 해설 요청</button>
          </div>
        </div>
      `;
      if (progressEl) progressEl.textContent = '완료';
      if (expEl) expEl.hidden = true;
      if (nextBtn) nextBtn.hidden = true;

      $('#btn-quiz-restart')?.addEventListener('click', () => {
        this.quizIndex = 0;
        this.quizScore = 0;
        this.quizAnswered = false;
        this._renderQuizQuestion();
      });

      $('#btn-quiz-share-chat')?.addEventListener('click', () => {
        this._hideModal('#quiz-modal-overlay');
        const scoreStr = `${this.quizScore}/${this.quizQuestions.length}`;
        const topicStr = this.quizTopic || '방금 푼';
        if (window.sendUserText) {
          window.sendUserText(`방금 "${topicStr}" 퀴즈를 풀었어! 결과는 ${scoreStr}점(${pct}점)이야. 내가 틀렸거나 헷갈렸던 부분에 대해 핵심만 짚어서 친절하게 해설해 줘!`);
        }
      });

      // 점수에 따른 아바타 반응
      const stage = this.getStage?.();
      if (stage) {
        if (this.quizScore === this.quizQuestions.length) stage.playTapMotion?.() || stage.setEmotion?.('cheer');
        else stage.setEmotion?.('smile');
      }
      return;
    }

    const cur = this.quizQuestions[this.quizIndex];
    if (progressEl) progressEl.textContent = `문제 ${this.quizIndex + 1} / ${this.quizQuestions.length}`;
    qEl.textContent = cur.q;
    if (expEl) expEl.hidden = true;
    if (nextBtn) nextBtn.hidden = true;
    this.quizAnswered = false;

    optionsEl.innerHTML = '';
    cur.options.forEach((optText, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quiz-option-btn';
      btn.innerHTML = `<span class="opt-num">${idx + 1}</span> <span>${optText}</span>`;
      btn.addEventListener('click', () => this._handleQuizAnswer(idx, btn));
      optionsEl.appendChild(btn);
    });
  }

  _handleQuizAnswer(chosenIdx, clickedBtn) {
    if (this.quizAnswered) return;
    this.quizAnswered = true;

    const cur = this.quizQuestions[this.quizIndex];
    const isCorrect = chosenIdx === cur.ans;
    const stage = this.getStage?.();

    if (isCorrect) {
      this.quizScore++;
      clickedBtn.classList.add('correct');
      if (stage) {
        stage.setEmotion?.('cheer');
      }
    } else {
      clickedBtn.classList.add('wrong');
      const allBtns = document.querySelectorAll('.quiz-option-btn');
      if (allBtns[cur.ans]) allBtns[cur.ans].classList.add('correct');
      if (stage) {
        stage.setEmotion?.('think');
      }
    }

    const expEl = $('#quiz-explanation-box');
    if (expEl) {
      expEl.hidden = false;
      expEl.innerHTML = `<strong>${isCorrect ? '✅ 정답입니다!' : '❌ 아쉽지만 오답이에요.'}</strong><p>${cur.exp}</p>`;
    }

    const nextBtn = $('#btn-quiz-next');
    if (nextBtn) {
      nextBtn.hidden = false;
      nextBtn.textContent = this.quizIndex < this.quizQuestions.length - 1 ? '다음 문제 →' : '결과 보기 🎉';
    }
  }

  // ============================================================
  // 2. 집중 타이머 (뽀모도로)
  // ============================================================
  openTimerModal() {
    this._showModal('#timer-modal-overlay');
    this._renderTimer();
  }

  startTimerWithMinutes(minutes = 25) {
    this.openTimerModal();
    this.resetTimer(minutes);
    this.timerSessionId = this.getSessionId?.() || 'default';
    this.toggleTimer();
  }

  _renderTimer() {
    const mins = Math.floor(this.timerSeconds / 60);
    const secs = this.timerSeconds % 60;
    const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    const displayEl = $('#timer-time-display');
    if (displayEl) displayEl.textContent = timeStr;

    // 프로그레스 바
    const bar = $('#timer-progress-fill');
    if (bar && this.timerTotal > 0) {
      const pct = (1 - (this.timerSeconds / this.timerTotal)) * 100;
      bar.style.width = `${pct}%`;
    }

    const startBtn = $('#btn-timer-start');
    if (startBtn) {
      startBtn.textContent = this.timerRunning ? '일시정지' : '시작';
      startBtn.classList.toggle('running', this.timerRunning);
    }
  }

  toggleTimer() {
    if (this.timerRunning) {
      clearInterval(this.timerInterval);
      this.timerRunning = false;
    } else {
      this.timerRunning = true;
      this.timerInterval = setInterval(() => {
        if (this.timerSeconds > 0) {
          this.timerSeconds--;
          this._renderTimer();
        } else {
          clearInterval(this.timerInterval);
          this.timerRunning = false;
          this._renderTimer();
          this._onTimerComplete();
        }
      }, 1000);
      const stage = this.getStage?.();
      stage?.setEmotion?.('focus');
    }
    this._renderTimer();
  }

  resetTimer(mins = 25) {
    clearInterval(this.timerInterval);
    this.timerRunning = false;
    this.timerSeconds = mins * 60;
    this.timerTotal = mins * 60;
    this._renderTimer();
  }

  _onTimerComplete() {
    // 타이머를 시작한 세션과 현재 세션이 다르면 다음 참가자에게 완료 메시지를 보내지 않는다.
    if (this.timerSessionId && this.timerSessionId !== (this.getSessionId?.() || 'default')) return;
    const stage = this.getStage?.();
    stage?.setEmotion?.('cheer');

    const shouldNotify = $('#check-timer-notify')?.checked !== false;
    if (shouldNotify && window.sendUserText) {
      const mins = Math.floor(this.timerTotal / 60);
      window.sendUserText(`⏰ ${mins}분 집중 타이머를 무사히 완료했어! 오늘 집중 잘 된 것 같아. 수고했다고 칭찬해 줘!`);
    } else {
      alert('⏰ 집중 시간이 끝났습니다! 수고하셨어요. 5분간 휴식을 취하세요.');
    }
  }

  // ============================================================
  // 3. 암기 카드 (3D 플립)
  // ============================================================
  openFlashcardModal() {
    this._showModal('#flashcard-modal-overlay');
    this._renderCard();
  }

  async generateCardsFromAI(topic = '') {
    const loadingEl = $('#card-loading-bar');
    const loadingText = $('#card-loading-text');
    const topicInput = $('#input-card-topic');
    const userTopic = topic !== undefined ? topic : (topicInput?.value?.trim() || '');

    if (loadingEl) {
      loadingEl.hidden = false;
      if (loadingText) {
        loadingText.textContent = userTopic
          ? `AI가 "${userTopic}" 핵심 암기 카드를 제작 중입니다...`
          : 'AI가 대화 내용을 요약하여 핵심 암기 카드를 제작 중입니다...';
      }
    }

    try {
      const sessionId = this.getSessionId?.() || 'default';
      const history = this.getHistory?.() || [];

      const res = await fetch(scopedUrl('/api/tools/generate-cards', { sessionId, scope: getAccountScope() }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, topic: userTopic, history, count: 4 })
      });

      if (!res.ok) throw new Error('암기 카드 생성 서버 오류 (' + res.status + ')');
      const data = await res.json();
      if (!data.cards || !data.cards.length) throw new Error('생성된 카드가 없습니다.');
      if (sessionId !== (this.getSessionId?.() || 'default')) return;

      this.cards = data.cards;
      this._saveCards();
      this.cardIndex = 0;
      this._renderCard();

      if (window.addNotice) {
        window.addNotice(`✨ AI 암기 카드 ${data.cards.length}장이 제작되었습니다!`);
      }
    } catch (err) {
      console.error('AI 카드 생성 실패:', err);
      if (window.addNotice) {
        window.addNotice('카드 생성 실패: ' + err.message);
      }
    } finally {
      if (loadingEl) loadingEl.hidden = true;
    }
  }

  setCachedCards(topic, cards) {
    if (!cards || !cards.length) return;
    this.cards = cards;
    this._saveCards();
    this.cardIndex = 0;
  }

  loadCardsFromAI(topic, cards) {
    if (!cards || !cards.length) return;
    this.setCachedCards(topic, cards);
    this.openFlashcardModal();
    if (window.addNotice) {
      window.addNotice(`🗂️ "${topic || '핵심 암기 카드'}" ${cards.length}장이 준비되었습니다!`);
    }
  }

  _cardStorage() {
    return getAuthenticatedUser()?.role === 'demo' ? sessionStorage : localStorage;
  }

  _loadCards() {
    try {
      const raw = this._cardStorage().getItem(this._accountStorageKey());
      if (raw) return JSON.parse(raw);
    } catch {}
    return DEFAULT_CARDS;
  }

  _saveCards() {
    try {
      this._cardStorage().setItem(this._accountStorageKey(), JSON.stringify(this.cards));
    } catch {}
  }

  _renderCard() {
    const cardEl = $('#flashcard-3d');
    const frontEl = $('#flashcard-front-text');
    const backEl = $('#flashcard-back-text');
    const indicatorEl = $('#flashcard-indicator');

    if (!cardEl || !frontEl || !backEl) return;

    if (!this.cards.length) {
      frontEl.textContent = '카드가 없습니다. 상단에서 AI 카드 생성을 눌러보세요!';
      backEl.textContent = '';
      if (indicatorEl) indicatorEl.textContent = '0 / 0';
      return;
    }

    if (this.cardIndex >= this.cards.length) this.cardIndex = 0;
    if (this.cardIndex < 0) this.cardIndex = this.cards.length - 1;

    const cur = this.cards[this.cardIndex];
    frontEl.textContent = cur.q;
    backEl.textContent = cur.a;
    if (indicatorEl) indicatorEl.textContent = `${this.cardIndex + 1} / ${this.cards.length}`;

    // 카드 앞면으로 리셋
    cardEl.classList.remove('is-flipped');
    this.cardFlipped = false;
  }

  flipCard() {
    const cardEl = $('#flashcard-3d');
    if (!cardEl) return;
    this.cardFlipped = !this.cardFlipped;
    cardEl.classList.toggle('is-flipped', this.cardFlipped);
  }

  nextCard() {
    this.cardIndex++;
    this._renderCard();
  }

  prevCard() {
    this.cardIndex--;
    this._renderCard();
  }

  addCard(q, a) {
    if (!q || !a) return;
    this.cards.push({ q, a });
    this._saveCards();
    this.cardIndex = this.cards.length - 1;
    this._renderCard();
  }

  // ============================================================
  // 4. 그래프 그리기 (2D Canvas Plotter)
  // ============================================================
  openGraphModal() {
    this._showModal('#graph-modal-overlay');
    setTimeout(() => this._initGraphCanvas(), 50);
  }

  openAndPlotGraph(expression = 'x^2') {
    this.openGraphModal();
    const input = $('#graph-func-input');
    if (input) input.value = expression;
    setTimeout(() => {
      this.drawGraph(expression);
    }, 120);
  }

  _initGraphCanvas() {
    const canvas = $('#graph-canvas');
    if (!canvas) return;
    this.graphCanvas = canvas;
    this.graphCtx = canvas.getContext('2d');

    // 리사이즈 해상도 보정
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * (window.devicePixelRatio || 1);
    canvas.height = 360 * (window.devicePixelRatio || 1);

    this.drawGraph($('#graph-func-input')?.value || 'x^2');
  }

  drawGraph(expression = 'x^2') {
    drawGraphOnCanvas(this.graphCanvas, expression);
  }

  // ============================================================
  // 5. 기분 체크 (Mood Check-in)
  // ============================================================
  openMoodModal() {
    this._showModal('#mood-modal-overlay');
  }

  handleMoodSubmit(moodKey, memo) {
    const stage = this.getStage?.();
    const moodReactions = {
      great: { label: '최고예요 🌟', emotion: 'cheer', reply: '우와! 오늘 기분이 최고조네! 이 에너지로 공부도 팍팍 달려보자! ✨' },
      good: { label: '좋아요 😊', emotion: 'smile', reply: '좋은 기분이라니 다행이야! 오늘도 즐겁게 같이 공부해 볼까? 😊' },
      neutral: { label: '보통이에요 😐', emotion: 'neutral', reply: '평온한 하루네! 차분하게 오늘 목표를 하나씩 달성해 보자. 📖' },
      tired: { label: '피곤해요 😴', emotion: 'spaceout', reply: '많이 피곤하구나... 무리하지 말고 가벼운 개념부터 쉬엄쉬엄 하자. 힘내! 🍵' },
      stressed: { label: '지쳐요 😰', emotion: 'relieved', reply: '스트레스 많이 받았지? 토닥토닥... 나한테 털어놓고 한숨 돌리면서 가자. 💙' }
    };

    const reaction = moodReactions[moodKey] || moodReactions.good;

    // 아바타 표정 반영
    if (stage) stage.setEmotion?.(reaction.emotion);

    // 개인 인텔리전스 및 서버에 기분 기록 저장
    try {
      fetch(scopedUrl('/api/user-intelligence/mood', { scope: getAccountScope() }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mood: moodKey, memo, timestamp: Date.now(), isDemo: getAuthenticatedUser()?.role === 'demo' })
      }).catch(() => {});
    } catch {}

    // 모달 닫기
    this._hideModal('#mood-modal-overlay');

    // 대화 세션에 컨디션 공유
    const shouldNotify = $('#check-mood-notify')?.checked !== false;
    if (shouldNotify && window.sendUserText) {
      window.sendUserText(`오늘 내 컨디션은 "${reaction.label}" 상태야.${memo ? ` (${memo})` : ''} 오늘 이에 맞춰서 친절하게 알려줘!`);
    } else if (window.addNotice) {
      window.addNotice(`기분 체크 완료: ${reaction.reply}`);
    }
  }

  // ============================================================
  // 공통 모달 유틸
  // ============================================================
  _showModal(selector) {
    const el = $(selector);
    if (el) {
      el.classList.add('open');
      el.classList.add('active');
    }
  }

  _hideModal(selector) {
    const el = $(selector);
    if (el) {
      el.classList.remove('open');
      el.classList.remove('active');
    }
  }

  _bindModalEvents() {
    // 닫기 버튼 및 배경 클릭 공통 바인딩
    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay && overlay.dataset.keepOpen !== 'true') {
          overlay.classList.remove('open');
          overlay.classList.remove('active');
        }
      });
    });

    document.querySelectorAll('.modal-overlay .modal-close, .modal-overlay [data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const overlay = btn.closest('.modal-overlay');
        if (overlay) {
          overlay.classList.remove('open');
          overlay.classList.remove('active');
        }
      });
    });

    // 1. 퀴즈 이벤트 바인딩
    $('#btn-quiz-next')?.addEventListener('click', () => {
      this.quizIndex++;
      this._renderQuizQuestion();
    });

    $('#btn-generate-ai-quiz')?.addEventListener('click', () => {
      const topic = $('#input-quiz-topic')?.value.trim();
      this.generateQuizFromAI(topic);
    });

    $('#btn-generate-session-quiz')?.addEventListener('click', () => {
      this.generateQuizFromAI('');
    });

    // 2. 타이머 이벤트 바인딩
    $('#btn-timer-start')?.addEventListener('click', () => this.toggleTimer());
    $('#btn-timer-reset')?.addEventListener('click', () => this.resetTimer(25));
    document.querySelectorAll('.timer-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.timer-preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mins = Number(btn.dataset.mins || 25);
        this.resetTimer(mins);
      });
    });
    $('#btn-timer-share-chat')?.addEventListener('click', () => {
      const mins = Math.floor(this.timerTotal / 60);
      this._hideModal('#timer-modal-overlay');
      if (window.sendUserText) {
        window.sendUserText(`🔥 지금부터 ${mins}분 집중 뽀모도로 공부를 시작할게! 내가 딴짓하지 않도록 지켜봐 줘.`);
      }
    });

    // 3. 플래시카드 이벤트 바인딩
    $('#flashcard-3d')?.addEventListener('click', () => this.flipCard());
    $('#btn-card-prev')?.addEventListener('click', () => this.prevCard());
    $('#btn-card-next')?.addEventListener('click', () => this.nextCard());
    $('#btn-card-easy')?.addEventListener('click', () => this.nextCard());
    $('#btn-card-hard')?.addEventListener('click', () => this.nextCard());
    $('#btn-generate-ai-cards')?.addEventListener('click', () => {
      const topic = $('#input-card-topic')?.value.trim();
      this.generateCardsFromAI(topic);
    });
    $('#btn-generate-session-cards')?.addEventListener('click', () => {
      this.generateCardsFromAI('');
    });
    $('#btn-card-ask-ai')?.addEventListener('click', () => {
      if (!this.cards.length) return;
      const cur = this.cards[this.cardIndex];
      this._hideModal('#flashcard-modal-overlay');
      if (window.sendUserText) {
        window.sendUserText(`암기 카드에서 "${cur.q}" (정답: ${cur.a}) 개념을 복습 중인데, 이 개념이 왜 중요한지 이해하기 쉽게 예시를 들어서 설명해 줘!`);
      }
    });
    $('#form-add-card')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('#input-card-q')?.value.trim();
      const a = $('#input-card-a')?.value.trim();
      if (q && a) {
        this.addCard(q, a);
        $('#input-card-q').value = '';
        $('#input-card-a').value = '';
      }
    });

    // 4. 그래프 이벤트 바인딩
    $('#graph-func-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const expr = $('#graph-func-input')?.value.trim();
      if (expr) this.drawGraph(expr);
    });
    $('#btn-graph-ask-ai')?.addEventListener('click', () => {
      const expr = $('#graph-func-input')?.value.trim() || 'x^2';
      this._hideModal('#graph-modal-overlay');
      if (window.sendUserText) {
        window.sendUserText(`함수 f(x) = ${expr} 그래프를 시각화해서 보고 있어. 이 함수의 정의역, 치역, 극값, 점근선이나 대칭성 같은 핵심 수학적 특징을 알기 쉽게 설명해 줘!`);
      }
    });
    document.querySelectorAll('.graph-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const expr = btn.dataset.expr;
        if (expr) {
          const input = $('#graph-func-input');
          if (input) input.value = expr;
          this.drawGraph(expr);
        }
      });
    });

    // 5. 기분 체크 제출
    document.querySelectorAll('.mood-emoji-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mood-emoji-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
    $('#btn-submit-mood')?.addEventListener('click', () => {
      const selected = $('.mood-emoji-btn.selected');
      const moodKey = selected ? selected.dataset.mood : 'good';
      const memo = $('#input-mood-memo')?.value.trim() || '';
      this.handleMoodSubmit(moodKey, memo);
    });
  }
}

// 캔버스에 직접 2D 함수 그래프를 그리는 독립 함수 (모달 및 채팅창 인라인 카드 겸용)
export function drawGraphOnCanvas(canvas, expression = 'x^2') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }

  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#090d16';
  ctx.fillRect(0, 0, w, h);

  // 좌표계 기준점 (중앙)
  const originX = w / 2;
  const originY = h / 2;
  const scale = (w / 16); // 1단위당 픽셀

  // 격자 그리기
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;

  for (let x = originX % scale; x < w; x += scale) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = originY % scale; y < h; y += scale) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // X축 / Y축
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(0, originY); ctx.lineTo(w, originY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(originX, 0); ctx.lineTo(originX, h); ctx.stroke();

  // 축 눈금 숫자
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.font = `${Math.max(10, Math.round(w / 55))}px monospace`;
  for (let u = -8; u <= 8; u += 2) {
    if (u === 0) continue;
    const px = originX + u * scale;
    if (px > 24 && px < w - 24) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(u), px, originY + 4);
    }
    const py = originY - u * scale;
    if (py > 20 && py < h - 20) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(u), originX - 6, py);
    }
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText('0', originX - 4, originY + 4);

  // 축 라벨
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = `bold ${Math.max(12, Math.round(w / 50))}px sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('x', w - 8, originY - 4);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('y', originX + 6, 6);

  // 함수 파싱 및 플로팅
  let fn;
  try {
    let cleanExpr = String(expression || 'x^2').trim().toLowerCase();
    cleanExpr = cleanExpr.replace(/\^/g, '**');
    cleanExpr = cleanExpr.replace(/(\d+)\s*([a-z(])/g, (m, p1, p2) => p1 + ' * ' + p2);
    cleanExpr = cleanExpr.replace(/\)\s*([a-z(])/g, (m, p1) => ')*' + p1);
    cleanExpr = cleanExpr.replace(/(^|[+\-*/(])\s*-\s*([a-z0-9_.]+(?:\*\*[a-z0-9_.]+)?)/gi, (m, p1, p2) => p1 + '(-1 * ' + p2 + ')');
    cleanExpr = cleanExpr.replace(/\bx\s*(sin|cos|tan|abs|sqrt|log|exp)\b/g, (m, p1) => 'x * ' + p1);
    cleanExpr = cleanExpr.replace(/\b(sin|cos|tan|abs|sqrt|log|exp|asin|acos|atan|floor|ceil|round)\b/g, (m, p1) => 'Math.' + p1);
    cleanExpr = cleanExpr.replace(/\bpi\b/g, 'Math.PI');
    cleanExpr = cleanExpr.replace(/\be\b/g, 'Math.E');

    fn = new Function('x', 'return ' + cleanExpr + ';');
    const testVal = fn(1);
    if (typeof testVal !== 'number' || isNaN(testVal)) throw new Error('Invalid formula');
  } catch {
    fn = (x) => x * x;
  }

  ctx.strokeStyle = '#00f2fe';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = 'rgba(0, 242, 254, 0.45)';
  ctx.shadowBlur = 6;
  ctx.beginPath();

  let started = false;
  for (let px = 0; px <= w; px += 2) {
    const mathX = (px - originX) / scale;
    let mathY;
    try {
      mathY = fn(mathX);
      if (!Number.isFinite(mathY)) continue;
    } catch { continue; }

    const py = originY - (mathY * scale);
    if (py < -h || py > h * 2) {
      started = false;
      continue;
    }

    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}
