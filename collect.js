'use strict';

// 뉴스 수집기: 모든 데이터를 코드로 직접 취득해 reports/{날짜}.md 에 추기한다.
// LLM 추정(환각)을 배제하기 위해 수치·목록을 실제 소스에서 파싱한다.

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

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

// ── 수집기 ──────────────────────────────────────────────────
async function collectVelog() {
  const query =
    'query{trendingPosts(input:{limit:5,timeframe:"day"}){title url_slug user{username}}}';
  const data = await fetchJson('https://v3.velog.io/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const posts = data?.data?.trendingPosts ?? [];
  if (!posts.length) throw new Error('빈 응답');
  return posts.slice(0, 5).map((p) => ({
    title: p.title,
    url: `https://velog.io/@${p.user.username}/${p.url_slug}`,
    author: p.user.username,
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
  return out.slice(0, 5);
}

async function collectGithub() {
  const html = await fetchText('https://github.com/trending');
  const $ = cheerio.load(html);
  const out = [];
  $('article.Box-row').each((_, el) => {
    const repo = $(el).find('h2 a').attr('href')?.replace(/^\//, '').trim();
    if (!repo) return;
    const desc = $(el).find('p').first().text().replace(/\s+/g, ' ').trim();
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
  const current = Number(d.closePriceRaw ?? String(d.closePrice).replace(/,/g, ''));
  const mag = Number(
    d.compareToPreviousClosePriceRaw ?? String(d.compareToPreviousClosePrice).replace(/,/g, '')
  );
  const ratio = Math.abs(Number(String(d.fluctuationsRatio).replace(/,/g, '')));
  const falling = /FALLING|LOWER_LIMIT/.test(d.compareToPreviousPrice?.name ?? '');
  const sign = falling ? -1 : 1;
  if (!Number.isFinite(current) || !Number.isFinite(mag)) throw new Error('값 파싱 실패');
  return { current, diff: mag * sign, pct: ratio * sign, marketStatus: d.marketStatus };
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
  const xml = await fetchText('https://www.hankyung.com/feed/economy');
  const pick = (block, tag) => {
    const m = block.match(
      new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)
    );
    return m ? m[1].trim() : '';
  };
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => ({ title: pick(m[1], 'title'), url: pick(m[1], 'link') }))
    .filter((x) => x.title && x.url)
    .slice(0, 3);
  if (!items.length) throw new Error('뉴스 없음');
  return items;
}

// ── 리포트 포맷 ─────────────────────────────────────────────
const FAIL = '[취득 실패]';

function fmtIndex(idx, stamp) {
  const L = [];
  L.push('### 기술 정보\n');

  L.push('#### Velog 트렌딩 (상위 5개)');
  L.push(`취득 시각: ${stamp}`);
  if (idx.velog) {
    idx.velog.forEach((p, i) => L.push(`${i + 1}. [${p.title}](${p.url}) — ${p.author}`));
  } else L.push(FAIL);
  L.push('');

  L.push('#### 요즘IT 인기 기사 (상위 5개)');
  L.push(`취득 시각: ${stamp}`);
  if (idx.yozm) {
    idx.yozm.forEach((a, i) => L.push(`${i + 1}. [${a.title}](${a.url})`));
  } else L.push(FAIL);
  L.push('');

  L.push('#### GitHub Trending (당일)');
  L.push(`취득 시각: ${stamp}`);
  if (idx.github) {
    idx.github.forEach((g, i) =>
      L.push(`${i + 1}. [${g.repo}](${g.url})${g.desc ? ` — ${g.desc}` : ''}${g.stars ? ` (${g.stars})` : ''}`)
    );
  } else L.push(FAIL);
  L.push('');

  L.push('### 경제 정보\n');

  L.push('#### 코스피/코스닥');
  L.push(`취득 시각: ${stamp}`);
  if (idx.kospi) {
    L.push(`- 코스피: **${num(idx.kospi.current)} pt** (전일 대비 **${signed(idx.kospi.diff)} (${signed(idx.kospi.pct)}%)**)`);
  } else L.push(`- 코스피: ${FAIL}`);
  if (idx.kosdaq) {
    L.push(`- 코스닥: **${num(idx.kosdaq.current)} pt** (전일 대비 **${signed(idx.kosdaq.diff)} (${signed(idx.kosdaq.pct)}%)**)`);
  } else L.push(`- 코스닥: ${FAIL}`);
  L.push('');

  L.push('#### USD/KRW 환율');
  L.push(`취득 시각: ${stamp}`);
  if (idx.usdkrw) {
    L.push(`- 현재값: **${num(idx.usdkrw.current)} 원**`);
  } else L.push(`- ${FAIL}`);
  L.push('');

  L.push('#### 주요 마켓 뉴스');
  if (idx.news) {
    idx.news.forEach((n, i) => L.push(`${i + 1}. [${n.title}](${n.url})`));
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

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const section = `\n${sectionHeader} (취득 시각: ${stamp})\n\n${fmtIndex(idx, stamp)}\n`;
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
