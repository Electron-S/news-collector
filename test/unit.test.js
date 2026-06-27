'use strict';

// 순수 함수 단위테스트. 네트워크/LLM/텔레그램 없이 로직만 검증한다.
// 실행: node --test  (Node 20 내장 test 러너, 추가 의존성 없음)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rank = require('../lib/rank');
const state = require('../lib/state');
const { parsePrice, parseRssItems, fmtIndex } = require('../collect');
const { renderEmail, inlineHtml } = require('../mailer');
const { channelAllowed } = require('../collect-telegram');

// ── lib/rank ────────────────────────────────────────────────
test('gravityScore: 인기 높을수록·최근일수록 높다', () => {
  assert.ok(rank.gravityScore(100, 1) > rank.gravityScore(10, 1)); // 인기
  assert.ok(rank.gravityScore(100, 1) > rank.gravityScore(100, 50)); // 시간 감쇠
  assert.equal(rank.gravityScore(1, 5), 0); // points-1=0
});

test('jaccard: 동일=1, 무관=0', () => {
  assert.equal(rank.jaccard('apple banana', 'apple banana'), 1);
  assert.equal(rank.jaccard('apple banana', 'orange grape'), 0);
  assert.ok(rank.jaccard('the quick brown fox', 'the quick red fox') > 0.4);
});

test('dedupeSimilar: 근접 중복 제거(상위 우선 유지)', () => {
  const items = [
    { t: 'OpenAI launches GPT-5 model today' },
    { t: 'OpenAI launches GPT-5 model now' }, // 위와 거의 동일
    { t: 'Completely different topic about rust' },
  ];
  const kept = rank.dedupeSimilar(items, (x) => x.t, 0.6);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].t, items[0].t);
});

test('interestHits: 관심 키워드 매칭 수', () => {
  assert.equal(rank.interestHits('새로운 AI 에이전트 출시', ['AI', '에이전트', '부동산']), 2);
  assert.equal(rank.interestHits('날씨 뉴스', ['AI']), 0);
});

// ── lib/state ───────────────────────────────────────────────
test('prune: 윈도우 밖 항목 제거', () => {
  const now = 1_000_000_000_000;
  const day = state.DAY_MS;
  const seen = { old: now - 10 * day, fresh: now - 1 * day };
  const pruned = state.prune(seen, 5, now);
  assert.equal(pruned.old, undefined);
  assert.equal(pruned.fresh, now - day);
});

test('isSeen/markSeen: 제목 포함 객체값 저장', () => {
  const seen = {};
  assert.equal(state.isSeen(seen, 'http://x'), false);
  state.markSeen(seen, 'http://x', 123, '제목A');
  assert.equal(state.isSeen(seen, 'http://x'), true);
  assert.deepEqual(seen['http://x'], { t: 123, title: '제목A' });
});

test('prune: 객체값(신버전)도 시각 기준 유지/제거', () => {
  const now = 1_000_000_000_000;
  const day = state.DAY_MS;
  const seen = {
    old: { t: now - 10 * day, title: 'old' },
    fresh: { t: now - day, title: 'fresh' },
  };
  const pruned = state.prune(seen, 5, now);
  assert.equal(pruned.old, undefined);
  assert.deepEqual(pruned.fresh, { t: now - day, title: 'fresh' });
});

test('recentTitles: 객체값에서 제목만 추출(빈 제목 제외)', () => {
  const seen = { a: { t: 1, title: 'AI 뉴스' }, b: { t: 2, title: '' }, c: 12345 };
  assert.deepEqual(state.recentTitles(seen), ['AI 뉴스']);
});

test('interestBoost: 매칭·학습가중 반영', () => {
  // 매칭 없음 → 1.0
  assert.equal(rank.interestBoost('날씨', ['AI']), 1);
  // 가중 0 매칭 1건 → 1 + 0.3*1
  assert.ok(Math.abs(rank.interestBoost('AI 소식', ['AI']) - 1.3) < 1e-9);
  // 양수 가중 → 보너스↑ , 음수 가중(<-1) → 0으로 바닥
  assert.ok(rank.interestBoost('AI 소식', ['AI'], { AI: 2 }) > 1.3);
  assert.equal(rank.interestBoost('AI 소식', ['AI'], { AI: -5 }), 1);
});

// ── collect (순수 파싱) ─────────────────────────────────────
test('parsePrice: 콤마 제거·빈값 NaN', () => {
  assert.equal(parsePrice('1,234.5'), 1234.5);
  assert.equal(parsePrice('-16.57'), -16.57);
  assert.ok(Number.isNaN(parsePrice('')));
  assert.ok(Number.isNaN(parsePrice(null)));
});

test('parseRssItems: CDATA 허용·빈 제목 제외', () => {
  const xml =
    '<rss><channel>' +
    '<item><title><![CDATA[헤드라인 A]]></title><link>https://ex.com/a</link></item>' +
    '<item><title>헤드라인 B</title><link>https://ex.com/b</link></item>' +
    '<item><title></title><link>https://ex.com/c</link></item>' +
    '</channel></rss>';
  const items = parseRssItems(xml);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { title: '헤드라인 A', url: 'https://ex.com/a' });
  assert.equal(parseRssItems(xml, 1).length, 1); // limit
});

test('fmtIndex: 기본 헤더 포함', () => {
  const out = fmtIndex({});
  assert.ok(out.includes('### 💻 IT/기술'));
  assert.ok(out.includes('### 📈 경제/투자'));
});

test('fmtIndex: hnReddit 섹션 및 포맷', () => {
  const out = fmtIndex({
    hnReddit: [{ title: 'Show HN: Test', url: 'https://ex.com', source: 'HN', points: 42, comments: 5 }],
  });
  assert.ok(out.includes('#### 해외 IT 토픽 (Hacker News)'));
  assert.ok(out.includes('[Show HN: Test](https://ex.com)'));
  assert.ok(out.includes('HN ▲42·💬5'));
});

// ── mailer (마크다운 → 이메일 HTML) ─────────────────────────
test('inlineHtml: 굵게·링크·이스케이프', () => {
  assert.equal(inlineHtml('**굵게**'), '<strong>굵게</strong>');
  assert.ok(inlineHtml('[텍스트](https://e.com)').includes('<a href="https://e.com"'));
  assert.ok(inlineHtml('a < b & c').startsWith('a &lt; b &amp; c'));
});

test('renderEmail: 최근 실행 섹션·헤더·링크·푸터', () => {
  const md = [
    '# 뉴스 수집 리포트 - 2026-06-27',
    '## 실행: 2026-06-27 (취득 시각: 09:00 KST)',
    '### 💻 IT/기술',
    '#### 인기 IT 기사',
    '1. [제목A](https://a.com)',
    '### 📈 경제/투자',
    '#### 지난밤 미국 증시',
    '- S&P500: **7,000 pt**',
  ].join('\n');
  const html = renderEmail(md, { surveyUrl: 'https://form', generatedAt: 'now' });
  assert.ok(html.includes('IT/기술') && html.includes('경제/투자'));
  assert.ok(html.includes('<a href="https://a.com"'));
  assert.ok(html.includes('<strong>7,000 pt</strong>'));
  assert.ok(html.includes('https://form')); // 설문 링크 푸터
});

// ── collect-telegram (채널 allow/deny) ──────────────────────
test('channelAllowed: deny 우선, allow 비면 전체 허용', () => {
  assert.equal(channelAllowed('미국 주식 인사이더', { allow: [], deny: ['묻따방'] }), true);
  assert.equal(channelAllowed('묻따방 🐕', { allow: [], deny: ['묻따방'] }), false);
  assert.equal(channelAllowed('잡담방', { allow: ['주식'], deny: [] }), false); // allow 불일치
  assert.equal(channelAllowed('주식 인사이더', { allow: ['주식'], deny: [] }), true);
});

// ── weekly (순수 함수) ────────────────────────────────────────
const weekly = require('../weekly');

test('kstDate: YYYY-MM-DD 형식', () => {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(weekly.kstDate()));
});

test('boostOf: 키워드·소스 가중 반영', () => {
  assert.equal(weekly.boostOf({ title: 'AI 소식' }, { kw: { AI: 2 } }), 2);
  assert.equal(weekly.boostOf({ title: 'AI 소식', source: 's' }, { kw: {}, source: { s: 2 } }), 1); // 소스 가중 0.5배
  assert.equal(weekly.boostOf({ title: 'AI 소식', source: 's' }, { kw: { AI: 2 }, source: { s: 2 } }), 3); // 2 + 1
});

test('topByCategory: 카테고리별 상위 N개, URL 중복 제거', () => {
  const hist = [
    { category: 'it', title: 'A', url: 'http://a', score: 10 },
    { category: 'it', title: 'B', url: 'http://a', score: 8 }, // 중복 URL
    { category: 'econ', title: 'C', url: 'http://c', score: 9 },
  ];
  const it = weekly.topByCategory(hist, 'it', {}, 2);
  assert.equal(it.length, 1);
  assert.equal(it[0].title, 'A');
});

test('fmtSection: 항목 있을 때/없을 때', () => {
  assert.ok(weekly.fmtSection('T', []).includes('없습니다'));
  const withItem = weekly.fmtSection('T', [{ title: 'A', url: 'http://a', source: 'S' }]);
  assert.ok(withItem.includes('1. [A](http://a) — S'));
});

// ── feedback (설문 CSV 순수 함수) ─────────────────────────────
const { parseCsv, matchedInterests, findColumns, applySurveyRow } = require('../feedback');

test('parseCsv: 따옴표·임베디드 콤마 처리', () => {
  const rows = parseCsv('Timestamp,관심 주제,비관심 주제\n2026,"AI, 반도체",부동산\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ['2026', 'AI, 반도체', '부동산']);
});

test('matchedInterests: config 관심사와 매칭(다중선택)', () => {
  assert.deepEqual(matchedInterests('AI, 반도체', ['AI', '반도체', '환율']), ['AI', '반도체']);
  assert.deepEqual(matchedInterests('날씨', ['AI']), []);
});

test('findColumns: 관심/비관심 컬럼 탐지', () => {
  const { interest, avoid } = findColumns(['Timestamp', '관심 주제', '비관심 주제']);
  assert.equal(interest, 1);
  assert.equal(avoid, 2);
});

test('applySurveyRow: 관심=+, 비관심=- 가중', () => {
  const header = ['ts', '관심 주제', '비관심 주제'];
  const row = ['2026', 'AI', '부동산'];
  const w = applySurveyRow(header, row, { kw: {} }, ['AI', '부동산'], 2);
  assert.equal(w.kw.AI, 2);
  assert.equal(w.kw['부동산'], -2);
});
