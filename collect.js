'use strict';

// 뉴스 수집기: 모든 데이터를 코드로 직접 취득해 reports/{날짜}.md 에 추기한다.
// LLM 추정(환각)을 배제하기 위해 수치·목록을 실제 소스에서 파싱한다.

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { enrich } = require('./enrich');

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT_MS = 12000;
const REPORTS_DIR = path.join(__dirname, 'reports');

// ── 날짜·시각 (Asia/Seoul 고정) ─────────────────────────────
function kstNow() {
  // sv-SE 로케일은 "YYYY-MM-DD HH:mm" 형식을 보장한다.
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
  const [date, time] = s.split(' ');
  return { date, time, stamp: `${date} ${time} KST` };
}

// ── HTTP (타임아웃 + 재시도) ────────────────────────────────
async function fetchText(url, { method = 'GET', headers = {}, body, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, ...headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (n) => Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const signed = (n) => (n >= 0 ? '+' : '') + num(n);

// ── 1행 요약 ────────────────────────────────────────────────
// 요약은 각 소스가 제공하는 텍스트(velog short_description, GitHub repo 설명)를
// 그대로 쓴다. 글 페이지를 따로 fetch 하지 않으므로 요청 수가 적고 안정적이다.
const SUMMARY_MAX = 100;

// 공백 정리 후 max 길이로 자르고 말줄임표를 붙인다.
const clip = (s, max = SUMMARY_MAX) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max).trim()}…` : t;
};

// ── 수집기 ──────────────────────────────────────────────────

// velog 트렌딩에서 제외할 주제 키워드(취업·면접·개인 회고/일상 등).
// IT 기술·경제 주제 위주로 추리기 위함이며, 제목·태그에 매칭한다.
const VELOG_EXCLUDE = [
  '면접', '합격', '후기', '회고', '취업', '취준', '자소서', '이력서', '채용',
  '인턴', '신입', '일기', '일상', '다이어리', '부트캠프', '코딩테스트', '코테',
  '수강', '졸업', '학점',
];

function isCareerOrPersonal(post) {
  const hay = `${post.title} ${(post.tags ?? []).join(' ')}`.toLowerCase();
  return VELOG_EXCLUDE.some((kw) => hay.includes(kw));
}

async function collectVelog() {
  // short_description 를 함께 받아 글 페이지를 따로 fetch 하지 않는다(요청 수·throttle↓).
  const query =
    'query{trendingPosts(input:{limit:20,timeframe:"day"}){title url_slug short_description tags user{username}}}';
  const data = await fetchJson('https://v3.velog.io/graphql', {
    method: 'POST',
    // velog API는 브라우저 UA + 대량 요청을 스크래핑으로 보고 차단하므로 비브라우저 UA를 보낸다.
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'news-collector/1.0' },
    body: JSON.stringify({ query }),
  });
  const posts = data?.data?.trendingPosts ?? [];
  if (!posts.length) throw new Error('빈 응답');
  // 후보를 넉넉히 반환하고 최종 5개 선별은 LLM(enrich)이 한다.
  // 키워드 필터 순서(기술 우선)는 LLM 미사용 시 폴백(앞 5개)용으로 유지한다.
  const ordered = posts.slice().sort((a, b) => {
    const aEx = isCareerOrPersonal(a);
    const bEx = isCareerOrPersonal(b);
    return aEx === bEx ? 0 : aEx ? 1 : -1;
  });
  return ordered
    .filter((p) => p.user?.username && p.url_slug)
    .slice(0, 15)
    .map((p) => ({
      title: p.title,
      url: `https://velog.io/@${p.user.username}/${p.url_slug}`,
      author: p.user.username,
      summary: clip(p.short_description),
      tags: p.tags ?? [],
    }));
}

async function collectYozm() {
  const html = await fetchText('https://yozm.wishket.com/magazine/');
  const $ = cheerio.load(html);
  const seen = new Set();
  const out = [];
  // 정상 기사 카드만 선택한다(하이라이트 문장 카드 등 비기사 링크 제외).
  $('a[data-testid="landing-article-title-link"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/magazine\/detail\/(\d+)\//);
    if (!m || seen.has(m[1])) return;
    const title = $(el).text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(m[1]);
    out.push({ title, url: `https://yozm.wishket.com${href}` });
  });
  if (!out.length) throw new Error('기사 없음');
  // 요즘IT는 제목만 표시하므로 요약(og:description)을 가져오지 않는다.
  return out.slice(0, 5);
}

async function collectGithub() {
  const html = await fetchText('https://github.com/trending');
  const $ = cheerio.load(html);
  const out = [];
  $('article.Box-row').each((_, el) => {
    const repo = $(el).find('h2 a').attr('href')?.replace(/^\//, '').trim();
    if (!repo) return;
    const desc = clip($(el).find('p').first().text());
    const stars = $(el).find('span.float-sm-right').text().replace(/\s+/g, ' ').trim();
    out.push({ repo, url: `https://github.com/${repo}`, desc, stars });
  });
  if (!out.length) throw new Error('저장소 없음');
  return out.slice(0, 5);
}

// 코스피/코스닥: 네이버 금융 실시간 polling API.
async function collectNaverIndex(code) {
  const data = await fetchJson(
    `https://polling.finance.naver.com/api/realtime/domestic/index/${code}`,
    { headers: { Referer: 'https://finance.naver.com/' } }
  );
  const d = data?.datas?.[0];
  if (!d) throw new Error('데이터 없음');
  // raw 등락액·등락률은 이미 부호를 포함한다(예: 하락 시 "-16.57", "-1.82").
  // 부호를 다시 파생하지 말고 그대로 사용한다.
  const current = Number(d.closePriceRaw ?? String(d.closePrice).replace(/,/g, ''));
  const diff = Number(
    d.compareToPreviousClosePriceRaw ?? String(d.compareToPreviousClosePrice).replace(/,/g, '')
  );
  const pctRaw = Number(String(d.fluctuationsRatio).replace(/,/g, ''));
  // fluctuationsRatio가 절대값으로 오는 경우 diff 부호와 동기화해 상승/하락 방향을 맞춘다.
  const pct = Math.abs(pctRaw) * Math.sign(diff || 1);
  if (!Number.isFinite(current) || !Number.isFinite(diff) || !Number.isFinite(pct))
    throw new Error('값 파싱 실패');
  return { current, diff, pct, marketStatus: d.marketStatus };
}

// USD/KRW: 무료·무키 환율 API.
async function collectUsdKrw() {
  const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
  if (data?.result !== 'success') throw new Error('API 실패');
  const krw = data.rates?.KRW;
  if (!krw) throw new Error('KRW 없음');
  return { current: krw, updated: data.time_last_update_utc };
}

async function collectMarketNews() {
  // 증권(finance) 피드: 실제 마켓 헤드라인. economy 피드는 기업 PR 위주라 부적합.
  const xml = await fetchText('https://www.hankyung.com/feed/finance');
  const pick = (block, tag) => {
    const m = block.match(
      new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)
    );
    return m ? m[1].trim() : '';
  };
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => ({ title: pick(m[1], 'title'), url: pick(m[1], 'link') }))
    .filter((x) => x.title && x.url)
    .slice(0, 4);
  if (!items.length) throw new Error('뉴스 없음');
  // 증권 헤드라인 자체가 한 줄 요약 역할을 한다. 기사 og:description 은
  // "제목, 기자, 증권" 형태로 제목과 중복되므로 별도 요약을 붙이지 않는다.
  return items;
}

// ── 리포트 포맷 ─────────────────────────────────────────────
const FAIL = '[취득 실패]';

function fmtIndex(idx) {
  const L = [];

  const summaryLine = (s) => {
    if (s) L.push(`   └ ${s}`);
  };

  L.push('#### Velog 트렌딩 (상위 5개)');
  if (idx.velog) {
    idx.velog.forEach((p, i) => {
      L.push(`${i + 1}. [${p.title}](${p.url}) — ${p.author}`);
      summaryLine(p.summary);
    });
  } else L.push(FAIL);
  L.push('');

  L.push('#### 요즘IT 인기 기사 (상위 5개)');
  if (idx.yozm) {
    idx.yozm.forEach((a, i) => L.push(`${i + 1}. [${a.title}](${a.url})`));
  } else L.push(FAIL);
  L.push('');

  L.push('#### GitHub Trending (당일)');
  if (idx.github) {
    idx.github.forEach((g, i) => {
      L.push(`${i + 1}. [${g.repo}](${g.url})${g.stars ? ` (${g.stars})` : ''}`);
      summaryLine(g.summaryKo || g.desc); // LLM 한글 요약 우선, 없으면 원문 설명
    });
  } else L.push(FAIL);
  L.push('');

  L.push('#### 코스피/코스닥');
  if (idx.kospi) {
    L.push(`- 코스피: **${num(idx.kospi.current)} pt** (전일 대비 **${signed(idx.kospi.diff)} (${signed(idx.kospi.pct)}%)**)`);
  } else L.push(`- 코스피: ${FAIL}`);
  if (idx.kosdaq) {
    L.push(`- 코스닥: **${num(idx.kosdaq.current)} pt** (전일 대비 **${signed(idx.kosdaq.diff)} (${signed(idx.kosdaq.pct)}%)**)`);
  } else L.push(`- 코스닥: ${FAIL}`);
  L.push('');

  L.push('#### USD/KRW 환율');
  if (idx.usdkrw) {
    L.push(`- 현재값: **${num(idx.usdkrw.current)} 원**`);
  } else L.push(`- ${FAIL}`);
  L.push('');

  L.push('#### 주요 마켓 뉴스 (한국경제 증권)');
  if (idx.news) {
    idx.news.forEach((n, i) => {
      L.push(`${i + 1}. [${n.title}](${n.url})`);
    });
  } else L.push(FAIL);

  return L.join('\n');
}

// ── 메인 ────────────────────────────────────────────────────
async function main() {
  const force = process.argv.includes('--force');
  const { date, stamp } = kstNow();

  const file = path.join(REPORTS_DIR, `${date}.md`);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const sectionHeader = `## 실행: ${date}`;
  if (existing.includes(sectionHeader) && !force) {
    console.error(`이미 오늘(${date}) 리포트가 존재합니다. 재수집하려면 --force 옵션을 사용하세요.`);
    process.exit(3); // 중복 → 건너뜀
  }

  const idx = {};
  const run = async (key, fn) => {
    try {
      idx[key] = await fn();
    } catch (err) {
      idx[key] = null;
      console.error(`[수집 실패] ${key}: ${err?.message ?? err}`);
    }
  };

  // 웹/RSS/금융 소스를 병렬 수집한다(소스가 분산되어 단일 호스트 레이트리밋 영향 없음).
  await Promise.all([
    run('velog', collectVelog),
    run('yozm', collectYozm),
    run('github', collectGithub),
    run('news', collectMarketNews),
    run('kospi', () => collectNaverIndex('KOSPI')),
    run('kosdaq', () => collectNaverIndex('KOSDAQ')),
    run('usdkrw', collectUsdKrw),
  ]);

  // LLM 보강(Claude Code): velog 선별 + GitHub 한글 요약. 실패 시 순수 코드로 폴백.
  const enriched = await enrich({ velog: idx.velog ?? [], github: idx.github ?? [] });
  if (idx.velog) {
    const keep = enriched?.velogKeep;
    const picked = keep?.length
      ? [...new Set(keep)].map((i) => idx.velog[i]).filter(Boolean)
      : idx.velog;
    idx.velog = picked.slice(0, 5);
  }
  if (idx.github && enriched?.githubKo) {
    idx.github.forEach((g, i) => {
      const key = String(i);
      if (Object.prototype.hasOwnProperty.call(enriched.githubKo, key)) {
        g.summaryKo = enriched.githubKo[key];
      }
    });
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const section = `\n${sectionHeader} (취득 시각: ${stamp})\n\n${fmtIndex(idx)}\n`;
  if (!existing) {
    fs.writeFileSync(
      file,
      `# 뉴스 수집 리포트 - ${date}\n\n<!-- 이하에 각 실행 시의 리포트가 추기됩니다 -->\n${section}`
    );
  } else {
    fs.appendFileSync(file, section);
  }

  // 성공 시 마지막 줄에 리포트 경로를 출력한다 (실행 스크립트가 이를 사용).
  process.stdout.write(file + '\n');
}

main().catch((err) => {
  console.error(`치명적 오류: ${err.stack || err.message}`);
  process.exit(1);
});
