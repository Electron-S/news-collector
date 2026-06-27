'use strict';

// P1 피드백 수신: 텔레그램 평가 버튼(👍/👎) 콜백을 getUpdates 로 수거해
// 선호 키워드·소스 가중치(state/weights.json)를 학습한다. cron 에서 collect 前에 실행한다.
// 데몬이 아니라 실행 시점 폴링이므로, 어제 누른 평가가 다음 실행 때 반영된다.

require('dotenv').config();
const path = require('path');
const { TOKEN, CHAT_ID, http } = require('./lib/telegram');
const config = require('./config');
const state = require('./lib/state');

const API = `https://api.telegram.org/bot${TOKEN}`;
const OFFSET_FILE = path.join(state.STATE_DIR, 'tg-offset.json');
const WEIGHTS_FILE = path.join(state.STATE_DIR, 'weights.json');
const PENDING_DIR = path.join(state.STATE_DIR, 'pending');

// 콜백 date(YYYYMMDD) → pending 파일명(YYYY-MM-DD).
const toDash = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

// 제목에서 관심 키워드(config.interests) 매칭분 추출.
function matchedKeywords(title) {
  const hay = String(title ?? '').toLowerCase();
  return config.interests.filter((kw) => hay.includes(String(kw).toLowerCase()));
}

async function main() {
  if (!TOKEN || !CHAT_ID || !config.feedback?.enabled) return;

  const offsetState = state.loadJson(OFFSET_FILE, { offset: 0 });
  let updates;
  try {
    const res = await http.post(`${API}/getUpdates`, {
      offset: offsetState.offset || 0,
      timeout: 0,
      allowed_updates: ['callback_query'],
    });
    updates = res.data?.result ?? [];
  } catch (err) {
    // 웹훅이 설정돼 있으면 409. 폴링 불가 → 조용히 종료(수집은 계속).
    const status = err.response?.status;
    console.error(`[피드백] getUpdates 실패(${status ?? err.code}) — 건너뜀`);
    return;
  }
  if (!updates.length) return;

  const weights = state.loadJson(WEIGHTS_FILE, { kw: {}, source: {} });
  weights.kw = weights.kw || {};
  weights.source = weights.source || {};

  // 활동이 있으면 옛 신호를 살짝 감쇠(최근 선호 우선).
  const decay = config.feedback.decay ?? 0.9;
  for (const obj of [weights.kw, weights.source]) {
    for (const k of Object.keys(obj)) {
      obj[k] *= decay;
      if (Math.abs(obj[k]) < 0.05) delete obj[k]; // 0 근처는 정리
    }
  }

  const pendingCache = {};
  let maxId = offsetState.offset || 0;
  let applied = 0;

  for (const u of updates) {
    maxId = Math.max(maxId, u.update_id + 1);
    const cq = u.callback_query;
    if (!cq?.data) continue;
    await http.post(`${API}/answerCallbackQuery`, { callback_query_id: cq.id, text: '반영됨 👍' }).catch((err) => {
      console.error(`[피드백] answerCallbackQuery 실패: ${err?.message ?? err}`);
    });

    const m = /^v:(\d{8}):(\d+):(u|d)$/.exec(cq.data);
    if (!m) continue;
    const [, d, gidStr, dir] = m;
    const date = toDash(d);
    if (!pendingCache[date]) {
      pendingCache[date] = state.loadJson(path.join(PENDING_DIR, `${date}.json`), []);
    }
    const item = pendingCache[date][Number(gidStr)];
    if (!item) continue;

    const delta = dir === 'u' ? 1 : -1;
    for (const kw of matchedKeywords(item.title)) {
      weights.kw[kw] = (weights.kw[kw] || 0) + delta;
    }
    if (item.source) weights.source[item.source] = (weights.source[item.source] || 0) + delta;
    applied++;
  }

  state.saveJson(WEIGHTS_FILE, weights);
  state.saveJson(OFFSET_FILE, { offset: maxId });
  console.error(`[피드백] 콜백 ${updates.length}건 처리, ${applied}건 반영.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[피드백] 오류: ${err?.message ?? err}`);
    process.exit(0); // 실패해도 수집 파이프라인은 계속되도록 0 종료
  });
}
module.exports = { matchedKeywords, toDash };
