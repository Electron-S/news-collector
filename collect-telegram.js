'use strict';

// 내가 구독한 텔레그램 "채널"(broadcast)의 최근 메시지를 수집한다.
// 봇이 아니라 내 계정 세션(TG_SESSION)으로 접근하므로 tg-login.js 로 1회 로그인이 선행돼야 한다.
// 그룹/슈퍼그룹/개인 대화는 제외하고 방향성 채널만 대상으로 한다(사용자 선택 범위).
// 중요 메시지 "선별"은 호출부(enrich)가 LLM으로 수행하고, 여기서는 원문만 모은다(환각 방지).

require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const config = require('./config');
const { clip } = require('./lib/util');

const HOURS = Number(process.env.TG_HOURS || 24); // 최근 N시간 메시지만
const PER_CHANNEL = Number(process.env.TG_PER_CHANNEL || 20); // 채널당 최대 조회 수
const MAX_MESSAGES = Number(process.env.TG_MAX_MESSAGES || 60); // 전체 상한(LLM 입력 보호)
const TEXT_MAX = 600; // 메시지 본문 보관 길이(LLM 요약 입력 — 이메일은 길이 제약이 없어 넉넉히)

// config.telegramChannels allow/deny 규칙으로 채널 제목을 거른다(부분일치, 대소문자 무시).
// deny 우선, allow 가 비어 있으면 전체 허용. 순수 함수(테스트 용이).
function channelAllowed(title, rules = {}) {
  const t = String(title ?? '').toLowerCase();
  const { allow = [], deny = [] } = rules;
  if (deny.some((kw) => t.includes(String(kw).toLowerCase()))) return false;
  if (allow.length && !allow.some((kw) => t.includes(String(kw).toLowerCase()))) return false;
  return true;
}

// 반환: [{ channel, text, url, date(unix s), views }] (최신순), 미설정 시 throw.
async function collectTelegramChannels() {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  const session = process.env.TG_SESSION;
  if (!apiId || !apiHash || !session) {
    throw new Error('TG_API_ID/TG_API_HASH/TG_SESSION 미설정 (tg-login.js 로 로그인 필요)');
  }

  // GramJS는 생성자에서 버전 배너를 stdout 으로 찍는다. collect.js 의 stdout 은
  // 리포트 경로 전용(run.sh가 캡처)이므로, 생성 동안만 stdout 쓰기를 막는다.
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  let client;
  try {
    client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 2,
    });
    client.setLogLevel('none'); // 이후 런타임 로그도 억제
  } finally {
    process.stdout.write = origWrite;
  }

  const cutoff = Math.floor(Date.now() / 1000) - HOURS * 3600;
  const out = [];
  try {
    await client.connect();
    const dialogs = await client.getDialogs({ limit: 200 });
    for (const d of dialogs) {
      if (out.length >= MAX_MESSAGES) break;
      const ent = d.entity;
      // broadcast 채널만: isChannel 이면서 megagroup(슈퍼그룹 채팅)이 아닌 것.
      if (!d.isChannel || !ent || ent.megagroup) continue;

      const title = ent.title || ent.username || '채널';
      if (!channelAllowed(title, config.telegramChannels)) continue; // allow/deny 필터
      let msgs = [];
      try {
        msgs = await client.getMessages(ent, { limit: PER_CHANNEL });
      } catch (err) {
        console.warn(`[텔레그램] 채널 "${title}" 조회 실패: ${err?.message ?? err}`);
        continue;
      }
      for (const m of msgs) {
        if (!m?.message) continue; // 텍스트 없는(미디어/서비스) 메시지 제외
        if (m.date < cutoff) continue;
        // Telegram channel id는 보통 -100{channel_id} 형태; t.me/c/{id} 링크에는 -100 prefix 제거
        const channelId = String(ent.id).replace(/^-100/, '');
        const url = ent.username
          ? `https://t.me/${ent.username}/${m.id}`
          : `https://t.me/c/${channelId}/${m.id}`;
        out.push({
          channel: title,
          text: clip(m.message, TEXT_MAX),
          url,
          date: m.date,
          views: m.views ?? 0,
        });
        if (out.length >= MAX_MESSAGES) break;
      }
    }
  } finally {
    if (client) await client.disconnect().catch((err) => { console.warn('[텔레그램] disconnect 실패:', err?.message ?? err); });
  }

  if (!out.length) throw new Error('최근 채널 메시지 없음');
  out.sort((a, b) => b.date - a.date);
  return out;
}

module.exports = { collectTelegramChannels, channelAllowed };
