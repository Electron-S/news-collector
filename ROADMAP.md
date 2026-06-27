# 개선 로드맵

고star 뉴스 수집기([Horizon](https://github.com/Thysrael/Horizon) 7.4k, [auto-news](https://github.com/finaldie/auto-news) 887, [RSS-to-Telegram-Bot](https://github.com/Rongronggg9/RSS-to-Telegram-Bot) 2.1k, [FreshRSS](https://github.com/FreshRSS/FreshRSS)) 대비, 그리고 개인화 뉴스 추천 연구를 토대로 한 다음 단계.

## 완료 (현재 구현됨)
- IT/경제 2메시지 분할, 구독 채널(MTProto) 수집·분류·바로가기
- 미국 증시 지수·국제/부동산 뉴스, AI 점수 선별, 중복 제거(URL+제목 Jaccard)
- 관심 키워드 가중, HN 중력 랭킹, 설정 외부화(config.js), 실패 알림, 테스트/CI
- **✅ P1 피드백 루프** — 👍/👎 인라인 버튼 → `feedback.js`가 `state/weights.json` 학습 → 랭킹·프롬프트 반영
- **✅ P2 주간 리캡** — `weekly.js`(월요일), `state/history.jsonl` 집계
- **✅ P3 교차일 근접중복 제거** — seen 제목 보관 + Jaccard 교차일 비교(교차언어는 임베딩 필요, 후속)
- **✅ P6 시장 감성 태깅** — 채널 경제 항목 📈/📉/➖

---

## 우선순위 로드맵

### 🔴 P1 — 피드백 루프(개인화의 핵심 레버)
**무엇**: 텔레그램 인라인 버튼(👍/👎/🔖)을 각 항목에 붙이고, 반응을 `state/feedback.json`에 적재해
`config.interests` 가중치를 자동 조정(👍한 항목의 키워드 가중↑, 👎↓).
**왜**: 연구상 "관심 프로파일 + 암묵적 피드백"이 노이즈 감소의 핵심. 현재는 관심사가 수동 고정.
**근거 저장소**: Horizon(임계값·개인화), 협업 필터링 연구.
**노력**: 中(텔레그램 콜백 수신용 경량 webhook 또는 getUpdates 폴링 필요).
**관련**: `notify.js`(버튼), 신규 `feedback.js`(수신·반영), `lib/rank.js`(가중 반영).

### 🔴 P2 — 주간 리캡 (다주기 다이제스트)
**무엇**: 매주 월요일 "지난주 핵심 N개" 리캡 메시지. 한 주간 `seen.json`+점수 이력에서 상위 항목 집계.
**왜**: auto-news의 Weekly Top-k. 저비용·고효용(이미 쌓인 데이터 활용).
**노력**: 小. `seen.json`에 score·title 저장 확장 + `collect.js --weekly` 모드 + cron 1줄.

### 🟠 P3 — 교차일 의미 중복 제거(임베딩)
**무엇**: 현재 교차일 중복은 URL 완전일치만. 같은 사건이 다른 URL·다른 언어(EN HN ↔ KR 기사)로 오면 못 잡음.
임베딩 유사도(또는 LLM 판정)로 교차일·교차언어 근접중복 제거.
**왜**: 연구의 SimHash/임베딩 기반 near-dup. 신호 품질↑.
**노력**: 中. seen에 제목/임베딩 저장, 임계값 비교. 경량 시작은 제목 Jaccard를 교차일로 확대.

### 🟠 P4 — 깊이 보강: 핵심 기사 본문 요약 + 커뮤니티 댓글 요약
**무엇**: 각 카테고리 1위 기사의 본문을 fetch해 3줄 요약. HN 상위 토픽의 댓글 상위 의견 요약.
**왜**: Horizon의 "comment summaries"·"web-researched context". 헤드라인만 → 맥락 제공.
**노력**: 中. 본문 fetch(Readability류)+LLM 요약 1~2건으로 한정(비용 관리).

### 🟡 P5 — 소스 확장
- **Reddit OAuth**(현재 403로 비활성) — 등록 앱 토큰 방식으로 부활.
- **arXiv**(cs.AI/cs.LG 신착), **lobste.rs**, **Product Hunt**, 특정 기술 블로그 RSS.
- **국내**: 네이버 DataLab 트렌드, 디스콰이엇 등.
**노력**: 소스당 小. config.js에 소스 추가 패턴 이미 마련됨.

### 🟡 P6 — 시장 신호 태깅 (감성)
**무엇**: 마켓/채널 항목에 강세/약세/중립 태그(이모지)·한줄 코멘트.
**왜**: news-aggregator의 sentiment(-1~+1). 경제 메시지 가독성↑.
**노력**: 小. enrichTelegram/마켓뉴스 LLM 출력에 sentiment 필드 추가.

### 🟢 P7 — 운영·관측
- 성공 하트비트(주 1회 "정상 동작 중"), 구조화 로그, GitHub 요약 캐시(repo별 재사용으로 LLM 절감).
- 과거 리포트 정적 검색 페이지(FreshRSS full-text search의 경량판).

---

## 어떻게 "개선 거리"를 계속 찾을까 (측정 기반)
1. **반복 점검**: 같은 항목이 며칠째 보이면 → 중복제거 윈도우/near-dup 임계값 조정.
2. **노이즈 점검**: 임계값 통과했는데 가치 낮은 항목 비율 → `scoreThreshold`·프롬프트 보정.
3. **누락 점검**: 놓친 중요 뉴스 → 소스 부족 신호(P5).
4. **피드백 데이터**(P1 도입 후): 👎 많은 키워드·채널·소스 → 가중치/allow-deny 자동 반영.
5. 분기별로 고star 저장소 변경점(neue 기능) 재조사.

## 추천 착수 순서
**P2(주간 리캡, 즉효·저비용) → P1(피드백 루프, 개인화 핵심) → P3(의미 중복) → P4(깊이)** 순.
P5·P6·P7은 사이사이 소스/기능 단위로 점진 추가.
