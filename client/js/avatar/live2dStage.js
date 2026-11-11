// Live2D 아바타 스테이지: PIXI + pixi-live2d-display 로드 및 표정/립싱크 제어.
// 세션별 모델 전환 지원: switchModel(modelId | modelUrl)로 런타임 교체 가능.
// 기본 모델은 Haru (실패 시 Senko 폴백) - 기존 동작 유지.
// 인터랙션: 클릭=건드리기, 빈 공간 드래그=위치 이동, 모델 위 드래그=쓰다듬기,
//           꾹 누르기=쓰다듬 홀딩, 더블클릭=축하.
// 동작은 레이어(유휴 < 감정 < 쓰다듬기 < 깜빡 < 반응)로 합성하며, 새 반응이 시작되면
// 이전 반응의 예약/제어권을 거두고 현재 자세에서 시간 기반 보간으로 이어간다.
import {
  softEmotion, playMotion, playTapMotion, playPetMotion, playCelebrateMotion,
  cancelMotions, configureMotionModel, PARAM_LEGACY_MAP,
} from './emotions.js';

export const DEFAULT_MODEL_ID = 'yinlang';
const FALLBACK_MODEL_URLS = ['/assets/models/live2d/yinlang/yinlang.model3.json'];

const DRAG_THRESHOLD_PX = 8;
const HOLD_MS = 650;
const PET_STROKE_PX = 220;
const DBLCLICK_WINDOW_MS = 260;

// 애니메이션 레이어 우선순위 (높을수록 우선, 해제 시 바로 아래 레이어 값으로 자연스럽게 복귀)
const LAYER = { idle: 0, emotion: 1, pet: 2, blink: 3, action: 4 };

const TRACK_OFFSETS = {
  ParamAngleX: '_trackAngleX',
  ParamAngleY: '_trackAngleY',
  ParamAngleZ: '_trackAngleZ',
  ParamEyeBallX: '_trackEyeBallX',
  ParamEyeBallY: '_trackEyeBallY',
  ParamBodyAngleX: '_trackBodyAngleX',
  ParamBodyAngleZ: '_trackBodyAngleZ',
};

const IDLE_IDS = ['ParamBodyAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamMouthOpenY'];
const BLINK_IDS = ['ParamEyeLOpen', 'ParamEyeROpen'];
const PET_IDS = [
  'ParamAngleX', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamCheek',
  'ParamMouthOpenY', 'ParamMouthForm', 'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamBrowLY', 'ParamBrowRY',
];

const MOUTH_IDS = ['ParamMouthOpenY', 'ParamMouthOpenY2', 'PARAM_MOUTH_OPEN_Y', 'MouthJawOpen'];
const isMouthParam = (id) => id === 'ParamMouthOpenY' || id === 'ParamMouthOpenY2' || id === 'PARAM_MOUTH_OPEN_Y';

function posKey(modelId) { return `miku_avatar_pos_${modelId || 'default'}`; }
function zoomKey(modelId) { return `miku_avatar_zoom_${modelId || 'default'}`; }
function modelUrlFor(models, id) { return models?.find((m) => m.id === id)?.modelUrl || null; }

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 5.5;

// 모델별 시점 프리셋 (상반신 포커스 / 전신)
// - 전신 모델(히요리, 미쿠, 은랑): 머리 상단을 56px(배지 하단)에 고정하고 상반신을 안정적으로 채움
// - 반신 모델(하루): 이미 골반에서 잘린 모델이므로 적정 배율 적용
const MODEL_VIEW_PRESETS = {
  hiyori_pro: { bustZoom: 3.5, headDistRatio: 0.48, fullZoom: 1.0 },
  hiyori:     { bustZoom: 3.5, headDistRatio: 0.48, fullZoom: 1.0 },
  haru:       { bustZoom: 1.85, headDistRatio: 0.46, fullZoom: 1.0 },
  miku:       { bustZoom: 3.4, headDistRatio: 0.48, fullZoom: 1.0 },
  yinlang:    { bustZoom: 3.2, headDistRatio: 0.47, fullZoom: 1.0 },
  senko:      { bustZoom: 3.0, headDistRatio: 0.46, fullZoom: 1.0 },
  default:    { bustZoom: 3.4, headDistRatio: 0.48, fullZoom: 1.0 },
};

export function getViewPreset(modelId, mode) {
  const key = (modelId || '').toLowerCase();
  let preset = MODEL_VIEW_PRESETS[key];
  if (!preset) {
    if (key.includes('hiyori')) preset = MODEL_VIEW_PRESETS.hiyori_pro;
    else if (key.includes('miku')) preset = MODEL_VIEW_PRESETS.miku;
    else if (key.includes('yinlang') || key.includes('silverwolf')) preset = MODEL_VIEW_PRESETS.yinlang;
    else if (key.includes('senko')) preset = MODEL_VIEW_PRESETS.senko;
    else if (key.includes('haru')) preset = MODEL_VIEW_PRESETS.haru;
    else preset = MODEL_VIEW_PRESETS.default;
  }
  const isBust = mode !== 'full';
  return {
    zoom: isBust ? preset.bustZoom : preset.fullZoom,
    headDistRatio: preset.headDistRatio,
  };
}

// 부드러운 보간 유틸
function lerp(a, b, t) { return a + (b - a) * Math.min(1, Math.max(0, t)); }
function approach(current, target, speed) {
  const d = target - current;
  if (Math.abs(d) < 0.001) return target;
  return current + d * Math.min(1, speed);
}

// [시각(ms, 값, 도달시간(ms))] 키프레임 목록 생성 도우미
function osc(amp, cycles, period, startAt = 0, tau = null) {
  const frames = [];
  const reach = tau ?? Math.round(period * 0.55);
  for (let i = 0; i < cycles; i++) {
    frames.push([startAt + i * period, i % 2 === 0 ? -amp : amp, reach]);
  }
  frames.push([startAt + cycles * period, 0, Math.round(period * 1.4)]);
  return frames;
}

// 상황별 동작 정의. tracks의 각 키프레임은 예약 취소 가능한 반응 레이어로 적용된다.
const REACTIONS = {
  nod: { emotion: 'smile', ms: 1200, tracks: {
    ParamAngleY: [[0, -8, 110], [200, 3, 130], [400, -8, 110], [600, 3, 130], [800, -6, 150], [1000, 0, 240]],
  } },
  think: { emotion: 'think', ms: 3200, tracks: {
    ParamAngleZ: [[0, -8, 420]], ParamAngleX: [[0, 5, 460]],
    ParamEyeLOpen: [[0, 0.7, 360]], ParamEyeROpen: [[0, 0.7, 360]],
    ParamBrowLY: [[0, -0.3, 380]], ParamBrowRY: [[0, -0.3, 380]], ParamMouthForm: [[0, -0.2, 420]],
  } },
  surprise: { emotion: 'cheer', ms: 1400, tracks: {
    ParamEyeLOpen: [[0, 1.2, 100]], ParamEyeROpen: [[0, 1.2, 100]],
    ParamAngleY: [[0, -12, 110]], ParamMouthOpenY: [[0, 0.3, 110]],
    ParamBrowLY: [[0, 0.6, 110]], ParamBrowRY: [[0, 0.6, 110]],
  } },
  joy: { emotion: 'cheer', ms: 2100, tracks: {
    ParamBodyAngleY: [[0, -10, 110], [200, 4, 130], [400, 0, 170], [700, -10, 110], [900, 4, 130],
      [1100, 0, 170], [1400, -10, 110], [1600, 4, 130], [1800, 0, 220]],
    ParamBodyAngleX: [[0, -6, 150], [350, 6, 150], [700, 0, 220]],
  } },
  sad: { emotion: 'sad', ms: 4200, tracks: {
    ParamAngleY: [[0, 10, 520]], ParamAngleZ: [[0, 5, 520]],
    ParamEyeLOpen: [[0, 0.4, 420]], ParamEyeROpen: [[0, 0.4, 420]],
    ParamBrowLY: [[0, -0.5, 420]], ParamBrowRY: [[0, -0.5, 420]], ParamBodyAngleY: [[0, 5, 620]],
  } },
  angry: { emotion: 'think', ms: 1200, tracks: {
    ParamBrowLY: [[0, -0.7, 140]], ParamBrowRY: [[0, -0.7, 140]], ParamMouthForm: [[0, -0.4, 160]],
    ParamAngleZ: osc(4, 8, 100, 0, 70),
  } },
  sleepy: { emotion: 'neutral', ms: 0, tracks: {
    ParamAngleY: [[0, 15, 900]], ParamAngleZ: [[0, 8, 900]],
    ParamEyeLOpen: [[0, 0.15, 700]], ParamEyeROpen: [[0, 0.15, 700]],
    ParamBodyAngleY: [[0, 8, 900]], ParamMouthOpenY: [[0, 0.08, 700]],
  } },
  wakeup: { emotion: 'smile', ms: 1700, tracks: {
    ParamAngleY: [[0, -5, 220], [500, -8, 260], [1200, 0, 420]],
    ParamBodyAngleY: [[0, -6, 240], [500, -10, 260], [1200, 0, 440]],
    ParamEyeLOpen: [[0, 1.1, 220], [1200, 1, 320]], ParamEyeROpen: [[0, 1.1, 220], [1200, 1, 320]],
  } },
  greet: { emotion: 'smile', ms: 1200, tracks: {
    ParamAngleY: [[0, 12, 200], [650, 12, 200], [950, 0, 300]],
    ParamBodyAngleY: [[0, 6, 240], [950, 0, 320]],
  } },
  shake: { emotion: 'think', ms: 1100, tracks: { ParamAngleX: osc(15, 6, 150, 0, 95) } },
  wave: { emotion: 'cheer', ms: 1650, tracks: {
    ParamBodyAngleX: [[0, -8, 240], [1350, 0, 300]],
    ParamAngleZ: osc(6, 8, 180, 0, 105),
  } },
  clap: { emotion: 'cheer', ms: 1700, tracks: {
    ParamBodyAngleX: osc(5, 6, 250, 0, 130),
    ParamMouthOpenY: [[0, 0.2, 130], [1400, 0.06, 240]],
  } },
  dance: { emotion: 'cheer', ms: 2700, tracks: {
    ParamAngleX: [[0, -10, 160], [300, 8, 160], [600, -6, 160], [900, 10, 160], [1200, -8, 160], [1500, 6, 160], [1800, -10, 160], [2100, 8, 160], [2400, 0, 260]],
    ParamAngleY: [[0, -5, 160], [300, 3, 160], [600, -8, 160], [900, 5, 160], [1200, 3, 160], [1500, -5, 160], [1800, -3, 160], [2100, 8, 160], [2400, 0, 260]],
    ParamAngleZ: [[0, -8, 160], [300, 6, 160], [600, -4, 160], [900, 8, 160], [1200, -6, 160], [1500, 4, 160], [1800, -8, 160], [2100, 6, 160], [2400, 0, 260]],
    ParamBodyAngleX: [[0, -6, 170], [300, 5, 170], [600, -4, 170], [900, 6, 170], [1200, -5, 170], [1500, 4, 170], [1800, -6, 170], [2100, 5, 170], [2400, 0, 260]],
    ParamMouthOpenY: [[0, 0.15, 170], [2400, 0.05, 260]],
  } },
  explain: { emotion: 'think', ms: 2200, tracks: {
    ParamAngleY: [[0, -8, 150], [180, 3, 160], [360, 0, 180], [600, -8, 150], [780, 3, 160], [960, 0, 180],
      [1200, -8, 150], [1380, 3, 160], [1560, 0, 220]],
    ParamBodyAngleX: [[0, -4, 320], [1900, 0, 380]],
  } },
  focus: { emotion: 'focus', ms: 2700, tracks: {
    ParamAngleY: [[0, 5, 220]], ParamBodyAngleY: [[0, -5, 240]],
    ParamEyeLOpen: [[0, 0.88, 200]], ParamEyeROpen: [[0, 0.88, 200]],
    ParamBrowLY: [[0, -0.25, 220]], ParamBrowRY: [[0, -0.25, 220]],
    ParamMouthForm: [[0, 0.1, 240]], ParamMouthOpenY: [[0, 0.02, 240]],
  } },
  proud: { emotion: 'proud', ms: 2400, tracks: {
    ParamBodyAngleY: [[0, -7, 200]], ParamBodyAngleX: [[0, 4, 220]],
    ParamAngleY: [[0, -8, 200]], ParamAngleZ: [[0, -7, 200]], ParamAngleX: [[0, 6, 220]],
    ParamBrowLY: [[0, 0.35, 200]], ParamBrowRY: [[0, 0.35, 200]],
    ParamMouthForm: [[0, 0.6, 200]], ParamMouthOpenY: [[0, 0.12, 220]],
  } },
  fighting: { emotion: 'cheer', ms: 1400, tracks: {
    ParamBodyAngleY: [[0, -8, 110], [180, 2, 130], [380, -14, 120], [620, 4, 150], [1050, 0, 260]],
    ParamEyeLOpen: [[0, 1.15, 120]], ParamEyeROpen: [[0, 1.15, 120]], ParamCheek: [[0, 0.35, 160]],
    ParamMouthOpenY: [[380, 0.28, 130], [1050, 0.06, 220]], ParamMouthForm: [[380, 0.5, 140]],
    ParamAngleY: [[380, -6, 160]],
  } },
  shy: { emotion: 'shy', ms: 3000, tracks: {
    ParamCheek: [[0, 0.65, 220]], ParamAngleX: [[0, 18, 320]], ParamAngleY: [[0, 10, 320]],
    ParamAngleZ: [[0, -6, 320]], ParamBodyAngleX: [[0, 5, 340]],
    ParamEyeLOpen: [[0, 0.55, 260]], ParamEyeROpen: [[0, 0.55, 260]],
    ParamMouthForm: [[0, 0.25, 260]], ParamMouthOpenY: [[0, 0.06, 260]],
  } },
  panic: { emotion: 'panic', ms: 1200, tracks: {
    ParamEyeLOpen: [[0, 1.3, 100]], ParamEyeROpen: [[0, 1.3, 100]],
    ParamBrowLY: [[0, 0.7, 100]], ParamBrowRY: [[0, 0.7, 100]],
    ParamMouthOpenY: [[0, 0.32, 100]], ParamMouthForm: [[0, -0.3, 130]],
    ParamAngleX: osc(14, 10, 80, 120, 50), ParamAngleZ: osc(8, 10, 80, 120, 50),
  } },
  curious: { emotion: 'curious', ms: 2800, tracks: {
    ParamAngleZ: [[0, 15, 240]], ParamAngleX: [[0, -9, 260]], ParamAngleY: [[0, -3, 260]],
    ParamEyeLOpen: [[0, 1.08, 220]], ParamEyeROpen: [[0, 0.95, 220]],
    ParamBrowLY: [[0, 0.25, 220]], ParamBrowRY: [[0, -0.15, 220]],
    ParamMouthOpenY: [[0, 0.12, 240]], ParamMouthForm: [[0, 0.15, 240]],
  } },
  dozeoff: { emotion: 'dozeoff', endEmotion: 'prev', ms: 3000, tracks: {
    ParamAngleY: [[0, 18, 700], [1300, -12, 150], [1850, 0, 420]],
    ParamBodyAngleY: [[0, 7, 700], [1300, -4, 170], [1850, 0, 420]],
    ParamEyeLOpen: [[0, 0.08, 700], [1300, 1.2, 150], [1850, 0.9, 320], [2600, 1, 300]],
    ParamEyeROpen: [[0, 0.08, 700], [1300, 1.2, 150], [1850, 0.9, 320], [2600, 1, 300]],
    ParamBrowLY: [[1300, 0.4, 170], [1850, 0, 320]], ParamBrowRY: [[1300, 0.4, 170], [1850, 0, 320]],
    ParamMouthForm: [[1850, 0.25, 220], [2600, 0, 320]],
  } },
  relieved: { emotion: 'relieved', ms: 2800, tracks: {
    ParamAngleY: [[0, -6, 240], [500, 9, 340], [1300, 0, 440]],
    ParamBodyAngleY: [[0, -4, 260], [500, 5, 340], [1300, 0, 440]],
    ParamEyeLOpen: [[500, 0.25, 280], [1300, 0.85, 280]], ParamEyeROpen: [[500, 0.25, 280], [1300, 0.85, 280]],
    ParamMouthOpenY: [[500, 0.15, 280], [1300, 0.04, 280]],
    ParamMouthForm: [[1300, 0.4, 280], [2400, 0, 320]],
  } },
  pout: { emotion: 'pout', ms: 3200, tracks: {
    ParamAngleX: [[0, -24, 280]], ParamAngleZ: [[0, -7, 280]], ParamBodyAngleX: [[0, -10, 320]],
    ParamMouthForm: [[0, -0.5, 260]], ParamMouthOpenY: [[0, 0.04, 280]],
    ParamBrowLY: [[0, -0.35, 260]], ParamBrowRY: [[0, -0.35, 260]],
    ParamEyeLOpen: [[0, 0.65, 280]], ParamEyeROpen: [[0, 0.65, 280]], ParamCheek: [[0, 0.25, 320]],
  } },
  whisper: { emotion: 'whisper', ms: 2800, tracks: {
    ParamBodyAngleY: [[0, -9, 260]], ParamAngleY: [[0, 6, 260]],
    ParamAngleZ: [[0, -11, 280]], ParamAngleX: [[0, 13, 280]],
    ParamEyeLOpen: [[0, 0.85, 240]], ParamEyeROpen: [[0, 0.1, 200]],
    ParamMouthOpenY: [[0, 0.09, 260]], ParamMouthForm: [[0, 0.35, 260]],
  } },
  sparkle: { emotion: 'sparkle', ms: 2000, tracks: {
    ParamEyeLOpen: [[0, 1.25, 130]], ParamEyeROpen: [[0, 1.25, 130]],
    ParamBrowLY: [[0, 0.5, 150]], ParamBrowRY: [[0, 0.5, 150]], ParamCheek: [[0, 0.45, 190]],
    ParamMouthForm: [[0, 0.6, 160]], ParamMouthOpenY: [[0, 0.22, 160]], ParamBodyAngleY: [[0, -5, 180]],
    ParamAngleZ: osc(7, 8, 180, 120, 105),
  } },
  spaceout: { emotion: 'spaceout', ms: 3700, tracks: {
    ParamAngleY: [[0, -8, 620]], ParamAngleZ: [[0, 4, 620]], ParamBodyAngleY: [[0, 3, 700]],
    ParamEyeLOpen: [[0, 0.42, 520]], ParamEyeROpen: [[0, 0.42, 520]],
    ParamBrowLY: [[0, 0, 520]], ParamBrowRY: [[0, 0, 520]],
    ParamMouthOpenY: [[0, 0.12, 520]], ParamMouthForm: [[0, 0, 520]],
  } },
  poke: { ms: 700, tracks: {
    ParamAngleY: [[0, 6, 100], [130, -4, 130], [280, 0, 220]],
    ParamBodyAngleY: [[0, 4, 120], [280, 0, 240]],
    ParamEyeLOpen: [[0, 0.35, 90], [220, 1, 200]], ParamEyeROpen: [[0, 0.35, 90], [220, 1, 200]],
  } },
  hold: { emotion: 'love', ms: 1600, tracks: {
    ParamAngleZ: [[0, -5, 260]], ParamBodyAngleY: [[0, -3, 280]],
  } },
  celebrate: { ms: 1000, tracks: {
    ParamBodyAngleY: [[0, -6, 130], [300, 3, 150], [600, 0, 260]],
  } },
};

export class Live2DStage {
  constructor(canvas) {
    this.canvas = canvas;
    this.app = null;
    this.model = null;
    this.modelId = null;
    this.modelUrl = null;
    this.availableModels = [];
    this.persistParams = {};
    this.lipVolume = 0;
    this._loading = null;

    // 위치/크기
    this.offsetX = 0;
    this.offsetY = 0;
    this.zoom = 1;
    this.viewMode = 'bust'; // 'bust' (상반신 포커스) | 'full' (전신)
    this._bustWeight = 1.0;
    this.onZoomChange = null;
    this.onViewModeChange = null;
    this._camAnim = null;
    this._smoothedLipOpen = 0;
    this._baseW = 1;
    this._baseH = 1;

    // 커서 트래킹
    this._cursorX = 0;
    this._cursorY = 0;
    this._cursorScreenX = 0;
    this._cursorScreenY = 0;
    this._cursorInWindow = false;
    this._lastMouseMove = 0;
    this._trackIntensity = 0; // 0~1
    this._trackAngleX = 0;
    this._trackAngleY = 0;
    this._trackAngleZ = 0;
    this._trackEyeBallX = 0;
    this._trackEyeBallY = 0;
    this._trackBodyAngleX = 0;
    this._trackBodyAngleZ = 0;

    // 유휴 애니메이션
    this._idleTime = 0;
    this._blinkTimer = 0;
    this._blinkState = 0; // 0=열림, 1=닫는중, 2=열리는중
    this._breathPhase = 0;
    this._swayPhase = 0;
    this._lastInteraction = Date.now();

    // 쓰다듬기
    this._petAcc = 0;
    this._petStrokes = 0;
    this._petIntensity = 0; // 0~1, 점진적 증가
    this._petSwayPhase = 0;
    this._petCursorDx = 0;

    // 파트 불투명도 부드러운 보간 (팔 전환 팝 현상 방지)
    this._partOpacities = {};
    this._lastApplyTime = 0;

    // 파라미터 레이어 합성: id -> Map(우선순위 -> {value, tau}), id -> 보간된 현재 값
    this._claims = {};
    this._pose = {};
    this._emotionIds = new Set();
    this._emotionTag = 'neutral';
    this._emotionDecayTimer = null;
    this._reaction = null;
    this._reactionPrevEmotion = null;

    // 인터랙션 상태
    this._press = null;
    this._holdTimer = null;
    this._holdFired = false;
    this._tapTimer = null;

    // 티커
    this._boundTick = this._tick.bind(this);
    this._boundApplyParams = this._applyModelParams.bind(this);
  }

  // ========== 초기화 ==========

  async init({ modelId = null, modelUrl = null, availableModels = [] } = {}) {
    if (!window.PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
      throw new Error('Live2D 플러그인 로드 실패 (vendor 스크립트 확인)');
    }
    this.availableModels = availableModels || [];

    const { Live2DModel } = PIXI.live2d;
    Live2DModel.registerTicker(PIXI.Ticker);

    const parent = this.canvas.parentElement;
    const w = parent?.clientWidth || 400;
    const h = parent?.clientHeight || 400;

    this.app = new PIXI.Application({
      view: this.canvas,
      width: w,
      height: h,
      backgroundAlpha: 0,
      autoStart: true,
      antialias: true,
    });

    const ordered = [];
    const pushUrl = (url, id) => {
      if (url && !ordered.some((o) => o.url === url)) ordered.push({ url, id });
    };
    const explicitUrl = modelUrl || (modelId ? modelUrlFor(this.availableModels, modelId) : null);
    if (explicitUrl) pushUrl(explicitUrl, modelId);
    const defaultUrl = modelUrlFor(this.availableModels, DEFAULT_MODEL_ID) || FALLBACK_MODEL_URLS[0];
    pushUrl(defaultUrl, DEFAULT_MODEL_ID);
    for (const url of FALLBACK_MODEL_URLS) pushUrl(url, null);

    let lastErr = null;
    for (const { url, id } of ordered) {
      try {
        await this._loadIntoStage(url, id);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.warn('모델 로드 실패, 다음 후보 시도:', url, err?.message);
      }
    }
    if (!this.model) {
      throw new Error(`Live2D 모델을 불러오지 못했습니다. (npm run setup 실행 확인) ${lastErr?.message ?? ''}`);
    }

    this._bindInteraction();
    this._startTicker();
    this.setEmotion('neutral');
  }

  async switchModel(modelIdOrUrl, { availableModels } = {}) {
    if (availableModels?.length) this.availableModels = availableModels;
    if (this._loading) await this._loading.catch(() => {});
    const task = this._doSwitch(modelIdOrUrl);
    this._loading = task;
    try { return await task; } finally { if (this._loading === task) this._loading = null; }
  }

  async _doSwitch(modelIdOrUrl) {
    let url = null, id = null;
    if (/^\/|^https?:/.test(modelIdOrUrl || '')) {
      url = modelIdOrUrl;
      id = this.availableModels.find((m) => m.modelUrl === url)?.id || null;
    } else {
      id = modelIdOrUrl;
      url = modelUrlFor(this.availableModels, id) || null;
      if (!url) throw new Error(`알 수 없는 모델입니다: ${id}`);
    }
    if (url === this.modelUrl) return { id: this.modelId, url: this.modelUrl };

    const { Live2DModel } = PIXI.live2d;
    const next = await Live2DModel.from(url, { autoInteract: false });
    this._stopTicker();
    this._detachCurrent();
    this.model = next;
    this.modelUrl = url;
    this.modelId = id;
    this._attachModel();
    this._startTicker();
    this.setEmotion('neutral');
    return { id: this.modelId, url: this.modelUrl };
  }

  async _loadIntoStage(url, id) {
    const { Live2DModel } = PIXI.live2d;
    const model = await Live2DModel.from(url, { autoInteract: false });
    this._detachCurrent();
    this.model = model;
    this.modelUrl = url;
    this.modelId = id;
    this._attachModel();
  }

  _attachModel() {
    this._resetAnimState();
    configureMotionModel(this.model, this.modelId);
    this._loadOffset();
    this._loadZoom();
    // 모델의 기본 비스케일링 크기(LocalBounds)를 안전하게 확보하여 비율 왜곡 방지
    try { this.model.scale.set(1); } catch {}
    const bounds = typeof this.model.getLocalBounds === 'function' ? this.model.getLocalBounds() : null;
    this._baseW = bounds?.width || this.model.width || 1;
    this._baseH = bounds?.height || this.model.height || 1;
    this.app.stage.addChild(this.model);
    this.model.anchor.set(0.5, 0.5);

    const savedMode = localStorage.getItem('miku_avatar_view_mode') || 'bust';
    // 구버전 고정값(2.25 이하) 또는 구버전 오프셋(수백 px) 캐시는 새 프리셋으로 자동 초기화
    const isOldBroken = savedMode === 'bust' && (this.zoom <= 2.5 || Math.abs(this.offsetY) > 150);
    const hasCustomOffset = localStorage.getItem(posKey(this.modelId)) !== null;
    if (!hasCustomOffset || isOldBroken) {
      this.offsetX = 0;
      this.offsetY = 0;
      this.setViewMode(savedMode, { animated: false, save: true });
    } else {
      this.viewMode = savedMode;
      this._bustWeight = savedMode === 'full' ? 0 : 1;
      this._fit();
    }

    // 최종 렌더 직전에 레이어 합성 결과(표정/반응/시선/립싱크)를 확정한다.
    this.model.internalModel.on('beforeModelUpdate', this._boundApplyParams);
  }

  _detachCurrent() {
    if (!this.model) return;
    clearTimeout(this._emotionDecayTimer);
    this._emotionDecayTimer = null;
    this._clearReaction();
    try { this.model.internalModel?.off?.('beforeModelUpdate', this._boundApplyParams); } catch {}
    try { this.app.stage.removeChild(this.model); } catch {}
    try { this.model.destroy({ children: true, texture: true, baseTexture: true }); } catch {
      try { this.model.destroy(); } catch {}
    }
    this.model = null;
  }

  _resetAnimState() {
    this._trackAngleX = 0;
    this._trackAngleY = 0;
    this._trackAngleZ = 0;
    this._trackEyeBallX = 0;
    this._trackEyeBallY = 0;
    this._trackBodyAngleX = 0;
    this._trackBodyAngleZ = 0;
    this._trackIntensity = 0;
    this._lastMouseMove = 0;
    this._petIntensity = 0;
    this._petStrokes = 0;
    this._partOpacities = {};
    this._lastApplyTime = 0;
    this._idleTime = 0;
    this._blinkTimer = 2 + Math.random() * 4;
    this._blinkState = 0;
    this._smoothedLipOpen = 0;
    this._claims = {};
    this._pose = {};
    this._emotionIds = new Set();
    this._emotionTag = 'neutral';
    clearTimeout(this._emotionDecayTimer);
    this._emotionDecayTimer = null;
    this._reactionPrevEmotion = null;
    this.persistParams = {};
    this._clearReaction();
  }

  // ========== 파라미터 레이어 시스템 ==========

  // 안전하게 파라미터 설정 (Cubism 4 / Cubism 2 호환)
  _setParam(id, value) {
    const core = this.model?.internalModel?.coreModel;
    if (!core) return;
    try { core.setParameterValueById?.(id, value, 1); } catch {}
    try { core.setParamFloat?.(id, value, 1); } catch {}
    const alt = PARAM_LEGACY_MAP?.[id];
    if (alt) {
      try { core.setParameterValueById?.(alt, value, 1); } catch {}
      try { core.setParamFloat?.(alt, value, 1); } catch {}
    }
  }

  _readParam(id) {
    const core = this.model?.internalModel?.coreModel;
    if (!core) return 0;
    try {
      const v = core.getParameterValueById?.(id);
      if (Number.isFinite(v)) return v;
    } catch {}
    try {
      const v = core.getParamFloat?.(id);
      if (Number.isFinite(v)) return v;
    } catch {}
    return 0;
  }

  // 제어권이 없어진 파라미터의 기준 값 (눈은 0이 감긴 상태이므로 1이 기준)
  _restValue(id) {
    return (id === 'ParamEyeLOpen' || id === 'ParamEyeROpen' || id === 'PARAM_EYE_L_OPEN' || id === 'PARAM_EYE_R_OPEN') ? 1 : 0;
  }

  // 특정 레이어가 파라미터 값을 소유하도록 한다. 이미 보간 중인 값에서 이어서 움직인다.
  _setLayer(id, prio, value, tau = 260) {
    const layers = this._claims[id] || (this._claims[id] = new Map());
    const cur = layers.get(prio);
    if (cur) {
      cur.value = value;
      cur.tau = Math.max(16, tau);
    } else {
      layers.set(prio, { value, tau: Math.max(16, tau) });
    }
    if (this._pose[id] === undefined) this._pose[id] = this._readParam(id) - this._cursorOffset(id);
  }

  // 시선 추적은 최종 값에 가산되므로, 모델에서 값을 읽을 때 그 성분을 빼야 중복 적용되지 않는다.
  _cursorOffset(id) {
    if (this._trackIntensity <= 0.01) return 0;
    const key = TRACK_OFFSETS[id];
    return key ? (this[key] ?? 0) : 0;
  }

  // 레이어 소유를 해제하면 바로 아래 레이어(감정 → 유휴) 값으로 보간되어 이어진다.
  _releaseLayer(id, prio) {
    const layers = this._claims[id];
    if (!layers || !layers.has(prio)) return;
    layers.delete(prio);
    if (!layers.size) delete this._claims[id];
  }

  _releaseIds(ids, prio) {
    for (const id of ids) this._releaseLayer(id, prio);
  }

  // 발화 중이 아니면 립싱크 파라미터도 다른 파라미터와 똑같이 레이어로 합성된다.
  // 이전 감정이 쓴 파라미터는 새 감정에 없으면 소유를 거두어 자세가 남지 않게 한다.
  _applyEmotionClaims(params) {
    const nextIds = new Set(Object.keys(params));
    for (const id of this._emotionIds) {
      if (!nextIds.has(id)) this._releaseLayer(id, LAYER.emotion);
    }
    this._emotionIds = nextIds;
    for (const [id, value] of Object.entries(params)) {
      this._setLayer(id, LAYER.emotion, value, isMouthParam(id) ? 220 : 300);
    }
  }

  // ========== 반응 수명 주기 ==========

  _beginReaction(name, durationMs = 0, endEmotion = null) {
    this._clearReaction();
    const reaction = {
      name,
      timers: new Set(),
      ids: new Set(),
      prevEmotion: this._reactionPrevEmotion ?? this._emotionTag,
      endEmotion,
      endsAt: durationMs > 0 ? Date.now() + durationMs : 0,
    };
    this._reactionPrevEmotion = null;
    this._reaction = reaction;
    if (durationMs > 0) {
      this._schedule(() => this._endReaction(reaction), durationMs);
    }
    return reaction;
  }

  // 현재 반응에 묶인 예약 작업. 반응이 바뀌면 함께 취소된다.
  _schedule(fn, delayMs) {
    const reaction = this._reaction;
    if (!reaction) { fn(); return null; }
    const id = setTimeout(() => {
      if (!reaction.timers.has(id)) return;
      reaction.timers.delete(id);
      if (this._reaction === reaction) fn();
    }, delayMs);
    reaction.timers.add(id);
    return id;
  }

  _actAt(id, value, tau, delayMs) {
    const reaction = this._reaction;
    if (!reaction) return;
    const apply = () => {
      reaction.ids.add(id);
      this._setLayer(id, LAYER.action, value, tau);
    };
    if (delayMs <= 0) apply();
    else this._schedule(apply, delayMs);
  }

  _clearReaction() {
    const reaction = this._reaction;
    if (!reaction) return;
    this._reaction = null;
    for (const id of reaction.timers) clearTimeout(id);
    reaction.timers.clear();
    for (const id of reaction.ids) this._releaseLayer(id, LAYER.action);
    reaction.ids.clear();
  }

  _endReaction(reaction) {
    if (this._reaction !== reaction) return;
    this._reaction = null;
    for (const id of reaction.ids) this._releaseLayer(id, LAYER.action);
    reaction.ids.clear();
    // 동작성 반응(꾸벅 졸기 등)은 얼굴을 남기지 않고 이전 감정으로 돌아간다.
    const target = reaction.endEmotion === 'prev' ? reaction.prevEmotion : null;
    if (target && target !== this._emotionTag) this.setEmotionSoft(target);
  }

  // ========== 메인 파라미터 적용 (beforeModelUpdate) ==========

  _applyModelParams() {
    const core = this.model?.internalModel?.coreModel;
    if (!core) return;

    // 은랑(yinlang) 워터마크/도장 레이어 매 프레임 투명도 0 강제 유지
    if (this.modelId === 'yinlang') {
      try {
        if (typeof core.setPartOpacityById === 'function') {
          core.setPartOpacityById('Part19', 0);
          core.setPartOpacityById('Part20', 0);
        }
        this._setParam('key12', 0);
      } catch {}
    }

    // 파트 불투명도 부드러운 전환 보간 (팔 등 포즈 전환 시 순간적인 깜빡임/팝핑 방지)
    const now = performance.now();
    const dtSec = this._lastApplyTime ? Math.min(0.1, (now - this._lastApplyTime) / 1000) : (1 / 60);
    this._lastApplyTime = now;
    const partCount = core.getPartCount?.() || 0;
    for (let i = 0; i < partCount; i++) {
      const target = core.getPartOpacityByIndex(i);
      if (this._partOpacities[i] === undefined) {
        this._partOpacities[i] = target;
      } else {
        const next = approach(this._partOpacities[i], target, dtSec * 7);
        this._partOpacities[i] = next;
        core.setPartOpacityByIndex(i, next);
      }
    }

    for (const [id, value] of Object.entries(this._pose)) this._setParam(id, value);

    // 시선/고개 추정은 감정·반응 자세 위에 얹히는 가산 오프셋이다.
    if (this._trackIntensity > 0.01) {
      for (const [id, key] of Object.entries(TRACK_OFFSETS)) {
        this._setParam(id, (this._pose[id] ?? 0) + this[key]);
      }
    }

    // 입: 발화/음성이 있으면 립싱크가 전담, 없으면 합성된 값(또는 대기 기본값)을 쓴다.
    if (this.isSpeaking || this.lipVolume > 0.008) {
      this._setMouthOpen(this._computeLipOpen());
    } else {
      this._setMouthOpen(this._pose.ParamMouthOpenY ?? 0.04);
    }
  }

  // ========== 립싱크 ==========

  // 발화 중 및 오디오 볼륨 기반 실시간 입 개폐량 계산 (엔벨로프 필터 적용)
  _computeLipOpen() {
    let targetOpen = 0;
    // 1) 오디오 볼륨(RMS) 기반 다이내믹 립싱크 (자연스러운 지수 곡선 매핑)
    if (this.lipVolume > 0.008) {
      targetOpen = Math.min(1, Math.pow(this.lipVolume, 0.78) * 1.45);
    }

    // 2) 발화 상태(isSpeaking) 시 부드러운 음절 리듬 보조
    if (this.isSpeaking && targetOpen < 0.06) {
      // 자음/숨고르기 구간에서도 살짝 열어두어 기계적 끊김 방지
      const t = performance.now();
      targetOpen = Math.max(targetOpen, Math.sin(t * 0.016) * 0.08 + 0.12);
    }

    // 엔벨로프 필터 (빠른 어택, 부드러운 릴리즈)
    if (this._smoothedLipOpen === undefined) this._smoothedLipOpen = 0;
    const speed = targetOpen > this._smoothedLipOpen ? 0.35 : 0.18;
    this._smoothedLipOpen += (targetOpen - this._smoothedLipOpen) * speed;

    return this._smoothedLipOpen;
  }

  // 립싱크 전용: 모션/물리/모델 차이(Haru/Senko/Yinlang)에 영향받지 않고 확실하게 입을 개폐
  _setMouthOpen(val) {
    const core = this.model?.internalModel?.coreModel;
    if (!core) return;
    const clamped = Math.max(0, Math.min(1, val));
    // Cubism 4 / Cubism 2 파라미터 ID를 모두 반영 (미쿠는 구버전 ID만 존재)
    for (const id of MOUTH_IDS) {
      try { core.setParameterValueById?.(id, clamped, 1); } catch {}
      try { core.setParamFloat?.(id, clamped, 1); } catch {}
    }
  }

  // ========== 티커 (매 프레임 애니메이션) ==========

  _startTicker() {
    if (this.app) this.app.ticker.add(this._boundTick);
  }

  _stopTicker() {
    if (this.app) this.app.ticker.remove(this._boundTick);
  }

  _tick(dt) {
    if (!this.model) return;
    const sec = dt / 60;
    const dtMs = Math.max(1, dt * (1000 / 60));
    const now = Date.now();

    this._tickCursorTracking(sec, now);
    this._tickIdle(sec, now);
    this._tickPetting(sec);
    this._tickBlend(dtMs);
  }

  // 레이어 목표값으로 시간 기반 지수 보간 (프레임 레이트와 무관하게 동일하게 움직인다)
  _tickBlend(dtMs) {
    for (const id of Object.keys(this._pose)) {
      const layers = this._claims[id];
      let best = null;
      let bestPrio = -Infinity;
      if (layers) {
        for (const [prio, layer] of layers) {
          if (prio > bestPrio) { bestPrio = prio; best = layer; }
        }
      }
      const cur = this._pose[id];
      if (!best) {
        // 소유자가 사라진 파라미터는 기준 자세로 천천히 알계인한 뒤 제어에서 뺀다.
        const rest = this._restValue(id);
        const next = rest + (cur - rest) * Math.exp(-dtMs / 320);
        if (Math.abs(next - rest) < 0.01) delete this._pose[id];
        else this._pose[id] = next;
        continue;
      }
      const k = 1 - Math.exp(-dtMs / best.tau);
      const next = cur + (best.value - cur) * k;
      this._pose[id] = Math.abs(best.value - next) < 0.0005 ? best.value : next;
    }
  }

  // --- 커서 트래킹 (스프링 댐핑 보간 및 자연스러운 각도) ---
  _tickCursorTracking(sec, now = Date.now()) {
    const isMouseIdle = (now - this._lastMouseMove) > 4000;
    if (!this._cursorInWindow || isMouseIdle || !this.model) {
      this._trackIntensity = approach(this._trackIntensity, 0, sec * 3);
      if (this._trackIntensity < 0.01) {
        this._trackAngleX = approach(this._trackAngleX, 0, sec * 4);
        this._trackAngleY = approach(this._trackAngleY, 0, sec * 4);
        this._trackAngleZ = approach(this._trackAngleZ, 0, sec * 4);
        this._trackEyeBallX = approach(this._trackEyeBallX, 0, sec * 5);
        this._trackEyeBallY = approach(this._trackEyeBallY, 0, sec * 5);
        this._trackBodyAngleX = approach(this._trackBodyAngleX, 0, sec * 4);
        this._trackBodyAngleZ = approach(this._trackBodyAngleZ, 0, sec * 4);
        return;
      }
    } else {
      this._trackIntensity = approach(this._trackIntensity, 1, sec * 5);
    }

    // 모델 중심 화면 좌표 (얼굴 높이 기준)
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2 + this.offsetX;
    const cy = rect.top + rect.height * 0.38 + this.offsetY;
    const dx = this._cursorScreenX - cx;
    const dy = this._cursorScreenY - cy;

    // 반응 반경 및 데드존 (미세한 떨림 방지)
    const maxDistX = Math.max(220, (window.innerWidth || 800) * 0.4);
    const maxDistY = Math.max(180, (window.innerHeight || 600) * 0.4);
    let normX = Math.max(-1, Math.min(1, dx / maxDistX));
    let normY = Math.max(-1, Math.min(1, dy / maxDistY));

    if (Math.abs(normX) < 0.03) normX = 0;
    if (Math.abs(normY) < 0.03) normY = 0;

    // 자연스럽고 안정적인 시선/고개 각도 (과도한 꺾임 방지)
    const targetAngleX = normX * 24 * this._trackIntensity;
    const targetAngleY = -normY * 18 * this._trackIntensity;
    const targetAngleZ = normX * 6 * this._trackIntensity;
    const targetEyeBallX = normX * 0.75 * this._trackIntensity;
    const targetEyeBallY = -normY * 0.75 * this._trackIntensity;
    const targetBodyAngleX = normX * 8 * this._trackIntensity;
    const targetBodyAngleZ = normX * 3 * this._trackIntensity;

    // 스프링 댐핑 (LERP 보간)으로 유기적인 감속 이동
    const dampFactor = Math.min(1, sec * (this._press?.dragging ? 16 : 8));
    this._trackAngleX += (targetAngleX - this._trackAngleX) * dampFactor;
    this._trackAngleY += (targetAngleY - this._trackAngleY) * dampFactor;
    this._trackAngleZ += (targetAngleZ - this._trackAngleZ) * dampFactor;
    this._trackEyeBallX += (targetEyeBallX - this._trackEyeBallX) * Math.min(1, dampFactor * 1.2);
    this._trackEyeBallY += (targetEyeBallY - this._trackEyeBallY) * Math.min(1, dampFactor * 1.2);
    this._trackBodyAngleX += (targetBodyAngleX - this._trackBodyAngleX) * Math.min(1, dampFactor * 0.8);
    this._trackBodyAngleZ += (targetBodyAngleZ - this._trackBodyAngleZ) * Math.min(1, dampFactor * 0.8);
  }

  // --- 유휴 애니메이션 ---
  _tickIdle(sec, now) {
    const isMotionPlaying = (this.model?.internalModel?.motionManager?.state?.currentPriority > 1) || Boolean(this._reaction);
    const idleMs = now - this._lastInteraction;
    if (idleMs < 2000 || isMotionPlaying) {
      this._releaseIds(IDLE_IDS, LAYER.idle);
      return; // 상호작용 직후 또는 액션 모션/반응 재생 중에는 유휴 자세를 붙잡지 않는다
    }

    this._idleTime += sec;

    // 호흡 (ParamBodyAngleY 미세 변화)
    this._breathPhase += sec * 1.8;
    this._setLayer('ParamBodyAngleY', LAYER.idle, Math.sin(this._breathPhase) * 2, 320);

    // 좌우 가벼운 흔들림 (ParamAngleZ)
    this._swayPhase += sec * 0.7;
    const sway = Math.sin(this._swayPhase) * 3 + Math.sin(this._swayPhase * 1.7) * 1.5;
    this._setLayer('ParamAngleZ', LAYER.idle, sway, 420);

    // 어깨 움직임 (ParamBodyAngleX)
    this._setLayer('ParamBodyAngleX', LAYER.idle, Math.sin(this._swayPhase * 0.5) * 2, 480);

    // 미세 입 움직임 (말하지 않고 소리가 없을 때만 살짝)
    if (!this.isSpeaking && this.lipVolume <= 0.008) {
      this._setLayer('ParamMouthOpenY', LAYER.idle, 0.04 + Math.sin(this._breathPhase * 0.3) * 0.02, 380);
    }

    this._tickBlink(sec);
  }

  // 깜빡임은 감정/반응 눈값 위에 얹었다가 해제하면 아래 레이어로 돌아간다.
  _tickBlink(sec) {
    this._blinkTimer -= sec;
    if (this._blinkTimer <= 0 && this._blinkState === 0) {
      this._blinkState = 1;
      this._blinkTimer = 0.12; // 닫히는 시간
    }
    if (this._blinkState === 1) {
      this._setLayer('ParamEyeLOpen', LAYER.blink, 0.1, 70);
      this._setLayer('ParamEyeROpen', LAYER.blink, 0.1, 70);
      if (this._blinkTimer <= 0) {
        this._blinkState = 2;
        this._blinkTimer = 0.1;
      }
    }
    if (this._blinkState === 2) {
      this._setLayer('ParamEyeLOpen', LAYER.blink, 1, 90);
      this._setLayer('ParamEyeROpen', LAYER.blink, 1, 90);
      if (this._blinkTimer <= 0) {
        this._blinkState = 0;
        this._blinkTimer = 2 + Math.random() * 5; // 다음 깜빡까지
        this._releaseIds(BLINK_IDS, LAYER.blink);
      }
    }
  }

  // --- 쓰다듬기 애니메이션 ---
  _tickPetting(sec) {
    if (this._petIntensity <= 0) return;

    // 쓰다듬기 강도 감쇠
    this._petIntensity = approach(this._petIntensity, 0, sec * 0.7);
    if (this._petIntensity < 0.02) {
      this._petIntensity = 0;
      this._releaseIds(PET_IDS, LAYER.pet); // 제어권을 감정/시선에 돌려준다
      return;
    }

    // 커서 방향으로 고개 기울이기 (쓰다듬는 방향 추적 - 부드럽고 다정한 흔들림)
    this._petSwayPhase += sec * 2.2;
    const petSway = Math.sin(this._petSwayPhase) * 4 * this._petIntensity;
    const petTilt = this._petCursorDx * 8 * this._petIntensity;

    this._setLayer('ParamAngleX', LAYER.pet, petSway + petTilt, 180);
    this._setLayer('ParamAngleZ', LAYER.pet, Math.sin(this._petSwayPhase * 0.7) * 4 * this._petIntensity, 200);
    this._setLayer('ParamBodyAngleX', LAYER.pet, this._petCursorDx * 6 * this._petIntensity, 240);
    this._setLayer('ParamCheek', LAYER.pet, 0.55 * this._petIntensity, 240);
    this._setLayer('ParamMouthForm', LAYER.pet, 0.45 * this._petIntensity, 200);
    this._setLayer('ParamEyeLSmile', LAYER.pet, 0.9 * this._petIntensity, 200);
    this._setLayer('ParamEyeRSmile', LAYER.pet, 0.9 * this._petIntensity, 200);
    this._setLayer('ParamEyeLOpen', LAYER.pet, 1.0 - 0.65 * this._petIntensity, 220);
    this._setLayer('ParamEyeROpen', LAYER.pet, 1.0 - 0.65 * this._petIntensity, 220);
    this._setLayer('ParamBrowLY', LAYER.pet, 0.25 * this._petIntensity, 220);
    this._setLayer('ParamBrowRY', LAYER.pet, 0.25 * this._petIntensity, 220);

    // 기쁨 표정 (발화 중이 아닐 때만 입)
    if (!this.isSpeaking && this.lipVolume <= 0.008) {
      this._setLayer('ParamMouthOpenY', LAYER.pet, 0.12 * this._petIntensity, 200);
    }
  }

  // ========== 감정/표정/발화 ==========

  setLipVolume(vol) {
    this.lipVolume = vol;
  }

  setSpeaking(speaking) {
    const wasSpeaking = this.isSpeaking;
    this.isSpeaking = Boolean(speaking);
    if (this.isSpeaking) {
      clearTimeout(this._emotionDecayTimer);
    } else if (wasSpeaking) {
      // 발화 종료 시 1.2초 후 편안한 기본 표정(neutral)으로 자동 감쇠 복귀
      this._scheduleEmotionDecay(1200);
    }
  }

  _scheduleEmotionDecay(delayMs = 3500) {
    clearTimeout(this._emotionDecayTimer);
    if (this._emotionTag === 'neutral') return;
    this._emotionDecayTimer = setTimeout(() => {
      if (this.isSpeaking) return;
      this.setEmotionSoft('neutral');
    }, delayMs);
  }

  setEmotion(tag) {
    if (!this.model) return;
    const t = tag || 'smile';
    this._reactionPrevEmotion = this._emotionTag;
    this._emotionTag = t;
    this.persistParams = { ...softEmotion(this.model, t, this.modelId) };
    this._applyEmotionClaims(this.persistParams);
    this._lastInteraction = Date.now();
    // 발화 중이 아닐 때 단독 감정은 3.5초 후 자동으로 neutral 복귀
    if (!this.isSpeaking && t !== 'neutral') {
      this._scheduleEmotionDecay(3500);
    }
    // 상황별 반응 모션 우선, 없으면 감정 단독 모션 실행
    if (!this.playSituation(t)) {
      this._clearReaction();
      playMotion(this.model, t, this.modelId);
    }
  }

  setEmotionSoft(tag) {
    if (!this.model) return;
    const t = tag || 'smile';
    this._emotionTag = t;
    this.persistParams = { ...softEmotion(this.model, t, this.modelId) };
    this._applyEmotionClaims(this.persistParams);
    this._lastInteraction = Date.now();
    if (!this.isSpeaking && t !== 'neutral') {
      this._scheduleEmotionDecay(3500);
    }
  }

  tap() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this._playReaction('poke');
    playTapMotion(this.model, this.modelId);
  }

  // ========== 위치/크기 ==========

  _loadOffset() {
    this.offsetX = 0; this.offsetY = 0;
    try {
      const raw = localStorage.getItem(posKey(this.modelId));
      if (!raw) return;
      const p = JSON.parse(raw);
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        this.offsetX = Math.max(-800, Math.min(800, p.x));
        this.offsetY = Math.max(-800, Math.min(800, p.y));
      }
    } catch {}
  }

  _saveOffset() {
    try { localStorage.setItem(posKey(this.modelId), JSON.stringify({ x: this.offsetX, y: this.offsetY })); } catch {}
  }

  _loadZoom() {
    this.zoom = 1;
    try {
      const raw = localStorage.getItem(zoomKey(this.modelId));
      const z = raw == null ? NaN : Number(raw);
      if (Number.isFinite(z)) this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    } catch {}
  }

  _saveZoom() {
    try { localStorage.setItem(zoomKey(this.modelId), String(this.zoom)); } catch {}
  }

  resetPosition() {
    this.setViewMode(this.viewMode || 'bust', { animated: true, save: true });
  }

  setZoom(z, { save = true } = {}) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(z) || 1));
    if (clamped === this.zoom && this.model) return this.zoom;
    this.zoom = clamped;
    if (save) this._saveZoom();
    this._notifyZoom();
    this._fit();
    return this.zoom;
  }

  getZoom() { return this.zoom; }
  _notifyZoom() { try { this.onZoomChange?.(this.zoom); } catch {} }

  getViewMode() {
    return this.viewMode || 'bust';
  }

  setViewMode(mode, { animated = true, save = true } = {}) {
    const nextMode = mode === 'full' ? 'full' : 'bust';
    this.viewMode = nextMode;
    if (save) {
      try { localStorage.setItem('miku_avatar_view_mode', nextMode); } catch {}
    }
    const preset = getViewPreset(this.modelId, nextMode);
    const targetZoom = preset.zoom;
    const targetOffsetX = 0;
    const targetOffsetY = 0; // _fit에서 모드별 최적 Y 위치를 자동 산출하므로 기본 오프셋은 0
    const targetWeight = nextMode === 'bust' ? 1 : 0;

    if (!animated || !this.model) {
      this._bustWeight = targetWeight;
      this.zoom = targetZoom;
      this.offsetX = targetOffsetX;
      this.offsetY = targetOffsetY;
      this._saveZoom();
      this._saveOffset();
      this._notifyZoom();
      this._fit();
      this.onViewModeChange?.(this.viewMode);
      return;
    }

    if (this._camAnim) cancelAnimationFrame(this._camAnim);
    const startZoom = this.zoom;
    const startX = this.offsetX;
    const startY = this.offsetY;
    const startWeight = typeof this._bustWeight === 'number' ? this._bustWeight : (startZoom > 2.0 ? 1 : 0);
    const startTime = performance.now();
    const duration = 400; // ms

    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

    const step = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      const ease = easeOutCubic(progress);

      this.zoom = startZoom + (targetZoom - startZoom) * ease;
      this.offsetX = startX + (targetOffsetX - startX) * ease;
      this.offsetY = startY + (targetOffsetY - startY) * ease;
      this._bustWeight = startWeight + (targetWeight - startWeight) * ease;
      this._fit();
      this._notifyZoom();

      if (progress < 1) {
        this._camAnim = requestAnimationFrame(step);
      } else {
        this._camAnim = null;
        this._bustWeight = targetWeight;
        this._saveZoom();
        this._saveOffset();
        this.onViewModeChange?.(this.viewMode);
      }
    };
    this._camAnim = requestAnimationFrame(step);
  }

  toggleViewMode() {
    const next = this.viewMode === 'bust' ? 'full' : 'bust';
    this.setViewMode(next, { animated: true, save: true });
    return next;
  }

  _getHeadDistance() {
    const preset = getViewPreset(this.modelId, 'bust');
    return (preset.headDistRatio || 0.48) * this._baseH;
  }

  _fit() {
    if (!this.app || !this.model) return;
    const parent = this.canvas.parentElement;
    if (parent) {
      const pw = Math.round(parent.clientWidth);
      const ph = Math.round(parent.clientHeight);
      if (pw >= 10 && ph >= 10 && (this.app.renderer.width !== pw || this.app.renderer.height !== ph)) {
        this.app.renderer.resize(pw, ph);
      }
    }
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    if (w === 0 || h === 0) return;

    const bustW = typeof this._bustWeight === 'number'
      ? this._bustWeight
      : ((this.viewMode || 'bust') === 'bust' ? 1 : 0);

    // 상반신(bust)과 전신(full)의 기준 폭 보간:
    // 가로 폭(w)을 넓혀도 인물이 비정상적으로 거대해지지 않도록 상반신 기준 폭을 최대 390px(또는 h * 0.46)로 제한
    const maxBustW = Math.max(280, Math.min(390, h * 0.46));
    const effectiveW = lerp(w, Math.min(w, maxBustW), bustW);
    const baseScale = Math.min(effectiveW / this._baseW, h / this._baseH) * 0.92;
    const scale = baseScale * this.zoom;
    this.model.scale.set(scale);

    // Y 위치 보간:
    // - 전신: 화면 중앙(h / 2)
    // - 상반신: 머리 상단이 상단 배지 바로 아래(y ≈ 56px)에 머물도록 idealCenterY 산출
    const headDist = this._getHeadDistance();
    const bustCenterY = 56 + (headDist * scale);
    const fullCenterY = h / 2;
    const centerY = lerp(fullCenterY, bustCenterY, bustW);

    this.model.x = w / 2 + this.offsetX;
    this.model.y = centerY + this.offsetY;
  }

  // ========== 인터랙션 ==========

  _toLocal(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _pointOnModel(x, y) {
    if (!this.model) return false;
    try {
      const b = this.model.getBounds();
      return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
    } catch { return false; }
  }

  _bindInteraction() {
    const canvas = this.canvas;
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';

    // 전역(Window) 커서 위치 추적: 화면 어디로 마우스를 옮겨도 시선과 고개가 부드럽게 추적
    const onGlobalMove = (e) => {
      if (this._cursorScreenX !== e.clientX || this._cursorScreenY !== e.clientY) {
        this._cursorScreenX = e.clientX;
        this._cursorScreenY = e.clientY;
        this._lastMouseMove = Date.now();
      }
      const p = this._toLocal(e);
      this._cursorX = p.x;
      this._cursorY = p.y;
      this._cursorInWindow = true;
      this._lastInteraction = Date.now();
    };
    window.addEventListener('pointermove', onGlobalMove, { passive: true });
    document.addEventListener('pointerleave', () => {
      this._cursorInWindow = false;
    });
    window.addEventListener('blur', () => {
      this._cursorInWindow = false;
    });

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.model || (e.button !== undefined && e.button !== 0)) return;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      const p = this._toLocal(e);
      this._press = {
        id: e.pointerId, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y,
        onModel: this._pointOnModel(p.x, p.y), dragging: false, movedModel: false,
      };
      this._petAcc = 0;
      this._holdFired = false;
      canvas.style.cursor = 'grabbing';
      clearTimeout(this._holdTimer);
      this._holdTimer = setTimeout(() => this._onHold(), HOLD_MS);
      this._lastInteraction = Date.now();
    });

    canvas.addEventListener('pointermove', (e) => {
      const pr = this._press;
      if (!pr || pr.id !== e.pointerId) return;
      const p = this._toLocal(e);
      const dx = p.x - pr.lastX;
      const dy = p.y - pr.lastY;
      pr.lastX = p.x; pr.lastY = p.y;

      if (!pr.dragging && Math.hypot(p.x - pr.startX, p.y - pr.startY) > DRAG_THRESHOLD_PX) {
        pr.dragging = true;
        clearTimeout(this._holdTimer);
      }
      if (!pr.dragging) return;

      if (pr.onModel) {
        this._onPet(dx, dy, p);
      } else {
        this._moveBy(dx, dy);
        pr.movedModel = true;
      }
      this._lastInteraction = Date.now();
    });

    const up = (e) => {
      const pr = this._press;
      clearTimeout(this._holdTimer);
      canvas.style.cursor = 'grab';
      if (!pr || (e.pointerId !== undefined && pr.id !== e.pointerId)) return;
      this._press = null;
      if (pr.movedModel) this._saveOffset();
      // 더블클릭과 겹치지 않게 단일 클릭 반응은 잠시 유예한다.
      if (!pr.dragging && !this._holdFired) this._scheduleTap();
      this._lastInteraction = Date.now();
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', () => {
      clearTimeout(this._holdTimer);
      canvas.style.cursor = 'grab';
      if (this._press?.movedModel) this._saveOffset();
      this._press = null;
    });

    canvas.addEventListener('dblclick', (e) => {
      if (!this.model) return;
      clearTimeout(this._tapTimer);
      const p = this._toLocal(e);
      this.celebrateAt(p.x, p.y);
    });

    canvas.addEventListener('wheel', (e) => {
      if (!this.model) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0012));
    }, { passive: false });

    let rafId = null;
    const onResize = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const parent = this.canvas.parentElement;
        if (!parent) return;
        const pw = Math.round(parent.clientWidth);
        const ph = Math.round(parent.clientHeight);
        if (pw < 10 || ph < 10) return;
        if (this.app?.renderer) {
          this.app.renderer.resize(pw, ph);
          this._fit();
        }
      });
    };
    window.addEventListener('resize', onResize);

    // DOM 컨테이너 크기 변경 감지 (로그인 창 전환, 사이드바 토글, 패널 열림/닫힘 대응)
    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      this._resizeObserver = new ResizeObserver(() => {
        onResize();
      });
      this._resizeObserver.observe(this.canvas.parentElement);
    }

    setTimeout(() => onResize(), 50);
    setTimeout(() => onResize(), 200);
    setTimeout(() => onResize(), 500);
  }

  _scheduleTap() {
    clearTimeout(this._tapTimer);
    this._tapTimer = setTimeout(() => { this._tapTimer = null; this.tap(); }, DBLCLICK_WINDOW_MS);
  }

  _moveBy(dx, dy) {
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    this.offsetX = Math.max(-w * 0.6, Math.min(w * 0.6, this.offsetX + dx));
    this.offsetY = Math.max(-h * 0.6, Math.min(h * 0.6, this.offsetY + dy));
    this.model.x = w / 2 + this.offsetX;
    this.model.y = h / 2 + this.offsetY;
  }

  // ========== 인터랙션 핸들러 ==========

  _onHold() {
    const pr = this._press;
    if (!pr || pr.dragging) return;
    this._holdFired = true;
    if (!pr.onModel || !this.model) return;
    this.holdAt(pr.lastX, pr.lastY);
  }

  _onPet(dx, dy, p) {
    if (!this.model) return;
    this._petAcc += Math.hypot(dx, dy);
    if (this._petAcc < PET_STROKE_PX) return;
    this._petAcc = 0;
    this.petStroke(p.x, p.y, dx);
  }

  // ========== 테스트/외부 API ==========

  getModelInfo() {
    let bounds = null;
    try {
      const b = this.model?.getBounds();
      if (b) bounds = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    } catch {}
    return {
      id: this.modelId, url: this.modelUrl,
      offsetX: Math.round(this.offsetX), offsetY: Math.round(this.offsetY),
      zoom: Math.round(this.zoom * 100) / 100, bounds,
    };
  }

  // 테스트/진단용: 지금 어떤 레이어가 어떤 파라미터를 잡고 있는지 반환한다.
  getActionInfo() {
    const state = this.model?.internalModel?.motionManager?.state;
    const layerNames = { [LAYER.idle]: 'idle', [LAYER.emotion]: 'emotion', [LAYER.pet]: 'pet', [LAYER.blink]: 'blink', [LAYER.action]: 'action' };
    const layers = {};
    for (const [id, claims] of Object.entries(this._claims)) {
      for (const prio of claims.keys()) {
        const name = layerNames[prio];
        if (!name) continue;
        (layers[name] ||= []).push(id);
      }
    }
    return {
      model: this.modelId,
      emotion: this._emotionTag,
      reaction: this._reaction
        ? { name: this._reaction.name, msLeft: Math.max(0, this._reaction.endsAt - Date.now()) }
        : null,
      motion: state?.currentGroup ? { group: state.currentGroup, index: state.currentIndex, priority: state.currentPriority } : null,
      layers,
      fading: Object.keys(this._pose).filter((id) => !this._claims[id]),
      speaking: Boolean(this.isSpeaking),
      lipVolume: +this.lipVolume.toFixed(3),
      mouth: +(this._pose.ParamMouthOpenY ?? 0).toFixed(2),
      petIntensity: +this._petIntensity.toFixed(2),
      trackIntensity: +this._trackIntensity.toFixed(2),
    };
  }

  centerPoint() {
    if (!this.app) return { x: 200, y: 200 };
    return { x: this.app.renderer.width / 2 + this.offsetX, y: this.app.renderer.height / 2 + this.offsetY };
  }

  nudge(dx, dy) {
    if (!this.model) return null;
    this._moveBy(dx, dy);
    this._saveOffset();
    return { offsetX: Math.round(this.offsetX), offsetY: Math.round(this.offsetY) };
  }

  // 쓰다듬기 1 스트로크
  petStroke(x, y, cursorDx = 0) {
    if (!this.model) return 0;
    this._petStrokes += 1;
    this._petIntensity = Math.min(1, this._petIntensity + 0.28);
    this._petCursorDx = Math.max(-1, Math.min(1, cursorDx / 20));

    // 점진적 표정 변화 (쓰다듬을수록 강해짐)
    if (this._petStrokes <= 3) {
      this.setEmotionSoft('smile');
    } else if (this._petStrokes <= 8) {
      this.setEmotionSoft('love');
    } else {
      this.setEmotionSoft('cheer');
    }

    // 쓰다듬기 시작 시 부드러운 다정한 모션 1회 전환 (스트로크 반복 난타 방지)
    if (this._petStrokes === 1) {
      playPetMotion(this.model, this.modelId);
    }
    if (this._petStrokes > 1000) this._petStrokes = 0;
    this._lastInteraction = Date.now();
    return this._petStrokes;
  }

  petAt(x, y, strokes = 3) {
    let n = 0;
    for (let i = 0; i < strokes; i++) {
      n = this.petStroke(x + (Math.random() * 40 - 20), y + (Math.random() * 24 - 12), Math.random() * 20 - 10);
    }
    return n;
  }

  holdAt(x, y) {
    if (!this.model) return false;
    this._petIntensity = 0.8;
    this._petCursorDx = 0;
    this._playReaction('hold');
    this._lastInteraction = Date.now();
    return true;
  }

  celebrateAt(x, y) {
    if (!this.model) return false;
    this._emotionTag = 'cheer';
    this.persistParams = { ...softEmotion(this.model, 'cheer', this.modelId) };
    this._applyEmotionClaims(this.persistParams);
    this._playReaction('celebrate');
    playCelebrateMotion(this.model, this.modelId);
    this._lastInteraction = Date.now();
    return true;
  }

  motionGroups() {
    try {
      const defs = this.model?.internalModel?.motionManager?.definitions;
      if (!defs) return {};
      return Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v?.length ?? 0]));
    } catch { return {}; }
  }

  async motionTest(group, index) {
    if (!this.model) return false;
    try { return await this.model.motion(group, index ?? undefined); } catch { return false; }
  }

  async expressionTest(id) {
    if (!this.model) return false;
    try { return await this.model.expression(id); } catch { return false; }
  }

  // ========== 상황별 모션 (레이어 기반) ==========

  _playReaction(name) {
    const def = REACTIONS[name];
    if (!def || !this.model) return false;
    this._beginReaction(name, def.ms, def.endEmotion);
    if (def.emotion) this.setEmotionSoft(def.emotion);
    const motionPlayed = playMotion(this.model, name, this.modelId);
    // 모션 파일이 실제로 실행된 경우, 모션 커브가 고개/몸통을 직접 구동하므로
    // 인공적인 절차적 트랙(osc 등)으로 모션 각도를 덮어씌우지 않는다.
    // 모션 파일이 없는 모델(센코, 은랑)이거나 모션 매핑이 없는 경우에만 tracks로 보조한다.
    if (!motionPlayed) {
      for (const [id, frames] of Object.entries(def.tracks)) {
        for (const [at, value, tau] of frames) this._actAt(id, value, tau, at);
      }
      try {
        const mm = this.model.internalModel?.motionManager;
        if (mm && mm.state?.currentPriority > 1) {
          mm.startRandomMotion(mm.groups.idle, 1);
        }
      } catch {}
    }
    return true;
  }

  playExplain() { return this._playReaction('explain'); }
  playSurprise() { return this._playReaction('surprise'); }
  playThink() { return this._playReaction('think'); }
  playJoy() { return this._playReaction('joy'); }
  playSad() { return this._playReaction('sad'); }
  playAngry() { return this._playReaction('angry'); }
  playSleepy() { return this._playReaction('sleepy'); }
  playWakeUp() { return this._playReaction('wakeup'); }
  playGreet() { return this._playReaction('greet'); }
  playShake() { return this._playReaction('shake'); }
  playWave() { return this._playReaction('wave'); }
  playClap() { return this._playReaction('clap'); }
  playDance() { return this._playReaction('dance'); }
  playFocus() { return this._playReaction('focus'); }
  playProud() { return this._playReaction('proud'); }
  playFighting() { return this._playReaction('fighting'); }
  playShy() { return this._playReaction('shy'); }
  playPanic() { return this._playReaction('panic'); }
  playCurious() { return this._playReaction('curious'); }
  playDozeOff() { return this._playReaction('dozeoff'); }
  playRelieved() { return this._playReaction('relieved'); }
  playPout() { return this._playReaction('pout'); }
  playWhisper() { return this._playReaction('whisper'); }
  playSparkle() { return this._playReaction('sparkle'); }
  playSpaceOut() { return this._playReaction('spaceout'); }
  playNod() { return this._playReaction('nod'); }

  // 상황별 모션 통합 디스패처 (이름으로 직접 실행)
  playSituation(name) {
    if (!name || !this.model) return false;
    return this._playReaction(String(name).toLowerCase());
  }
}
