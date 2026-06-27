'use strict';

// P2 주간 리캡: 최근 N일 history 에서 카테고리별 상위 항목을 모아 리포트로 만들고 전송한다.
// 점수 = 수집 당시 점수(LLM/중력) + 피드백 학습 가중. 월요일 cron 에서 실행.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');
const state = require('./lib/state');

const REPORTS_DIR = path.join(__dirname, 'reports');
const WEIGHTS_FILE = path.join(state.STATE_DIR, 'weights.json');

function kstDate() {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return s; // YYYY-MM-DD
}

// 학습 가중을 점수에 가산: 매칭 관심키워드 가중 합 + 소스 가중(0.5배).
function boostOf(item, weights) {
  let b = 0;
  const hay = String(item.title ?? '').toLowerCase();
  for (const [kw, w] of Object.entries(weights.kw || {})) {
    if (hay.includes(String(kw).toLowerCase())) b += w;
  }
  b += (weights.source?.[item.source] || 0) * 0.5;
  return b;
}

function topByCategory(history, category, weights, n) {
  const seenUrl = new Set();
  return history
    .filter((h) => h.category === category && h.url && h.title)
    .map((h) => ({ ...h, rank: (Number(h.score) || 0) + boostOf(h, weights) }))
    .sort((a, b) => b.rank - a.rank)
    .filter((h) => (seenUrl.has(h.url) ? false : seenUrl.add(h.url))) // URL 중복 제거(최고점 유지)
    .slice(0, n);
}

function fmtSection(title, items) {
  const L = [`### ${title}`, ''];
  if (items.length) {
    items.forEach((h, i) => {
      const src = h.source ? ` — ${h.source}` : '';
      L.push(`${i + 1}. [${h.title}](${h.url})${src}`);
    });
  } else {
    L.push('지난주 집계된 항목이 없습니다.');
  }
  return L.join('\n');
}

function main() {
  const date = kstDate();
  const { windowDays, topPerCategory } = config.weekly;
  const history = state.readHistory(windowDays, Date.now());
  if (!history.length) {
    console.error('[주간] 집계할 이력이 없습니다(평일 수집이 누적되어야 합니다).');
    process.exit(0);
  }
  const weights = state.loadJson(WEIGHTS_FILE, { kw: {}, source: {} });
  const it = topByCategory(history, 'it', weights, topPerCategory);
  const econ = topByCategory(history, 'econ', weights, topPerCategory);

  const body = [
    `## 실행: ${date} (주간 리캡 · 최근 ${windowDays}일)`,
    '',
    fmtSection('💻 IT/기술 — 지난주 핵심', it),
    '',
    fmtSection('📈 경제/투자 — 지난주 핵심', econ),
    '',
  ].join('\n');

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = path.join(REPORTS_DIR, `weekly-${date}.md`);

  if (process.argv.includes('--dry-run')) {
    process.stdout.write(file + '\n');
    return;
  }

  fs.writeFileSync(file, `# 주간 뉴스 리캡 - ${date}\n\n${body}`);

  // 전송 로직 재사용: mailer.js 에 위임(이메일 발송).
  const child = execFile('node', [path.join(__dirname, 'mailer.js'), file], (err, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (err) process.exit(1);
  });
}

if (require.main === module) main();
module.exports = { kstDate, boostOf, topByCategory, fmtSection };
