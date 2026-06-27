'use strict';

// 수집 소스·임계값·중복제거·관심사를 한 곳에 모은다(소스 설정 외부화).
// 코드 수정 없이 이 파일만 고쳐 소스를 늘리거나 필터를 바꿀 수 있다.

module.exports = {
  // 섹션별 노출 항목 수
  counts: {
    yozm: 5,
    github: 5,
    marketNews: 4,
    globalNews: 3,
    realEstate: 4,
    hnReddit: 4,
    telegram: 8,
  },

  // 한국경제 RSS 피드
  feeds: {
    marketNews: 'https://www.hankyung.com/feed/finance',
    globalNews: 'https://www.hankyung.com/feed/international',
    realEstate: 'https://www.hankyung.com/feed/realestate',
  },

  // 미국 증시 관련 뉴스 필터(국제 피드에서 시장 글만 추림)
  usMarketKeywords: [
    '뉴욕증시', '나스닥', 'S&P', '다우', '월가', '월스트리트', '연준', '연은', 'Fed', 'FOMC',
    '금리', '인플레', '국채', '달러', '위안화', '엔화', '환율', '증시', '주가', '스테이블코인',
    '펀드', '마진', '관세', '반도체', '엔비디아', '마이크론', '상장', 'IPO',
  ],

  // 해외 IT 커뮤니티 소스 (코드 랭킹: 인기·시간감쇠 + 관심 가중)
  hackerNews: { fetch: 30 }, // Algolia front_page 에서 가져올 후보 수
  // Reddit 공개 JSON 은 OAuth 없이는 대부분 403(데이터센터/봇 차단)이라 기본 비활성.
  // 사용하려면 subreddits 를 채우고 OAuth 토큰 방식으로 확장해야 한다(현재는 HN 만으로 섹션 구성).
  reddit: { subreddits: [], perSub: 12 },

  // 구독 텔레그램 채널 allow/deny (제목 부분일치, 대소문자 무시).
  // allow 가 비어 있으면 전체 허용. deny 는 항상 제외(allow 보다 우선).
  telegramChannels: {
    allow: [],
    deny: ['묻따방'],
  },

  // LLM 중요도 점수(0~10) 임계값 — 이 미만 항목은 제외(조용한 날엔 적게 노출).
  scoreThreshold: 6,

  // 관심 키워드 — 매칭 시 랭킹 점수에 가중(양질 신호 강화) + LLM 프롬프트에 전달.
  interests: ['AI', 'LLM', '에이전트', 'agent', '반도체', 'GPU', '금리', '환율', '부동산', '실적'],

  // 중복 제거: 최근 N일 내 이미 보낸 URL 은 다시 보내지 않는다.
  dedupWindowDays: 5,
  // 근접 중복(같은 사건 여러 소스) 제거 임계값(제목 토큰 Jaccard 유사도). 교차일에도 적용.
  nearDupThreshold: 0.6,

  // 피드백 루프(P1): 평가 버튼 최대 항목 수, 학습 가중 감쇠(매 반영 시 ×decay 로 옛 신호 약화).
  feedback: { enabled: true, maxItems: 12, decay: 0.9 },

  // 주간 리캡(P2): 카테고리별 상위 N개, 집계 윈도우(일).
  weekly: { topPerCategory: 7, windowDays: 7 },
};
