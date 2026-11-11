# GPT-SoVITS 캐릭터 참조 음성 (Reference Voice) 안내

여기에 5~10초 길이의 깨끗한 캐릭터 음성 파일(`.wav`)을 배치하면, Live2D 아바타별로 해당 음색과 억양을 복제하여 고품질 TTS로 발화합니다.

## 파일 배치 규격
- `miku.wav`: 하츠네 미쿠 음색
- `senko.wav`: 센코 음색
- `haru.wav`: 하루 음색
- `hiyori.wav`: 히요리 음색
- `yinlang.wav`: 은랑 음색
- `default.wav`: 기본 공용 음색

> **권장 음성 조건**:
> - 포맷: 16-bit PCM WAV (샘플레이트 24kHz, 32kHz, 44.1kHz, 48kHz 모두 지원)
> - 길이: 3초 ~ 10초 사이 (너무 길면 추론 시간이 늘어납니다)
> - 배경 음악(BGM)이나 잡음이 없는 또렷한 목소리
