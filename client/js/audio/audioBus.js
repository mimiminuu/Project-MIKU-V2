// 공유 오디오 컨텍스트 / 시그널 라우팅.
// - voiceBus: TTS 재생 오디오만 연결 → 립싱크용 AnalyserNode
// - micGain: 마이크 입력 덕킹 노드 (TTS 재생 중 0으로 감쇠)
let ctx = null;
let voiceBus = null;
let voiceAnalyser = null;
let micGain = null;
let lipListeners = [];

export function getContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

// 사용자 제스처(클릭) 시 컨텍스트 재개
export function ensureResumed() {
  const c = getContext();
  if (c.state === 'suspended') c.resume();
}

function initRouting() {
  if (voiceBus) return;
  const c = getContext();
  voiceBus = c.createGain();
  voiceAnalyser = c.createAnalyser();
  voiceAnalyser.fftSize = 512;
  voiceAnalyser.smoothingTimeConstant = 0.25;
  voiceBus.connect(voiceAnalyser);
  voiceBus.connect(c.destination);

  micGain = c.createGain();
  micGain.gain.value = 1;

  // 시간영역 RMS 기반 음량 계산 (단일 톤/짧은 발화 및 자모음 변화에 민첩하게 반응)
  const domain = new Float32Array(voiceAnalyser.fftSize);
  let smooth = 0;
  const loop = () => {
    voiceAnalyser.getFloatTimeDomainData(domain);
    let sumSq = 0;
    for (let i = 0; i < domain.length; i++) {
      const t = domain[i];
      sumSq += t * t;
    }
    const rms = Math.sqrt(sumSq / domain.length); // 0..~0.707
    // 미세 노이즈 게이트 + 음성 영역 감도 확장
    const gate = Math.max(0, rms - 0.005);
    const vol = Math.min(1, Math.pow(gate * 7.5, 0.82));
    // 어택(빠른 개방) + 릴리즈(자연스러운 폐쇄)
    if (vol > smooth) {
      smooth = smooth * 0.35 + vol * 0.65;
    } else {
      smooth = smooth * 0.72 + vol * 0.28;
    }
    const finalVol = smooth < 0.008 ? 0 : smooth;
    for (const fn of lipListeners) fn(finalVol);
    requestAnimationFrame(loop);
  };
  loop();
}

export function getVoiceBus() {
  initRouting();
  return voiceBus;
}

export function getMicGain() {
  initRouting();
  return micGain;
}

export function getVoiceAnalyser() {
  initRouting();
  return voiceAnalyser;
}

export function onLipVolume(fn) {
  initRouting();
  lipListeners.push(fn);
}

// --- 음성 간섭 방지: TTS 재생 중 마이크 입력 일시 차단 ---
export function setMicBlocked(blocked) {
  initRouting();
  micGain.gain.setTargetAtTime(blocked ? 0 : 1, getContext().currentTime, 0.03);
}

export function getMicBlocked() {
  return micGain ? micGain.gain.value < 0.5 : false;
}

// --- 마스터 음량(TTS) 조절 (0.0 ~ 1.0) ---
export function setMasterVolume(val) {
  initRouting();
  const clamped = Math.max(0, Math.min(1, Number(val)));
  voiceBus.gain.setTargetAtTime(clamped, getContext().currentTime, 0.02);
}

export function getMasterVolume() {
  initRouting();
  return voiceBus.gain.value;
}