'use strict';

// LLM 보강: Claude Code(claude -p, Sonnet)를 헤드리스로 호출해
//  1) 요즘IT 후보에 0~10 중요도 점수를 매겨 정렬(관심사 가중)
//  2) GitHub repo 설명을 한국어 한 줄로 요약
// enrich 와 enrichTelegram 은 각각 별도 호출이며, 실패 시 null 을 반환해 호출부가 순수 코드로 폴백한다.

const { execFile } = require('child_process');

const MODEL = process.env.NEWS_LLM_MODEL || 'claude-sonnet-4-6';
const TIMEOUT_MS = 180000;

// 프롬프트를 argv 가 아니라 stdin 으로 전달한다(긴 텔레그램 입력에서 argv 한계·실패 방지).
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', '--model', MODEL, '--output-format', 'json'],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(err);
        const noise = stderr && stderr.trim();
        if (noise) console.error(`[claude stderr] ${noise}`);
        resolve(stdout);
      }
    );
    child.stdin.on('error', (err) => reject(err));
    child.stdin.write(prompt, () => child.stdin.end());
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

// 0~10 정수 점수로 정규화(범위 밖/비정상은 0).
const clampScore = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : 0;
};

// 피드백 학습 결과(선호/비선호 키워드)를 프롬프트 한 줄로. 비면 빈 문자열.
function prefsLine(prefer = [], avoid = []) {
  const parts = [];
  if (prefer.length) parts.push(`특히 선호(점수 가산): ${prefer.join(', ')}`);
  if (avoid.length) parts.push(`비선호(점수 감산): ${avoid.join(', ')}`);
  return parts.join('. ');
}

function buildPrompt(yozm, github, interests, prefer, avoid) {
  const input = {
    yozm: yozm.map((a, i) => ({ id: i, title: a.title })),
    github: github.map((g, i) => ({ id: i, repo: g.repo, desc: g.desc })),
  };
  const interestLine = interests?.length ? `사용자 관심사: ${interests.join(', ')}. 관심사와 가까울수록 점수를 높인다.` : '';
  return [
    '너는 한국어 IT/경제 데일리 다이제스트 큐레이터다. 아래 입력을 보고 결과 JSON만 출력한다(코드펜스·설명 금지).',
    interestLine,
    prefsLine(prefer, avoid),
    '',
    '1) YOZM 후보(IT 기사) 각각에 0~10 정수 중요도 점수를 매긴다(AI·머신러닝·LLM·생성형AI 관련이면 가산).',
    '   취업/회고/광고/스팸/주제무관 글은 낮은 점수. 점수 높은 순으로 정렬해 반환한다.',
    '2) GITHUB 각 repo의 기능·용도·특징을 한국어 2~3문장(120자 내외, 따옴표 없이)으로 충분히 설명한다.',
    '',
    '--- 입력 시작 ---',
    JSON.stringify(input),
    '--- 입력 끝 ---',
    '',
    '출력 형식(이 스키마만): {"yozm":[{"id":<번호>,"score":<0~10>},...],"github":{"<id>":"요약",...}}',
  ].join('\n');
}

// 반환: { yozm: [{id,score}](점수순), githubKo: Record<number,string> } 또는 실패 시 null
async function enrich({ yozm = [], github = [], interests = [], prefer = [], avoid = [] }) {
  if (!yozm.length && !github.length) return null;
  try {
    const stdout = await runClaude(buildPrompt(yozm, github, interests, prefer, avoid));
    const parsed = parseResult(stdout);
    const seen = new Set();
    const yozmScored = Array.isArray(parsed.yozm)
      ? parsed.yozm
          .filter((it) => it && Number.isInteger(it.id) && it.id >= 0 && it.id < yozm.length)
          .filter((it) => (seen.has(it.id) ? false : seen.add(it.id)))
          .map((it) => ({ id: it.id, score: clampScore(it.score) }))
          .sort((a, b) => b.score - a.score)
      : [];
    const githubKo = {};
    if (parsed.github && typeof parsed.github === 'object' && parsed.github !== null) {
      for (const [k, v] of Object.entries(parsed.github)) {
        const i = Number(k);
        if (Number.isInteger(i) && typeof v === 'string' && v.trim()) {
          githubKo[i] = v.trim();
        }
      }
    }
    if (!yozmScored.length && !Object.keys(githubKo).length) return null;
    return { yozm: yozmScored, githubKo };
  } catch (err) {
    console.error(`[LLM 보강 실패] ${err?.message ?? err} — 순수 코드로 폴백`);
    return null;
  }
}

// ── 텔레그램 채널 메시지 선별 ───────────────────────────────
const SENTIMENTS = new Set(['bull', 'bear', 'neutral']);

function buildTelegramPrompt(messages, max, interests, prefer, avoid) {
  const input = messages.map((m, i) => ({ id: i, channel: m.channel, text: m.text }));
  const interestLine = interests?.length ? `사용자 관심사: ${interests.join(', ')}. 관심사와 가까울수록 점수를 높인다.` : '';
  return [
    '너는 한국어 뉴스 다이제스트 큐레이터다. 아래는 사용자가 구독한 텔레그램 채널의 최근 메시지다.',
    '뉴스/정보 가치가 높은 "중요" 메시지만 골라 결과 JSON만 출력한다(코드펜스·설명 금지).',
    interestLine,
    prefsLine(prefer, avoid),
    '',
    `- 중요도 높은 순으로 최대 ${max}개의 id 를 고른다.`,
    '- 광고/홍보/이벤트/잡담/인사/단순 리액션/중복 메시지는 제외한다.',
    '- 각 항목에 0~10 정수 중요도 점수(score)를 매긴다.',
    '- 각 항목을 한국어 2~3문장(200자 내외, 따옴표 없이)으로, 핵심 맥락·수치·배경까지 담아 요약한다.',
    '- 각 항목의 분야를 cat 으로 표기한다: IT·기술·개발·AI 관련이면 "it", 그 외 증시·투자·경제·부동산 등은 "econ".',
    '- 증시·투자 관련 항목은 시장 영향 방향을 sentiment 로 표기한다: 강세 "bull", 약세 "bear", 중립/불명 "neutral".',
    '- 고를 만한 게 없으면 items 를 빈 배열로 둔다.',
    '',
    '--- 입력 시작 ---',
    JSON.stringify(input),
    '--- 입력 끝 ---',
    '',
    '출력 형식(이 스키마만): {"items":[{"id":<번호>,"cat":"it"|"econ","score":<0~10>,"sentiment":"bull"|"bear"|"neutral","summary":"요약"},...]}',
  ].join('\n');
}

// 반환: [{ id, cat, score, sentiment, summary }] (중요도순) 또는 실패 시 null
async function enrichTelegram(messages = [], max = 7, interests = [], prefer = [], avoid = []) {
  if (!messages.length) return null;
  try {
    const stdout = await runClaude(buildTelegramPrompt(messages, max, interests, prefer, avoid));
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
        score: clampScore(it.score),
        sentiment: SENTIMENTS.has(it.sentiment) ? it.sentiment : 'neutral',
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
