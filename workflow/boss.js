#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
  PORT, LOCK_FILE, SECURITY_JS_EXPR, WINDOW_24H, DAILY_BUDGET,
  isNightHour, paceMultiplier, loadLock, writeLock, assertNotLocked, throwSecurity,
  unlockRefusal, loadBudget, countWithin, reserveAction,
  noteEmptyJd, resetEmptyJd, budgetSnapshot,
} = require('./safety');
const cdpLib = () => require('./cdp');
const { arg, positional, jobIdOf, isRealJobUrl } = require('./cli-args');
const { RESUME_MAPPING, loadDailyOptions, saveDailyOptions } = require('./daily-options');
const { LEDGER_FILE, loadLedger, saveLedger } = require('./ledger-store');
const { conversationStatus, currentConversations, resumeTrigger } = require('./conversation-domain');
const {
  PROFILES, addDecision, parseSearchCard,
  isCurrentFavorite, discoverySourceRank, isCurrentCycleJob, preScreenJob, recruiterFromButton, conversationKey,
  priorContactReason, ensureJob, jobDescription, targetRejectReason, explicitWorkflowStopReason,
  queueRejectReason, candidateRemoteRejectReason, assessRemote,
} = require('./job-domain');
const {
  normalizeStructuredPage,
  unreadableJobMessage, hydrateLegacyStructured, reviewIntegrityIssues,
  reviewsReady, openerCurrent, readyRejectReason,
} = require('./jd-domain');
const { resumeForJob, conversationCommand, conversationWorkbenchPayload } = require('./conversation-workbench');
const { waitForJobPage, isExpiredJobRedirect } = require('./page-flows');
const { migrateJd, rehashJd, importLegacy, validate } = require('./maintenance');
const {
  loadFavoritesSession, favorites, favoritesNext, favoriteStatus, favoriteQueue,
  search, harvestCurrent, loadSearchSession, extractSearchLinks, storeSearchLinks, searchNext, searchClose,
  loadRecommendSession, recommendations, recommendationsNext, recommendationsClose,
  companyJobs, jobSources,
} = require('./discovery-commands');
const { HELP, help } = require('./command-help');
const { createSelfTest } = require('./self-test');
const { VERSION: PROJECT_SCORE_VERSION, scoreProjectJob, informationCompleteness } = require('./project-scoring');
const { sendCounts, openerBatch, sendPlan, dispatch } = require('./dispatch');
const {
  send, verifyDelivery, aiOpener, saveOpener, discardOpener, aiSend, review, company,
  conversationOpen, conversationReply, resumeSend,
} = require('./outreach-commands');
const {
  capabilities, browserTabs, browserSnapshot, browserOpen, browserClick, browserFill,
  browserSelect, browserScroll, browserBack, browserWait, browserHover, browserKey, browserToggle,
} = require('./browser-cli');

const now = () => new Date().toISOString();
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

function dailyOptions() {
  const mode = arg('resume');
  if (mode) saveDailyOptions(mode);
  const state = loadDailyOptions();
  console.log(JSON.stringify({ ...state, prompt: state.needsChoice ? '请询问用户：今天回复后发简历选 关闭(off)、仅明确索要(explicit)、还是积极回复也发送(positive)？' : '' }, null, 2));
}

const ONLINE_COMMANDS = new Set(['check', 'replies', 'interactions', 'profile', 'favorites', 'favorites-next', 'recommendations', 'recommendations-next', 'recommendations-close', 'settings-status', 'search', 'search-next', 'search-close', 'harvest-current', 'read', 'ai-send', 'send', 'dispatch', 'verify-delivery', 'company-jobs', 'browser-tabs', 'browser-snapshot', 'browser-open', 'browser-click', 'browser-fill', 'browser-select', 'browser-scroll', 'browser-back', 'browser-wait', 'browser-hover', 'browser-key', 'browser-toggle', 'conversation-open', 'conversation-reply', 'resume-send']);

function unlock() {
  const reason = arg('reason');
  if (!reason) throw new Error('解锁必须由人工给出 --reason=说明');
  const previous = loadLock();
  const forced = process.argv.includes('--force');
  const refusal = unlockRefusal(previous);
  if (refusal && !forced) throw new Error(refusal);
  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    locked: false, port: PORT, unlockedAt: now(), unlockReason: reason,
    ...(forced && refusal ? { forcedOverride: refusal } : {}),
    previousLock: previous.locked ? previous : null,
  }, null, 2));
  console.log(`已解锁（端口 ${PORT}）：${reason}${previous.locked ? `（上次锁定：${previous.reason} @ ${previous.lockedAt}）` : '（此前无锁定）'}`);
  if (forced && refusal) console.log(`⚠ 已用 --force 越过冷静期：${refusal}`);
}

function budgetStatus() {
  console.log(JSON.stringify(budgetSnapshot(), null, 2));
}

function projectScore() {
  const ledger = loadLedger();
  const limit = Math.min(100, Math.max(1, Number(arg('top') || arg('limit') || 30)));
  const results = [];
  const scored = new Map();
  const counts = { completeJd: 0, cardScored: 0, eligible: 0, hardReject: 0 };
  for (const job of ledger.jobs) {
    const complete = job.jd?.status === 'read' && !!job.jd?.structured?.description && !job.jd.structured.incomplete;
    const layer = complete ? 'jd' : 'card';
    if (complete) counts.completeJd++;
    else if (job.title || job.company || job.preScreen?.reasons?.length) counts.cardScored++;
    const result = scoreProjectJob(job, { layer });
    scored.set(job.jobId, result);
    if (result.status === 'hard_reject') counts.hardReject++;
    else counts.eligible++;
    if (complete || result.status === 'eligible') results.push({ job, result });
  }
  const unreadCandidatePool = ledger.jobs.filter(job => isCurrentCycleJob(job)
    && (isCurrentFavorite(job) || ['priority', 'review'].includes(job.preScreen?.status))
    && !['read', 'partial', 'expired'].includes(job.jd?.status)
    && !queueRejectReason(job) && !candidateRemoteRejectReason(job) && !priorContactReason(ledger, job));
  const cardPool = unreadCandidatePool.map(job => ({ job, result:scored.get(job.jobId) }));
  const sort = (a, b) => (b.result.score - a.result.score)
    || (b.result.signals.length - a.result.signals.length)
    || ((b.job.preScreen?.activityRank || 0) - (a.job.preScreen?.activityRank || 0));
  const top = rows => rows.sort(sort).slice(0, limit).map(({ job, result }, index) => ({
    rank:index + 1, jobId:job.jobId, title:job.title, company:job.company, salary:job.salary,
    score:result.score, status:result.status, companySize:result.companySize, remoteSuggestion:result.remoteSuggestion, askInOpener:result.askInOpener,
    recruiterTitle:result.recruiterTitle, hardRejects:result.hardRejects.map(x => x.label),
    signals:result.signals.map(x => x.label), layer:result.layer,
  }));
  console.log(JSON.stringify({
    version:PROJECT_SCORE_VERSION,
    offline:true,
    consumesBossBudget:false,
    scanned:ledger.jobs.length,
    completeJd:counts.completeJd,
    cardScored:counts.cardScored,
    unreadCandidatePool:unreadCandidatePool.length,
    counts,
    topCompleteJd:top(results.filter(x => x.result.layer === 'jd')),
    topUnreadCards:top(cardPool),
    nextCommands:[
      'node workflow/boss.js candidates --sort=complete --limit=20',
      'node workflow/boss.js jd <jobId>',
    ],
  }, null, 2));
}

function resumeCandidates() {
  const ledger = loadLedger();
  const daily = loadDailyOptions();
  const jobs = new Map(ledger.jobs.map(job => [job.jobId, job]));
  const rows = currentConversations(ledger).filter(row => ['needs_inspect', 'boss_last_review'].includes(row.status)).map(row => {
    const job = jobs.get(row.encryptJobId);
    const trigger = resumeTrigger(row.lastMessage);
    const eligible = daily.resumeMode === 'explicit' ? trigger === 'explicit' : daily.resumeMode === 'positive' ? ['explicit', 'positive'].includes(trigger) : false;
    return { company:row.company, name:row.name, bossId:row.encryptBossId, jobId:row.encryptJobId, title:job?.title || '', lastMessage:row.lastMessage, time:Number(row.time || 0), trigger, resume:resumeForJob(job), consentRequired:!!row.resumeConsentRequired, eligible };
  }).filter(row => !['closed', 'already_sent'].includes(row.trigger)).sort((a, b) => b.time - a.time);
  const eligible = rows.filter(x => x.eligible);
  const liveInspect = rows.filter(x => x.trigger === 'inspect');
  const awaitingPolicy = rows.filter(x => !x.eligible && ['explicit', 'positive'].includes(x.trigger));
  const review = rows.filter(x => x.trigger === 'review');
  const limit = process.argv.includes('--full') ? rows.length : Math.min(100, Number(arg('limit') || 20));
  console.log(JSON.stringify({
    dailyOptions:daily,
    counts:{ total:rows.length, eligible:eligible.length, awaitingPolicy:awaitingPolicy.length, liveInspect:liveInspect.length, review:review.length },
    showingPerGroup:limit,
    eligible:eligible.slice(0, limit),
    awaitingPolicy:awaitingPolicy.slice(0, limit),
    liveInspect:liveInspect.slice(0, limit),
    review:review.slice(0, limit),
    mapping:RESUME_MAPPING,
  }, null, 2));
}

// 2026-07-25 实测发现：85 条待发池只有 5 套模板开场白（重复 25/23/19/16/2 次），
// 旧核验靠「聊天列表里这条文案精确匹配的记录只有 1 条」判定，模板一重复就必然误判成待复核——
// 实测每次都已点击发送、状态显示送达、公司名匹配，只是文案撞了别的联系人。
// 改用 BOSS 会话数据模型里的 encryptBossId 精确定位这一个招聘者的会话线程（同一手法取自 replies()
// 已验证过的 Vue vm 读取方式），不再靠文案本身的唯一性。identity 找不到就如实判定核验失败，不放宽标准。
// 只读探测一个已打开标签的真实 DOM 状态：连到既有标签（不新开、不导航、不点击），
// 判定逻辑与 SECURITY_JS_EXPR 一致。探测失败（标签已关闭/超时）时不静默放过，
// 交给调用方按保守的 URL 强信号兜底。
async function probeTabSecurity(tab) {
  const { CDP } = cdpLib();
  const cdp = new CDP(PORT);
  try {
    await cdp.connectPage(t => t.id === tab.id);
    const probe = await cdp.eval(`JSON.stringify({security:${SECURITY_JS_EXPR},bodyPreview:(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').slice(0,120)})`, 8000);
    return JSON.parse(probe || '{}');
  } catch (error) {
    return { probeFailed: String(error.message || error) };
  } finally {
    cdp.close();
  }
}

// 只有真正会出现在拦截页 URL 上的强信号才在 DOM 探测失败时兜底；
// 不用裸 `security_check` 子串——BOSS 静默通过安全复核后仍会把该参数留在 URL 上（2026-07-25 实测误报）。
const HARD_URL_ONLY_RE = /\/403\.html|[?&]code=(32|36|37)(?:&|$)|\/web\/passport\/|账户存在异常行为|暂时限制访问|访问受限/i;

async function check() {
  const tabs = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());
  const boss = tabs.filter(x => x.type === 'page' && /zhipin\.com/.test(x.url || ''));
  const inspected = [];
  for (const tab of boss) {
    const probe = await probeTabSecurity(tab);
    const hit = probe.probeFailed ? HARD_URL_ONLY_RE.test(`${tab.url} ${tab.title}`) : !!probe.security;
    inspected.push({ url: tab.url, title: tab.title, hit, ...probe });
  }
  const security = inspected.filter(x => x.hit);
  console.log(JSON.stringify({ port: PORT, bossTabs: boss.length, securityPages: security.length, tabs: inspected }, null, 2));
  if (security.length) {
    writeLock('check 发现安全/异常页面', security.map(x => `${x.url} ${x.title} ${x.bodyPreview || ''}`).join(' ; '));
    console.log(`已写入熔断锁 ${rel(LOCK_FILE)}：所有在线命令拒绝运行，人工确认后 unlock`);
  }
  if (!boss.length || security.length) process.exitCode = 2;
}

async function replies() {
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab('https://www.zhipin.com/web/geek/chat', PORT);
  try {
    await cdp.waitFor(`(()=>{let vm=document.querySelector('.friend-content-warp')?.__vue__;while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;return (vm?.$props?.dataSources||vm?.dataSources||[]).length})()`, { timeoutMs: 18000, description: '消息虚拟列表数据' });
    const raw = await cdp.eval(`(()=>{
      let vm=document.querySelector('.friend-content-warp')?.__vue__;
      while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;
      const sources=vm?.$props?.dataSources||vm?.dataSources||[];
      return JSON.stringify(sources.map(s=>({
        name:s.name||'',company:s.brandName||'',time:s.lastTS||0,lastMessage:s.lastText||'',
        statusClass:s.lastIsSelf?(Number(s.lastMsgStatus)===2?'message-status status-read':'message-status status-delivery'):'',
        statusText:s.lastIsSelf?(Number(s.lastMsgStatus)===2?'[已读]':'[送达]'):'',
        unread:String(s.unreadCount||''),encryptBossId:s.encryptBossId||'',encryptJobId:s.encryptJobId||'',
        friendId:String(s.friendId||''),uid:String(s.uid||''),lastMsgId:String(s.lastMsgId||'')
      })));
    })()`);
    const syncAt = now();
    const rows = JSON.parse(raw || '[]').map(item => {
      return { ...item, status: conversationStatus(item), checkedAt: syncAt };
    });
    const ledger = loadLedger();
    const keyed = new Map(ledger.conversations.map(x => [conversationKey(x), x]));
    for (const row of rows) {
      const key = conversationKey(row);
      const legacyKey = `name:${row.company || ''}@@${row.name || ''}`;
      const previous = keyed.get(key) || keyed.get(legacyKey);
      if (key !== legacyKey) keyed.delete(legacyKey);
      const merged = { ...previous, ...row };
      if (row.status === 'needs_inspect' && previous?.liveInspectedMsgId && previous.liveInspectedMsgId === row.lastMsgId && previous.lastMessage) {
        merged.listLastMessage = '';
        merged.lastMessage = previous.lastMessage;
        merged.status = previous.status;
      }
      keyed.set(key, merged);
    }
    ledger.conversations = [...keyed.values()];
    ledger.conversationSyncAt = syncAt;
    saveLedger(ledger);
    const currentRows = [...keyed.values()].filter(item => item.checkedAt === syncAt).sort((a, b) => Number(b.time || 0) - Number(a.time || 0));
    const review = currentRows.filter(x => x.status === 'boss_last_review');
    const inspect = currentRows.filter(x => x.status === 'needs_inspect');
    const contacts = currentRows.filter(x => x.status === 'contact_shared');
    const notices = currentRows.filter(x => x.status === 'system_notice');
    console.log(`会话 ${currentRows.length}；待判断 ${review.length}；待精确检查 ${inspect.length}；联系方式待决定 ${contacts.length}；系统回执 ${notices.length}`);
    review.forEach(x => console.log(`- [待判断] ${x.company} ${x.name} [job=${x.encryptJobId} boss=${x.encryptBossId}]: ${x.lastMessage}`));
    inspect.forEach(x => console.log(`- [待精确检查] ${x.company} ${x.name} [job=${x.encryptJobId} boss=${x.encryptBossId}]：列表文本为空，运行 conversation-open --job-id=${x.encryptJobId} --boss-id=${x.encryptBossId}`));
    contacts.forEach(x => console.log(`- [联系方式待决定] ${x.company} ${x.name} [job=${x.encryptJobId} boss=${x.encryptBossId}]: ${x.lastMessage}`));
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function interactions() {
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab('https://www.zhipin.com/web/geek/recommend', PORT);
  const snapshots = [];
  try {
    await cdp.waitFor(`/谁看过我|对我感兴趣的/.test(document.body?.innerText||'')`, { timeoutMs: 15000, description: '互动页面' });
    for (const label of ['谁看过我', '对我感兴趣的']) {
      await cdp.eval(`(()=>{const label=${JSON.stringify(label)};const el=[...document.querySelectorAll('span,a,li')].find(x=>(x.innerText||'').trim()===label&&x.offsetParent);if(!el)return false;el.click();return true})()`);
      await cdp.waitFor(`document.readyState!=='loading'&&!!document.body`, { timeoutMs: 8000, description: `${label}内容` });
      const raw = await cdp.eval(`JSON.stringify({text:(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,5000),links:[...document.querySelectorAll('a[href*="/job_detail/"]')].filter(a=>!a.href.includes('personal_added_job')).map(a=>{const text=(a.innerText||'').trim();const lines=text.split(/\\n+/).map(x=>x.trim()).filter(Boolean);const salaryIndex=lines.findIndex(x=>/\\d+(?:\\.\\d+)?-\\d+(?:\\.\\d+)?K/i.test(x));return {url:a.href,title:salaryIndex>0?lines[salaryIndex-1]:'',text}}).slice(0,30)})`);
      const snapshot = { type: label, capturedAt: now(), ...JSON.parse(raw || '{}') };
      snapshot.links = (snapshot.links || []).filter(link => isRealJobUrl(link.url));
      snapshots.push(snapshot);
    }
    const ledger = loadLedger();
    ledger.interactions = snapshots;
    for (const job of ledger.jobs) job.sources = (job.sources || []).filter(source => !source.startsWith('interaction:'));
    let fresh = 0;
    const counts = { priority: 0, review: 0, reject: 0 };
    for (const snapshot of snapshots) {
      for (const link of snapshot.links || []) {
        const id = jobIdOf(link.url);
        if (!id) continue;
        const existed = ledger.jobs.some(job => job.jobId === id);
        const job = ensureJob(ledger, id, link.url);
        const parsed = parseSearchCard({ title: link.title, text: link.text });
        if (link.title) job.title = link.title;
        if (!job.salary) job.salary = parsed.salary;
        job.sources = [...new Set([...(job.sources || []), `interaction:${snapshot.type}`])];
        job.discovery = { ...job.discovery, interactionSeenAt: snapshot.capturedAt };
        const screened = preScreenJob(ledger, job, { title: link.text, text: link.text });
        counts[screened.status]++;
        if (!existed) fresh++;
      }
    }
    ledger.runs.push({ id: `interactions-${Date.now()}`, type: 'interactions', source: '谁看过我/对我感兴趣的', found: snapshots.reduce((sum, snapshot) => sum + (snapshot.links?.length || 0), 0), fresh, counts, at: now() });
    saveLedger(ledger);
    console.log(JSON.stringify({ sources: snapshots.map(snapshot => ({ type: snapshot.type, found: snapshot.links?.length || 0 })), fresh, counts, nextCommand: 'node workflow/boss.js candidates --source=interaction --sort=complete --limit=20' }, null, 2));
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function profile() {
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab('https://www.zhipin.com/web/geek/resume', PORT);
  try {
    await cdp.waitFor(`(()=>{const t=document.body?.innerText||'';return ${SECURITY_JS_EXPR}||(!/正在加载中/.test(t)&&!!document.querySelector('.resume-container,.resume-box,.resume-attachment')&&/个人优势|期望职位/.test(t)&&/附件管理/.test(t))})()`, { timeoutMs: 20000, description: '在线简历真实内容' });
    const raw = await cdp.eval(`JSON.stringify((()=>{const attachmentItems=[...document.querySelectorAll('.annex-list li,.annex-item')];const attachments=[...new Set(attachmentItems.map(item=>(item.innerText||'').match(/[^\\n]+\\.pdf/i)?.[0]?.trim()).filter(Boolean))];return {url:location.href,security:${SECURITY_JS_EXPR},expectations:document.querySelector('#purpose')?.innerText.replace(/\\s+/g,' ').trim()||document.querySelector('.resume-expect')?.innerText.replace(/\\s+/g,' ').trim()||'',advantage:document.querySelector('#summary .advantage-text')?.innerText.trim()||document.querySelector('.resume-summary,.resume-userDesc')?.innerText.trim()||'',attachments,attachmentCount:attachments.length}})())`);
    const snapshot = { ...JSON.parse(raw || '{}'), checkedAt: now() };
    const ledger = loadLedger();
    ledger.profile = snapshot;
    saveLedger(ledger);
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

// 只读检查 BOSS 账号设置。自动招呼语若被平台重新打开，会在点击“立即沟通”时
// 代替定制开场白自动发出，因此它是每日发送前必须可诊断的业务状态。
async function settingsStatus() {
  const { openTab, closeTab } = cdpLib();
  // 登录判定用配置里的 BOSS 显示名（reins.config.json 的 loginName），代码里不写具体人名
  const loginNameRe = String(require('./reins-config').loadConfig().loginName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cdp = await openTab('https://www.zhipin.com/web/geek/notify-set?type=greetSet', PORT);
  try {
    await cdp.waitFor(`/启用招呼语/.test(document.body?.innerText||'')||${SECURITY_JS_EXPR}`, { timeoutMs: 15000, description: '招呼语设置' });
    const raw = await cdp.eval(`JSON.stringify((()=>{const body=document.body?.innerText||'';const sw=document.querySelector('.ui-switch');return {url:location.href,security:${SECURITY_JS_EXPR},loggedIn:(${JSON.stringify(loginNameRe)}?new RegExp(${JSON.stringify(loginNameRe)}).test(body):true)&&!/登录后查看|立即登录/.test(body),autoGreetingEnabled:!!sw?.classList.contains('ui-switch-checked'),switchClass:String(sw?.className||''),checkedAt:new Date().toISOString()}})())`);
    const state = JSON.parse(raw || '{}');
    if (state.security) throwSecurity('账号设置页进入安全验证', state.url || '');
    console.log(JSON.stringify(state, null, 2));
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

function reviewPayload(job) {
  const structured = job.jd?.structured || {};
  return {
    jobId: job.jobId,
    title: job.title,
    company: job.company,
    salary: job.salary || structured.salary || '',
    experience: structured.experience || '',
    education: structured.education || '',
    remoteHint: job.jd?.remoteHint || '',
    recruiterActive: job.recruiter?.activeText || '',
    activityRank: job.recruiter?.activityRank || 0,
    jdStatus: job.jd?.status || 'unknown',
    descriptionChars: String(structured.description || '').length,
    description: structured.description || '',
    benefits: structured.benefits || '',
    review: Object.fromEntries(['remote', 'pay', 'risk'].map(k => [k, job.review?.[k]?.status || 'pending'])),
    outreachStatus: job.outreach?.status || 'not_sent',
  };
}

// 离线复看已读过的 JD：不联网、不占额度、不受熔断锁限制。
// 用于上下文被压缩后重新拿回某个岗位的正文，而不是去读台账原文件。
function showJd() {
  const input = positional() || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(x => x.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  if (!String(job.jd?.structured?.description || '').trim()) throw new Error(`岗位 ${id} 尚无完整 JD 正文，请先 read`);
  console.log(JSON.stringify(reviewPayload(job), null, 2));
}

function normalizeConversations() {
  const ledger = loadLedger();
  const counts = {};
  let changed = 0;
  let removedPending = 0;
  for (const row of ledger.conversations) {
    const previous = row.status || '';
    const next = conversationStatus(row);
    counts[next] = (counts[next] || 0) + 1;
    if (previous === 'needs_reply' && next !== 'needs_reply') removedPending++;
    if (previous !== next) {
      row.status = next;
      changed++;
    }
  }
  saveLedger(ledger);
  console.log(JSON.stringify({ changed, removedPending, conversationSyncAt: ledger.conversationSyncAt, counts }, null, 2));
}

// 离线：把「JD 没写远程」误判成 remote=fail 的岗位改回 negotiable（v7 口径：无到岗证据就允许发送并在开场白里问）。
// 默认只列出，加 --apply 才写台账；证据里出现到岗/坐班/驻场/线下等词的一律不动。
function reviewRelax() {
  const ledger = loadLedger();
  const apply = process.argv.includes('--apply');
  const limit = Number(arg('limit')) || 50;
  const onsiteWords = /到岗|坐班|驻场|现场|线下|本地|到公司|面试后.{0,6}上班|固定(?:办公)?地点/;
  const rows = [];
  for (const job of ledger.jobs) {
    if (!isCurrentCycleJob(job) || job.outreach?.status !== 'not_sent' || job.review?.remote?.status !== 'fail') continue;
    if (job.jd?.status !== 'read' || !job.jd?.structured?.description) continue;
    if (onsiteWords.test(String(job.review.remote.evidence || ''))) continue;
    const result = scoreProjectJob(job, { layer: 'jd' });
    if (result.status !== 'eligible' || result.remoteSuggestion !== 'negotiable') continue;
    if (queueRejectReason(job) || priorContactReason(ledger, job)) continue;
    rows.push({ job, result });
    if (apply) {
      job.review.remote = { status: 'negotiable', evidence: `JD 未写远程也无到岗要求；开场白询问能否远程/线上协作（v7 放宽，原判：${String(job.review.remote.evidence || '').slice(0, 60)}）` };
      addDecision(job, 'jd_remote', 'negotiable', 'remote_review', 'remote 由 fail 放宽为 negotiable：无到岗证据，改为开场白询问', job.review.remote.evidence);
      if (!job.nextAction || /不发送|跳过/.test(job.nextAction)) job.nextAction = '补审 pay/risk 后写开场白（须带远程问句）';
    }
  }
  if (apply) saveLedger(ledger);
  console.log(`${apply ? '已放宽' : '可放宽'} ${rows.length} 条 remote=fail → negotiable${apply ? '' : '（加 --apply 写入台账）'}`);
  rows.slice(0, limit).forEach(({ job, result }) => console.log(`- ${job.jobId} ${job.salary || '薪资未知'} ${job.title} @ ${job.company} ｜pay=${job.review.pay.status} risk=${job.review.risk.status} ｜${result.signals.filter(x => x.code !== 'complete_field').map(x => x.code).join(',')}`));
}

// 一次性给出接手一轮作业所需的全部状态，替代过去 check + budget + list + replies 的多次往返。
// 自己要负责报告"是否被锁"，所以不能被熔断锁挡在门外。
async function preflight() {
  const full = process.argv.includes('--full');
  const lock = loadLock();
  const blocked = lock.locked ? `锁定中：${lock.reason}（${lock.lockedAt}）` : '';

  let browser = { ok: false, bossTabs: 0, securityPages: 0 };
  let bossTabRows = [];
  try {
    const tabs = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());
    const boss = tabs.filter(x => x.type === 'page' && /zhipin\.com/.test(x.url || ''));
    bossTabRows = boss;
    const inspected = [];
    for (const tab of boss) {
      const probe = await probeTabSecurity(tab);
      inspected.push(probe.probeFailed ? HARD_URL_ONLY_RE.test(`${tab.url} ${tab.title}`) : !!probe.security);
    }
    const security = inspected.filter(Boolean).length;
    browser = { ok: boss.length > 0 && security === 0, bossTabs: boss.length, securityPages: security };
    if (security) {
      writeLock('preflight 发现安全/异常页面', boss.map(x => `${x.url} ${x.title}`).join(' ; '));
      browser.note = `已写入熔断锁 ${rel(LOCK_FILE)}：所有在线命令拒绝运行`;
    } else if (!boss.length) {
      browser.note = '没有 zhipin 标签页，登录态无法确认；先在调试浏览器里打开 BOSS 再作业';
    }
  } catch (error) {
    browser.note = `CDP 端口 ${PORT} 不可达：${error.message}`;
  }

  const budget = loadBudget();
  const ledger = loadLedger();
  const approved = ledger.jobs.filter(x =>
    isCurrentCycleJob(x) && reviewsReady(x) &&
    x.outreach?.status === 'not_sent' &&
    !readyRejectReason(x) &&
    !priorContactReason(ledger, x)
  );
  const ready = approved.filter(openerCurrent);
  const approvedForOpener = approved.filter(x => !openerCurrent(x));
  const awaitingReview = ledger.jobs.filter(x =>
    isCurrentCycleJob(x) && x.jd?.status === 'read' && x.outreach?.status === 'not_sent' &&
    !reviewsReady(x) &&
    !['remote', 'pay', 'risk'].some(k => x.review?.[k]?.status === 'fail') &&
    !queueRejectReason(x) &&
    !priorContactReason(ledger, x)
  );
  const unread = ledger.jobs.filter(x =>
    isCurrentCycleJob(x) && (isCurrentFavorite(x) || ['priority', 'review'].includes(x.preScreen?.status)) &&
    !['read', 'partial', 'expired'].includes(x.jd?.status) &&
    !queueRejectReason(x) &&
    !candidateRemoteRejectReason(x) &&
    !priorContactReason(ledger, x)
  );
  const remaining = Object.fromEntries(['searchPages', 'jobReads', 'sends']
    .map(kind => [kind, Math.max(0, DAILY_BUDGET[kind] - countWithin(budget, kind, WINDOW_24H))]));
  const jobWorkNext = (blocked || !browser.ok) && awaitingReview.length
    ? `浏览器当前不可用，先离线审核已有完整 JD：node workflow/boss.js list --queue=review --limit=20；发送前再恢复浏览器`
    : blocked || !browser.ok
      ? '先恢复浏览器/登录态或等待熔断解除，不执行在线动作'
      : ready.length
      ? `先处理本地发送材料已就绪岗位：node workflow/boss.js list --queue=send-ready --sort=complete --limit=20`
      : approvedForOpener.length
      ? `先为审核通过岗位生成并核对开场白：node workflow/boss.js list --queue=approved --sort=complete --limit=20`
      : awaitingReview.length
        ? `先离线审核已有完整 JD：node workflow/boss.js list --queue=review --limit=20`
        : unread.length && remaining.jobReads > 0
          ? `读取信息最完整的现有候选：node workflow/boss.js candidates --sort=complete --limit=20`
          : remaining.searchPages > 0
          ? '现有队列已耗尽，先查看岗位入口与断点：node workflow/boss.js job-sources'
          : '等待滚动额度恢复；当前无可执行的高质量在线动作';
  console.log(JSON.stringify({
    port: PORT,
    blocked: blocked || undefined,
    browser,
    readiness: {
      jobWorkflow: !blocked && browser.ok ? 'ready' : 'blocked',
    },
    rate: {
      night: isNightHour(),
      paceMultiplier: paceMultiplier(),
      remaining24h: remaining,
      consecutiveEmptyJd: budget.consecutiveEmptyJd || 0,
    },
    sends: sendCounts(ledger),
    ledger: {
      jobs: ledger.jobs.length,
      completeJd: ledger.jobs.filter(x => x.jd?.status === 'read').length,
      delivered: ledger.jobs.filter(x => x.outreach?.status === 'delivered').length,
      deliveryUnverified: ledger.jobs.filter(x => x.outreach?.status === 'delivery_unverified').map(x => x.jobId),
    },
    queue: {
      readyToSend: ready.length,
      approvedForOpener: approvedForOpener.length,
      awaitingReview: awaitingReview.length,
      unreadCandidates: unread.length,
      ...(full ? {
        readyToSendIds: ready.slice(0, 20).map(x => x.jobId),
        approvedForOpenerIds: approvedForOpener.slice(0, 20).map(x => x.jobId),
        awaitingReviewIds: awaitingReview.slice(0, 20).map(x => x.jobId),
        unreadCandidateIds: unread.slice(0, 20).map(x => x.jobId),
      } : {}),
    },
    sourceProgress: {
      favorites: (() => { const state = loadFavoritesSession(); const currentSnapshot = ledger.jobs.filter(job => (job.sources || []).includes('favorite:current')).length; return state.scanId ? { nextCommand: 'node workflow/boss.js favorites-next', page: state.page, totalPages: state.totalPages, accumulated: state.ids?.length || 0, currentSnapshot } : { currentSnapshot }; })(),
      recommendations: (() => { const state = loadRecommendSession(); if (!state.tabId) return null; const tab = bossTabRows.find(item => item.id === state.tabId); const valid = tab && (() => { try { const url = new URL(tab.url); return url.pathname === '/web/geek/jobs' && !url.searchParams.get('query'); } catch { return false; } })(); return valid ? { nextCommand: 'node workflow/boss.js recommendations-next', page: state.page, seen: state.seenIds?.length || 0 } : { stale: true, reason: '推荐专用标签已关闭或被其他页面占用', recoveryCommand: 'node workflow/boss.js recommendations' }; })(),
      search: (() => { const state = loadSearchSession(); if (!state.tabId) return null; const tab = bossTabRows.find(item => item.id === state.tabId); const valid = tab && (() => { try { const url = new URL(tab.url); return url.pathname === '/web/geek/jobs' && url.searchParams.get('query') === state.query; } catch { return false; } })(); return valid ? { nextCommand: 'node workflow/boss.js search-next', query: state.query, page: state.page, seen: state.seenIds?.length || 0 } : { stale: true, reason: '搜索专用标签已关闭或被其他页面占用', recoveryCommand: `node workflow/boss.js search "${state.query || '<关键词>'}"` }; })(),
    },
    recommendedNext: jobWorkNext,
  }, null, 2));
  if (blocked || !browser.ok) process.exitCode = 2;
}

async function readJob() {
  const input = positional() || arg('url');
  // 2026-08-10：BOSS 加密岗位 ID 可能含 `~`（如 4f8cde746decdf950XN50t--GFE~），
  // 纯 \w- 正则会把它误判为非法输入；URL 形态由 jobIdOf 先行提取，不受影响。
  const id = jobIdOf(input) || (/^[\w~-]+$/.test(input || '') ? input : '');
  const existing = id ? loadLedger().jobs.find(x => x.jobId === id) : null;
  const url = jobIdOf(input) ? input : existing?.url;
  if (!id) throw new Error('需要有效的 BOSS 岗位详情链接');
  if (!url) throw new Error(`台账中没有岗位 ${id} 的详情链接`);
  await reserveAction('jobReads', id);
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab(url, PORT);
  try {
    const page = await waitForJobPage(cdp, id);
    if (page.security) throwSecurity('岗位页进入安全验证', `${id} -> ${page.url || ''}`);
    if (jobIdOf(page.url) !== id) {
      if (!isExpiredJobRedirect(page.url)) throwSecurity('岗位页发生异常跳转', `${id} -> ${page.url || ''}`);
      const ledger = loadLedger();
      const job = ensureJob(ledger, id, url);
      job.jd = { ...(job.jd || {}), status: 'expired', checkedAt: now() };
      job.nextAction = '岗位已失效（详情页跳回首页/列表）';
      job.preScreen = { ...(job.preScreen || {}), status: 'reject', reason: job.nextAction };
      saveLedger(ledger);
      console.log(`EXPIRED ${id} 岗位详情页跳回 ${page.url}，已标记失效，未写熔断锁`);
      return;
    }
    if (!String(page.structured?.description || '').trim()) {
      noteEmptyJd(unreadableJobMessage(page));
      throw new Error(unreadableJobMessage(page));
    }
    resetEmptyJd();
    const parsed = normalizeStructuredPage(page);
    const ledger = loadLedger();
    const job = ensureJob(ledger, id, url);
    job.title = parsed.structured.title || job.title;
    job.company = parsed.structured.company || job.company;
    job.salary = parsed.structured.salary || job.salary;
    const recruiter = recruiterFromButton(page.button, parsed.structured.recruiter.name, job.company);
    job.recruiter = { ...recruiter, title: parsed.structured.recruiter.title, activeText: parsed.structured.recruiter.activeText, activityRank: parsed.structured.recruiter.activityRank };
    if (parsed.structured.incomplete) {
      if (job.jd?.status !== 'read') {
        job.jd = { status: 'partial', liveStatus: 'partial', evidencePath: '', remoteHint: parsed.remoteEvidence, hash: parsed.hash, structured: parsed.structured, checkedAt: now() };
      } else {
        job.jd.liveStatus = 'partial';
        job.jd.liveCheckedAt = now();
      }
      addDecision(job, 'jd_read', 'reject', 'incomplete_jd', '职位正文被登录提示截断，不能审核或发送', '登录查看完整内容');
    } else {
      job.jd = { status: 'read', liveStatus: 'complete', evidencePath: '', remoteHint: parsed.remoteEvidence, hash: parsed.hash, structured: parsed.structured, checkedAt: now() };
      addDecision(job, 'jd_read', 'pass', 'complete_jd', '已读取完整结构化 JD', `${parsed.structured.description.length} 字`);
      if (!job.preScreen?.profile) preScreenJob(ledger, job, { title: job.title, text: `${job.title}\n${job.salary}` });
    }
    job.sources = [...new Set([...(job.sources || []), arg('source') || 'manual'])];
    const relatedLinks = (await extractSearchLinks(cdp)).filter(link => jobIdOf(link.url) !== id);
    saveLedger(ledger);
    const related = relatedLinks.length
      ? storeSearchLinks(relatedLinks, { query: id, page: 1, sourcePrefix: 'related', runType: 'related' }).summary
      : { query: id, page: 1, captured: 0, visible: 0, fresh: 0, counts: { priority: 0, review: 0, reject: 0 } };
    // --jd 直接带出审核所需的全部字段（含 JD 正文），省掉紧接着的第二次命令往返：
    // 审岗本来就必须看正文，拆成两次调用只是多花一轮工具开销。
    if (process.argv.includes('--jd')) {
      console.log(JSON.stringify({ ...reviewPayload(job), relatedDiscovery: related }, null, 2));
    } else {
      console.log(JSON.stringify({
        status: job.jd.status, jobId: id, title: job.title, company: job.company, salary: job.salary,
        remoteHint: job.jd.remoteHint, descriptionChars: job.jd.structured?.description?.length || 0,
        recruiterActive: job.recruiter.activeText || '', activityRank: job.recruiter.activityRank || 0,
        relatedDiscovery: related,
      }, null, 2));
    }
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

function conversationWorkbench() {
  const jobId = arg('job-id') || positional();
  const bossId = arg('boss-id');
  if (!jobId && !bossId) throw new Error('请提供 <jobId> 或 --job-id/--boss-id');
  const ledger = loadLedger();
  const rows = currentConversations(ledger).filter(row => (!jobId || row.encryptJobId === jobId) && (!bossId || row.encryptBossId === bossId));
  if (rows.length !== 1) throw new Error(`会话目标必须唯一，当前匹配 ${rows.length} 条；请同时提供 --job-id 和 --boss-id`);
  console.log(JSON.stringify(conversationWorkbenchPayload(ledger, rows[0], { full: process.argv.includes('--full') }), null, 2));
}

function jobWorkbenchPayload(ledger, job, { full = false } = {}) {
  const conversation = currentConversations(ledger).find(row =>
    (row.encryptJobId && row.encryptJobId === job.jobId) ||
    (job.recruiter?.encryptBossId && row.encryptBossId === job.recruiter.encryptBossId)
  );
  const prior = priorContactReason(ledger, job);
  const queueStop = queueRejectReason(job);
  const integrityIssues = reviewIntegrityIssues(job);
  const failedReview = ['remote', 'pay', 'risk'].find(field => job.review?.[field]?.status === 'fail');
  const pendingReview = ['remote', 'pay', 'risk'].filter(field => (job.review?.[field]?.status || 'pending') === 'pending');
  const openerReady = openerCurrent(job);
  let stage = 'unknown';
  let blockers = [];
  let nextCommands = [];

  if (job.outreach?.status === 'delivery_unverified') {
    stage = 'delivery-unverified';
    blockers = ['送达证据尚未确认，禁止重发'];
    nextCommands = [`node workflow/boss.js verify-delivery ${job.jobId}`];
  } else if (job.outreach?.status === 'chat_created_not_sent') {
    stage = 'resume-first-message';
    blockers = openerReady ? [] : ['已建联但当前 JD 没有可恢复的绑定开场白'];
    nextCommands = openerReady
      ? [`node workflow/boss.js ai-send ${job.jobId} --use-saved --resume-chat --dry-run`, `node workflow/boss.js ai-send ${job.jobId} --use-saved --resume-chat`]
      : [`node workflow/boss.js jd ${job.jobId}`, `node workflow/boss.js save-opener ${job.jobId}`];
  } else if (['delivered', 'delivered_legacy'].includes(job.outreach?.status)) {
    stage = conversation && ['boss_last_review', 'contact_shared', 'needs_inspect'].includes(conversation.status) ? 'incoming-review' : 'delivered';
    nextCommands = conversation ? [conversationCommand(conversation)] : ['node workflow/boss.js replies'];
  } else if (job.outreach?.status && job.outreach.status !== 'not_sent') {
    stage = 'closed-or-communicated';
    blockers = [job.nextAction || `首次沟通状态为 ${job.outreach.status}`];
    nextCommands = conversation ? [conversationCommand(conversation)] : [];
  } else if (prior) {
    stage = 'existing-conversation';
    blockers = [prior];
    nextCommands = conversation ? [conversationCommand(conversation)] : ['node workflow/boss.js replies'];
  } else if (queueStop) {
    stage = 'stopped';
    blockers = [queueStop];
  } else if (job.jd?.status !== 'read' || !String(job.jd?.structured?.description || '').trim()) {
    stage = 'read-jd';
    blockers = [job.jd?.status === 'partial' ? '现有 JD 不完整' : '尚无完整 JD'];
    nextCommands = [`node workflow/boss.js read ${job.jobId} --jd`];
  } else if (failedReview) {
    stage = 'rejected';
    blockers = [`${failedReview} 审核为 fail`, job.review?.[failedReview]?.evidence || ''].filter(Boolean);
  } else if (integrityIssues.length) {
    stage = 'review-invalid';
    blockers = integrityIssues.map(issue => `${issue.field}: ${issue.message}${issue.evidence ? `（${issue.evidence}）` : ''}`);
    nextCommands = [
      `node workflow/boss.js jd ${job.jobId}`,
      `node workflow/boss.js review ${job.jobId} --remote=<pending|pass|negotiable|fail> --remote-evidence="<原句>" --pay=<pending|pass|fail> --pay-evidence="<原句>" --risk=<pending|pass|fail> --risk-evidence="<原句>"`,
    ];
  } else if (pendingReview.length) {
    stage = 'review';
    blockers = pendingReview.map(field => `${field} 尚未审核`);
    nextCommands = [
      `node workflow/boss.js jd ${job.jobId}`,
      `node workflow/boss.js review ${job.jobId} --remote=<pending|pass|negotiable|fail> --remote-evidence="<原句>" --pay=<pending|pass|fail> --pay-evidence="<原句>" --risk=<pending|pass|fail> --risk-evidence="<原句>"`,
    ];
  } else if (!openerReady) {
    stage = job.opener?.status === 'generated' ? 'rewrite-stale-opener' : 'write-opener';
    blockers = job.opener?.status === 'generated' ? ['已存开场白未绑定当前 JD'] : ['尚未保存定制开场白'];
    nextCommands = [`node workflow/boss.js jd ${job.jobId}`, `node workflow/boss.js save-opener ${job.jobId}`];
  } else {
    stage = 'send-ready';
    nextCommands = [`node workflow/boss.js ai-send ${job.jobId} --use-saved --dry-run`, `node workflow/boss.js ai-send ${job.jobId} --use-saved`];
  }

  const includeDescription = full || ['review', 'review-invalid', 'write-opener', 'rewrite-stale-opener'].includes(stage);
  const allSources = job.sources || [];
  const recentBusinessSources = [...new Set(allSources
    .filter(source => /^(?:favorite:current|interaction(?::|$)|company(?::|$)|recommendation(?::|$)|related(?::|$)|search(?::|$))/.test(source))
    .reverse())].slice(0, 6);
  return {
    stage,
    job: {
      jobId: job.jobId,
      title: job.title,
      company: job.company,
      salary: job.salary || job.jd?.structured?.salary || '',
      url: job.url,
      sourceCount: allSources.length,
      sources: full ? allSources : recentBusinessSources,
      sourceRank: discoverySourceRank(job),
      activity: job.recruiter?.activeText || '',
      activityRank: Number(job.recruiter?.activityRank || job.preScreen?.activityRank || 0),
    },
    jd: {
      status: job.jd?.status || 'unknown',
      hash: job.jd?.hash || '',
      remoteHint: job.jd?.remoteHint || '',
      ...(includeDescription ? { description: job.jd?.structured?.description || '', benefits: job.jd?.structured?.benefits || '' } : {}),
    },
    review: Object.fromEntries(['remote', 'pay', 'risk'].map(field => [field, {
      status: job.review?.[field]?.status || 'pending',
      evidence: job.review?.[field]?.evidence || '',
    }])),
    opener: {
      status: openerReady ? 'current' : job.opener?.status || 'none',
      message: job.opener?.message || '',
      generator: job.opener?.generator || '',
    },
    outreach: {
      status: job.outreach?.status || 'not_sent',
      verify: job.outreach?.verify || null,
      nextAction: job.nextAction || '',
    },
    conversation: conversation ? {
      status: conversation.status,
      company: conversation.company,
      name: conversation.name,
      lastMessage: conversation.lastMessage,
      bossId: conversation.encryptBossId,
      jobId: conversation.encryptJobId,
      resumeTrigger: resumeTrigger(conversation.lastMessage),
      suggestedResume: resumeForJob(job),
    } : null,
    blockers,
    nextCommands,
  };
}

function jobWorkbench() {
  const input = positional() || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const job = ledger.jobs.find(item => item.jobId === id);
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  console.log(JSON.stringify(jobWorkbenchPayload(ledger, hydrateLegacyStructured(job), { full: process.argv.includes('--full') }), null, 2));
}

function reviewAudit() {
  const ledger = loadLedger();
  const rows = ledger.jobs
    .filter(job => isCurrentCycleJob(job) && job.jd?.status === 'read' && job.outreach?.status === 'not_sent')
    .map(job => ({ jobId: job.jobId, title: job.title, company: job.company, issues: reviewIntegrityIssues(job), stopReason: explicitWorkflowStopReason(job) }))
    .filter(row => row.issues.length || row.stopReason);
  const invalidReviews = rows.filter(row => row.issues.length);
  const explicitStops = rows.filter(row => row.stopReason);
  const counts = {};
  for (const row of rows) {
    for (const issue of row.issues) counts[issue.code] = (counts[issue.code] || 0) + 1;
    if (row.stopReason) counts.explicit_workflow_stop = (counts.explicit_workflow_stop || 0) + 1;
  }
  const ordered = [...invalidReviews, ...explicitStops.filter(row => !row.issues.length)];
  const limit = process.argv.includes('--full') ? ordered.length : Math.min(100, Number(arg('limit') || 20));
  console.log(JSON.stringify({
    total: rows.length,
    invalidReviews: invalidReviews.length,
    explicitStops: explicitStops.length,
    counts,
    showing: Math.min(limit, ordered.length),
    rows: ordered.slice(0, limit),
    nextCommand: invalidReviews.length ? `node workflow/boss.js job-workbench ${invalidReviews[0].jobId}` : 'node workflow/boss.js next-work',
  }, null, 2));
}

function nextWork() {
  const ledger = loadLedger();
  const daily = loadDailyOptions();
  const lane = arg('lane') || 'auto';
  if (!['auto', 'conversations', 'jobs', 'discover'].includes(lane)) throw new Error('next-work --lane 仅支持 auto/conversations/jobs/discover');
  if (lane === 'discover') {
    console.log(JSON.stringify({ kind:'discover', lane, dailyOptions:daily, nextCommands:['node workflow/boss.js job-sources'] }, null, 2));
    return;
  }
  if (lane === 'conversations') {
    const conversations = currentConversations(ledger);
    const urgentConversation = conversations
      .filter(row => row.status === 'needs_inspect')
      .sort((a, b) =>
        (Number(Number(b.unread || 0) > 0) - Number(Number(a.unread || 0) > 0)) ||
        (Number(b.time || 0) - Number(a.time || 0))
      )[0];
    if (urgentConversation) {
      const trigger = resumeTrigger(urgentConversation.lastMessage);
      const ids = [urgentConversation.encryptJobId ? `--job-id=${urgentConversation.encryptJobId}` : '', urgentConversation.encryptBossId ? `--boss-id=${urgentConversation.encryptBossId}` : ''].filter(Boolean).join(' ');
      const resumeDryRun = `node workflow/boss.js resume-send --auto --dry-run ${ids}`.trim();
      const resumeSendCommand = `node workflow/boss.js resume-send --auto ${ids}`.trim();
      const automaticResumeAllowed = (trigger === 'explicit' && ['explicit', 'positive'].includes(daily.resumeMode)) || (trigger === 'positive' && daily.resumeMode === 'positive');
      const resumeRequest = ['explicit', 'positive'].includes(trigger);
      const consentRequired = !!urgentConversation.resumeConsentRequired;
      const workbench = conversationWorkbenchPayload(ledger, urgentConversation);
      console.log(JSON.stringify({
        ...workbench,
        replyContext: {
          guidance: workbench.replyGuidance,
          factsSource: workbench.factsSource,
          replyCommand: workbench.commands.reply,
        },
        suggestedResume: workbench.resume.suggested,
        resumeTrigger: workbench.resume.trigger,
        requiredDecision: consentRequired
          ? 'BOSS 正式简历请求卡尚未同意；点击同意可能先发送平台在线简历，当前只允许干运行并等待用户选择策略'
          : resumeRequest && daily.needsChoice ? '今天尚未选择自动发简历策略；可先干运行，真实发送前必须由用户选择 off/explicit/positive' : '',
        nextCommands: consentRequired
          ? [resumeDryRun, 'node workflow/boss.js daily-options']
          : resumeRequest
          ? automaticResumeAllowed
            ? [resumeDryRun, resumeSendCommand]
            : daily.resumeMode === 'off'
              ? [conversationCommand(urgentConversation)]
              : [resumeDryRun, 'node workflow/boss.js daily-options']
          : [conversationCommand(urgentConversation)],
      }, null, 2));
      return;
    }
    console.log(JSON.stringify({ kind:'conversations-clear', lane, dailyOptions:daily, nextCommands:['node workflow/boss.js replies'] }, null, 2));
    return;
  }
  const sortJobs = rows => rows.sort((a, b) => informationCompleteness(b).score - informationCompleteness(a).score);
  const current = ledger.jobs.filter(job => isCurrentCycleJob(job) && !queueRejectReason(job));
  const pick = sortJobs(current.filter(job => job.outreach?.status === 'not_sent' && reviewsReady(job) && openerCurrent(job) && !priorContactReason(ledger, job)))[0]
    || sortJobs(current.filter(job => job.outreach?.status === 'not_sent' && reviewsReady(job) && !openerCurrent(job) && !priorContactReason(ledger, job)))[0]
    || sortJobs(current.filter(job => job.outreach?.status === 'not_sent' && job.jd?.status === 'read' && !reviewsReady(job) && !['remote', 'pay', 'risk'].some(field => job.review?.[field]?.status === 'fail') && !priorContactReason(ledger, job)))[0]
    || sortJobs(current.filter(job => job.outreach?.status === 'not_sent' && !['read', 'partial', 'expired'].includes(job.jd?.status) && ['priority', 'review'].includes(job.preScreen?.status) && !priorContactReason(ledger, job)))[0];
  if (pick) {
    console.log(JSON.stringify({ kind: 'job', dailyOptions: daily, ...jobWorkbenchPayload(ledger, hydrateLegacyStructured(pick)) }, null, 2));
    return;
  }
  console.log(JSON.stringify({ kind: 'discover', lane, dailyOptions: daily, nextCommands: ['node workflow/boss.js job-sources'] }, null, 2));
}

function list() {
  const ledger = loadLedger();
  const approved = ledger.jobs.filter(x =>
    isCurrentCycleJob(x) && reviewsReady(x) &&
    x.outreach?.status === 'not_sent' &&
    !readyRejectReason(x) &&
    !priorContactReason(ledger, x)
  );
  const sendReady = approved.filter(openerCurrent);
  const review = currentConversations(ledger).filter(x => x.status === 'boss_last_review');
  const inspect = currentConversations(ledger).filter(x => x.status === 'needs_inspect');
  const contacts = currentConversations(ledger).filter(x => x.status === 'contact_shared');
  const pre = Object.fromEntries(['priority', 'review', 'reject'].map(status => [status, ledger.jobs.filter(x => x.preScreen?.status === status).length]));
  console.log(`岗位 ${ledger.jobs.length}｜完整JD ${ledger.jobs.filter(x => x.jd?.status === 'read').length}｜预筛优先 ${pre.priority}｜预筛待看 ${pre.review}｜预筛淘汰 ${pre.reject}｜审核通过 ${approved.length}｜材料就绪 ${sendReady.length}｜待判断 ${review.length}｜待精确检查 ${inspect.length}｜联系方式待决定 ${contacts.length}｜远程友好公司 ${ledger.companies.filter(x => x.status === 'pass').length}`);
  // 2026-07-26：可发送队列上百条时，只印前 20 条会逼 agent 去翻 ledger.json（单岗约 5KB）。
  // --limit / --grep / --max-salary 让筛选留在命令里，避免把整本台账拉进上下文。
  const limit = Number(arg('limit')) || 20;
  const grep = arg('grep');
  const maxSalary = Number(arg('max-salary')) || 0;
  const monthlyLow = s => {
    const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)\s*[kK]/);
    if (m) return Number(m[1]);
    const one = String(s || '').match(/(\d+(?:\.\d+)?)\s*[kK]/);
    return one ? Number(one[1]) : null;
  };
  // --queue=review 看「JD 已读齐但三项审核未判完」的待审队列，这些岗位可以离线 jd <id> 复看后直接判，
  // 不用再花详情页额度；默认仍是可发送队列。
  const queue = arg('queue') || 'approved';
  const awaiting = ledger.jobs.filter(x =>
    isCurrentCycleJob(x) && x.jd?.status === 'read' &&
    x.outreach?.status === 'not_sent' &&
    !reviewsReady(x) &&
    !['remote', 'pay', 'risk'].some(k => x.review?.[k]?.status === 'fail') &&
    !queueRejectReason(x) &&
    !priorContactReason(ledger, x)
  );
  if (!['approved', 'send-ready', 'review'].includes(queue)) throw new Error('list --queue 仅支持 approved/send-ready/review');
  let rows = queue === 'review' ? awaiting : queue === 'send-ready' ? sendReady : approved;
  const tag = queue === 'review' ? '待审' : queue === 'send-ready' ? '材料就绪' : '审核通过待准备';
  // --has-remote 把「已存 JD 里有没有远程表述」的筛选留在命令里，并回印命中的原句作为 review 证据。
  // 没有它就只能逐个 jd <id> 试，几百个岗位时那是纯浪费。
  const hit = new Map();
  if (process.argv.includes('--has-remote')) {
    rows = rows.filter(x => {
      const result = assessRemote(x.title, `${jobDescription(x)}\n${x.review?.remote?.evidence || ''}`);
      if (result.status === 'pass') hit.set(x.jobId, result.evidence);
      return result.status === 'pass';
    });
  }
  if (grep) rows = rows.filter(x => new RegExp(grep, 'i').test(`${x.title} ${x.company}`));
  // --source 按来源筛，主要用途是把 interaction:谁看过我 / 对我感兴趣的 挑出来——
  // 这些招聘者刚看过本人主页，活跃度天然最高，优先级高于搜索页捞的岗位。
  const source = arg('source');
  if (source) rows = rows.filter(x => (x.sources || []).some(s => s.includes(source)));
  if (maxSalary) rows = rows.filter(x => { const lo = monthlyLow(x.salary); return lo !== null && lo <= maxSalary; });
  const sort = arg('sort') || 'complete';
  if (sort === 'complete') rows.sort((a, b) => informationCompleteness(b).score - informationCompleteness(a).score);
  else if (sort !== 'default') throw new Error('list --sort 仅支持 complete/default');
  console.log(`筛后 ${rows.length}`);
  rows.slice(0, limit).forEach(x => console.log(`- [${tag}｜信息完整度${informationCompleteness(x).score}/6] ${x.jobId} ${x.salary || '薪资未知'} ${x.title} @ ${x.company}${openerCurrent(x) ? ' [开场白已绑定当前JD]' : ''}${hit.has(x.jobId) ? ` ｜远程原句：${hit.get(x.jobId)}` : ''}`));
}

function profiles() {
  for (const [id, profile] of Object.entries(PROFILES)) {
    console.log(`${id}\t${profile.label}\t${profile.titleKeywords.join('、')}`);
  }
}

function candidates() {
  const ledger = loadLedger();
  const limit = Math.min(100, Number(arg('limit') || 30));
  const profile = arg('profile');
  const source = arg('source');
  if (profile && !PROFILES[profile]) throw new Error(`未知岗位方向 ${profile}；可用：${Object.keys(PROFILES).join('/')}`);
  // v2：不再按项目信号、来源或招聘者活跃度排序，只优先读取信息更完整的卡片。
  const sort = arg('sort') || 'complete';
  if (!['complete', 'default'].includes(sort)) throw new Error('candidates --sort 仅支持 complete/default；v2 不再按项目分、来源或招聘者活跃度排序');
  const rows = ledger.jobs
    .filter(job => isCurrentCycleJob(job) && (isCurrentFavorite(job) || ['priority', 'review'].includes(job.preScreen?.status)) && (!profile || job.preScreen.profile === profile))
    .filter(job => !source || (job.sources || []).some(item => item.includes(source)))
    .filter(job => !['read', 'partial', 'expired'].includes(job.jd?.status) && !queueRejectReason(job) && !candidateRemoteRejectReason(job) && !priorContactReason(ledger, job))
    .sort((a, b) => informationCompleteness(b).score - informationCompleteness(a).score)
    .slice(0, limit);
  console.log(`待读完整 JD 候选 ${rows.length}`);
  rows.forEach(job => { const info = informationCompleteness(job); console.log(`- ${job.jobId} [信息完整度 ${info.score}/6：${info.fields.join('、') || '仅职位卡'}] ${job.title} ${job.salary || ''} @ ${job.company || '公司未知'}`); });
}

const selfTest = createSelfTest({ reviewPayload, jobWorkbenchPayload, onlineCommands: ONLINE_COMMANDS });

async function doctor() {
  const checks = [];
  const run = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) });
    } catch (error) {
      checks.push({ name, ok: false, error: String(error.message || error) });
    }
  };
  await run('node', () => ({ version: process.version, supported: Number(process.versions.node.split('.')[0]) >= 22 }));
  await run('files', () => {
    const required = [
      'workflow/cdp.js', 'workflow/browser.js', 'workflow/browser-cli.js', 'workflow/safety.js',
      'workflow/ledger-store.js', 'workflow/cli-args.js', 'workflow/daily-options.js',
      'workflow/job-domain.js', 'workflow/jd-domain.js', 'workflow/conversation-domain.js',
      'workflow/conversation-workbench.js', 'workflow/page-flows.js', 'workflow/opener-service.js',
      'workflow/delivery-verification.js', 'workflow/maintenance.js', 'workflow/discovery-commands.js',
      'workflow/outreach-commands.js', 'workflow/command-help.js', 'workflow/self-test.js', 'workflow/project-scoring.js',
      'workflow/README.md', 'workflow/dispatch.js', 'workflow/reins-config.js', 'README.md', 'AGENTS.md',
      path.relative(ROOT, require('./reins-config').loadConfig().factsFile),
    ];
    const missing = required.filter(file => !fs.existsSync(path.join(ROOT, file)));
    if (missing.length) throw new Error(`缺少：${missing.join('、')}`);
    return { required: required.length };
  });
  await run('modules', () => {
    const modules = [
      'cdp', 'browser', 'browser-cli', 'safety', 'ledger-store', 'cli-args', 'daily-options',
      'job-domain', 'jd-domain', 'conversation-domain', 'conversation-workbench', 'page-flows',
      'opener-service', 'delivery-verification', 'maintenance', 'discovery-commands',
      'outreach-commands', 'command-help', 'self-test', 'project-scoring',
    ];
    modules.forEach(name => require(`./${name}`));
    return { loaded: modules.length };
  });
  await run('help-coverage', () => {
    const missing = Object.keys(commands).filter(name => !HELP[name]);
    const stale = Object.keys(HELP).filter(name => !commands[name]);
    if (missing.length || stale.length) throw new Error(`缺帮助=${missing.join(',') || '无'}；失效帮助=${stale.join(',') || '无'}`);
    return { commands: Object.keys(commands).length, online: ONLINE_COMMANDS.size, offline: Object.keys(commands).length - ONLINE_COMMANDS.size };
  });
  await run('ledger', () => validate({ quiet: true }));
  await run('self-test', () => selfTest({ quiet: true }));
  const ok = checks.every(check => check.ok && (check.name !== 'node' || check.detail.supported));
  console.log(JSON.stringify({ ok, mode: 'offline', consumesBossBudget: false, checks }, null, 2));
  if (!ok) process.exitCode = 1;
}

const commands = {
  import: importLegacy, 'migrate-jd': migrateJd, 'project-score': projectScore, 'rehash-jd': rehashJd, validate, 'normalize-conversations': normalizeConversations, preflight, 'daily-options': dailyOptions, 'resume-candidates': resumeCandidates, check, replies, interactions, 'job-sources': jobSources, 'next-work': nextWork, 'conversation-workbench': conversationWorkbench, 'job-workbench': jobWorkbench, 'review-audit': reviewAudit, profile, favorites, 'favorites-next': favoritesNext, recommendations, 'recommendations-next': recommendationsNext, 'recommendations-close': recommendationsClose, 'settings-status': settingsStatus, 'favorite-status': favoriteStatus, profiles, search, 'search-next': searchNext, 'search-close': searchClose, 'harvest-current': harvestCurrent, candidates,
  read: readJob, jd: showJd, review, 'ai-opener': () => (process.argv.includes('--batch') ? openerBatch() : aiOpener()), 'save-opener': saveOpener, 'discard-opener': discardOpener, 'ai-send': aiSend, send, 'verify-delivery': verifyDelivery, 'favorite-queue': favoriteQueue,
  company, 'company-jobs': companyJobs, list, unlock, budget: budgetStatus,
  capabilities, 'browser-tabs': browserTabs, 'browser-snapshot': browserSnapshot, 'browser-open': browserOpen, 'browser-click': browserClick, 'browser-fill': browserFill,
  'browser-scroll': browserScroll, 'browser-back': browserBack, 'browser-wait': browserWait, 'browser-hover': browserHover, 'browser-key': browserKey, 'browser-toggle': browserToggle, 'browser-select': browserSelect, 'conversation-open': conversationOpen,
  'conversation-reply': conversationReply, 'resume-send': resumeSend,
  'review-relax': reviewRelax, 'send-plan': sendPlan, dispatch,
  doctor, 'self-test': selfTest,
};
const command = process.argv[2];
if (command === 'help' || command === '--help' || process.argv.includes('--help')) {
  help(command === 'help' ? (process.argv[3] || '') : command === '--help' ? '' : command);
  process.exit(0);
}
if (!commands[command]) {
  help();
  process.exit(command ? 1 : 0);
}
if (ONLINE_COMMANDS.has(command)) {
  try { assertNotLocked(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exit(1); }
}
Promise.resolve(commands[command]()).catch(error => { console.error(`ERROR: ${error.message}`); process.exit(1); });
