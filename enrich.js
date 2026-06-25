'use strict';

// LLM 보강: Claude Code(claude -p, Sonnet)를 헤드리스로 호출해
//  1) velog 후보 중 IT·기술·경제 관련 글만 선별(취업/회고/스팸/무관 글 제외)
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
      (err, stdout) => {
        if (err) return reject(err);
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

function buildPrompt(velog, github) {
  const input = {
    velog: velog.map((p, i) => ({ id: i, title: p.title, tags: p.tags ?? [] })),
    github: github.map((g, i) => ({ id: i, repo: g.repo, desc: g.desc })),
  };
  return [
    '너는 한국어 IT/경제 데일리 다이제스트 큐레이터다. 아래 입력을 보고 결과 JSON만 출력한다(코드펜스·설명 금지).',
    '',
    '1) VELOG 후보(개발 블로그 트렌딩) 중 IT·기술·개발·경제와 관련이 높은 항목 id를 관련도순으로 최대 5개 고른다.',
    '   취업/면접/합격/회고/일상 글, 광고·스팸성(예: 카드현금화·대출·도박), 주제 무관 글은 제외한다.',
    '2) GITHUB 각 repo의 기능을 한국어 한 문장(40자 이내, 따옴표 없이)으로 요약한다.',
    '',
    '--- 입력 시작 ---',
    JSON.stringify(input),
    '--- 입력 끝 ---',
    '',
    '출력 형식(이 스키마만): {"velogKeep":[id,...],"github":{"<id>":"요약",...}}',
  ].join('\n');
}

// 반환: { velogKeep: number[], githubKo: Record<number,string> } 또는 실패 시 null
async function enrich({ velog = [], github = [] }) {
  if (!velog.length && !github.length) return null;
  try {
    const stdout = await runClaude(buildPrompt(velog, github));
    const parsed = parseResult(stdout);
    const velogKeep = Array.isArray(parsed.velogKeep)
      ? parsed.velogKeep.filter((n) => Number.isInteger(n) && n >= 0 && n < velog.length)
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
    if (!velogKeep.length && !Object.keys(githubKo).length) return null;
    return { velogKeep, githubKo };
  } catch (err) {
    console.error(`[LLM 보강 실패] ${err?.message ?? err} — 순수 코드로 폴백`);
    return null;
  }
}

module.exports = { enrich };
