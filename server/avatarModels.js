// 아바타 모델 레지스트리: 클라이언트 선택 UI + 세션별 저장 검증에 사용.
// 새 모델 추가 시: 1) client/assets/models/live2d/<id>/xxx.model3.json 배치
//                 2) 아래 배열에 항목 추가 (id는 폴더명과 일치 권장)
import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from './config.js';

const SETTINGS_FILE = path.join(STORE_DIR, 'global_settings.json');
export const AVATAR_MODELS = [
  {
    id: 'haru',
    name: '하루',
    modelUrl: '/assets/models/live2d/haru/Haru.model3.json',
    thumbnail: '/assets/models/live2d/haru/Haru.2048/texture_00.png',
  },
];

export const DEFAULT_AVATAR_MODEL_ID = 'haru';

// 모델별 맞춤 TTS 음색 프리셋 (하루: 차분한 선생님 / 히요리: 발랄한 여고생 등)
export const AVATAR_VOICE_PRESETS = {
  haru: {
    voice: 'ko-KR-SunHiNeural',
    pitch: '+0Hz',
    rate: '-2%',
    desc: '차분하고 신뢰감 있는 선생님 스타일',
    supertonic: { voice: 'F1', speed: 1.0 },
  },
  hiyori_pro: {
    voice: 'ko-KR-SunHiNeural',
    pitch: '+16Hz',
    rate: '+8%',
    desc: '밝고 통통 튀는 여고생 친구 스타일',
    supertonic: { voice: 'F2', speed: 1.08 },
  },
  miku: {
    voice: 'ko-KR-SunHiNeural',
    pitch: '+22Hz',
    rate: '+10%',
    desc: '에너지 넘치는 밝은 친구 스타일',
    supertonic: { voice: 'F3', speed: 1.1 },
  },
  senko: {
    voice: 'ko-KR-SunHiNeural',
    pitch: '+6Hz',
    rate: '-4%',
    desc: '다정하고 포근한 힐링 스타일',
    supertonic: { voice: 'F4', speed: 0.96 },
  },
  yinlang: {
    voice: 'ko-KR-SunHiNeural',
    pitch: '-4Hz',
    rate: '+2%',
    desc: '쿨하고 나른한 게이머 스타일',
    supertonic: { voice: 'F5', speed: 1.04 },
  },
  default: {
    voice: 'ko-KR-SunHiNeural',
    pitch: '+0Hz',
    rate: '+0%',
    supertonic: { voice: 'F1', speed: 1.0 },
  },
};

export function getAvatarDisplayName(modelId) {
  const targetId = modelId === 'hiyori' ? 'hiyori_pro' : (modelId || DEFAULT_AVATAR_MODEL_ID);
  const model = getAvatarModel(targetId);
  if (!model) return '친구';
  return model.name.replace(/\s*\(.*?\)/, '').trim();
}

export function getVoicePreset(modelId) {
  const targetId = modelId === 'hiyori' ? 'hiyori_pro' : (modelId || 'haru');
  return AVATAR_VOICE_PRESETS[targetId] || AVATAR_VOICE_PRESETS.default;
}

export function getAvatarModel(id) {
  const targetId = id === 'hiyori' ? 'hiyori_pro' : id;
  return AVATAR_MODELS.find((m) => m.id === targetId) || null;
}

export function resolveAvatarModelId(id) {
  const targetId = id === 'hiyori' ? 'hiyori_pro' : id;
  return getAvatarModel(targetId)?.id || DEFAULT_AVATAR_MODEL_ID;
}

export function getGlobalAvatarModelId() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (data.avatarModelId) return resolveAvatarModelId(data.avatarModelId);
    }
  } catch {}
  return DEFAULT_AVATAR_MODEL_ID;
}

export function setGlobalAvatarModelId(modelId) {
  const resolved = resolveAvatarModelId(modelId);
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    let data = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      try { data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
    }
    data.avatarModelId = resolved;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
  return resolved;
}
