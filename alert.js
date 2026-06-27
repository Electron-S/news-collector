'use strict';

// 하드 실패(수집 크래시/전송 실패) 시 텔레그램으로 짧은 관리자 알림을 보낸다.
// 사용법: node alert.js "메시지". 토큰 미설정이거나 전송 실패해도 조용히 종료(0)한다.

const { TOKEN, CHAT_ID, http } = require('./lib/telegram');

const msg = process.argv.slice(2).join(' ').trim() || '뉴스 수집기 알림';

if (!TOKEN || !CHAT_ID) process.exit(0);

http
  .post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text: `⚠️ [뉴스 수집기] ${msg}`,
    disable_web_page_preview: true,
  })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`알림 전송 실패: ${err?.message ?? err}`);
    process.exit(0);
  });
