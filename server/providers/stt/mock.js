// STT mock: 서버 측 실시간 인식 파이프가 아직 미구현이므로,
// dev 모드에서는 클라이언트(브라우저)의 Web Speech API가 인식을 담당합니다.
// 이 파일은 인터페이스 자리만 유지합니다.
import { STTProvider } from './index.js';

export class MockSTTProvider extends STTProvider {
  async init() {}
}