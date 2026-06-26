'use strict';

// 뉴스 수집기: 모든 데이터를 코드로 직접 취득해 reports/{날짜}.md 에 추기한다.
// LLM 추정(환각)을 배제하기 위해 수치·목록을 실제 소스에서 파싱한다.

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { enrich, enrichTelegram } = require('./enrich');
const { collectTelegramChannels } = require('./collect-telegram');

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
// 요약은 GitHub repo 설명 등 각 소스가 제공하는 텍스트를
// 그대로 쓴다. 글 페이지를 따로 fetch 하지 않으므로 요청 수가 적고 안정적이다.
const SUMMARY_MAX = 100;

// 공백 정리 후 max 길이로 자르고 말줄임표를 붙인다.
const clip = (s, max = SUMMARY_MAX) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max).trim()}…` : t;
};

// 콤마 포함 금융 수치를 숫자로 파싱한다. 빈 값은 NaN 으로 처리해 후속 isFinite 에서 거른다.
const parsePrice = (v) => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  return s === '' ? NaN : Number(s);
};

// ── 수집기 ──────────────────────────────────────────────────

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
  // 후보를 넉넉히 반환하고 최종 5개(AI 관련도순) 선별은 LLM(enrich)이 한다.
  return out.slice(0, 15);
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
  const current = parsePrice(d.closePriceRaw ?? d.closePrice);
  const diff = parsePrice(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice);
  const pctRaw = parsePrice(d.fluctuationsRatio);
  // fluctuationsRatio가 절대값으로 오는 경우 diff 부호와 동기화해 상승/하락 방향을 맞춘다.
  const pct = Math.abs(pctRaw) * Math.sign(diff);
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

// 한국경제 RSS(<item> 목록)에서 제목·링크를 추출한다. CDATA 래핑을 허용한다.
// 헤드라인 자체가 한 줄 요약 역할을 하므로 별도 og:description 은 붙이지 않는다.
async function fetchRssItems(url, limit) {
  const xml = await fetchText(url);
  const pick = (block, tag) => {
    const m = block.match(
      new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)
    );
    return m ? m[1].trim() : '';
  };
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => ({ title: pick(m[1], 'title'), url: pick(m[1], 'link') }))
    .filter((x) => x.title && x.url)
    .slice(0, limit);
  if (!items.length) throw new Error('뉴스 없음');
  return items;
}

// 증권(finance) 피드: 실제 마켓 헤드라인. economy 피드는 기업 PR 위주라 부적합.
const collectMarketNews = () => fetchRssItems('https://www.hankyung.com/feed/finance', 4);

// 지난밤 미국 증시 관련 뉴스: 국제 피드는 일반 세계뉴스(폭염·정치 등)가 섞여 있어,
// 증시·금융 관련 키워드가 제목에 든 글만 추린다. 매칭이 없으면 빈 배열(헤드라인 생략).
const US_MARKET_KW = [
  '뉴욕증시', '나스닥', 'S&P', '다우', '월가', '월스트리트', '연준', '연은', 'Fed', 'FOMC',
  '금리', '인플레', '국채', '달러', '위안화', '엔화', '환율', '증시', '주가', '스테이블코인',
  '펀드', '마진', '관세', '반도체', '엔비디아', '마이크론', '상장', 'IPO',
];
async function collectGlobalNews() {
  const items = await fetchRssItems('https://www.hankyung.com/feed/international', 30);
  return items.filter((n) => US_MARKET_KW.some((kw) => n.title.includes(kw))).slice(0, 3);
}

// 부동산 뉴스.
const collectRealEstateNews = () => fetchRssItems('https://www.hankyung.com/feed/realestate', 4);

// 미국 증시 지수: S&P500(.INX)·나스닥(.IXIC)·다우(.DJI).
// 네이버 해외지수 API. 응답은 국내 지수와 유사하게 콤마 포함 문자열로 오며,
// 등락액·등락률이 이미 부호를 포함한다(domestic collectNaverIndex 와 동일 패턴).
async function collectUsIndices() {
  const SYMS = [
    ['S&P500', '.INX'],
    ['나스닥', '.IXIC'],
    ['다우', '.DJI'],
  ];
  const out = [];
  for (const [name, sym] of SYMS) {
    try {
      const d = await fetchJson(`https://api.stock.naver.com/index/${sym}/basic`, {
        headers: { Referer: 'https://m.stock.naver.com/' },
      });
      const current = parsePrice(d?.closePrice);
      const diff = parsePrice(d?.compareToPreviousClosePrice);
      const pctRaw = parsePrice(d?.fluctuationsRatio);
      if (!Number.isFinite(current) || !Number.isFinite(diff) || !Number.isFinite(pctRaw)) continue;
      // 등락률이 절대값으로 오는 경우 대비, 등락액 부호와 동기화한다.
      const pct = Math.abs(pctRaw) * Math.sign(diff);
      out.push({ name, current, diff, pct });
    } catch (err) {
      console.warn(`[미국 지수] ${name} 수집 실패: ${err?.message ?? err}`);
    }
  }
  if (!out.length) throw new Error('미국 지수 없음');
  return out;
}

// ── 리포트 포맷 ─────────────────────────────────────────────
const FAIL = '[취득 실패]';

function fmtIndex(idx) {
  const L = [];

  const summaryLine = (s) => {
    if (s) L.push(`   └ ${s}`);
  };
  const newsList = (items) => {
    if (items) items.forEach((n, i) => L.push(`${i + 1}. [${n.title}](${n.url})`));
    else L.push(FAIL);
  };
  // 구독 채널 메시지 소블록(해당 카테고리 메시지에 분산 추가). 항목 없으면 미출력.
  const tgBlock = (items) => {
    if (!items?.length) return;
    L.push('');
    L.push('#### 📨 구독 채널 주요 소식');
    items.forEach((m, i) => {
      L.push(`${i + 1}. ${m.channel}`);
      L.push(`   └ ${m.summary || m.text} [바로가기](${m.url})`);
    });
  };

  // ── 💻 IT/기술 ──────────────────────────────────────────────
  L.push('### 💻 IT/기술');
  L.push('');

  L.push('#### 인기 IT 기사 (AI 중심)');
  newsList(idx.yozm);
  L.push('');

  L.push('#### GitHub Trending (당일)');
  if (idx.github) {
    idx.github.forEach((g, i) => {
      L.push(`${i + 1}. [${g.repo}](${g.url})${g.stars ? ` (${g.stars})` : ''}`);
      summaryLine(g.summaryKo || g.desc); // LLM 한글 요약 우선, 없으면 원문 설명
    });
  } else L.push(FAIL);
  tgBlock(idx.telegramIt);
  L.push('');

  // ── 📈 경제/투자 ────────────────────────────────────────────
  L.push('### 📈 경제/투자');
  L.push('');

  L.push('#### 지난밤 미국 증시');
  if (idx.usIndices) {
    idx.usIndices.forEach((d) => {
      // 미 장 시작 전(프리마켓)에는 당일 등락이 0으로 와서 오해를 부르므로 종가만 표기.
      const delta =
        d.diff === 0 && d.pct === 0
          ? '(전일 종가)'
          : `(전일 대비 **${signed(d.diff)} (${signed(d.pct)}%)**)`;
      L.push(`- ${d.name}: **${num(d.current)} pt** ${delta}`);
    });
  } else L.push(`- ${FAIL}`);
  if (idx.globalNews) {
    idx.globalNews.forEach((n) => L.push(`   · [${n.title}](${n.url})`));
  }
  L.push('');

  L.push('#### 국내 지수 (코스피/코스닥)');
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
  newsList(idx.news);
  L.push('');

  L.push('#### 부동산 뉴스 (한국경제)');
  newsList(idx.realEstate);
  tgBlock(idx.telegramEcon);

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
    run('yozm', collectYozm),
    run('github', collectGithub),
    run('news', collectMarketNews),
    run('usIndices', collectUsIndices),
    run('globalNews', collectGlobalNews),
    run('realEstate', collectRealEstateNews),
    run('kospi', () => collectNaverIndex('KOSPI')),
    run('kosdaq', () => collectNaverIndex('KOSDAQ')),
    run('usdkrw', collectUsdKrw),
    run('telegram', collectTelegramChannels), // TG 미설정 시 실패→null(섹션 생략)
  ]);

  // LLM 보강(Claude Code): 요즘IT AI 선별 + GitHub 한글 요약. 실패 시 순수 코드로 폴백.
  const enriched = await enrich({ yozm: idx.yozm ?? [], github: idx.github ?? [] });
  // keep 목록 순서대로 재정렬 후 상위 5개. keep 이 비면 원본 순서 유지(폴백).
  const reorder = (list, keep) =>
    keep?.length
      ? [...new Set(keep)].map((i) => list[i]).filter(Boolean).slice(0, 5)
      : list.slice(0, 5);
  if (idx.yozm) idx.yozm = reorder(idx.yozm, enriched?.yozmKeep);

  // 구독 채널 중요 메시지 선별(LLM): 카테고리(it/econ)와 요약을 받아 두 메시지에 분산.
  // 실패 시 최신 일부를 경제 카테고리로 폴백.
  if (idx.telegram?.length) {
    const picked = await enrichTelegram(idx.telegram, 8);
    const items = picked
      ? picked
          .filter((it) => idx.telegram[it.id])
          .map((it) => ({ ...idx.telegram[it.id], summary: it.summary, cat: it.cat }))
      : idx.telegram.slice(0, 7).map((m) => ({ ...m, cat: 'econ' }));
    idx.telegramIt = items.filter((m) => m.cat === 'it');
    idx.telegramEcon = items.filter((m) => m.cat !== 'it');
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
