# news-collector

매일 기술·경제 뉴스를 **코드로 수집**하고 Telegram으로 알림을 보내는 도구.

수집은 `collect.js`가 실제 소스(API/RSS/HTML)에서 직접 파싱하므로 LLM 추정(환각)이 없고,
Claude 세션 없이 cron 만으로 자동 실행할 수 있다.

## 설정

```bash
cd ~/develop/news-collector
npm install
cp .env.example .env
# .env에 Telegram Bot Token과 Chat ID 입력
```

## 실행

```bash
./run.sh                 # 수집 → 알림 (한 번에)
```

또는 단계별:

```bash
node collect.js          # reports/{날짜}.md 에 추기, 경로를 stdout 으로 출력
node collect.js --force  # 같은 날짜 재수집(중복 가드 무시)
node notify.js reports/{날짜}.md           # Telegram 전송
node notify.js reports/{날짜}.md --dry-run # 전송 없이 변환 결과 미리보기
```

## 자동화 (cron)

매일 오전 8시 30분 실행 예시:

```cron
30 8 * * * cd /home/cyyoo/develop/news-collector && /usr/bin/env bash run.sh >> reports/cron.log 2>&1
```

> 시각은 서버 타임존 기준이다. KST가 아니라면 crontab 상단에 `CRON_TZ=Asia/Seoul` 을 추가하거나
> 시간을 보정한다. (리포트 내부 날짜·시각은 항상 KST로 기록된다.)

## 수집 항목

| 항목 | 소스 | 표시 |
|------|------|------|
| Velog 트렌드 (5) | v3.velog.io GraphQL | 제목 + 요약 (IT·경제 글만 LLM 선별) |
| 요즘IT 인기 기사 (5) | yozm.wishket.com | 제목만 |
| GitHub Trending (5) | github.com/trending | 기능을 LLM이 한국어 1줄 요약 |
| 코스피/코스닥 | 네이버 금융 | 현재값·등락액·등락률 |
| USD/KRW 환율 | open.er-api.com | 현재값 |
| 마켓 뉴스 (4) | 한국경제 증권 RSS (/feed/finance) | 헤드라인 |

개별 소스가 실패해도 나머지는 정상 수집되며, 실패 항목은 리포트에 `[취득 실패]`로 표기된다.

## LLM 보강 (enrich.js)

데이터 취득은 코드로(환각 없음) 하고, **보강만 LLM**이 한다. `claude -p`(헤드리스 Claude Code,
기본 모델 `claude-sonnet-4-6`)를 매 실행 1회 호출해 ① velog 후보 중 IT·기술·경제 글을 선별하고
(취업/회고/스팸/무관 글 제외), ② GitHub repo 설명을 한국어 1줄로 요약한다.
LLM 호출이 실패하면 순수 코드로 폴백한다(velog 키워드 필터·GitHub 원문 설명). 모델은
`NEWS_LLM_MODEL` 환경변수로 변경 가능.

> cron으로 자동 실행하려면 `claude` CLI가 PATH에 있고 로그인돼 있어야 한다
> (crontab PATH에 `~/.local/bin` 포함). LLM 호출은 Claude 구독/사용량을 소모한다.

## Telegram 메시지

리포트는 평소 **한 통의 메시지**로 전송된다. Telegram 메시지 한도(4096자)에 맞춰
요약 길이 제한·중복 제거로 분량을 조절하며, 한도를 넘으면 줄 경계에서 안전하게 분할한다.
마크다운은 HTML(`parse_mode=HTML`)로 변환되어 제목이 클릭 가능한 링크로 표시된다.

## 구조

```
├── CLAUDE.md       # 에이전트/실행 지시서
├── collect.js      # 뉴스 수집 (코드 기반, reports/{날짜}.md 추기)
├── enrich.js       # LLM 보강 (claude -p: velog 선별 + GitHub 한글 요약)
├── notify.js       # Telegram 알림 (HTML, 단일 메시지 지향·줄 단위 분할, 재시도)
├── run.sh          # collect → notify 실행 스크립트 (cron용)
├── reports/        # 수집 리포트 (날짜별 .md)
└── .env            # Telegram 토큰/채팅ID
```
