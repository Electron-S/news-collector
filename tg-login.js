'use strict';

// 텔레그램 사용자 계정(MTProto) 1회 로그인 도우미.
// 봇과 별개로 "내가 구독한 채널"을 읽으려면 내 계정 세션이 필요하다.
// 실행: node tg-login.js  → 전화번호·인증코드(·2FA) 입력 → 세션 문자열 출력.
// 출력된 문자열을 .env 의 TG_SESSION 에 저장하면 이후 자동 인증된다.

require('dotenv').config();
const readline = require('readline');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error(
    '.env 에 TG_API_ID, TG_API_HASH 를 먼저 설정하세요.\n' +
      'https://my.telegram.org → API development tools 에서 발급받습니다.'
  );
  process.exit(1);
}

// 한 줄 입력(질문 표시 후 응답 대기).
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => {
    rl.close();
    resolve(ans.trim());
  }));
}

(async () => {
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
  });
  await client.start({
    phoneNumber: () => ask('전화번호(국가코드 포함, 예: +821012345678): '),
    password: () => ask('2단계 인증 비밀번호(없으면 그냥 Enter): '),
    phoneCode: () => ask('받은 인증코드: '),
    onError: (err) => console.error('로그인 오류:', err?.message ?? err),
  });

  const session = client.session.save();
  console.log('\n로그인 성공. 아래 한 줄을 .env 에 추가하세요(외부에 공유 금지):\n');
  console.log(`TG_SESSION=${session}`);
  await client.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('로그인 실패:', err?.message ?? err);
  process.exit(1);
});
