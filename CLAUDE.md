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

## 설정 (config.js)

소스·개수·임계값·관심사·중복제거 윈도우를 **`config.js` 한 곳**에 모았다. 소스를 늘리거나
필터를 바꿀 땐 코드가 아니라 `config.js`만 수정한다(피드 URL, 섹션별 개수, 채널 allow/deny,
`scoreThreshold`, `interests`, `dedupWindowDays`, `nearDupThreshold`).

## 수집 항목 (collect.js 가 처리)

데이터 취득은 코드로(환각 없음), 보강(번역·선별·점수)만 LLM이 한다.
리포트는 **💻 IT/기술** 과 **📈 경제/투자** 두 카테고리(`### ` 헤더)로 나뉜다.

### 💻 IT/기술
- 인기 IT 기사 5개 (yozm.wishket.com) — LLM이 0~10 **중요도 점수**(AI·관심사 가중)로 선별, `scoreThreshold` 미만 제외
- GitHub Trending 5개 — 기능을 LLM이 한국어 1줄로 요약 (github.com/trending)
- 해외 IT 토픽 (Hacker News) — Algolia front_page 를 **중력점수**(인기·시간감쇠)+관심 가중으로 코드 랭킹(영문 제목, LLM 미사용). Reddit 은 OAuth 필요로 기본 비활성
- (TG 설정 시) 구독 채널 주요 소식 중 **IT/기술 분류** 메시지

### 📈 경제/투자
- 지난밤 미국 증시: S&P500·나스닥·다우 현재값·전일 대비·등락률 (네이버 해외지수 api.stock.naver.com) + 증시·금융 키워드로 거른 국제 뉴스 3건 (한국경제 /feed/international). 미 장 시작 전이면 등락이 0으로 와서 「전일 종가」로만 표기.
- 국내 지수(코스피/코스닥): 현재값·전일 대비·등락률 (네이버 금융)
- USD/KRW 환율: 현재값 (open.er-api.com)
- 주요 마켓 뉴스 4건 (한국경제 증권 RSS, /feed/finance) — 헤드라인 자체가 요약
- 부동산 뉴스 4건 (한국경제 RSS, /feed/realestate)
- (TG 설정 시) 구독 채널 주요 소식 중 **경제/투자 분류** 메시지

### 📨 구독 채널 주요 소식 (선택 — TG 설정 시에만)
- 내가 구독한 텔레그램 **채널**(broadcast)의 최근 메시지 중 중요한 것만 LLM이 선별·요약하고, 각 항목을 IT/경제로 분류해 **위 두 카테고리 메시지에 나눠 넣는다**(별도 메시지 아님). 요약 끝의 `바로가기` 링크는 해당 메시지 딥링크.
- 봇(`TELEGRAM_BOT_TOKEN`)이 아니라 **내 계정 세션(MTProto)** 으로 읽는다. `collect-telegram.js` 가 수집.
- 설정: `.env` 의 `TG_API_ID`/`TG_API_HASH`(my.telegram.org 발급) + `node tg-login.js` 1회 로그인으로 얻은 `TG_SESSION`. 미설정 시 이 소블록은 **자동 생략**.
- 그룹·슈퍼그룹·개인 대화는 제외(방향성 채널만). 범위는 `TG_HOURS`/`TG_PER_CHANNEL`/`TG_MAX_MESSAGES` 로 조정.

## LLM 보강 (enrich.js)

`claude -p`(헤드리스 Claude Code, 모델 `claude-sonnet-4-6`)를 호출해
① 요즘IT 후보에 0~10 중요도 점수를 매겨 정렬(관심사 가중),
② GitHub repo 설명을 한국어 1줄로 요약한다(①~②는 1회 호출).
③ (TG 설정 시) 구독 채널 메시지에 점수·요약·IT/경제 분류를 매긴다(`enrichTelegram`, 별도 1회 호출).
프롬프트는 **stdin 으로 전달**한다(긴 텔레그램 입력의 argv 한계·실패 방지).
LLM 호출이 실패하면 순수 코드로 폴백한다(원본 순서·GitHub 원문 설명·채널 최신 일부는 경제로).
모델은 `NEWS_LLM_MODEL` 환경변수로 바꿀 수 있다.

## 품질·신뢰성 장치

- **중복 제거(state/seen.json)**: 최근 `dedupWindowDays` 일 내 보낸 URL 은 다시 보내지 않는다. 같은 사건이 여러 소스/여러 날에 겹치면 제목 유사도(`nearDupThreshold`, Jaccard)로 **단일 실행 내 + 교차일** 근접 중복도 제거한다(P3). `state/` 는 git 비추적.
- **점수 임계값**: LLM 0~10 점수로 `scoreThreshold` 미만은 노출하지 않아 조용한 날엔 적게 나간다.
- **피드백 학습(P1, feedback.js)**: 매일 전송하는 '📊 평가' 메시지의 👍/👎 인라인 버튼을 `run.sh`가 collect 前 `feedback.js`(getUpdates 폴링)로 수거해 `state/weights.json`(키워드·소스 가중)을 갱신. 학습값은 HN 랭킹 가중(`interestBoost`)과 LLM 프롬프트(선호/비선호 주입)에 반영된다. 데몬이 아니라 **다음 실행 때 반영**(탭→이튿날). config.interests 파일은 불변.
- **주간 리캡(P2, weekly.js)**: `state/history.jsonl`(노출 항목 이력)에서 최근 `weekly.windowDays`일 상위 항목을 카테고리별로 모아 월요일 별도 전송(점수+피드백 가중 랭킹). 전송은 `notify.js` 재사용.
- **시장 감성(P6)**: 구독 채널 경제 항목에 LLM이 강세/약세/중립을 매겨 📈/📉/➖ 로 표기.
- **실패 알림**: 핵심 소스 실패 시 메시지 상단에 `⚠️ 일부 수집 실패: …` 표기. 수집 크래시·전송 실패 등 하드 실패는 `run.sh` 가 `alert.js` 로 텔레그램 관리자 알림을 보낸다.
- **테스트/CI**: 순수 함수 단위테스트(`node --test`, `test/unit.test.js`)와 GitHub Actions(`.github/workflows/ci.yml`)로 회귀를 막는다.

## 출력 포맷

- 리포트 상단(`## 실행:` 줄)에 「취득 시각」을 1회 기재(모든 소스를 동시에 수집하므로 섹션별 반복 생략).
- 본문은 `### 💻 IT/기술` / `### 📈 경제/투자` 2개 카테고리로 구성(구독 채널 소식은 각 카테고리 안에 `#### 📨` 소블록으로 포함). `notify.js` 가 `### ` 경계로 갈라 **메시지 2건**(IT → 경제 순)으로 전송하며, 한 파일에 실행 섹션이 여러 개면 **가장 최근 실행만** 보낸다.
- 기사 제목과 URL을 세트로 출력. 마켓·뉴스류는 1행(제목 링크)으로 기재.
- 취득 실패 시 `[취득 실패]` 로 표기(개별 섹션 단위로 실패해도 나머지는 정상 수집).

## 자동화

매일 자동 실행은 cron 으로 `run.sh` 를 등록한다(README 참고). 대화형 Claude 세션은
필요 없으나, LLM 보강을 위해 cron이 헤드리스 `claude -p` 를 호출하므로 `claude` CLI가
PATH(`~/.local/bin`)에 있고 로그인돼 있어야 한다.

주간 리캡은 별도 cron 으로 `weekly.js` 를 월요일에 등록한다(일일 08:30 과 비충돌하도록 09:00):
`0 9 * * 1 cd /home/cyyoo/develop/news-collector && node weekly.js >> reports/cron.log 2>&1`
