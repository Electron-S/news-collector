# 뉴스 수집 에이전트 지시

뉴스 수집은 **코드(`collect.js`)로 수행**한다. LLM이 직접 웹을 읽어 제목·수치를
추정하지 말 것(환각 방지). 모든 데이터는 실제 소스에서 파싱된다.

## 실행 방법

가장 간단한 방법은 실행 스크립트 한 줄이다:

```bash
./run.sh
```

`run.sh` 는 다음을 순서대로 수행한다.

1. `node collect.js` — 아래 정보를 수집해 `reports/{오늘의 날짜}.md` 에 추기(append).
   - 같은 날짜 섹션이 이미 있으면 건너뛴다(중복 누적 방지). 재수집은 `node collect.js --force`.
   - 날짜·시각은 항상 `Asia/Seoul` 기준.
2. `node notify.js <리포트 경로>` — 작성된 리포트를 Telegram 으로 전송.

수동으로 단계를 나눠 실행할 수도 있다:

```bash
REPORT=$(node collect.js) && node notify.js "$REPORT"
```

## 수집 항목 (collect.js 가 처리)

각 기사에는 발행사가 제공하는 `og:description` 을 1행 요약으로 함께 붙인다(LLM 미사용).

### 기술 정보
- Velog 트렌드 상위 5개 + 1행 요약 (v3.velog.io GraphQL)
- 요즘IT 인기 기사 상위 5개 + 1행 요약 (yozm.wishket.com)
- GitHub Trending 당일 상위 5개 + repo 설명 (github.com/trending)

### 경제 정보
- 코스피/코스닥 지수: 현재값·전일 대비·등락률 (네이버 금융)
- USD/KRW 환율: 현재값 (open.er-api.com)
- 주요 마켓 뉴스 4건 (한국경제 증권 RSS, /feed/finance) — 헤드라인 자체가 요약

## 출력 포맷

- 리포트 상단(`## 실행:` 줄)에 「취득 시각」을 1회 기재(모든 소스를 동시에 수집하므로 섹션별 반복 생략 — 텔레그램 1메시지 분량 유지).
- 기사 제목과 URL을 세트로 출력.
- 마켓 뉴스는 1행(제목 링크)으로 기재.
- 취득 실패 시 `[취득 실패]` 로 표기(개별 섹션 단위로 실패해도 나머지는 정상 수집).

## 자동화

매일 자동 실행은 cron 으로 `run.sh` 를 등록한다(README 참고). Claude 세션이
떠 있을 필요가 없다.
