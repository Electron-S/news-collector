'use strict';

// 리포트(마크다운)를 HTML 뉴스레터로 렌더해 Gmail SMTP 로 발송한다.
// 텔레그램 전송을 대체한다. 사용법: node mailer.js <리포트.md> [--dry-run]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('./config');

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_TO = process.env.MAIL_TO || SMTP_USER;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;

// ── 인라인 변환 (escape → 굵게 → 링크) ─────────────────────
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function inlineHtml(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(.+?)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" style="color:#2563eb;text-decoration:none">$1</a>');
}

// ── 마크다운 리포트 → 이메일 HTML 본문 (순수 함수) ─────────
// 최근 '## 실행:' 섹션만 렌더한다. `### `=섹션, `#### `=소제목,
// `N.`/`- `=항목, `   └ `/`   · `=보조줄, `⚠️`=경고 배너.
function renderEmail(markdown, { surveyUrl = '', generatedAt = '' } = {}) {
  const all = markdown.split('\n');
  let from = 0;
  for (let i = 0; i < all.length; i++) if (/^##\s+실행:/.test(all[i])) from = i;
  const lines = all.slice(from);

  const out = [];
  let listOpen = false;
  let stamp = '';
  const closeList = () => {
    if (listOpen) {
      out.push('</div>');
      listOpen = false;
    }
  };
  const openList = () => {
    if (!listOpen) {
      out.push('<div style="margin:0 0 6px">');
      listOpen = true;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^##\s+실행:/.test(line)) {
      stamp = line.replace(/^##\s+/, '');
      continue;
    }
    if (/^⚠️/.test(line)) {
      closeList();
      out.push(`<div style="background:#fef3c7;color:#92400e;padding:8px 12px;border-radius:6px;margin:8px 0;font-size:14px">${escapeHtml(line)}</div>`);
      continue;
    }
    const sec = line.match(/^###\s+(.*)$/);
    if (sec) {
      closeList();
      out.push(`<h2 style="font-size:20px;margin:24px 0 8px;padding-bottom:6px;border-bottom:2px solid #e5e7eb">${inlineHtml(sec[1])}</h2>`);
      continue;
    }
    const sub = line.match(/^####\s+(.*)$/);
    if (sub) {
      closeList();
      out.push(`<h3 style="font-size:15px;color:#374151;margin:16px 0 6px">${inlineHtml(sub[1])}</h3>`);
      continue;
    }
    // 보조줄: 요약(└) / 헤드라인(·)
    const subline = line.match(/^\s*(?:└|·)\s+(.*)$/);
    if (subline) {
      openList();
      out.push(`<div style="color:#6b7280;font-size:13px;margin:0 0 6px 14px">${inlineHtml(subline[1])}</div>`);
      continue;
    }
    // 항목: "N. ..." 또는 "- ..."
    const item = line.match(/^\s*(?:\d+\.|-)\s+(.*)$/);
    if (item) {
      openList();
      out.push(`<div style="margin:6px 0 2px;font-size:14px">${inlineHtml(item[1])}</div>`);
      continue;
    }
    // 기타 텍스트
    openList();
    out.push(`<div style="font-size:14px">${inlineHtml(line)}</div>`);
  }
  closeList();

  const footerBits = [];
  if (surveyUrl) {
    footerBits.push(`<a href="${escapeHtml(surveyUrl)}" style="color:#2563eb">관심사 설문 보내기</a> — 응답하면 다음 다이제스트부터 반영됩니다`);
  }
  if (generatedAt) footerBits.push(`생성: ${escapeHtml(generatedAt)}`);
  const footer = footerBits.length
    ? `<div style="margin-top:28px;padding-top:12px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px">${footerBits.join('<br>')}</div>`
    : '';

  const caption = stamp ? `<div style="color:#9ca3af;font-size:12px;margin-bottom:4px">${escapeHtml(stamp)}</div>` : '';
  return [
    '<div style="max-width:640px;margin:0 auto;padding:16px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,\'Helvetica Neue\',Arial,sans-serif;color:#111827;line-height:1.5">',
    caption,
    out.join('\n'),
    footer,
    '</div>',
  ].join('\n');
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('사용법: node mailer.js <리포트_파일_경로> [--dry-run]');
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`파일을 찾을 수 없습니다: ${resolved}`);
    process.exit(1);
  }
  const markdown = fs.readFileSync(resolved, 'utf-8');
  const base = path.basename(resolved, '.md');
  const isWeekly = base.startsWith('weekly-');
  const date = base.replace(/^weekly-/, '');
  const subject = `${config.mail.subjectPrefix}${isWeekly ? ' 주간 리캡' : ''} ${date}`;
  const html = renderEmail(markdown, {
    surveyUrl: config.feedback?.surveyUrl || '',
    generatedAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
  });

  if (process.argv.includes('--dry-run')) {
    const preview = path.join(path.dirname(resolved), 'email-preview.html');
    fs.writeFileSync(preview, html);
    console.log(`[dry-run] 제목: ${subject}`);
    console.log(`[dry-run] HTML ${html.length}자 → 미리보기: ${preview}`);
    return;
  }

  if (!SMTP_USER || !SMTP_PASS) {
    console.error('.env 에 SMTP_USER, SMTP_PASS(Gmail 앱 비밀번호)를 설정하세요.');
    process.exit(1);
  }
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } });
  await transport.sendMail({ from: MAIL_FROM, to: MAIL_TO, subject, html });
  console.log(`이메일 전송 완료: ${subject} → ${MAIL_TO}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`이메일 전송 실패: ${err?.message ?? err}`);
    process.exit(1);
  });
}

module.exports = { renderEmail, inlineHtml, escapeHtml };
