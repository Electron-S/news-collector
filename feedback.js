'use strict';

// 피드백: 주간 설문(Google 폼) 응답을 읽어 관심/비관심 키워드를 학습 가중(state/weights.json)에 반영.
// 폼 응답 시트를 '웹에 게시(CSV)'한 공개 URL(config.feedback.responsesCsvUrl)을 인증 없이 읽는다.
// run.sh 에서 collect 前에 실행한다. 미설정이면 아무 것도 하지 않는다(이메일 푸터 링크만 노출).

require('dotenv').config();
const path = require('path');
const config = require('./config');
const state = require('./lib/state');

const WEIGHTS_FILE = path.join(state.STATE_DIR, 'weights.json');
const SURVEY_FILE = path.join(state.STATE_DIR, 'feedback-survey.json');

// 최소 CSV 파서(따옴표·임베디드 콤마/개행 처리). 순수 함수.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// 셀 값(체크박스 다중선택은 "A, B" 형태)을 config.interests 와 매칭되는 키워드로.
function matchedInterests(cellValue, interests) {
  const vals = String(cellValue ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const v of vals) {
    const kw = interests.find((k) => k.toLowerCase() === v.toLowerCase());
    if (kw && !out.includes(kw)) out.push(kw);
  }
  return out;
}

// 헤더에서 관심/비관심 컬럼 인덱스를 찾는다.
function findColumns(header) {
  const interest = header.findIndex((h) => /관심/.test(h) && !/없|비관심|제외/.test(h));
  const avoid = header.findIndex((h) => /비관심|관심\s*없|관심없|제외/.test(h));
  return { interest, avoid };
}

// 최신 응답 1건을 weights 에 반영(순수). 관심=+boost, 비관심=-boost.
function applySurveyRow(header, lastRow, weights, interests, boost) {
  const { interest, avoid } = findColumns(header);
  const next = { kw: { ...(weights.kw || {}) } };
  const bump = (list, sign) => {
    for (const kw of list) next.kw[kw] = (next.kw[kw] || 0) + sign * boost;
  };
  if (interest >= 0 && interest < lastRow.length) bump(matchedInterests(lastRow[interest], interests), 1);
  if (avoid >= 0 && avoid < lastRow.length) bump(matchedInterests(lastRow[avoid], interests), -1);
  return next;
}

async function main() {
  const url = config.feedback?.responsesCsvUrl;
  if (!config.feedback?.enabled || !url) return; // 미설정 → idle

  let text;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    console.error(`[피드백] 설문 CSV 로드 실패: ${err?.message ?? err}`);
    return;
  }

  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  if (rows.length < 2) return; // 헤더만 있거나 빈 응답
  const header = rows[0];
  const lastRow = rows[rows.length - 1];

  // 동일 응답 재적용 방지(첫 칸=타임스탬프 기준).
  const surveyState = state.loadJson(SURVEY_FILE, { lastTs: '' });
  const ts = lastRow[0] || '';
  if (ts && ts === surveyState.lastTs) return;

  let weights = state.loadJson(WEIGHTS_FILE, { kw: {}, source: {} });
  weights.kw = weights.kw || {};
  // 새 응답 반영 전 옛 신호 감쇠.
  const decay = config.feedback.decay ?? 0.9;
  for (const k of Object.keys(weights.kw)) {
    weights.kw[k] *= decay;
    if (Math.abs(weights.kw[k]) < 0.05) delete weights.kw[k];
  }
  weights = applySurveyRow(header, lastRow, weights, config.interests, 2);

  state.saveJson(WEIGHTS_FILE, weights);
  state.saveJson(SURVEY_FILE, { lastTs: ts });
  console.error('[피드백] 설문 응답 반영 완료.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[피드백] 오류: ${err?.message ?? err}`);
    process.exit(0);
  });
}

module.exports = { parseCsv, matchedInterests, findColumns, applySurveyRow };
