# news-collector

매일 **IT/기술**과 **경제/투자** 뉴스를 코드로 수집해 **HTML 이메일**(뉴스레터)로 보내는 개인용 다이제스트.

수집은 `collect.js`가 실제 소스(API/RSS/HTML)에서 직접 파싱하므로 LLM 추정(환각)이 없고,
LLM은 **선별·점수·요약·분류**만 담당한다. Claude 세션 없이 cron만으로 자동 실행된다.

## 설정

```bash
cd ~/develop/news-collector
npm install
cp .env.example .env
```

`.env`에 Gmail SMTP 정보를 넣는다:
- Gmail → 2단계 인증 켜기 → https://myaccount.google.com/apppasswords 에서 **앱 비밀번호(16자리)** 발급
- `SMTP_USER`(Gmail 주소)·`SMTP_PASS`(앱 비밀번호)·`MAIL_TO`(받는 주소) 입력

## 실행

```bash
./run.sh                 # 설문 반영 → 수집 → 이메일 (cron이 쓰는 경로)
```

또는 단계별:

```bash
node feedback.js                          # (설정 시) 주간 설문 CSV 반영 → 학습 가중 갱신
node collect.js                           # reports/{날짜}.md 에 추기, 경로를 stdout 으로 출력
node collect.js --force                   # 같은 날짜 재수집(중복 가드 무시)
node mailer.js reports/{날짜}.md           # 이메일 발송
node mailer.js reports/{날짜}.md --dry-run # 전송 없이 HTML 미리보기(reports/email-preview.html)
node weekly.js                            # 주간 리캡 생성·발송 (월요일 cron)
node weekly.js --dry-run                  # 리캡 파일만 생성
```

## 자동화 (cron)

```cron
CRON_TZ=Asia/Seoul
PATH=/home/cyyoo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# 매일 08:30 — 일일 다이제스트
30 8 * * * cd /home/cyyoo/develop/news-collector && /usr/bin/env bash run.sh >> reports/cron.log 2>&1
# 매주 월 09:00 — 주간 리캡
0 9 * * 1 cd /home/cyyoo/develop/news-collector && node weekly.js >> reports/cron.log 2>&1
```

> 리포트 내부 날짜·시각은 항상 KST. cron으로 LLM 보강을 쓰려면 `claude` CLI가 PATH(`~/.local/bin`)에
> 있고 로그인돼 있어야 한다.

## 이메일 구성 (하루 1통, 두 섹션)

| 섹션 | 항목 | 소스 |
|------|------|------|
| 💻 IT/기술 | 인기 IT 기사 (AI 중심) | yozm.wishket.com — LLM 0~10 점수 선별 |
| 💻 IT/기술 | GitHub Trending | github.com/trending — 기능·특징을 LLM이 한국어 2~3문장 요약 |
| 💻 IT/기술 | 해외 IT 토픽 | Hacker News(Algolia) — 인기·시간감쇠 중력 랭킹 |
| 📈 경제/투자 | 지난밤 미국 증시 | 네이버 해외지수(S&P500·나스닥·다우) + 국제 뉴스(증시 키워드 필터) |
| 📈 경제/투자 | 국내 지수·환율 | 네이버 금융 · open.er-api.com |
| 📈 경제/투자 | 마켓 뉴스 / 부동산 | 한국경제 RSS(/feed/finance, /feed/realestate) |
| 양쪽 | 구독 채널 주요 소식 | 내 텔레그램 채널(MTProto) — LLM 선별·요약·분류, 경제 항목엔 📈/📉/➖ |

개별 소스가 실패해도 나머지는 정상 수집되며, 핵심 소스 실패 시 본문 상단에 `⚠️ 일부 수집 실패`로
표기하고, 수집/발송 자체가 실패하면 `alert.js`가 이메일로 관리자 알림을 보낸다.

## 품질·개인화 장치

- **중복 제거**: 최근 N일 보낸 URL 제외 + 제목 유사도(Jaccard)로 **단일 실행 내·교차일** 근접중복 제거.
- **점수 임계값**: LLM 중요도 점수(0~10)가 임계값 미만이면 노출 안 함(조용한 날엔 적게).
- **피드백 학습(주간 설문)**: 이메일은 버튼이 없으므로 푸터의 **설문 링크**(`config.feedback.surveyUrl`)로
  관심/비관심 주제를 응답한다. 폼 응답 시트를 '웹에 CSV 게시'한 공개 URL(`responsesCsvUrl`)을
  `feedback.js`가 인증 없이 읽어 키워드 가중치(`state/weights.json`)에 반영 → 랭킹·LLM 프롬프트에 적용.
- **주간 리캡**: `state/history.jsonl` 이력에서 지난 7일 상위 항목을 월요일에 모아 발송(`weekly.js`).
- **설정 외부화**: 소스·개수·임계값·관심사·채널 allow/deny·설문 URL 은 `config.js` 한 곳에서.

## 구독 채널 수집 (선택)

봇이 아닌 **내 계정**으로 구독 채널(broadcast)을 읽으므로 MTProto 로그인이 필요하다. (전송 채널과 무관)

1. https://my.telegram.org → API development tools → `TG_API_ID`/`TG_API_HASH` 발급 후 `.env`에 입력
2. `node tg-login.js` 1회 실행(전화·인증코드) → 출력된 `TG_SESSION` 을 `.env`에 저장

미설정 시 채널 소블록은 자동 생략된다. 그룹·개인 대화는 제외하고 방향성 채널만 대상으로 한다.

## 주간 설문 피드백 (선택)

1. Google Form 생성 — "관심 주제"·"비관심 주제"를 `config.interests` 항목의 체크박스로.
2. 폼 링크를 `config.feedback.surveyUrl` 에 넣으면 이메일 푸터에 노출된다.
3. 응답 시트 → 파일 → 공유 → 웹에 게시 → CSV → 그 URL 을 `config.feedback.responsesCsvUrl` 에 넣으면
   `feedback.js`가 최신 응답을 읽어 학습한다(미설정 시 링크만 노출).

## 테스트

```bash
node --test    # 순수 함수 단위테스트 (rank, state, RSS 파싱, renderEmail, 설문 CSV 등)
```

GitHub Actions(`.github/workflows/ci.yml`)가 push·PR 마다 syntax check + 테스트를 돌린다.

## 구조

```
├── CLAUDE.md          # 에이전트/실행 지시서
├── ROADMAP.md         # 개선 로드맵
├── config.js          # 소스·개수·임계값·관심사·채널·설문 설정 (한 곳)
├── collect.js         # 수집·중복제거·점수·이력 (reports/{날짜}.md 추기)
├── enrich.js          # LLM 보강 (claude -p: 점수·요약·분류·감성, 선호 주입)
├── mailer.js          # 리포트 → HTML 이메일 렌더·발송 (Gmail SMTP)
├── feedback.js        # 주간 설문 CSV 수집 → 학습 가중 갱신
├── weekly.js          # 주간 리캡 생성·발송
├── alert.js           # 하드 실패 시 이메일 알림
├── collect-telegram.js# 구독 채널(MTProto) 수집 (소스)
├── tg-login.js        # MTProto 1회 로그인(세션 발급)
├── lib/               # rank(랭킹), state(중복·이력), util(공용)
├── test/              # 단위테스트
├── reports/           # 수집 리포트 (날짜별 .md)
├── state/             # 중복·이력·학습 상태 (git 비추적)
└── .env               # SMTP 자격증명 / (선택) TG 세션
```
