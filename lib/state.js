'use strict';

// 중복 제거용 상태 저장소: 최근 보낸 URL과 시각(ms)을 JSON 으로 보관한다.
// state/seen.json 은 git 에 올리지 않는다(.gitignore).

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', 'state');
const SEEN_FILE = path.join(STATE_DIR, 'seen.json');
const DAY_MS = 86400000;

function loadSeen() {
  try {
    const obj = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    // 파일 없음(ENOENT)은 최초 실행의 정상 상황이라 조용히 시작. 그 외(손상 등)만 경고.
    if (err?.code !== 'ENOENT') console.warn('[상태] seen.json 로드 실패:', err?.message ?? err);
    return {};
  }
}

function saveSeen(seen) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen));
}

// 윈도우(N일) 밖의 오래된 항목 제거 — 순수 함수.
function prune(seen, windowDays, nowMs) {
  const cutoff = nowMs - windowDays * DAY_MS;
  const out = {};
  for (const [url, ts] of Object.entries(seen)) {
    if (typeof ts === 'number' && ts >= cutoff) out[url] = ts;
  }
  return out;
}

const isSeen = (seen, url) => Object.prototype.hasOwnProperty.call(seen, url);
const markSeen = (seen, url, nowMs) => {
  seen[url] = nowMs;
};

module.exports = { loadSeen, saveSeen, prune, isSeen, markSeen, SEEN_FILE, DAY_MS };
