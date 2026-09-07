const { PORT, BUDGET_FILE, reserveAction, throwSecurity, humanPause, sleepMs } = require('./safety');
const cdpLib = () => require('./cdp');
const { arg, positional, jobIdOf } = require('./cli-args');
const { loadDailyOptions } = require('./daily-options');
const { loadLedger, saveLedger } = require('./ledger-store');
const {
  PROFILES, addDecision, matchProfile, recruiterFromButton, priorContactReason,
  ensureJob,
} = require('./job-domain');
const { hydrateLegacyStructured, jdHashOf, normalizeStructuredPage } = require('./jd-domain');
const { conversationStatus, currentConversations, resumeTrigger } = require('./conversation-domain');
const { resumeForJob } = require('./conversation-workbench');
const {
  waitForJobPage, waitForChatReady,
  isClosedJobText, isExpiredJobRedirect,
} = require('./page-flows');
const { validateOpener, openerStyle, assertSendReady, assertAiReady, assertOpenerFits, assertOpenerFresh, openerLengthReason, detectSendBlock, generateOpener, factAnchorReason } = require('./opener-service');
const { companyEvidenceTerms, normalizeDeliveryText, buildDeliveryVerifyExpr, sentVerification } = require('./delivery-verification');
const now = () => new Date().toISOString();

async function sendMessage(url, message) {
  const id = jobIdOf(url);
  if (!id || !message) throw new Error('需要岗位链接和 MSG/--message');
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(x => x.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error('岗位未进入台账，请先 read');
  ledger.jobs[index] = job;
  message = validateOpener(message, { allowQuestion: openerStyle(job) === 'project' });
  assertAiReady(ledger, job);
  const resumeChat = job.outreach?.status === 'chat_created_not_sent' || process.argv.includes('--resume-chat');

  const staticReason = resumeChat ? '' : priorContactReason(ledger, job);
  // 静态去重命中时不联网，不占额度；真要发才计入 sends，并连带计一次详情页
  if (!staticReason && !resumeChat) await reserveAction('sends', `${id} ${job.title}`, BUDGET_FILE, ['jobReads']);
  if (staticReason) {
    job.outreach = { status: 'skipped_communicated', message, evidencePath: '', verify: null, target: { title: job.title, company: job.company }, sentAt: now() };
    job.nextAction = staticReason;
    addDecision(job, 'dedup', 'reject', 'prior_contact', staticReason, job.recruiter?.encryptBossId || '');
    saveLedger(ledger);
    console.log(`STATIC_SKIPPED (${staticReason}) ${id} ${job.title} @ ${job.company}`);
    return;
  }

  const { openTab, closeTab } = cdpLib();
  const originalCdp = await openTab(url, PORT);
  let cdp = originalCdp;
  let sendConnections = [originalCdp];
  let sendTabIds = new Set([originalCdp.tabId]);
  try {
    const preflight = await waitForJobPage(cdp, id);
    if (preflight.security) throwSecurity('发送前岗位页进入安全验证', `${id} ${job.url}`);
    if (isClosedJobText(preflight.bodyText)) {
      job.outreach = { status: 'skipped_closed', message, evidencePath: '', verify: null, target: { title: job.title, company: job.company }, sentAt: now() };
      job.nextAction = '职位已关闭';
      addDecision(job, 'send_gate', 'reject', 'closed', job.nextAction, '职位已关闭');
      saveLedger(ledger);
      console.log(`SKIPPED_CLOSED ${id} ${job.title} @ ${job.company}`);
      return;
    }
    if (jobIdOf(preflight.url) !== id || !preflight.button?.text) throw new Error('发送前岗位页或沟通按钮核验失败');
    const actual = normalizeStructuredPage(preflight);
    if (actual.structured.incomplete) throw new Error('发送前 JD 变为不完整，已停止');
    const storedCompanyPrefix = String(job.company || '').replace(/(?:\.\.\.|…)+$/, '');
    if (storedCompanyPrefix && /\.\.\.|…/.test(job.company || '') && actual.structured.company?.startsWith(storedCompanyPrefix)) {
      job.company = actual.structured.company;
      job.jd.structured.company = actual.structured.company;
      job.jd.hash = jdHashOf(job.jd.structured);
    }
    if (job.jd.hash && actual.hash !== job.jd.hash) throw new Error('JD 自上次审核后已变化，请重新 read 和 review');
    const liveRecruiter = recruiterFromButton(preflight.button, actual.structured.recruiter.name, actual.structured.company);
    job.recruiter = liveRecruiter;
    if (job.title && actual.structured.title && job.title !== actual.structured.title) throw new Error(`岗位标题不一致：${job.title} / ${actual.structured.title}`);
    if (job.company && actual.structured.company && job.company !== actual.structured.company) {
      const prefix = job.company.replace(/(?:\.\.\.|…)+$/, '');
      if (prefix && actual.structured.company.startsWith(prefix)) job.company = actual.structured.company;
      else throw new Error(`公司不一致：${job.company} / ${actual.structured.company}`);
    }
    const liveReason = priorContactReason(ledger, job, liveRecruiter);
    if (!resumeChat && (liveReason || preflight.button.text.includes('继续') || preflight.button.text.includes('聊过') || preflight.button.text.includes('已沟通'))) {
      job.outreach = { status: 'skipped_communicated', message, evidencePath: '', verify: null, target: { title: actual.structured.title, company: actual.structured.company }, sentAt: now() };
      job.nextAction = liveReason || '页面显示已沟通';
      addDecision(job, 'dedup', 'reject', 'prior_contact', job.nextAction, liveRecruiter.encryptBossId || '');
      saveLedger(ledger);
      console.log(`SKIPPED (${job.nextAction}) ${id} ${actual.structured.title} @ ${actual.structured.company}`);
      return;
    }
    const preExistingTabIds = new Set((await cdpLib().listTabs(PORT)).map(tab => tab.id));
    let entered = { clicked: false, text: preflight.button.text };
    const relationshipReady = /继续|聊过|已沟通/.test(preflight.button.text || '') || preflight.button.isFriend === 'true';
    if (!resumeChat || !relationshipReady) {
      await cdpLib().activateTab(cdp.tabId, PORT);
      await sleepMs(250);
      entered = await cdp.eval(`(()=>{const visible=el=>!!el&&el.offsetParent!==null&&(()=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0})();const b=[...document.querySelectorAll('.btn-startchat')].find(visible);if(!b)return {clicked:false};b.scrollIntoView({block:'center'});b.focus();b.click();return {clicked:true,text:(b.innerText||'').trim()};})()`);
      if (!entered?.clicked) throw new Error('发送前没有找到可见的沟通按钮');
    }
    job.outreach = { status: 'chat_created_not_sent', message, evidencePath: '', verify: null, target: { title: job.title, company: job.company }, sentAt: null, redirectUrl: preflight.button.redirectUrl };
    job.nextAction = '会话已建立，定制消息待发送；失败时使用 --resume-chat 续发，禁止重新点立即沟通';
    saveLedger(ledger);
    // 点击后可能在当前标签、弹出的新标签或 redirect-url 中进入聊天；统一等待真实聊天输入框。
    const ready = await waitForChatReady(cdp, preflight.button.redirectUrl || job.outreach.redirectUrl, 25, preExistingTabIds);
    cdp = ready.cdp;
    sendConnections = ready.connections;
    sendTabIds = new Set(ready.tabIds);
    const chatReady = !!(ready.probe?.input && ready.probe?.chat);
    if (!chatReady) {
      // 最终再判一次是否 BOSS 拦截（而非单纯加载慢）
      const finalProbe = ready.probe || {};
      const block = detectSendBlock(finalProbe?.bodyText || '');
      if (block) {
        job.outreach = { status: 'blocked', message, evidencePath: '', verify: null, target: { title: job.title, company: job.company }, sentAt: now() };
        job.nextAction = block;
        addDecision(job, 'send_gate', 'reject', 'blocked_by_boss', block, '');
        saveLedger(ledger);
        console.log(`BLOCKED (${block}) ${id} ${job.title} @ ${job.company}`);
        return;
      }
      throw new Error(`chat-not-ready: ${JSON.stringify({ url: finalProbe?.url || '', route: !!finalProbe?.route, shell: !!finalProbe?.shell, input: !!finalProbe?.input, inputSelector: finalProbe?.inputSelector || '', body: finalProbe?.bodyText || '', error: finalProbe?.error || '' })}`);
    }
    await humanPause(400, 900);
    // 从这一刻起浏览器命令可能已经点击“发送”：先持久化为“只允许复核”，避免进程/CDP
    // 在点击后、回传前断开时仍保留 chat_created_not_sent，随后 --resume-chat 造成重复发送。
    job.outreach = { ...job.outreach, status: 'delivery_unverified', sentAt: now() };
    job.nextAction = '发送动作已开始，结果未确认前只允许 verify-delivery，禁止重发';
    saveLedger(ledger);
    const sent = await cdp.eval(`(async()=>{
     try {
      const hasDialog = [...document.querySelectorAll('button,a,span')].some(x => /已沟通过|沟通新职位/.test(x.innerText || ''));
      if (hasDialog) {
        const cancelBtn = [...document.querySelectorAll('button,a,span')].find(x => (x.innerText || '').trim() === '取消');
        if (cancelBtn) cancelBtn.click();
        return { error: 'already-communicated' };
      }
      const msg=${JSON.stringify(message)};
      // 发送前再关一次可能遮挡输入框的“号码隐私保护”安全弹窗
      const pv=[...document.querySelectorAll('button,a,span')].find(x=>{const t=(x.innerText||'').trim();return t==='取消'&&/隐私保护|安全风险/.test(document.body.innerText);});if(pv)pv.click();
      await new Promise(r=>setTimeout(r,300));
      const visible=el=>!!el&&el.offsetParent!==null&&(()=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0})();
      const route=location.pathname.includes('/web/geek/chat');
      const shell=!!document.querySelector('.friend-content-warp,.chat-container,.chat-content,.chat-panel');
      const findInput=()=>{const pool=[...document.querySelectorAll('#chat-input,textarea,[contenteditable=true]')].filter(visible);return pool.find(x=>x.id==='chat-input')||pool.find(x=>{const meta=String(x.className||'')+' '+String(x.getAttribute('placeholder')||'')+' '+String(x.getAttribute('data-placeholder')||'');return x.isContentEditable||meta.includes('输入')||meta.includes('消息')||meta.toLowerCase().includes('message')||meta.toLowerCase().includes('chat-input')})||null;};
      let input=findInput();
      if(!input||!(route||shell))return {error:'chat-not-ready'};
      input.focus();
      if(input.matches('textarea,input')){input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));input.value=msg;input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:msg}));}else{input.innerHTML='';const div=document.createElement('div');div.innerText=msg;input.appendChild(div);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:msg}));}
      await new Promise(r=>setTimeout(r,700));
      const button=[...document.querySelectorAll('button,a')].find(x=>x.offsetParent&&!x.disabled&&(x.innerText||'').trim()==='发送');
      if(!button)return {error:'send-button'};
      button.click();
      const targetBossId=${JSON.stringify(liveRecruiter.encryptBossId || '')};
      const findMatches=()=>{
        let vm=document.querySelector('.friend-content-warp')?.__vue__;
        while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;
        const sources=vm?.$props?.dataSources||vm?.dataSources||[];
        return targetBossId?sources.filter(s=>s&&String(s.encryptBossId||'')===targetBossId):[];
      };
      let matches=[],entry,confirmed=false,delivered=false;
      for(let attempt=0;attempt<15;attempt++){
        matches=findMatches();
        entry=matches[0];
        confirmed=!!(entry&&entry.lastIsSelf&&(entry.lastText||'').trim()===msg);
        delivered=confirmed&&Number(entry.lastMsgStatus||0)>=1;
        if(delivered)break;
        if(attempt<14)await new Promise(r=>setTimeout(r,1000));
      }
      // 发送后页面可能重渲染把 #chat-input 换成新节点，旧引用可能已从 DOM 摘除；重新取一次再读，
      // 取不到就按空输入框处理（消息已经点了发送，不能因为这个读不到就整体判失败）。
      input=findInput()||input;
      const inputValue=input?(input.matches('textarea,input')?input.value:input.innerText):'';
       return {inputEmpty:!input||String(inputValue||'').trim()==='',identityMatchCount:matches.length,matchedText:confirmed,readOrDelivered:delivered,jobMatched:confirmed&&String(entry.encryptJobId||'')===${JSON.stringify(id)},companyVisible:${JSON.stringify(companyEvidenceTerms(job.company || actual.structured.company))}.some(term=>document.body.innerText.includes(term))}
     } catch (e) {
       return { error: 'js-exception: ' + (e && e.message || String(e)) };
     }
    })()`);
    if (sent && sent.error === 'already-communicated') {
      job.outreach = { status: 'skipped_communicated', message, evidencePath: '', verify: null, target: { title: actual.structured.title, company: actual.structured.company }, sentAt: now() };
      job.nextAction = '已沟通过，跳过';
      addDecision(job, 'dedup', 'reject', 'chat_already_communicated', job.nextAction, liveRecruiter.encryptBossId || '');
      saveLedger(ledger);
      console.log(`SKIPPED (already communicated) ${id} ${actual.structured.title} @ ${actual.structured.company}`);
      return;
    }
    if (sent && ['chat-not-ready', 'send-button'].includes(sent.error)) {
      job.outreach = { ...job.outreach, status: 'chat_created_not_sent', sentAt: null };
      job.nextAction = `消息尚未点击发送（${sent.error}），可修复聊天页后使用 --resume-chat 续发`;
      saveLedger(ledger);
      throw new Error(job.nextAction);
    }
    const verify = sentVerification(sent);
    if (!Object.values(verify).every(Boolean)) throw new Error(`送达核验失败：${JSON.stringify({ sent, verify })}`);
    job.outreach = { status: 'delivered', message, evidencePath: '', verify, target: { title: actual.structured.title, company: actual.structured.company }, sentAt: now() };
    job.nextAction = '已送达；后续按会话记录判断';
    addDecision(job, 'delivery', 'pass', 'delivered', '完整消息已在本人同一气泡显示送达或已读，且输入框已清空', message);
    saveLedger(ledger);
    console.log(`DELIVERED ${id} ${actual.structured.title} @ ${actual.structured.company}`);
  } catch (error) {
    addDecision(job, 'send_gate', 'reject', 'send_blocked', error.message, '');
    job.nextAction = error.message;
    if (/送达核验失败/.test(error.message)) {
      job.outreach = { status: 'delivery_unverified', message, evidencePath: '', verify: null, target: { title: job.title, company: job.company }, sentAt: now() };
    }
    saveLedger(ledger);
    throw error;
  } finally {
    for (const connection of new Set(sendConnections)) connection.close();
    for (const tabId of sendTabIds) await closeTab(tabId, PORT);
  }
}

async function send() {
  const url = positional() || arg('url');
  return sendWithAutomaticVerification(url, process.env.MSG || arg('message'));
}

async function sendWithAutomaticVerification(url, message) {
  const id = jobIdOf(url) || url;
  try {
    return await sendMessage(url, message);
  } catch (error) {
    if (!/送达核验失败/.test(error.message || '')) throw error;
    console.log(`AUTO_VERIFY ${id}`);
    return verifyDelivery(id);
  }
}

async function verifyDelivery(inputOverride) {
  const input = inputOverride || positional() || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(x => x.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  // hydrateLegacyStructured 返回的是副本，不挂回台账的话后面改 outreach 再 saveLedger 全部丢失，
  // 复核会打印 DELIVERED_LATE 但状态永远停在 delivery_unverified。
  ledger.jobs[index] = job;
  if (job.outreach?.status !== 'delivery_unverified' || !job.outreach.message) throw new Error('只允许复核 delivery_unverified 且保留原消息的岗位');
  await reserveAction('jobReads', `verify-delivery ${id}`);
  const conversation = ledger.conversations.find(row => row.encryptJobId === id);
  const bossId = job.recruiter?.encryptBossId || conversation?.encryptBossId || '';
  if (!bossId) throw new Error('送达复核缺少招聘者身份，未重发');
  const result = await require('./browser').openConversation({ port: PORT, bossId, jobId: id, full: true });
  if (result.security) throwSecurity('送达复核会话进入安全验证', `${id} ${job.url}`);
  const target = result.target || {};
  const normalizedMessage = normalizeDeliveryText(job.outreach.message);
  const conversationDelivered = (result.conversation?.myMessages || []).some(line => {
    const text = String(line || '');
    return /(?:送达|已读)/.test(text) && normalizeDeliveryText(text).includes(normalizedMessage);
  });
  const targetCompanyClean = String(target.company || '').replace(/(?:\.\.\.|…)+$/, '').trim();
  const companyVisible = String(target.company || '') === String(job.company || '')
    || (!!targetCompanyClean && String(job.company || '').startsWith(targetCompanyClean))
    || companyEvidenceTerms(job.company).some(term => String(target.company || '').includes(term) || targetCompanyClean.includes(term));
  const verify = {
    inputEmpty: result.inputEmpty === true,
    identityMatched: target.bossId === bossId && target.jobId === id && (target.lastIsSelf === true || conversationDelivered),
    delivered: Number(target.lastMsgStatus || 0) >= 1 || conversationDelivered,
    companyVisible,
    matchedText: normalizeDeliveryText(target.lastMessage) === normalizedMessage || conversationDelivered,
  };
  if (Object.values(verify).every(Boolean)) {
    job.outreach = { ...job.outreach, status: 'delivered', verify, target: { title: job.title, company: job.company } };
    job.nextAction = '已送达；后续按会话记录判断';
    addDecision(job, 'delivery', 'pass', 'delivery_verified_late', '延迟复核通过精确会话确认同一完整消息已送达或已读，未重发', job.outreach.message);
    saveLedger(ledger);
    console.log(`DELIVERED_LATE ${id} ${job.title} @ ${job.company}`);
    return;
  }
  job.nextAction = '送达仍待确认，禁止重发';
  addDecision(job, 'delivery', 'pending', 'delivery_still_unverified', JSON.stringify(verify), job.outreach.message);
  saveLedger(ledger);
  console.log(`UNVERIFIED ${id} ${JSON.stringify(verify)}`);
}

function aiOpener() {
  const input = positional() || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(x => x.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  ledger.jobs[index] = job;
  assertAiReady(ledger, job);
  const result = generateOpener(job, arg('profile'), ledger);
  job.opener = { status: 'generated', message: result.message, profile: result.profileId, style: result.style || openerStyle(job), jdHash: job.jd.hash, generatedAt: now(), generator: result.generator };
  addDecision(job, 'opener', 'pass', 'ai_generated', `AI 已按${PROFILES[result.profileId].label}生成并通过事实门禁`, result.message);
  saveLedger(ledger);
  console.log(result.message);
  return result.message;
}

// 宿主 agent 自己按 JD 写好开场白后存入台账：走和 ai-opener 完全相同的门禁
// （事实白名单 validateOpener + 可发送校验 + 招聘者去重），只是文案作者换成 agent。
// 存的时候绑定 jdHash，之后 JD 变了 ai-send --use-saved 会拒发。
function saveOpener() {
  const input = positional() || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(x => x.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  ledger.jobs[index] = job;
  assertAiReady(ledger, job);
  const style = openerStyle(job);
  const message = validateOpener(process.env.MSG || arg('message'), { allowQuestion: style === 'project' });
  assertOpenerFits(job, message);
  const lengthReason = openerLengthReason(message);
  if (lengthReason) throw new Error(`开场白长度不合规：${lengthReason}`);
  assertOpenerFresh(ledger, message);
  const profileId = matchProfile(job.title, job.jd.structured.description, arg('profile') || job.preScreen?.profile);
  job.opener = { status: 'generated', message, profile: profileId, style, jdHash: job.jd.hash, generatedAt: now(), generator: 'host-agent' };
  addDecision(job, 'opener', 'pass', 'agent_generated', `宿主 agent 已按${PROFILES[profileId]?.label || '岗位方向'}写定并通过事实门禁`, message);
  saveLedger(ledger);
  console.log(`OPENER_SAVED ${id} ${message}`);
}

function discardOpener() {
  const input = positional() || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const job = ledger.jobs.find(item => item.jobId === id);
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  const previous = String(job.opener?.message || '');
  job.opener = { status:'none', message:'', profile:'', style:'', jdHash:'', generatedAt:'', generator:'' };
  if (job.outreach?.status === 'not_sent') job.nextAction = '写开场白';
  addDecision(job, 'opener', 'pending', 'opener_discarded', '已撤回开场白草稿，岗位退出材料就绪队列', previous);
  saveLedger(ledger);
  console.log(`OPENER_DISCARDED ${id} ${job.title} @ ${job.company}`);
}

async function aiSend() {
  const input = positional() || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(x => x.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  ledger.jobs[index] = job;
  assertSendReady(job);
  // --use-saved：发送台账里已经写定的开场白（save-opener 存的），不再重新生成。
  // 仍要求 jdHash 未变；文案本身在存入时已过 validateOpener。
  if (process.argv.includes('--use-saved')) {
    if (job.opener?.status !== 'generated' || !job.opener.message) throw new Error(`岗位 ${id} 没有已存的开场白，先 save-opener 或去掉 --use-saved`);
    if (job.opener.jdHash !== job.jd.hash) throw new Error('已存开场白绑定的 JD 已变化，禁止发送；请按新 JD 重写');
    validateOpener(job.opener.message, { allowQuestion: job.opener.style === 'project' });
    assertOpenerFits(job, job.opener.message);
    // 9-05：存量开场白也要过锚点/禁写数字/通用问句门禁，旧稿（具体测试数、金额）在这里被拒，按事实卡重写后再发。
    const staleAnchor = factAnchorReason(job.opener.message);
    if (staleAnchor) throw new Error(`已存开场白不符合当前规则，请 discard-opener 后按事实卡重写：${staleAnchor}`);
    if (process.argv.includes('--dry-run')) {
      console.log(`DRY_RUN(saved by ${job.opener.generator}) ${job.opener.message}`);
      return;
    }
    return sendWithAutomaticVerification(job.url, job.opener.message);
  }
  const result = generateOpener(job, arg('profile'), ledger);
  job.opener = { status: 'generated', message: result.message, profile: result.profileId, style: result.style || openerStyle(job), jdHash: job.jd.hash, generatedAt: now(), generator: result.generator };
  addDecision(job, 'opener', 'pass', 'ai_generated', `AI 已按${PROFILES[result.profileId].label}生成并通过事实门禁`, result.message);
  saveLedger(ledger);
  if (process.argv.includes('--dry-run')) {
    console.log(`DRY_RUN ${result.message}`);
    return;
  }
  const latest = loadLedger().jobs.find(x => x.jobId === id);
  if (latest.jd.hash !== latest.opener.jdHash) throw new Error('开场白绑定的 JD 已变化，禁止发送');
  return sendWithAutomaticVerification(latest.url, latest.opener.message);
}

function review() {
  const id = positional();
  const ledger = loadLedger();
  const job = ledger.jobs.find(x => x.jobId === id);
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  for (const field of ['remote', 'pay', 'risk']) {
    const status = arg(field);
    if (!status) continue;
    const allowed = field === 'remote' ? ['pending', 'pass', 'negotiable', 'fail'] : ['pending', 'pass', 'fail'];
    if (!allowed.includes(status)) throw new Error(`${field} 只能是 ${allowed.join('/')}`);
    const evidence = arg(`${field}-evidence`) || job.review[field]?.evidence || '';
    job.review[field] = { status, evidence };
    if (field === 'remote' && process.argv.includes('--user-selected')) job.review[field].userSelected = true;
    addDecision(job, `jd_${field}`, status === 'fail' ? 'reject' : status, `${field}_review`, `${field} 审核为 ${status}`, evidence);
  }
  if (arg('next')) job.nextAction = arg('next');
  saveLedger(ledger);
  console.log(`${id}: remote=${job.review.remote.status}, pay=${job.review.pay.status}, risk=${job.review.risk.status}`);
}

function company() {
  const name = positional();
  if (!name) throw new Error('缺少公司名');
  const ledger = loadLedger();
  const existing = ledger.companies.find(x => x.name === name) || { name };
  Object.assign(existing, { status: arg('status') || existing.status || 'pending', evidence: arg('evidence') || existing.evidence || '', url: arg('url') || existing.url || '', checkedAt: now() });
  if (!ledger.companies.includes(existing)) ledger.companies.push(existing);
  saveLedger(ledger);
  console.log(`${name}: ${existing.status}`);
}

async function conversationOpen() {
  const result = await require('./browser').openConversation({ port: PORT, tabId: arg('tab'), bossId: arg('boss-id'), jobId: arg('job-id'), company: arg('company'), name: arg('name'), full:process.argv.includes('--full') });
  if (result.security) throwSecurity('conversation-open 进入安全/异常页面', `${result.url} ${result.title}`);
  if (result.target && result.conversation?.loaded) {
    const ledger = loadLedger();
    const row = ledger.conversations.find(item => item.encryptBossId === result.target.bossId && item.encryptJobId === result.target.jobId);
    if (row) {
      const incoming = (result.conversation.incomingMessages || [])
        .filter(message => !/竞争者PK|查看详细分析|查看职位|按Enter键发送|滚动加载更多/.test(message));
      const resolvedMessage = String(result.target.lastMessage || '').trim() || incoming[incoming.length - 1] || '';
      if (resolvedMessage) {
        const header = result.conversation.jobHeader || {};
        Object.assign(row, {
          lastMessage: resolvedMessage,
          statusClass: '',
          statusText: '',
          status: conversationStatus({ ...row, lastMessage: resolvedMessage, statusClass: '' }),
          jobTitle: header.title || row.jobTitle || '',
          jobSalary: header.salary || row.jobSalary || '',
          jobLocation: header.location || row.jobLocation || '',
          recruiterRole: header.recruiterRole || row.recruiterRole || '',
          resumeConsentRequired: !String(result.target.lastMessage || '').trim() && !!result.conversation.hasResumeConsentPrompt && !result.conversation.resumeToolReady,
          liveInspectedAt: now(),
          liveInspectedMsgId: row.lastMsgId || '',
        });
        let job;
        if (row.encryptJobId) {
          job = ensureJob(ledger, row.encryptJobId, `https://www.zhipin.com/job_detail/${row.encryptJobId}.html`);
          if (header.title) job.title = header.title;
          if (header.salary) job.salary = header.salary;
          if (!job.company && row.company) job.company = row.company;
          job.sources = [...new Set([...(job.sources || []), 'conversation'])];
          job.discovery = { ...job.discovery, conversationSeenAt: now() };
          job.recruiter = { ...job.recruiter, name:row.name || job.recruiter?.name || '', company:row.company || job.recruiter?.company || '', encryptBossId:row.encryptBossId || job.recruiter?.encryptBossId || '' };
        }
        saveLedger(ledger);
        result.ledgerSync = { updated:true, lastMessage:row.lastMessage, status:row.status, job:job?{jobId:job.jobId,title:job.title,company:job.company,salary:job.salary}:null, liveInspectedAt:row.liveInspectedAt };
      } else {
        result.ledgerSync = { updated:false, reason:'精确会话中仍没有可归类的对方消息' };
      }
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

function conversationTargetArgs() {
  return { port: PORT, tabId: arg('tab'), bossId: arg('boss-id'), jobId: arg('job-id'), company: arg('company'), name: arg('name') };
}

async function conversationReply() {
  const answer = String(process.env.BOSS_VALUE ?? arg('message') ?? '').trim();
  if (!answer) throw new Error('conversation-reply 需要用户指定的回复正文');
  const ledger = loadLedger();
  const target = conversationTargetArgs();
  const conversationPool = currentConversations(ledger);
  const rows = conversationPool.filter(row => (!target.bossId || row.encryptBossId === target.bossId) && (!target.jobId || row.encryptJobId === target.jobId) && (!target.company || row.company === target.company) && (!target.name || row.name === target.name));
  if (rows.length !== 1) throw new Error(`回复目标会话必须唯一，当前 ${rows.length} 条`);
  const row = rows[0];
  const result = await require('./browser').replyConversation({ ...target, message:answer, expectedLastMessage:row.lastMessage, allowOursLast: process.argv.includes('--allow-ours-last'), full:process.argv.includes('--full') });
  if (result.security) throwSecurity('conversation-reply 进入安全/异常页面', `${result.url} ${result.title}`);
  if (result.verify?.matched && result.verify?.delivered) {
    const currentRow = ledger.conversations.find(x => x.encryptBossId === result.target.bossId && x.encryptJobId === result.target.jobId);
    if (currentRow) {
      const read = Number(result.verify.lastMsgStatus) === 2;
      Object.assign(currentRow, { lastMessage:result.message, statusClass:read?'message-status status-read':'message-status status-delivery', statusText:read?'[已读]':'[送达]', status:read?'ours_last_read':'ours_last_delivered', unread:'', time:Date.now() });
    }
    saveLedger(ledger);
  }
  console.log(JSON.stringify(result, null, 2));
}

async function resumeSend() {
  let resume = arg('resume');
  let allowPositive = process.argv.includes('--allow-positive');
  const dryRun = process.argv.includes('--dry-run');
  if (process.argv.includes('--auto')) {
    const daily = loadDailyOptions();
    if (daily.resumeMode === 'unset' && !dryRun) throw new Error('今天尚未选择自动发简历策略；先运行 daily-options --resume=off|explicit|positive');
    if (daily.resumeMode === 'off' && !dryRun) throw new Error('今天的自动发简历策略为 off');
    const ledger = loadLedger();
    const target = conversationTargetArgs();
    const rows = currentConversations(ledger).filter(row => (!target.bossId || row.encryptBossId === target.bossId) && (!target.jobId || row.encryptJobId === target.jobId) && (!target.company || row.company === target.company) && (!target.name || row.name === target.name));
    if (rows.length !== 1) throw new Error(`自动简历目标会话必须唯一，当前 ${rows.length} 条`);
    const trigger = resumeTrigger(rows[0].lastMessage);
    if (trigger === 'closed' || trigger === 'review') throw new Error(`该回复不能自动发简历：${trigger} ${rows[0].lastMessage}`);
    if (daily.resumeMode === 'explicit' && !['explicit', 'inspect'].includes(trigger)) throw new Error(`今天仅允许明确索要触发，当前为 ${trigger}`);
    const job = ledger.jobs.find(x => x.jobId === rows[0].encryptJobId);
    resume = resumeForJob(job);
    allowPositive = daily.resumeMode === 'positive' && trigger === 'positive';
  }
  const result = await require('./browser').sendResume({ ...conversationTargetArgs(), resume, allowPositive, dryRun, full:process.argv.includes('--full') });
  if (result.security) throwSecurity('resume-send 进入安全/异常页面', `${result.url} ${result.title}`);
  const verified = result.skipped === 'already_sent' || (result.verify?.matched && result.verify?.delivered);
  if (verified && result.target?.jobId) {
    const ledger = loadLedger();
    const job = ledger.jobs.find(x => x.jobId === result.target.jobId);
    if (job) {
      job.resumeOutreach = {
        status: result.skipped === 'already_sent' ? 'already_sent' : 'delivered',
        resume: result.resume || resume,
        target: result.target,
        verifiedAt: now(),
      };
      saveLedger(ledger);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}


module.exports = {
  sendMessage,
  send,
  verifyDelivery,
  aiOpener,
  saveOpener,
  discardOpener,
  aiSend,
  review,
  company,
  conversationOpen,
  conversationReply,
  resumeSend,
};
