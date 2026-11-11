// MIKU 시스템 공용 도구 스키마 정의 (OpenAI / Ollama 호환 규격)
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '사용자가 첨부하거나 업로드한 학습 자료(PDF, TXT, MD 파일)의 문제, 지문, 본문 내용을 직접 읽어올 때 호출합니다. 특정 페이지(예: 5쪽)나 페이지 범위(예: 5~7쪽)를 지정하여 읽을 때도 반드시 호출합니다.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: '읽을 파일의 이름 또는 키워드 (예: "모의고사", "학습자료.pdf")',
          },
          page: {
            type: 'number',
            description: '읽기 시작할 페이지 번호 (기본값: 1, 예: 5쪽이면 5)',
          },
          maxPages: {
            type: 'number',
            description: '연속으로 읽을 페이지 수 (기본값: 1, 예: 5~7쪽이면 page: 5, maxPages: 3)',
          },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '최신 정보, 뉴스, 사건/사고, 인물/작품 정보, 사실 관계 확인, 또는 사용자가 "검색해봐", "찾아봐", "인터넷에서 알아봐", "~에 대해 알려줘"라고 요청할 때 반드시 호출합니다. 모르는 내용이나 불확실한 사실은 지레짐작하지 말고 반드시 이 도구로 검색해야 합니다.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '검색할 키워드 또는 검색 질의어 (핵심 단어 위주로 간결하게 지정)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'python_execute',
      description: 'Python 코드를 실행하거나 계산, 데이터 분석, 시뮬레이션, matplotlib 그래프를 생성할 때 호출합니다. 사용자가 "파이썬 불러봐", "파이썬 실행해", "파이썬 켜봐", "코드 실행해줘", "파이썬 테스트"라고 요청하면 반드시 이 도구를 호출하여 Python 코드를 실행해야 합니다. 코드가 주어지지 않은 경우 간단한 Python 테스트 코드나 버전 확인, 또는 사용자가 요청한 내용의 코드를 스스로 작성하여 실행하세요.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: '실행할 파이썬 코드 (그래프는 matplotlib.pyplot 사용)',
          },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: '사칙연산, 거듭제곱, 삼각함수, 원의 넓이 등 정밀한 수치 계산이 필요한 경우 호출합니다.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '계산할 수식 (예: 348 * 79, pi * 6^2, 2^10)',
          },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_explanation',
      description: '개념 정리, 원리 해설, 공식 유도, 핵심 요약 등 사용자가 개념을 물어보거나 설명을 원할 때 반드시 호출하여 화면 우측 칠판(설명 패널)에 시각적 정리 자료를 띄웁니다.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '설명 패널 제목',
          },
          content: {
            type: 'string',
            description: '마크다운 형식의 설명 본문',
          },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_explanation',
      description: '화면 우측의 칠판(설명 패널)을 닫을 때 호출합니다.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_rag',
      description: '업로드된 학습 자료에서 내용을 검색할 때 호출합니다.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '검색할 키워드',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_goal',
      description: '오늘의 학습 목표를 설정하거나 갱신할 때 호출합니다.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '학습 목표 내용',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_quiz',
      description: '사용자가 퀴즈, 쪽지시험, 문제 내줘/문제 풀기, 이해도 점검을 원할 때 호출합니다. 1~5개의 4지선다형 문제와 해설을 생성하여 사용자가 화면에서 버튼을 눌러 직접 풀 수 있는 인터랙티브 퀴즈를 출제합니다.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: '퀴즈 출제 주제 (예: "한국 근현대사", "광합성과 호흡", "영단어 어휘")',
          },
          questions: {
            type: 'array',
            description: '4지선다형 퀴즈 문제 목록 (1~5개)',
            items: {
              type: 'object',
              properties: {
                q: { type: 'string', description: '문제 지문' },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '4개의 보기 선택지 목록',
                },
                ans: { type: 'number', description: '정답 인덱스 (0, 1, 2, 3 중 하나)' },
                exp: { type: 'string', description: '정답 해설 및 설명' },
              },
              required: ['q', 'options', 'ans', 'exp'],
            },
          },
        },
        required: ['topic', 'questions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_flashcards',
      description: '사용자가 암기 카드, 플래시카드, 단어장, 핵심 요약 정리를 요청할 때 호출합니다. 3D 암기 카드 모달에 플래시카드를 생성합니다.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: '암기 카드 주제',
          },
          cards: {
            type: 'array',
            description: '플래시카드 목록 (3~6개)',
            items: {
              type: 'object',
              properties: {
                q: { type: 'string', description: '앞면: 핵심 용어, 공식 또는 질문' },
                a: { type: 'string', description: '뒷면: 정의, 해설 또는 핵심 암기 내용' },
              },
              required: ['q', 'a'],
            },
          },
        },
        required: ['topic', 'cards'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_study_timer',
      description: '집중 타이머(뽀모도로 타이머, 공부 시간 측정)를 시작하거나 설정할 때 호출합니다.',
      parameters: {
        type: 'object',
        properties: {
          minutes: {
            type: 'number',
            description: '타이머 시간 (분 단위, 기본 25분)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plot_function_graph',
      description: '수학 함수 그래프 시각화를 요청받았을 때 인터랙티브 캔버스에 2D 그래프를 그릴 때 호출합니다.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '그릴 수학 함수식 (예: "x^2 - 4", "sin(x)", "2*x + 1", "abs(x)")',
          },
        },
        required: ['expression'],
      },
    },
  },
];
