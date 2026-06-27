'use strict';

// 상태 저장소: 중복 제거(seen) + 주간 리캡 이력(history) + 범용 JSON(weights·pending·offset).
// state/ 전체는 git 에 올리지 않는다(.gitignore).

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', 'state');
const SEEN_FILE = path.join(STATE_DIR, 'seen.json');
const HISTORY_FILE = path.join(STATE_DIR, 'history.jsonl');
const DAY_MS = 86400000;

// ── 범용 JSON 로드/저장 (weights·pending·tg-offset 공용) ─────
function loadJson(file, fallback = {}) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return obj ?? fallback;
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn(`[상태] ${path.basename(file)} 로드 실패:`, err?.message ?? err);
    return fallback;
  }
}

function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

// ── seen (중복 제거) ────────────────────────────────────────
// 값 형식: { t: 보낸시각(ms), title }. 구버전(숫자 ts)도 읽어들인다(하위호환).
const loadSeen = () => loadJson(SEEN_FILE, {});
const saveSeen = (seen) => saveJson(SEEN_FILE, seen);

// 항목의 시각(ms)을 꺼낸다(구버전 숫자/신버전 객체 모두).
const seenTs = (v) => {
  if (typeof v === 'number') return v;
  if (v && typeof v.t === 'number') return v.t;
  return NaN;
};

// 윈도우(N일) 밖의 오래된 항목 제거 — 순수 함수.
function prune(seen, windowDays, nowMs) {
  const cutoff = nowMs - windowDays * DAY_MS;
  const out = {};
  for (const [url, v] of Object.entries(seen)) {
    const ts = seenTs(v);
    if (Number.isFinite(ts) && ts >= cutoff) out[url] = v;
  }
  return out;
}

const isSeen = (seen, url) => Object.prototype.hasOwnProperty.call(seen, url);
const markSeen = (seen, url, nowMs, title = '') => {
  seen[url] = { t: nowMs, title };
};

// seen 에 보관된 제목 목록(근접중복 비교용) — 순수 함수.
function recentTitles(seen) {
  const out = [];
  for (const v of Object.values(seen)) {
    const title = typeof v === 'object' && v ? v.title : '';
    if (title) out.push(title);
  }
  return out;
}

// ── history (주간 리캡 이력) ────────────────────────────────
// 한 줄당 JSON 한 건: { ts, date, category, source, title, url, score }.
function appendHistory(item) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(item) + '\n');
}

// 최근 days 일 이내 항목을 읽어 반환(파싱 실패 줄은 건너뜀).
function readHistory(days, nowMs) {
  let text;
  try {
    text = fs.readFileSync(HISTORY_FILE, 'utf-8');
  } catch {
    return [];
  }
  const cutoff = nowMs - days * DAY_MS;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.ts === 'number' && o.ts >= cutoff) out.push(o);
    } catch {
      /* 손상된 줄 무시 */
    }
  }
  return out;
}

// history.jsonl 을 최근 days 일분으로 트림(파일 비대화 방지).
function trimHistory(days, nowMs) {
  const kept = readHistory(days, nowMs);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, kept.map((o) => JSON.stringify(o)).join('\n') + (kept.length ? '\n' : ''));
}

module.exports = {
  STATE_DIR, SEEN_FILE, HISTORY_FILE, DAY_MS,
  loadJson, saveJson,
  loadSeen, saveSeen, prune, isSeen, markSeen, seenTs, recentTitles,
  appendHistory, readHistory, trimHistory,
};
