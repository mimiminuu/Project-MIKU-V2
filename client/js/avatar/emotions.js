// 감정 태그 → 표정/모션 매핑.
// 파라미터는 이 파일이 직접 쓰지 않고 반환만 한다. (실제 적용은 Live2DStage의 레이어 합성이 전담)
// 모션은 모델마다 의미가 다르므로 모델별로 명시 등록한 것만 재생한다.

const PARAMS_BY_TAG = {
  smile: {
    ParamMouthForm: 0.55,
    ParamMouthOpenY: 0.16,
    ParamBrowLY: 0.2,
    ParamBrowRY: 0.2,
    ParamEyeLSmile: 0.85,
    ParamEyeRSmile: 0.85,
    ParamCheek: 0.25,
  },
  neutral: {
    ParamMouthOpenY: 0.04,
    ParamMouthForm: 0,
    ParamEyeLSmile: 0,
    ParamEyeRSmile: 0,
    ParamCheek: 0,
    ParamBrowLY: 0,
    ParamBrowRY: 0,
  },
  think: {
    ParamAngleZ: -5,
    ParamEyeLOpen: 0.65,
    ParamEyeROpen: 0.65,
    ParamBrowLY: -0.35,
    ParamBrowRY: -0.35,
    ParamMouthForm: -0.15,
    ParamMouthOpenY: 0.06,
  },
  cheer: {
    ParamMouthForm: 0.65,
    ParamMouthOpenY: 0.26,
    ParamBrowLY: 0.45,
    ParamBrowRY: 0.45,
    ParamEyeLSmile: 0.9,
    ParamEyeRSmile: 0.9,
    ParamCheek: 0.45,
  },
  sad: {
    ParamAngleZ: 4,
    ParamEyeLOpen: 0.45,
    ParamEyeROpen: 0.45,
    ParamBrowLY: -0.5,
    ParamBrowRY: -0.5,
    ParamMouthForm: -0.35,
    ParamMouthOpenY: 0.05,
  },
  wink: {
    ParamEyeLOpen: 1,
    ParamEyeLSmile: 0.6,
    ParamEyeROpen: 0.02,
    ParamEyeRSmile: 1,
    ParamMouthForm: 0.45,
    ParamMouthOpenY: 0.12,
    ParamCheek: 0.35,
    ParamAngleZ: 2,
  },
  love: {
    ParamEyeLOpen: 0.85,
    ParamEyeROpen: 0.85,
    ParamEyeLSmile: 0.95,
    ParamEyeRSmile: 0.95,
    ParamMouthOpenY: 0.2,
    ParamMouthForm: 0.65,
    ParamBrowLY: 0.45,
    ParamBrowRY: 0.45,
    ParamCheek: 0.55,
    ParamAngleZ: -3,
  },
  // 상황별 태그 매핑
  focus: { ParamEyeLOpen: 0.88, ParamEyeROpen: 0.88, ParamBrowLY: -0.25, ParamBrowRY: -0.25, ParamMouthForm: 0.1, ParamMouthOpenY: 0.02 },
  proud: { ParamMouthForm: 0.6, ParamBrowLY: 0.35, ParamBrowRY: 0.35, ParamAngleY: -6, ParamAngleZ: -5, ParamMouthOpenY: 0.1 },
  fighting: { ParamMouthForm: 0.5, ParamMouthOpenY: 0.25, ParamBrowLY: 0.4, ParamBrowRY: 0.4, ParamCheek: 0.35, ParamEyeLOpen: 1.15, ParamEyeROpen: 1.15 },
  shy: { ParamCheek: 0.65, ParamAngleX: 16, ParamAngleY: 8, ParamAngleZ: -5, ParamEyeLOpen: 0.55, ParamEyeROpen: 0.55, ParamMouthForm: 0.25, ParamMouthOpenY: 0.06 },
  panic: { ParamEyeLOpen: 1.25, ParamEyeROpen: 1.25, ParamBrowLY: 0.7, ParamBrowRY: 0.7, ParamMouthOpenY: 0.3, ParamMouthForm: -0.3 },
  curious: { ParamAngleZ: 14, ParamAngleX: -7, ParamEyeLOpen: 1.08, ParamEyeROpen: 0.95, ParamBrowLY: 0.25, ParamBrowRY: -0.15, ParamMouthOpenY: 0.12, ParamMouthForm: 0.15 },
  dozeoff: { ParamAngleY: 16, ParamEyeLOpen: 0.1, ParamEyeROpen: 0.1, ParamBodyAngleY: 6, ParamMouthOpenY: 0.05 },
  relieved: { ParamAngleY: 8, ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7, ParamMouthForm: 0.35, ParamMouthOpenY: 0.06, ParamBrowLY: 0.1, ParamBrowRY: 0.1 },
  pout: { ParamAngleX: -22, ParamAngleZ: -7, ParamMouthForm: -0.5, ParamBrowLY: -0.35, ParamBrowRY: -0.35, ParamEyeLOpen: 0.65, ParamEyeROpen: 0.65, ParamCheek: 0.25 },
  whisper: { ParamAngleZ: -10, ParamAngleX: 12, ParamEyeLOpen: 0.85, ParamEyeROpen: 0.1, ParamMouthOpenY: 0.08, ParamMouthForm: 0.35 },
  sparkle: { ParamEyeLOpen: 1.25, ParamEyeROpen: 1.25, ParamBrowLY: 0.5, ParamBrowRY: 0.5, ParamCheek: 0.45, ParamMouthForm: 0.6, ParamMouthOpenY: 0.2 },
  spaceout: { ParamAngleY: -8, ParamEyeLOpen: 0.42, ParamEyeROpen: 0.42, ParamMouthOpenY: 0.12, ParamMouthForm: 0 },
};

// 모델별 감정/행동 모션. 없는 태그는 표정+파라미터로만 반응한다.
// (은랑 TapBody=변신, 센코 Tap/Taphead=10~36초 노래·수면처럼 대화가 끝난 뒤에도 남는 모션은 자동 재생 금지)
const MOTION_BY_MODEL = {
  haru: {
    smile: ['TapBody', 0], think: ['Idle', 0], cheer: ['TapBody', 0], sad: ['TapBody', 2],
    wink: ['TapBody', 1], love: ['TapBody', 1], focus: ['Idle', 1], proud: ['TapBody', 3],
    fighting: ['TapBody', 0], shy: ['TapBody', 1], panic: ['TapBody', 3], curious: ['TapBody', 0],
    dozeoff: ['Idle', 1], relieved: ['Idle', 0], pout: ['TapBody', 2], whisper: ['Idle', 0],
    sparkle: ['TapBody', 0], spaceout: ['Idle', 1], nod: ['TapBody', 0], shake: ['TapBody', 3],
    wave: ['TapBody', 0], clap: ['TapBody', 3], dance: ['TapBody', 1], explain: ['Idle', 0],
    surprise: ['TapBody', 0], joy: ['TapBody', 0], angry: ['TapBody', 2], sleepy: ['Idle', 1],
    wakeup: ['Idle', 0], greet: ['TapBody', 0],
  },
  hiyori_pro: {
    smile: ['Idle', 1], think: ['Idle', 0], cheer: ['FlickUp', 0], sad: ['FlickDown', 0],
    wink: ['Idle', 1], love: ['Idle', 1], focus: ['Idle', 2], proud: ['FlickUp', 0],
    fighting: ['FlickUp', 0], shy: ['Flick', 0], panic: ['Flick', 0], curious: ['Idle', 1],
    dozeoff: ['Idle', 2], relieved: ['Idle', 1], pout: ['FlickDown', 0], whisper: ['Idle', 1],
    sparkle: ['FlickUp', 0], spaceout: ['Idle', 2], nod: undefined, shake: undefined,
    wave: ['FlickUp', 0], clap: ['Tap@Body', 0], dance: ['FlickUp', 0], explain: ['Idle', 0],
    surprise: ['FlickUp', 0], joy: ['FlickUp', 0], angry: ['FlickDown', 0], sleepy: ['Idle', 2],
    wakeup: ['Idle', 0], greet: ['FlickUp', 0],
  },
  miku: {
    smile: ['Tap', 0], think: ['Idle', 0], cheer: ['Flick', 0], sad: ['Flick3', 0],
    wink: ['Tap', 1], love: ['Tap', 1], focus: ['Idle', 0], proud: ['Flick', 1],
    fighting: ['Flick', 0], shy: ['Tap', 2], panic: ['Flick', 2], curious: ['Tap', 0],
    dozeoff: ['Idle', 0], relieved: ['Idle', 0], pout: ['Flick', 2], whisper: ['Tap', 2],
    sparkle: ['Flick', 0], spaceout: ['Idle', 0], nod: ['Tap', 0], shake: ['Flick', 1],
    wave: ['Flick', 0], clap: ['Tap', 1], dance: ['Tap', 2], explain: ['Idle', 0],
    surprise: ['Flick', 0], joy: ['Flick', 0], angry: ['Flick', 2], sleepy: ['Idle', 0],
    wakeup: ['Tap', 0], greet: ['Tap', 0],
  },
  // 세코/은랑은 보유 모션이 노래(16s)·변신(안경 토글)·수면 같은 특수 동작뿐이라,
  // 의미가 맞는 경우에만 연결하고 나머지는 표정·파라미터 반응으로 남긴다.
  senko: {
    sleepy: ['Taphead', 1], dozeoff: ['Taphead', 1], spaceout: ['Taphead', 1],
    dance: ['Tap', 0],
  },
  yinlang: {
    sleepy: ['TapBody', 2], dozeoff: ['TapBody', 2],
  },
};

// 모델별 건드리기(탭) 모션. 루프/상태가 남는 모션은 넣지 않는다.
const TAP_MOTION_BY_MODEL = {
  haru: [['TapBody', undefined]],
  hiyori_pro: [['Tap', 0], ['Tap@Body', 0]],
  miku: [['Tap', undefined], ['Flick', undefined]],
  yinlang: [],
  senko: [],
};

// 모델별 쓰다듬기(펫) 모션. 탭(공격/놀람) 반응과 철저히 분리된 부드럽고 다정한 모션.
const PET_MOTION_BY_MODEL = {
  haru: [['Idle', 0]],
  hiyori_pro: [['Idle', 1]], // m02: 고개를 살포시 기울이며 다정하게 미소 짓는 모션
  miku: [['Idle', 0]],
  yinlang: [],
  senko: [],
};

// 모델별 축하(더블클릭) 모션.
const CELEBRATE_MOTION_BY_MODEL = {
  haru: [['TapBody', 0]],
  hiyori_pro: [['FlickUp', 0], ['Tap', 0]],
  miku: [['Flick', 0], ['Tap', 0]],
  yinlang: [],
  senko: [],
};

// Cubism 3/4 표준 파라미터 ID ↔ Cubism 2 레거시 파라미터 ID 매핑 (Miku 등 대응)
export const PARAM_LEGACY_MAP = {
  ParamAngleX: 'PARAM_ANGLE_X',
  ParamAngleY: 'PARAM_ANGLE_Y',
  ParamAngleZ: 'PARAM_ANGLE_Z',
  ParamEyeLOpen: 'PARAM_EYE_L_OPEN',
  ParamEyeROpen: 'PARAM_EYE_R_OPEN',
  ParamEyeLSmile: 'PARAM_EYE_L_SMILE',
  ParamEyeRSmile: 'PARAM_EYE_R_SMILE',
  ParamEyeBallX: 'PARAM_EYE_BALL_X',
  ParamEyeBallY: 'PARAM_EYE_BALL_Y',
  ParamBrowLY: 'PARAM_BROW_L_Y',
  ParamBrowRY: 'PARAM_BROW_R_Y',
  ParamBrowLX: 'PARAM_BROW_L_X',
  ParamBrowRX: 'PARAM_BROW_R_X',
  ParamBrowLAngle: 'PARAM_BROW_L_ANGLE',
  ParamBrowRAngle: 'PARAM_BROW_R_ANGLE',
  ParamBrowLForm: 'PARAM_BROW_L_FORM',
  ParamBrowRForm: 'PARAM_BROW_R_FORM',
  ParamMouthForm: 'PARAM_MOUTH_FORM',
  ParamMouthOpenY: 'PARAM_MOUTH_OPEN_Y',
  ParamCheek: 'PARAM_CHEEK',
  ParamBodyAngleX: 'PARAM_BODY_ANGLE_X',
  ParamBodyAngleY: 'PARAM_BODY_ANGLE_Y',
  ParamBodyAngleZ: 'PARAM_BODY_ANGLE_Z',
  ParamBreath: 'PARAM_BREATH',
};

export const EMOTION_TAGS = Object.keys(PARAMS_BY_TAG);

// 표정 정의는 없지만 상황 모션으로 응답하는 행동 태그 (서버 VALID_EMOTIONS와 동일하게 맞춰야 한다)
export const ACTION_TAGS = ['nod', 'shake', 'wave', 'clap', 'dance', 'explain', 'surprise', 'joy', 'angry', 'sleepy', 'wakeup', 'greet'];

function motionGroupCount(model, group) {
  try {
    const defs = model.internalModel?.motionManager?.definitions;
    return defs?.[group]?.length ?? 0;
  } catch {
    return 0;
  }
}

function modelKey(modelId) {
  const key = (modelId || '').toLowerCase();
  if (MOTION_BY_MODEL[key]) return key;
  if (key.includes('hiyori')) return 'hiyori_pro';
  if (key.includes('miku')) return 'miku';
  if (key.includes('yinlang') || key.includes('silverwolf')) return 'yinlang';
  if (key.includes('senko')) return 'senko';
  if (key.includes('haru')) return 'haru';
  return null;
}

// 재생 요청. FORCE여도 SDK가 페이드 인/아웃으로 크로스페이드한다.
function requestMotion(model, group, index) {
  if (!model || !group) return false;
  if (motionGroupCount(model, group) === 0) return false;
  try {
    const r = model.motion(group, index ?? undefined, 3);
    if (r?.catch) r.catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export function playMotion(model, tag, modelId = null) {
  const key = modelKey(modelId);
  const pick = key && MOTION_BY_MODEL[key]?.[tag];
  if (!pick) return false;
  return requestMotion(model, pick[0], pick[1]);
}

// 진행 중인 모션을 세운다. 새 반응 시작 시 호출해 이전 모션이 남는 것을 막는다.
export function cancelMotions(model) {
  try { model?.internalModel?.motionManager?.stopAllMotions(); } catch { /* noop */ }
}

// 모델별 모션/표정 동작 옵션. 로드 직후 1회 적용한다.
export function configureMotionModel(model, modelId) {
  if (!model) return;
  // 모션 시작 시 표정이 초기화되는 것을 막아 감정 표현이 유지되게 한다.
  const cfg = window.PIXI?.live2d?.config;
  if (cfg) {
    cfg.preserveExpressionOnMotion = true;
    cfg.motionFadingDuration = 600;     // 기본 모션 페이드 시간 600ms
    cfg.idleMotionFadingDuration = 800; // 유휴 모션 페이드 시간 800ms (기본 2초의 늘어짐 해소)
    if (cfg.cubism4) cfg.cubism4.setOpacityFromMotion = true;
  }

  // Cubism 4 모션 매니저 크로스페이드 패치:
  // 기본 Cubism4MotionManager._startMotion은 queueManager.stopAllMotions()를 호출하여 이전 모션을 즉시 삭제함.
  // 이로 인해 동작 전환 시 뚝 끊기는 현상이 발생하므로, stopAllMotions() 없이 startMotion의 setFadeOut으로 부드럽게 크로스페이드하도록 변경.
  const mm = model.internalModel?.motionManager;
  if (mm && typeof mm._startMotion === 'function') {
    mm._startMotion = function(motion, onFinish) {
      motion.setFinishedMotionHandler(onFinish);
      return this.queueManager.startMotion(motion, false, performance.now());
    };
  }

  // 자동 Idle이 수면/특수 모션을 골라 반복하는 것을 막는다.
  const defs = model.internalModel?.motionManager?.definitions;
  if (defs?.Idle && modelKey(modelId) === 'yinlang') {
    const safe = defs.Idle.filter((d) => !/sleep/i.test(d?.File || ''));
    if (safe.length) defs.Idle = safe;
  }
}

// 건드리기(놀리기) 반응용 모션
export function playTapMotion(model, modelId = null) {
  if (!model) return false;
  const key = modelKey(modelId);
  const candidates = (key && TAP_MOTION_BY_MODEL[key]) || [['TapBody', undefined], ['Tap', undefined], ['Flick', undefined]];
  for (const [group, index] of candidates) {
    if (requestMotion(model, group, index)) return true;
  }
  return false;
}

// 표정+파라미터만 적용한다. 모션은 반응(레이어) 시작 후에 스테이지가 별도로 요청한다.
export function softEmotion(model, tag, modelId = null) {
  const params = PARAMS_BY_TAG[tag] || PARAMS_BY_TAG.smile;
  applyExpression(model, tag, modelId);
  return params;
}

// 모델별 표정(expression) 매핑. 표정 파일 의미를 아는 것만 등록.
// 미등록 태그는 기본 표정으로 되돌려 이전 감정이 남지 않게 한다.
const EXPRESSION_BY_MODEL = {
  yinlang: {
    smile: ['e05'],
    love: ['e02'],
    cheer: ['e07'],
    sad: ['e08'],
    fighting: ['e07'],
    proud: ['e07'],
    shy: ['e02'],
    panic: ['e08'],
    relieved: ['e05'],
    whisper: ['e05'],
    sparkle: ['e07'],
  },
  haru: {
    smile: ['f00', 'f04'],
    love: ['f06'],
    cheer: ['f04'],
    sad: ['f03'],
    think: ['f07'],
    wink: ['f00'],
    neutral: ['f00'],
    focus: ['f07'],
    proud: ['f01'],
    fighting: ['f04', 'f01'],
    shy: ['f06'],
    panic: ['f05'],
    curious: ['f00'],
    dozeoff: ['f00'],
    relieved: ['f04'],
    pout: ['f02', 'f03'],
    whisper: ['f00'],
    sparkle: ['f05'],
    spaceout: ['f00'],
  },
};

function applyExpression(model, tag, modelId) {
  if (!model || typeof model.expression !== 'function') return;
  const key = modelKey(modelId);
  const names = key && EXPRESSION_BY_MODEL[key]?.[tag];
  const wanted = names?.[0] ?? null;
  if (wanted && model._appliedExpression === wanted) return;
  model._appliedExpression = wanted;
  if (!wanted) {
    try { model.internalModel?.motionManager?.expressionManager?.resetExpression(); } catch { /* noop */ }
    return;
  }
  try {
    const r = model.expression(wanted);
    if (r?.then) r.then((ok) => { if (!ok) model._appliedExpression = null; }).catch(() => { model._appliedExpression = null; });
  } catch {
    model._appliedExpression = null;
  }
}

// 쓰다듬기 반응용 모션 (다정한 유휴 모션 활용)
export function playPetMotion(model, modelId = null) {
  if (!model) return false;
  const key = modelKey(modelId);
  const candidates = (key && PET_MOTION_BY_MODEL[key]) || [];
  for (const [group, index] of candidates) {
    if (requestMotion(model, group, index)) return true;
  }
  return false;
}

// 축하(더블클릭) 반응용 모션: 우선순위 3(FORCE) 적용
export function playCelebrateMotion(model, modelId = null) {
  if (!model) return false;
  const key = modelKey(modelId);
  const candidates = (key && CELEBRATE_MOTION_BY_MODEL[key]) || [['TapBody', 0], ['Tap', 0], ['Flick', 0]];
  for (const [group, index] of candidates) {
    if (requestMotion(model, group, index)) return true;
  }
  return false;
}