// Offline: replace storage and browser before loading the real command.
const assert = require('node:assert/strict');
const row = { encryptBossId:'boss', encryptJobId:'job', lastMessage:'方便发下简历吗' };
const ledger = { jobs:[{ jobId:'job', title:'小程序开发' }], conversations:[row] };
let outgoing;
require.cache[require.resolve('./ledger-store')] = { exports:{
  loadLedger:() => ledger,
  saveLedger:() => {},
} };
require.cache[require.resolve('./browser')] = { exports:{
  replyConversation:async options => {
    outgoing = options;
    return { target:{ bossId:'boss', jobId:'job' }, message:options.message, verify:{ matched:true, delivered:true } };
  },
} };
const { conversationReply } = require('./outreach-commands');
(async () => {
  process.env.BOSS_VALUE = '好的，我自己处理。';
  await conversationReply();
  assert.equal(outgoing.message, process.env.BOSS_VALUE);
  assert.equal(outgoing.messages, undefined, '不得自动追加第二条话术');
  assert.equal(row.lastMessage, process.env.BOSS_VALUE);
  outgoing = undefined;
  process.env.BOSS_VALUE = '';
  await assert.rejects(conversationReply(), /需要用户指定的回复正文/);
  assert.equal(outgoing, undefined, '空正文不得进入浏览器发送');
  console.log('CONVERSATION_REPLY_TEST_OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
