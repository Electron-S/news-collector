'use strict';

// 하드 실패(수집 크래시/메일 발송 실패) 시 관리자에게 이메일 알림을 보낸다.
// 사용법: node alert.js "메시지". 미설정이거나 실패해도 조용히 종료(0)한다.

require('dotenv').config();
const nodemailer = require('nodemailer');

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_TO = process.env.MAIL_TO || SMTP_USER;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const msg = process.argv.slice(2).join(' ').trim() || '뉴스 수집기 알림';

if (!SMTP_USER || !SMTP_PASS) process.exit(0);

const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } });
transport
  .sendMail({ from: MAIL_FROM, to: MAIL_TO, subject: '⚠️ 뉴스 수집기 실패', text: msg })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`알림 전송 실패: ${err?.message ?? err}`);
    process.exit(0);
  });
