'use strict';

// 순수 함수 단위테스트. 네트워크/LLM/텔레그램 없이 로직만 검증한다.
// 실행: node --test  (Node 20 내장 test 러너, 추가 의존성 없음)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rank = require('../lib/rank');
const state = require('../lib/state');
const { parsePrice, parseRssItems, fmtIndex } = require('../collect');
const { mdToHtml, splitByLines } = require('../notify');
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

test('isSeen/markSeen', () => {
  const seen = {};
  assert.equal(state.isSeen(seen, 'http://x'), false);
  state.markSeen(seen, 'http://x', 123);
  assert.equal(state.isSeen(seen, 'http://x'), true);
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

// ── notify (마크다운 → 텔레그램 HTML) ───────────────────────
test('mdToHtml: 헤더·굵게·링크·이스케이프', () => {
  assert.equal(mdToHtml('### 제목'), '<b>제목</b>');
  assert.equal(mdToHtml('**굵게**'), '<b>굵게</b>');
  assert.equal(mdToHtml('[텍스트](https://e.com)'), '<a href="https://e.com">텍스트</a>');
  assert.equal(mdToHtml('a < b & c'), 'a &lt; b &amp; c');
});

test('splitByLines: 한도 초과 시 분할', () => {
  const text = ['aaaa', 'bbbb', 'cccc'].join('\n');
  const chunks = splitByLines(text, 9); // 한 줄(4) + \n + 한 줄(4) = 9
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length <= 9));
});

// ── collect-telegram (채널 allow/deny) ──────────────────────
test('channelAllowed: deny 우선, allow 비면 전체 허용', () => {
  assert.equal(channelAllowed('미국 주식 인사이더', { allow: [], deny: ['묻따방'] }), true);
  assert.equal(channelAllowed('묻따방 🐕', { allow: [], deny: ['묻따방'] }), false);
  assert.equal(channelAllowed('잡담방', { allow: ['주식'], deny: [] }), false); // allow 불일치
  assert.equal(channelAllowed('주식 인사이더', { allow: ['주식'], deny: [] }), true);
});
