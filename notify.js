'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const axios = require('axios');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  console.error('.env 파일에 TELEGRAM_BOT_TOKEN과 TELEGRAM_CHAT_ID를 설정하세요.');
  process.exit(1);
}

const ipv4Agent = new https.Agent({ family: 4 });
const http = axios.create({ httpsAgent: ipv4Agent, timeout: 15000 });
const API = `https://api.telegram.org/bot${TOKEN}`;

const CHUNK_LIMIT = 4000; // Telegram 4096자 한도 - 안전 여유
const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 마크다운 → Telegram HTML 변환 ───────────────────────────
// 리포트가 쓰는 부분집합만 변환한다: 헤더(#), 굵게(**), 링크([](url)).
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\[(.+?)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function mdToHtml(md) {
  return md
    .split('\n')
    .filter((line) => !/^\s*<!--/.test(line)) // 텔레그램에서 불필요한 주석 줄 제거
    .map((line) => {
      const escaped = escapeHtml(line);
      const header = escaped.match(/^#{1,6}\s+(.*)$/);
      if (header) return `<b>${renderInline(header[1])}</b>`;
      return renderInline(escaped);
    })
    .join('\n');
}

// ── 줄 경계 기준 분할 (단어·태그 중간 절단 방지) ────────────
function splitByLines(text, limit) {
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    // 한 줄이 한도를 넘으면 문자 단위로 강제 분할(드문 경우).
    if (line.length > limit) {
      if (buf) {
        chunks.push(buf);
        buf = '';
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (buf.length + line.length + 1 > limit) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// ── 전송 (재시도 + 429 백오프) ──────────────────────────────
async function sendChunk(text) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await http.post(`${API}/sendMessage`, {
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      return;
    } catch (err) {
      const status = err.response?.status;
      const retryAfter = err.response?.data?.parameters?.retry_after;
      const last = attempt === MAX_RETRIES;
      if (status === 429 && retryAfter && !last) {
        console.error(`429 레이트리밋 — ${retryAfter}s 대기 후 재시도 (${attempt}/${MAX_RETRIES})`);
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      if (!last) {
        console.error(`전송 오류(${status ?? err.code}) — 재시도 (${attempt}/${MAX_RETRIES})`);
        await sleep(1000 * attempt);
        continue;
      }
      const detail = err.response?.data?.description ?? err.message;
      throw new Error(detail);
    }
  }
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('사용법: node notify.js <리포트_파일_경로>');
    process.exit(1);
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`파일을 찾을 수 없습니다: ${resolved}`);
    process.exit(1);
  }

  const content = fs.readFileSync(resolved, 'utf-8').trim();
  if (!content) {
    console.error('리포트가 비어 있습니다.');
    process.exit(1);
  }

  // 같은 파일에 실행 섹션이 누적될 수 있으므로(--force 재수집 등) 가장 최근 실행만 전송한다.
  const allLines = content.split('\n');
  let from = 0;
  for (let i = 0; i < allLines.length; i++) {
    if (/^##\s+실행:/.test(allLines[i])) from = i;
  }

  // 카테고리(### …) 경계로 갈라 메시지를 만든다. collect.js 는 IT/경제(+선택 채널) 카테고리를
  // '### ' 헤더로 출력한다. 헤더 이전의 실행시각(preamble)은 모든 메시지 머리말로 공유.
  const preamble = [];
  const blocks = [];
  for (const line of allLines.slice(from)) {
    if (/^###\s/.test(line)) blocks.push([line]);
    else if (blocks.length) blocks[blocks.length - 1].push(line);
    else preamble.push(line);
  }
  const stamp = preamble.join('\n').trim();

  // '### ' 카테고리가 없으면(예: 구버전 리포트) 전체를 단일 메시지로 폴백.
  const sources = blocks.length ? blocks.map((b) => b.join('\n')) : [content];
  // 각 카테고리에 시각 머리말을 얹어 standalone 메시지로 만든 뒤 4000자 청크로 분할.
  const messages = sources.map((md) =>
    splitByLines(mdToHtml(stamp ? `${stamp}\n\n${md}` : md), CHUNK_LIMIT)
  );

  if (process.argv.includes('--dry-run')) {
    console.log(`[dry-run] ${messages.length}개 카테고리 메시지 (한도 ${CHUNK_LIMIT}자)`);
    messages.forEach((chunks, mi) =>
      chunks.forEach((c, i) =>
        console.log(`=== 메시지 ${mi + 1} chunk ${i + 1} (${c.length}자) ===\n${c}\n`)
      )
    );
    return;
  }

  try {
    let sent = 0;
    for (const chunks of messages) {
      // blocks 순서 = collect 출력 순서(IT 먼저, 경제 나중).
      for (const chunk of chunks) {
        await sendChunk(chunk);
        sent++;
        await sleep(1200); // 연속 전송 레이트리밋 완화
      }
    }
    console.log(`Telegram 알림 전송 완료(${messages.length}개 카테고리, ${sent}개 메시지): ${resolved}`);
  } catch (err) {
    console.error(`Telegram 전송 실패: ${err.message}`);
    process.exit(1);
  }
}

main();
