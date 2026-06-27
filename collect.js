'use strict';

// 뉴스 수집기: 모든 데이터를 코드로 직접 취득해 reports/{날짜}.md 에 추기한다.
// LLM 추정(환각)을 배제하기 위해 수치·목록을 실제 소스에서 파싱한다.

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { enrich, enrichTelegram } = require('./enrich');
const { collectTelegramChannels } = require('./collect-telegram');
const config = require('./config');
const state = require('./lib/state');
const { gravityScore, jaccard, dedupeSimilar, interestBoost } = require('./lib/rank');

const WEIGHTS_FILE = path.join(state.STATE_DIR, 'weights.json');
const { clip: clipBase, sleep } = require('./lib/util');

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

const num = (n) => Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const signed = (n) => (n >= 0 ? '+' : '') + num(n);

// ── 1행 요약 ────────────────────────────────────────────────
// 요약은 GitHub repo 설명 등 각 소스가 제공하는 텍스트를
// 그대로 쓴다. 글 페이지를 따로 fetch 하지 않으므로 요청 수가 적고 안정적이다.
const SUMMARY_MAX = 100;
const clip = (s, max = SUMMARY_MAX) => clipBase(s, max);

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
  // 후보를 넉넉히 반환하고 LLM이 중요도 점수를 매겨 임계값 이상 상위 N개를 선별한다.
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
  // 후보를 넉넉히 반환하고 중복 제거 없이 unseen 처리 후 config.counts.github 개로 자른다.
  return out.slice(0, 15);
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

// RSS XML(<item> 목록)에서 제목·링크를 추출하는 순수 함수. CDATA 래핑을 허용한다.
// 네트워크가 없어 단위테스트가 쉽다.
function parseRssItems(xml, limit = Infinity) {
  const pick = (block, tag) => {
    const m = block.match(
      new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)
    );
    return m ? m[1].trim() : '';
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => ({ title: pick(m[1], 'title'), url: pick(m[1], 'link') }))
    .filter((x) => x.title && x.url)
    .slice(0, limit);
}

// 한국경제 RSS 후보를 가져온다(헤드라인 자체가 한 줄 요약 역할).
async function fetchRssItems(url, limit) {
  const items = parseRssItems(await fetchText(url), limit);
  if (!items.length) throw new Error('뉴스 없음');
  return items;
}

// 증권(finance) 피드: 실제 마켓 헤드라인. 후보를 넉넉히 받아 중복 제거 후 자른다.
const collectMarketNews = () => fetchRssItems(config.feeds.marketNews, 12);

// 지난밤 미국 증시 관련 뉴스: 국제 피드는 일반 세계뉴스(폭염·정치 등)가 섞여 있어,
// 증시·금융 키워드가 제목에 든 글만 추린다. 매칭이 없으면 빈 배열(헤드라인 생략).
async function collectGlobalNews() {
  const items = await fetchRssItems(config.feeds.globalNews, 30);
  return items.filter((n) => config.usMarketKeywords.some((kw) => n.title.includes(kw)));
}

// 부동산 뉴스.
const collectRealEstateNews = () => fetchRssItems(config.feeds.realEstate, 12);

// ── 해외 IT 커뮤니티 (Hacker News + Reddit): 코드로 인기·시간감쇠 랭킹 ──
// 영문 제목 그대로 노출(개발자 대상). 환각 방지를 위해 LLM 번역은 하지 않는다.

// Hacker News front page (Algolia API, 무키). points·댓글수·작성시각 포함.
async function collectHackerNews() {
  const data = await fetchJson(
    `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${config.hackerNews.fetch}`
  );
  const nowSec = Date.now() / 1000;
  return (data?.hits ?? [])
    .filter((h) => h.title)
    .map((h) => ({
      source: 'HN',
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: Number(h.points) || 0,
      comments: Number(h.num_comments) || 0,
      ageHours: Math.max(0, (nowSec - Number(h.created_at_i)) / 3600),
    }))
    .filter((h) => Number.isFinite(h.ageHours));
}

// Reddit 지정 서브레딧 top(당일). 비브라우저 UA 필요.
async function collectReddit() {
  const out = [];
  const nowSec = Date.now() / 1000;
  for (const sub of config.reddit.subreddits) {
    try {
      const data = await fetchJson(
        `https://www.reddit.com/r/${sub}/top.json?t=day&limit=${config.reddit.perSub}`,
        { headers: { 'User-Agent': 'news-collector/1.0' } }
      );
      for (const c of data?.data?.children ?? []) {
        const p = c.data;
        if (!p?.title) continue;
        out.push({
          source: `r/${sub}`,
          title: p.title,
          url: `https://www.reddit.com${p.permalink}`,
          points: Number(p.score) || 0,
          comments: Number(p.num_comments) || 0,
          ageHours: Math.max(0, (nowSec - Number(p.created_utc)) / 3600),
        });
      }
    } catch (err) {
      console.warn(`[Reddit] r/${sub} 수집 실패: ${err?.message ?? err}`);
    }
  }
  return out.filter((h) => Number.isFinite(h.ageHours));
}

// HN+Reddit 후보를 합쳐 중력점수(+관심·피드백 가중)로 랭킹한다. 최종 자르기는 main 이 한다.
async function collectHnReddit(kwWeights = {}) {
  const [hn, rd] = await Promise.all([
    collectHackerNews().catch(() => []),
    collectReddit().catch(() => []),
  ]);
  const all = [...hn, ...rd];
  if (!all.length) throw new Error('HN/Reddit 없음');
  // 인기·시간감쇠(중력) × 관심 가중(피드백 학습 반영).
  for (const it of all) {
    it.score = gravityScore(it.points, it.ageHours) * interestBoost(it.title, config.interests, kwWeights);
  }
  return all.sort((a, b) => b.score - a.score);
}

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
  // withSentiment=true(경제 블록)면 강세/약세/중립을 채널명 앞에 이모지로 표기(P6).
  const SENT_EMOJI = { bull: '📈', bear: '📉', neutral: '➖' };
  const tgBlock = (items, withSentiment = false) => {
    if (!items?.length) return;
    L.push('');
    L.push('#### 📨 구독 채널 주요 소식');
    items.forEach((m, i) => {
      const tag = withSentiment && m.sentiment ? `${SENT_EMOJI[m.sentiment] || ''} ` : '';
      L.push(`${i + 1}. ${tag}${m.channel}`);
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
  L.push('');

  L.push('#### 해외 IT 토픽 (Hacker News)');
  if (idx.hnReddit?.length) {
    idx.hnReddit.forEach((h, i) => {
      L.push(`${i + 1}. [${h.title}](${h.url}) — ${h.source} ▲${h.points}·💬${h.comments}`);
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
  tgBlock(idx.telegramEcon, true); // 경제 블록: 감성 태그 표기

  return L.join('\n');
}

// 수집 실패 키 → 사람이 읽는 이름(실패 경고 표기용).
const SOURCE_LABEL = {
  yozm: '요즘IT', github: 'GitHub', news: '마켓뉴스', usIndices: '미국증시',
  globalNews: '국제뉴스', realEstate: '부동산', kospi: '코스피', kosdaq: '코스닥',
  usdkrw: '환율', hnReddit: 'HN/Reddit', telegram: '텔레그램채널',
};

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

  // 피드백 학습 가중 로드(P1). prefer/avoid 는 LLM 프롬프트에, kw 가중은 HN 랭킹에 반영.
  const weights = state.loadJson(WEIGHTS_FILE, { kw: {}, source: {} });
  const kwWeights = weights.kw || {};
  const kwEntries = Object.entries(kwWeights);
  const prefer = kwEntries.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  const avoid = kwEntries.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, 5).map(([k]) => k);

  const idx = {};
  const failures = [];
  const run = async (key, fn) => {
    try {
      idx[key] = await fn();
    } catch (err) {
      idx[key] = null;
      failures.push(key);
      console.error(`[수집 실패] ${key}: ${err?.message ?? err}`);
    }
  };

  // 웹/RSS/금융 소스를 병렬 수집한다(소스가 분산되어 단일 호스트 레이트리밋 영향 없음).
  await Promise.all([
    run('yozm', collectYozm),
    run('github', collectGithub),
    run('hnReddit', () => collectHnReddit(kwWeights)),
    run('news', collectMarketNews),
    run('usIndices', collectUsIndices),
    run('globalNews', collectGlobalNews),
    run('realEstate', collectRealEstateNews),
    run('kospi', () => collectNaverIndex('KOSPI')),
    run('kosdaq', () => collectNaverIndex('KOSDAQ')),
    run('usdkrw', collectUsdKrw),
    run('telegram', collectTelegramChannels), // TG 미설정 시 실패→null(섹션 생략)
  ]);

  // ── 중복 제거: 최근 N일 보낸 URL 제외 + 근접중복(제목 유사) 제거(단일 실행 내 + 교차일) ──
  const seen = state.prune(state.loadSeen(), config.dedupWindowDays, Date.now());
  const titlesForDedup = state.recentTitles(seen); // 교차일 근접중복 비교용(P3)
  const titleFresh = (title) =>
    !titlesForDedup.some((t) => jaccard(t, title) >= config.nearDupThreshold);
  const unseen = (items) =>
    (items || []).filter((it) => it.url && !state.isSeen(seen, it.url) && titleFresh(it.title || ''));
  const dedupNews = (items, n) =>
    dedupeSimilar(unseen(items), (x) => x.title, config.nearDupThreshold).slice(0, n);

  if (idx.yozm) idx.yozm = unseen(idx.yozm); // 후보 유지(LLM 선별)
  if (idx.github) idx.github = unseen(idx.github).slice(0, config.counts.github);
  if (idx.news) idx.news = dedupNews(idx.news, config.counts.marketNews);
  if (idx.globalNews) idx.globalNews = dedupNews(idx.globalNews, config.counts.globalNews);
  if (idx.realEstate) idx.realEstate = dedupNews(idx.realEstate, config.counts.realEstate);
  if (idx.hnReddit) idx.hnReddit = dedupNews(idx.hnReddit, config.counts.hnReddit);
  if (idx.telegram) idx.telegram = unseen(idx.telegram); // 후보 유지(LLM 선별)

  // ── LLM 보강: 요즘IT 점수·선별 + GitHub 한글 요약. 실패 시 순수 코드 폴백 ──
  const enriched = await enrich({
    yozm: idx.yozm ?? [],
    github: idx.github ?? [],
    interests: config.interests,
    prefer,
    avoid,
  });
  if (idx.yozm) {
    const cand = idx.yozm;
    const picks = enriched?.yozm;
    idx.yozm = picks?.length
      ? picks
          .filter((p) => p.score >= config.scoreThreshold && cand[p.id])
          .map((p) => ({ ...cand[p.id], score: p.score })) // 점수 부착(주간 리캡용)
          .slice(0, config.counts.yozm)
      : cand.slice(0, config.counts.yozm); // 폴백: 원본 순서
  }
  if (idx.github && enriched?.githubKo) {
    idx.github.forEach((g, i) => {
      if (Object.prototype.hasOwnProperty.call(enriched.githubKo, String(i))) {
        g.summaryKo = enriched.githubKo[String(i)];
      }
    });
  }

  // ── 구독 채널 중요 메시지: LLM 점수·분류(it/econ)·요약 → 임계값 통과분만 두 메시지로 분산 ──
  if (idx.telegram?.length) {
    const cand = idx.telegram;
    const picked = await enrichTelegram(cand, config.counts.telegram, config.interests, prefer, avoid);
    const items = picked
      ? picked
          .filter((it) => it.score >= config.scoreThreshold && cand[it.id])
          .map((it) => ({ ...cand[it.id], summary: it.summary, cat: it.cat, sentiment: it.sentiment, score: it.score }))
      : cand.slice(0, config.counts.telegram).map((m) => ({ ...m, cat: 'econ', sentiment: 'neutral', score: 0 }));
    idx.telegramIt = items.filter((m) => m.cat === 'it');
    idx.telegramEcon = items.filter((m) => m.cat !== 'it');
  }

  // ── 실패 경고: 핵심 소스 실패 시 메시지 상단에 표기(텔레그램은 미설정이면 제외) ──
  const tgConfigured = Boolean(process.env.TG_SESSION);
  const warned = failures.filter((k) => k !== 'telegram' || tgConfigured);
  const warnLine = warned.length
    ? `\n⚠️ 일부 수집 실패: ${warned.map((k) => SOURCE_LABEL[k] || k).join(', ')}\n`
    : '';

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const section = `\n${sectionHeader} (취득 시각: ${stamp})\n${warnLine}\n${fmtIndex(idx)}\n`;
  if (!existing) {
    fs.writeFileSync(
      file,
      `# 뉴스 수집 리포트 - ${date}\n\n<!-- 이하에 각 실행 시의 리포트가 추기됩니다 -->\n${section}`
    );
  } else {
    fs.appendFileSync(file, section);
  }

  // ── 상태 갱신: 노출 항목을 seen(중복) + history(주간 리캡) 에 기록 ──
  // 각 항목을 {category, source, title, url, score} 로 정규화한다.
  const norm = (it, category) => ({
    category,
    source: it.source || it.channel || (it.repo ? 'GitHub' : ''),
    title: it.title || it.summary || it.repo || '',
    url: it.url,
    score: Number(it.score) || 0,
  });
  const shownIt = [
    ...(idx.yozm || []).map((x) => norm(x, 'it')),
    ...(idx.github || []).map((x) => norm(x, 'it')),
    ...(idx.hnReddit || []).map((x) => norm(x, 'it')),
    ...(idx.telegramIt || []).map((x) => norm(x, 'it')),
  ];
  const shownEcon = [
    ...(idx.news || []).map((x) => norm(x, 'econ')),
    ...(idx.globalNews || []).map((x) => norm(x, 'econ')),
    ...(idx.realEstate || []).map((x) => norm(x, 'econ')),
    ...(idx.telegramEcon || []).map((x) => norm(x, 'econ')),
  ];
  const allShown = [...shownIt, ...shownEcon];
  const now = Date.now();
  for (const it of allShown) {
    if (it.url) state.markSeen(seen, it.url, now, it.title);
  }
  state.saveSeen(seen);
  for (const it of allShown) {
    if (it.url) state.appendHistory({ ts: now, date, ...it }); // P2 이력
  }
  state.trimHistory(30, now);

  // 성공 시 마지막 줄에 리포트 경로를 출력한다 (실행 스크립트가 이를 사용).
  process.stdout.write(file + '\n');
}

// 직접 실행될 때만 main() 을 돈다(테스트에서 require 가능하도록).
if (require.main === module) {
  main().catch((err) => {
    console.error(`치명적 오류: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { parsePrice, parseRssItems, fmtIndex };
