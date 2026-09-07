// 批量作业：模型离线写材料（ai-opener --batch）→ 生成计划文件（send-plan）→ 确定性执行器逐条发送（dispatch）。
// 模型只在第一步参与；第二步是人看一眼计划的唯一确认点；第三步不需要任何模型在线，
// 每条发送仍走 sendMessage 的全部门禁（去重、jdHash、事实门禁、额度、节流、送达核验），
// 任何安全/额度/浏览器级异常就停机并留下断点，重跑同一个计划文件即续跑。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { PORT, DAILY_BUDGET, BURST_LIMIT, WINDOW_24H, WINDOW_10MIN, loadBudget, countWithin, loadLock, assertNotLocked, sleepMs } = require('./safety');
const { arg } = require('./cli-args');
const { loadLedger, saveLedger } = require('./ledger-store');
const { PROFILES, addDecision, priorContactReason, isCurrentCycleJob } = require('./job-domain');
const { hydrateLegacyStructured, reviewsReady, openerCurrent, readyRejectReason } = require('./jd-domain');
const { validateOpener, openerStyle, assertAiReady, assertOpenerFits, factAnchorReason, generateOpener } = require('./opener-service');

const ROOT = path.resolve(__dirname, '..');
const PLAN_DIR = path.join(ROOT, 'data', 'plans');
const now = () => new Date().toISOString();
const hashOf = text => crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
// 这些错误不是单个岗位的问题，继续下一条只会把账号搭进去
const HALT_RE = /额度已用完|突发上限|硬顶|安全验证|熔断|锁定中|CDP|不可达|ECONNREFUSED|ECONNRESET|fetch failed|登录态|登录失效|账户|访问受限|异常/;

// 与 preflight/list 同一口径的「审核通过、未发送、未联系过」队列
function approvedQueue(ledger) {
  return ledger.jobs.filter(x =>
    isCurrentCycleJob(x) && reviewsReady(x) &&
    ['not_sent', 'chat_created_not_sent'].includes(x.outreach?.status) &&
    !readyRejectReason(x) &&
    !priorContactReason(ledger, x));
}

// 发送计数：只数本系统自己发出去的首次招呼（本人手动打招呼/回复不在台账里，也不该被数）
function sendCounts(ledger, { now: at = Date.now() } = {}) {
  const sent = ledger.jobs.filter(x => ['delivered', 'delivered_legacy', 'delivery_unverified'].includes(x.outreach?.status) && x.outreach?.sentAt);
  const today = new Date(at).toISOString().slice(0, 10);
  const last = sent.reduce((max, x) => Math.max(max, Date.parse(x.outreach.sentAt) || 0), 0);
  return {
    sentToday: sent.filter(x => x.outreach.sentAt.startsWith(today)).length,
    sent7d: sent.filter(x => at - Date.parse(x.outreach.sentAt) <= 7 * WINDOW_24H).length,
    daysSinceLastSend: last ? Math.floor((at - last) / WINDOW_24H) : null,
  };
}

// 一条已存开场白能不能进计划：和 ai-send --use-saved 完全相同的门禁，只是把 throw 变成原因字符串
function planRejectReason(ledger, job) {
  if (!openerCurrent(job)) return job.opener?.status === 'generated' ? '已存开场白绑定的 JD 已变化' : '没有当前 JD 的开场白';
  try {
    assertAiReady(ledger, job);
    validateOpener(job.opener.message, { allowQuestion: job.opener.style === 'project' });
    assertOpenerFits(job, job.opener.message);
    const anchor = factAnchorReason(job.opener.message);
    if (anchor) throw new Error(`不符合当前规则：${anchor}`);
  } catch (error) {
    return error.message;
  }
  return '';
}

function buildPlan(ledger, { limit = Infinity, at = now() } = {}) {
  const items = [];
  const rejected = [];
  for (const raw of approvedQueue(ledger)) {
    const job = hydrateLegacyStructured(raw);
    const reason = planRejectReason(ledger, job);
    if (reason) { rejected.push({ jobId: job.jobId, title: job.title, reason }); continue; }
    if (items.length >= limit) break;
    items.push({
      jobId: job.jobId, url: job.url, title: job.title, company: job.company,
      bossId: job.recruiter?.encryptBossId || '', jdHash: job.jd.hash, openerHash: hashOf(job.opener.message),
      profile: job.opener.profile, resumeChat: job.outreach?.status === 'chat_created_not_sent',
      status: 'pending', result: '', at: '',
    });
  }
  return { version: 1, port: PORT, createdAt: at, status: 'planned', items, rejected, halt: null };
}

function loadPlan(file) {
  if (!fs.existsSync(file)) throw new Error(`计划文件不存在：${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function savePlan(plan, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n', 'utf8');
}
function latestPlanFile() {
  if (!fs.existsSync(PLAN_DIR)) return '';
  const files = fs.readdirSync(PLAN_DIR).filter(name => /^plan-.*\.json$/.test(name)).sort();
  return files.length ? path.join(PLAN_DIR, files[files.length - 1]) : '';
}
function resolvePlanFile() {
  const given = arg('plan');
  if (given) return path.isAbsolute(given) ? given : path.join(ROOT, given);
  const latest = latestPlanFile();
  if (!latest) throw new Error('没有计划文件，先运行 send-plan');
  return latest;
}
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const planSummary = plan => Object.fromEntries(['pending', 'done', 'unverified', 'skipped', 'failed'].map(k => [k, plan.items.filter(i => i.status === k).length]));

// 拒绝原因归类：哪个门禁拒得最多，就是提示词/事实卡该改的地方
function reasonBucket(reason) {
  const text = String(reason || '');
  if (/长度|不足 120|超过 200/.test(text)) return '长度';
  if (/锚点/.test(text)) return '锚点';
  if (/重复|已用/.test(text)) return '同日重复';
  if (/问句|问题/.test(text)) return '问句';
  if (/技术名|未确认|禁写/.test(text)) return '事实红线';
  if (/AI 感|套话|顿号|分号/.test(text)) return 'AI感';
  if (/生成失败|codex|模型/i.test(text)) return '模型调用';
  return '其他';
}
function histogram(reasons) {
  const counts = {};
  for (const reason of reasons) counts[reasonBucket(reason)] = (counts[reasonBucket(reason)] || 0) + 1;
  return counts;
}

// ai-opener --batch：给整个「审核通过但没有当前开场白」队列离线生成开场白。不碰浏览器、不占额度。
// 每条生成完立即落台账，中途断了已生成的不丢；同一岗位当天生成失败过就跳过，--retry-failed 才重试。
async function openerBatch() {
  const ledger = loadLedger();
  const limit = Number(arg('limit')) || Infinity;
  const retryFailed = process.argv.includes('--retry-failed');
  const today = now().slice(0, 10);
  const queue = approvedQueue(ledger).filter(x => !openerCurrent(x));
  const results = { ok: [], failed: [], skipped: 0 };
  let handled = 0;
  for (const raw of queue) {
    if (handled >= limit) break;
    if (!retryFailed && raw.opener?.lastFailure?.at?.startsWith(today)) { results.skipped++; continue; }
    handled++;
    const index = ledger.jobs.findIndex(x => x.jobId === raw.jobId);
    const job = hydrateLegacyStructured(ledger.jobs[index]);
    ledger.jobs[index] = job;
    try {
      const result = generateOpener(job, arg('profile'), ledger);
      job.opener = { status: 'generated', message: result.message, profile: result.profileId, style: result.style || openerStyle(job), jdHash: job.jd.hash, generatedAt: now(), generator: result.generator };
      addDecision(job, 'opener', 'pass', 'ai_generated', `AI 已按${PROFILES[result.profileId]?.label || '岗位方向'}批量生成并通过事实门禁`, result.message);
      results.ok.push(job.jobId);
      console.log(`OPENER_OK ${job.jobId} ${job.title} @ ${job.company}`);
    } catch (error) {
      job.opener = { ...(job.opener || { status: 'none', message: '' }), lastFailure: { at: now(), reason: error.message } };
      results.failed.push({ jobId: job.jobId, reason: error.message });
      console.log(`OPENER_FAIL ${job.jobId} ${job.title}：${error.message.slice(0, 160)}`);
    }
    saveLedger(ledger);
  }
  const summary = { queue: queue.length, generated: results.ok.length, failed: results.failed.length, skippedFailedToday: results.skipped, rejectReasons: histogram(results.failed.map(f => f.reason)) };
  console.log(JSON.stringify(summary));
  if (results.ok.length) console.log('下一步：node workflow/boss.js send-plan');
  return summary;
}

// send-plan：把材料就绪队列固化成计划文件。每条都重新过一遍发送门禁，绑定 jdHash 与开场白哈希。
function sendPlan() {
  const ledger = loadLedger();
  const budget = loadBudget();
  const remaining = Math.max(0, DAILY_BUDGET.sends - countWithin(budget, 'sends', WINDOW_24H));
  const limit = Math.min(Number(arg('limit')) || remaining, remaining);
  const plan = buildPlan(ledger, { limit });
  const stamp = now().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const file = path.join(PLAN_DIR, `plan-${stamp}.json`);
  console.log(`可发送 ${plan.items.length}｜门禁拒绝 ${plan.rejected.length}｜24h 剩余发送额度 ${remaining}`);
  for (const item of plan.items) console.log(`- ${item.jobId} ${item.title} @ ${item.company}${item.resumeChat ? '（续发已建会话）' : ''}`);
  if (plan.rejected.length) {
    console.log(`门禁拒绝（重写用 discard-opener 后 ai-opener --batch）：${JSON.stringify(histogram(plan.rejected.map(r => r.reason)))}`);
    for (const row of plan.rejected.slice(0, Number(arg('show-rejected')) || 10)) console.log(`  x ${row.jobId} ${row.title}：${row.reason.slice(0, 120)}`);
  }
  if (!plan.items.length) { console.log(remaining ? '没有可进入计划的岗位；先 ai-opener --batch 或补审队列' : '24 小时发送额度已用完，等窗口滑出'); return plan; }
  if (process.argv.includes('--dry-run')) { console.log('DRY_RUN 未写计划文件'); return plan; }
  savePlan(plan, file);
  console.log(`PLAN_SAVED ${rel(file)}`);
  console.log(`确认无误后执行：node workflow/boss.js dispatch --plan=${rel(file)}`);
  return plan;
}

// 发送前再核一次：台账里的岗位必须还是计划生成时那份材料
function recheckItem(ledger, item) {
  const job = ledger.jobs.find(x => x.jobId === item.jobId);
  if (!job) return { reason: '台账中已无此岗位' };
  const hydrated = hydrateLegacyStructured(job);
  if (hydrated.jd?.hash !== item.jdHash) return { reason: 'JD 已变化' };
  if (hashOf(hydrated.opener?.message) !== item.openerHash) return { reason: '开场白已被改动或撤回' };
  const reason = planRejectReason(ledger, hydrated);
  return reason ? { reason } : { job: hydrated };
}

async function waitForBurstWindow() {
  for (;;) {
    const used = countWithin(loadBudget(), 'sends', WINDOW_10MIN);
    if (used < BURST_LIMIT.sends) return;
    console.error(`[节流] 10 分钟发送突发已满 ${used}/${BURST_LIMIT.sends}，等待 60s`);
    await sleepMs(60000);
  }
}

// dispatch：逐条执行计划。--status 只看进度；--dry-run 只重验不发送。
async function dispatch() {
  const file = resolvePlanFile();
  const plan = loadPlan(file);
  if (process.argv.includes('--status')) {
    console.log(JSON.stringify({ plan: rel(file), status: plan.status, ...planSummary(plan), halt: plan.halt }, null, 2));
    return plan;
  }
  const dryRun = process.argv.includes('--dry-run');
  const maxConsecutiveFailures = Number(arg('max-failures')) || 3;
  const { sendWithAutomaticVerification } = require('./outreach-commands');
  let consecutiveFailures = 0;
  plan.halt = null;
  plan.status = dryRun ? plan.status : 'running';
  if (!dryRun) savePlan(plan, file);
  for (const item of plan.items) {
    if (item.status !== 'pending') continue;
    try { assertNotLocked(); } catch (error) { plan.halt = { at: now(), reason: error.message, jobId: item.jobId }; break; }
    const check = recheckItem(loadLedger(), item);
    if (check.reason) {
      item.status = 'skipped'; item.result = check.reason; item.at = now();
      console.log(`SKIP ${item.jobId} ${item.title}：${check.reason}`);
      if (!dryRun) savePlan(plan, file);
      continue;
    }
    if (dryRun) { console.log(`DRY_RUN_OK ${item.jobId} ${item.title}`); continue; }
    await waitForBurstWindow();
    try {
      // 续发已建会话依赖 sendMessage 读到 chat_created_not_sent 状态，不需要额外参数
      await sendWithAutomaticVerification(check.job.url, check.job.opener.message);
      const after = loadLedger().jobs.find(x => x.jobId === item.jobId);
      const status = after?.outreach?.status || 'unknown';
      item.status = status === 'delivery_unverified' ? 'unverified' : status === 'delivered' ? 'done' : 'skipped';
      item.result = status; item.at = now();
      consecutiveFailures = 0;
      console.log(`${item.status.toUpperCase()} ${item.jobId} ${item.title} @ ${item.company} → ${status}`);
    } catch (error) {
      item.status = 'failed'; item.result = error.message.slice(0, 300); item.at = now();
      consecutiveFailures++;
      console.log(`FAILED ${item.jobId} ${item.title}：${error.message.slice(0, 200)}`);
      if (loadLock().locked || HALT_RE.test(error.message)) plan.halt = { at: now(), reason: error.message.slice(0, 300), jobId: item.jobId };
      else if (consecutiveFailures >= maxConsecutiveFailures) plan.halt = { at: now(), reason: `连续 ${consecutiveFailures} 条失败，停机等人工检查`, jobId: item.jobId };
    }
    savePlan(plan, file);
    if (plan.halt) break;
  }
  if (!dryRun) {
    const summary = planSummary(plan);
    plan.status = plan.halt ? 'halted' : summary.pending ? 'partial' : 'completed';
    savePlan(plan, file);
    console.log(JSON.stringify({ plan: rel(file), status: plan.status, ...summary, halt: plan.halt, sends: sendCounts(loadLedger()) }));
    if (plan.halt) {
      console.error(`HALTED：${plan.halt.reason}`);
      console.error(`处理后续跑：node workflow/boss.js dispatch --plan=${rel(file)}`);
      process.exitCode = 2;
    }
  }
  return plan;
}

module.exports = { approvedQueue, sendCounts, planRejectReason, buildPlan, recheckItem, hashOf, reasonBucket, histogram, openerBatch, sendPlan, dispatch, PLAN_DIR };
