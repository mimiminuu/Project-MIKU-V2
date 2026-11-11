# AI 컴페니언 아키텍처

학습용 친근한 어시스턴트 + 커스텀 Live2D 아바타.
LLM/STT/TTS는 **Provider 인터페이스**로 분리되어 있으며, 기본값으로 Ollama(LLM) · Gemini 3.8 Flash TTS · Whisper(STT)가 활성화되어 있습니다.
프로바이더 로드/연결 실패 시 자동으로 mock으로 폴백하므로 서버는 항상 기동됩니다. Gemini TTS는 `GEMINI_API_KEY`가 필요하며, 키가 없으면 Edge TTS로 폴백합니다.

## 구조

```
server/                        # Node.js (Express + ws)
├── index.js                   # 정적 서빙 + 업로드 API + 엔트리
├── config.js                  # 환경 설정 (.env)
├── ws/hub.js                  # WebSocket 라우팅
├── core/sessions.js           # 세션 ID 검증(경로 조작 방지) + 세션별 장기 기억 캐시
├── core/sentenceChunker.js    # 구두점(.!?) 기준 청크 + 타임아웃 플러시
├── core/pipeline.js           # LLM 스트림 → 청크 → TTS 큐 → 클라이언트
├── providers/                 # LLM / TTS / STT / Embedding 인터페이스 + 구현
├── memory/                    # 단기 기억, 장기 기억(망각 알고리즘), 컨텍스트 빌더
└── rag/                       # 인제스트(PDF/청크) + Chroma 검색

client/                        # 순수 HTML/JS (빌드 도구 불필요)
├── vendor/                    # pixi.min.js, cubism4.min.js, live2dcubismcore.min.js
├── assets/models/live2d/      # 샘플 Live2D 모델 (setup-sample-model로 다운로드)
└── js/
    ├── app.js                 # 오케스트레이션
    ├── audio/                 # 오디오 컨텍스트, TTS 재생 큐, 마이크(게이트)
    └── avatar/                # PIXI 스테이지, 감정-표정 매핑, 립싱크
```

## 실행

1. `npm install` (샘플 모델 + vendor 자동 준비)
2. (선택, RAG용) `pip install chromadb` 후 `npm run chroma` — 현재 chromadb 1.5.9 설치 완료
3. `npm start` → http://localhost:25565
4. 테스트: `npm test`(유닛) / `npm run e2e`(서버 실행 상태에서 WS 검증)

> **원클릭 실행: `server start.bat`** — 앱 서버(25565)와 Chroma DB(8000)를 함께 기동하고,
> 종료 시 함께 정리합니다(이 세션이 연 Chroma만 종료). 종료는 Ctrl+C 후 **N** 을 눌러 정리 구간을 통과하면 됩니다.

## 파이프라인

```
음성(마이크) ──▶ 마이크 PCM(16kHz Int16) ──WS 바이너리──▶ 서버 Whisper ──▶ user_text
              └──(mock STT / 미지원 브라우저)──▶ Web Speech API ──▶ user_text (WS)
                                   ▼
[단기 기억]  [장기 기억 recall]   [RAG 검색 ─ Chroma]
              └─────────────┴──────────┴──▶ system prompt
                                   ▼
                            LLM.streamChat ──▶ 감정 태그 파싱 [smile] 등
                                   ▼
                        SentenceChunker(구두점 절단) ──▶ TTS 큐(순차)
                                   ▼
         WS: emotion / assistant_text_partial / tts_meta+오디오(바이너리)
                                   ▼
   클라이언트: 아바타 표정 + 립싱크 + 재생 (재생 중 마이크 게이트)
```

- **첫 발화 지연 최소화:** 청크 미완성 문장은 1.2초 타임아웃으로 강제 플러시.
- **음성 간섭 방지:** TTS 재생이 실제로 시작/종료되는 순간 마이크 입력 게인 0 + 음성인식 중지.

## 메모리 & 망각

- 장기 기억 항목: `{ type, content, importance, accessCount, lastAccessAt, mastered }`
- 검색 점수:
  `(관련도×1.5 + 중요도/5) × 망각감쇠(1/(1+경과일/7)) × (마스터 시 0.25)`
- 저장: JSON 파일(`server/store/memory.db`) - 원자적 쓰기(tmp+rename)

## Provider 교체 (LLM/STT/TTS 확정 시)

```
server/providers/llm/openai.js     →  export class ... extends LLMProvider { async *streamChat() }
server/providers/tts/gemini.js     →  Interactions API 호출 → WAV(24kHz mono 16-bit) 반환
server/providers/stt/whisper.js    →  extends STTProvider (실시간 스트리밍)
.env: LLM_PROVIDER=openai / TTS_PROVIDER=gemini / STT_PROVIDER=whisper
```

Gemini TTS 튜닝:
- `GEMINI_TTS_VOICE` — 프리빌트 30종(Leda, Aoede, Kore, Sulafat 등), 확장 보이스 라이브러리, 커스텀 보이스 ID
- `GEMINI_TTS_STYLE` — 문장 단위 `speech_metadata.style` 자연어 지시(감정·속도·볼륨). 예: `warm and enthusiastic`
- `GEMINI_TTS_MODEL` — `gemini-3.8-flash-tts`(표현력) / `gemini-3.8-flash-lite-tts`(경량)
- 피치/속도 수치 파라미터는 없습니다. 스타일 지시 또는 후처리로 제어합니다.
STT는 웹소켓 바이너리(마이크 PCM 16kHz Int16) → 서버 Whisper 인식 → `user_text` 구조로 구현되어 있습니다(`hub.js` 의 isBinary 분기).
서버는 에너지 기반 VAD로 침묵 800ms 를 감지해 발화를 절단하며, TTS 재생 시작 시 클라이언트가 `stt_reset` 을 보내 버퍼를 비웁니다.
클라이언트는 `GET /api/config` 로 서버 STT 사용 여부를 판단합니다.

## 아바타

- 렌더링: PIXI v6 + pixi-live2d-display 0.4.0 (호환 버전 고정)
- 모델: `client/assets/models/live2d/` 하위 폴더 구조 (레지스트리: `server/avatarModels.js`)
  - `haru/Haru.model3.json` — 기본 모델 (공식 샘플, 표정 8종 + 모션 다수)
  - `senko/senko.model3.json` — 폴백 모델 (로드 실패 시 자동 대체)
  - `yinlang/yinlang.model3.json` — 银狼 (모션 Idle/TapBody + 표정 13종 내장)
  - 새 모델 추가: 폴더 배치 후 `server/avatarModels.js` 의 `AVATAR_MODELS` 에 항목 추가
- 모델 전환: 스테이지 하단 선택 UI → `Live2DStage.switchModel(id)` → `POST /api/avatar-model`
  - 선택은 세션별 저장 (`memory_<sessionId>.db` 의 `avatar_model` 항목) — 다른 세션에 영향 없음
  - 미선택/무효 시 기본 모델(Haru)로 로딩. API: `GET /api/avatar-models`, `GET/POST /api/avatar-model`
- 감정 태그 → 모션/파라미터: `client/js/avatar/emotions.js`
  - 파라미터는 `beforeModelUpdate` 시점에 매 프레임 재적용 → Idle 모션에 덮어써지지 않음
- 립싱크: TTS 버스의 **시간영역 RMS** 음량 → `ParamMouthOpenY`
- 배치: 화면 중앙 맞춤 + 전체가 들어오는 스케일 (`_fit`, 하단 잘림 방지). 빈 공간 드래그로 이동(모델별 위치 기억),
  크기 슬라이더(30~250%, 1% 단위)/휠 줌(모델별 배율 기억), 🎯 버튼으로 위치+크기 초기화
- 인터랙션: 클릭=건드리기(Tap 모션), 모델 위 드래그=쓰다듬기(표정+하트+3회마다 모션),
  꾹 누르기(0.65초)=홀딩 반응, 더블클릭=축하(cheer+모션+하트). 은랑은 표정 파일(e01~)도 함께 전환

## 개발 계획 (로드맵 / 완료 현황)

| 단계 | 내용 | 상태 |
| --- | --- | --- |
| M1 | 스캐폴딩: package.json, 폴더 구조, config, `.env.example` | ✅ 완료 |
| M2 | 샘플 모델(Haru+Senko) 다운로드 & vendor(PIXI/Cubism) 준비 | ✅ 완료 |
| M3 | 백엔드: providers/mock, SentenceChunker, Pipeline, 메모리, 컨텍스트 | ✅ 완료 |
| M4 | RAG: 인제스트(PDF/TXT/MD) + Chroma 검색, 임베딩(로컬 transformers) | ✅ 완료 (chromadb 1.5.9) |
| M5 | 클라이언트 아바타: PIXI 스테이지, 감정 매핑, 립싱크, 폴백 로딩 | ✅ 완료 |
| M6 | 클라이언트 UI: 메인 채팅 + 기능별 독립 테스트 페이지(`/test.html`, Shift+T) | ✅ 완료 |
| M8 | 테스트 페이지 확장: ⑭ 모델 전환, ⑮ 위치/크기, ⑯ 인터랙션, ⑰ 아바타 API 검증, ⑱ 모션/표정 랩 | ✅ 완료 |
| M7 | 테스트: 유닛 4건 + E2E(WS) 9건 + 원클릭 실행 배치 | ✅ 완료 |

### 다음 단계 (예정)

- [x] 실서비스 Provider 교체: LLM(Ollama) / TTS(Edge TTS) / STT(Whisper) — openai, elevenlabs 등 추가 옵션은 인터페이스 그대로 확장 가능
- [x] 웹소켓 바이너리 오디오 → 서버 실시간 STT 루프 구현 (`hub.js` 의 isBinary 분기 — Whisper 통합 완료)
- [x] 세션 ID 화이트리스트 검증(경로 조작 방지) + 세션별 장기 기억 캐시 (`core/sessions.js`)
- [ ] 실제 학습 데이터/교과서 연동 시작 (업로드 대신 목차 기반 자동 인제스트)
- [ ] 아바타 감정 표현 품질 튜닝 (모션 우선순위, 표정 blend)
- [ ] 감정/음성 품질 튜닝, 하드웨어 가속 확인
- [ ] 모바일 반응형 및 배포(HTTPS, ws secure) 검토