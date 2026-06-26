'use strict';

// LLM 보강: Claude Code(claude -p, Sonnet)를 헤드리스로 호출해
//  1) 요즘IT 후보를 AI 관련도가 높은 순으로 재정렬·선별
//  2) GitHub repo 설명을 한국어 한 줄로 요약
// 한 번의 호출로 처리하며, 실패 시 null 을 반환해 호출부가 순수 코드로 폴백한다.

const { execFile } = require('child_process');

const MODEL = process.env.NEWS_LLM_MODEL ?? 'claude-sonnet-4-6';
const TIMEOUT_MS = 120000;

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['-p', prompt, '--model', MODEL, '--output-format', 'json'],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(err);
        if (stderr && stderr.trim()) console.error(`[claude stderr] ${stderr.trim()}`);
        resolve(stdout);
      }
    );
  });
}

// claude -p 의 JSON 봉투에서 result(모델 텍스트)를 꺼내고, 그 안의 JSON 객체를 파싱한다.
function parseResult(stdout) {
  const envelope = JSON.parse(stdout);
  if (!envelope.result) throw new Error('LLM 응답 봉투에 result 필드 없음');
  const text = String(envelope.result);
  // 코드펜스·잡텍스트가 섞여도 첫 '{' ~ 마지막 '}' 구간만 파싱한다.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('LLM 응답에서 JSON 객체 구간을 찾을 수 없음');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function buildPrompt(yozm, github) {
  const input = {
    yozm: yozm.map((a, i) => ({ id: i, title: a.title })),
    github: github.map((g, i) => ({ id: i, repo: g.repo, desc: g.desc })),
  };
  return [
    '너는 한국어 IT/경제 데일리 다이제스트 큐레이터다. 아래 입력을 보고 결과 JSON만 출력한다(코드펜스·설명 금지).',
    '',
    '1) YOZM 후보(IT 기사) 중 AI·머신러닝·LLM·생성형AI 관련도가 높은 순으로 id를 최대 5개 고른다.',
    '   AI 관련 기사가 5개 미만이면 나머지는 일반 IT·기술 기사로 채우되 항상 AI 관련 글을 앞에 둔다.',
    '2) GITHUB 각 repo의 기능을 한국어 한 문장(40자 이내, 따옴표 없이)으로 요약한다.',
    '',
    '--- 입력 시작 ---',
    JSON.stringify(input),
    '--- 입력 끝 ---',
    '',
    '출력 형식(이 스키마만): {"yozmKeep":[id,...],"github":{"<id>":"요약",...}}',
  ].join('\n');
}

// 반환: { yozmKeep: number[], githubKo: Record<number,string> } 또는 실패 시 null
async function enrich({ yozm = [], github = [] }) {
  if (!yozm.length && !github.length) return null;
  // id 목록을 유효 범위(0..len-1) 정수로만 거른다.
  const validIds = (arr, len) =>
    Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n) && n >= 0 && n < len) : [];
  try {
    const stdout = await runClaude(buildPrompt(yozm, github));
    const parsed = parseResult(stdout);
    const yozmKeep = validIds(parsed.yozmKeep, yozm.length);
    const githubKo = {};
    if (parsed.github && typeof parsed.github === 'object' && parsed.github !== null) {
      for (const [k, v] of Object.entries(parsed.github)) {
        const i = Number(k);
        if (Number.isInteger(i) && typeof v === 'string' && v.trim()) {
          githubKo[i] = v.trim();
        }
      }
    }
    if (!yozmKeep.length && !Object.keys(githubKo).length) return null;
    return { yozmKeep, githubKo };
  } catch (err) {
    console.error(`[LLM 보강 실패] ${err?.message ?? err} — 순수 코드로 폴백`);
    return null;
  }
}

// ── 텔레그램 채널 메시지 선별 ───────────────────────────────
function buildTelegramPrompt(messages, max) {
  const input = messages.map((m, i) => ({ id: i, channel: m.channel, text: m.text }));
  return [
    '너는 한국어 뉴스 다이제스트 큐레이터다. 아래는 사용자가 구독한 텔레그램 채널의 최근 메시지다.',
    '뉴스/정보 가치가 높은 "중요" 메시지만 골라 결과 JSON만 출력한다(코드펜스·설명 금지).',
    '',
    `- 중요도 높은 순으로 최대 ${max}개의 id 를 고른다.`,
    '- 광고/홍보/이벤트/잡담/인사/단순 리액션/중복 메시지는 제외한다.',
    '- 각 항목을 한국어 한 문장(60자 이내, 따옴표 없이)으로 요약한다.',
    '- 각 항목의 분야를 cat 으로 표기한다: IT·기술·개발·AI 관련이면 "it", 그 외 증시·투자·경제·부동산 등은 "econ".',
    '- 고를 만한 게 없으면 items 를 빈 배열로 둔다.',
    '',
    '--- 입력 시작 ---',
    JSON.stringify(input),
    '--- 입력 끝 ---',
    '',
    '출력 형식(이 스키마만): {"items":[{"id":<번호>,"cat":"it"|"econ","summary":"요약"},...]}',
  ].join('\n');
}

// 반환: [{ id:number, summary:string }] (중요도순) 또는 실패 시 null
async function enrichTelegram(messages = [], max = 7) {
  if (!messages.length) return null;
  try {
    const stdout = await runClaude(buildTelegramPrompt(messages, max));
    const parsed = parseResult(stdout);
    if (!Array.isArray(parsed.items)) return null;
    const seen = new Set();
    const items = parsed.items
      .filter((it) => it && Number.isInteger(it.id) && it.id >= 0 && it.id < messages.length)
      .filter((it) => {
        if (seen.has(it.id)) return false;
        seen.add(it.id);
        return true;
      })
      .map((it) => ({
        id: it.id,
        cat: it.cat === 'it' ? 'it' : 'econ', // 미지정/오류는 경제로 처리(채널 대부분 금융)
        summary: typeof it.summary === 'string' ? it.summary.trim() : '',
      }))
      .slice(0, max);
    return items.length ? items : null;
  } catch (err) {
    console.error(`[텔레그램 보강 실패] ${err?.message ?? err} — 순수 코드로 폴백`);
    return null;
  }
}

module.exports = { enrich, enrichTelegram };
