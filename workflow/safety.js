const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.BOSS_CDP_PORT || 9222);
const LOCK_FILE = path.join(DATA_DIR, `lock.${PORT}.json`);
const LEGACY_LOCK_FILE = path.join(DATA_DIR, 'lock.json');
const BUDGET_FILE = path.join(DATA_DIR, `budget.${PORT}.json`);

const SECURITY_PAGE_RE = /captcha|verify|\/403\.html|[?&]code=(32|36|37)(?:&|$)|\/web\/passport\/|账户存在异常行为|暂时限制访问|访问受限/i;
const SEVERE_LOCK_RE = /code=(?:32|36|37)|访问受限|账户存在异常|暂时限制访问|环境存在异常/;
const SECURITY_JS_EXPR = "(location.href.includes('/403.html')||/[?&]code=(32|36|37)(&|$)/.test(location.href)||location.href.includes('/web/passport/')||!!document.querySelector('.security-check,.verify-wrap,.captcha')||/账户存在异常行为|暂时限制访问|访问受限/.test(document.body?.innerText||''))";

const WINDOW_24H = 24 * 60 * 60 * 1000;
const WINDOW_10MIN = 10 * 60 * 1000;
// 发送前会额外加载一次岗位详情；700 次读 JD + 120 次发送仍低于 900 次平台硬顶。
// 搜索页扩到 90；仍受平台硬顶、10 分钟突发上限和最小间隔约束。
const DAILY_BUDGET = { searchPages: 90, jobReads: 700, sends: 120, maxConsecutiveEmptyJd: 3 };
const HARD_CEILING = { searchPages: 120, jobReads: 900, sends: 150 };
const BURST_LIMIT = { searchPages: 6, jobReads: 45, sends: 15 };
const MIN_GAP_MS = { searchPages: 15000, jobReads: 8000, sends: 30000 };
const NIGHT_START_HOUR = 23;
const NIGHT_END_HOUR = 9;
const NIGHT_PACE = 1;

const now = () => new Date().toISOString();
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const rndInt = (lo, hi) => lo + Math.floor(Math.random() * (Math.max(hi, lo) - lo + 1));
const humanPause = (lo, hi) => sleepMs(rndInt(lo, hi));
const isNightHour = (date = new Date()) => {
  const hour = date.getHours();
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
};
const paceMultiplier = (date = new Date()) => (isNightHour(date) ? NIGHT_PACE : 1);
const matchSecurityPage = text => SECURITY_PAGE_RE.test(String(text || ''));

function loadLock(file = LOCK_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (file === LOCK_FILE) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_LOCK_FILE, 'utf8'));
      if (legacy && (Number(legacy.port) || 9222) === PORT) return { ...legacy, fromLegacyFile: true };
    } catch {}
  }
  return { locked: false };
}

function writeLock(reason, evidence = '', file = LOCK_FILE) {
  const lock = { locked: true, port: PORT, reason, evidence: String(evidence).slice(0, 500), lockedAt: now() };
  fs.writeFileSync(file, JSON.stringify(lock, null, 2));
  return lock;
}

function assertNotLocked(file = LOCK_FILE) {
  const lock = loadLock(file);
  if (lock.locked) throw new Error(`账号熔断锁定中：${lock.reason}（${lock.lockedAt}）。禁止任何在线动作，人工确认后用 unlock --reason=说明 解除`);
}

function throwSecurity(reason, evidence = '') {
  writeLock(reason, evidence);
  throw new Error(`${reason}，已停止并写入熔断锁 ${path.relative(ROOT, LOCK_FILE).replace(/\\/g, '/')}；人工确认前所有在线命令拒绝运行`);
}

function unlockRefusal(previous, at = Date.now()) {
  if (!previous?.locked) return '';
  if (!SEVERE_LOCK_RE.test(`${previous.reason || ''} ${previous.evidence || ''}`)) return '';
  const lockedAt = Date.parse(previous.lockedAt || '') || 0;
  if (!lockedAt) return '';
  const sameDay = new Date(lockedAt).toLocaleDateString('sv') === new Date(at).toLocaleDateString('sv');
  if (!sameDay && at - lockedAt >= WINDOW_24H) return '';
  const earliest = new Date(lockedAt + WINDOW_24H).toLocaleString('sv');
  return `风控级熔断当天不得解锁续跑（2026-07-21 裁定的硬规则②）：${previous.reason}，锁定于 ${previous.lockedAt}，最早可解锁 ${earliest}。确需提前解锁请加 --force 自负风险`;
}

function loadBudget(file = BUDGET_FILE) {
  let budget = null;
  try { budget = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!budget || !Array.isArray(budget.events)) budget = { port: PORT, consecutiveEmptyJd: 0, events: [] };
  const floor = Date.now() - 2 * WINDOW_24H;
  budget.events = budget.events.filter(event => (Date.parse(event?.at) || 0) >= floor);
  return budget;
}

function saveBudget(budget, file = BUDGET_FILE) {
  fs.writeFileSync(file, JSON.stringify({ ...budget, port: PORT, updatedAt: now() }, null, 2));
}

function countWithin(budget, kind, windowMs, at = Date.now()) {
  const floor = at - windowMs;
  return (budget.events || []).filter(event => event.kind === kind && (Date.parse(event.at) || 0) >= floor).length;
}

function lastActionAt(budget) {
  const times = (budget.events || []).map(event => Date.parse(event.at) || 0);
  return times.length ? Math.max(...times) : 0;
}

async function reserveAction(kind, detail = '', file = BUDGET_FILE, alsoCount = []) {
  const budget = loadBudget(file);
  const pace = paceMultiplier();
  for (const each of [kind, ...alsoCount]) {
    const used = countWithin(budget, each, WINDOW_24H);
    const ceiling = HARD_CEILING[each];
    if (ceiling != null && used >= ceiling) throwSecurity(`${each} 触到平台硬顶：24 小时内已 ${used}/${ceiling}`, 'hard-ceiling');
    const limit = DAILY_BUDGET[each];
    if (limit != null && used >= limit) throw new Error(`24 小时滚动额度已用完：${each} ${used}/${limit}，等窗口滑出再继续；不为凑数继续访问`);
  }
  const burst = BURST_LIMIT[kind];
  if (burst != null) {
    const allowed = Math.max(1, Math.floor(burst / pace));
    const used10min = countWithin(budget, kind, WINDOW_10MIN);
    if (used10min >= allowed) throw new Error(`10 分钟突发上限：${kind} ${used10min}/${allowed}${pace > 1 ? '（深夜减半）' : ''}，先歇一会儿再继续`);
  }
  const gap = (MIN_GAP_MS[kind] || 0) * pace;
  const since = Date.now() - lastActionAt(budget);
  if (gap && since < gap) {
    const wait = rndInt(gap - since, gap - since + Math.round(gap * 0.5));
    console.error(`[节流] 距上次动作 ${Math.round(since / 1000)}s，等待 ${Math.round(wait / 1000)}s 后执行 ${kind}${pace > 1 ? '（深夜速率减半）' : ''}`);
    await sleepMs(wait);
  }
  const fresh = loadBudget(file);
  const at = now();
  const night = isNightHour();
  for (const each of [kind, ...alsoCount]) fresh.events.push({ kind: each, detail, at, night });
  saveBudget(fresh, file);
  return fresh;
}

function noteEmptyJd(message, file = BUDGET_FILE) {
  const budget = loadBudget(file);
  budget.consecutiveEmptyJd = (budget.consecutiveEmptyJd || 0) + 1;
  saveBudget(budget, file);
  if (budget.consecutiveEmptyJd >= DAILY_BUDGET.maxConsecutiveEmptyJd) throwSecurity(`连续 ${budget.consecutiveEmptyJd} 次空白/受限 JD（${message}）`, 'consecutive-empty-jd');
}

function resetEmptyJd(file = BUDGET_FILE) {
  const budget = loadBudget(file);
  if (budget.consecutiveEmptyJd) {
    budget.consecutiveEmptyJd = 0;
    saveBudget(budget, file);
  }
}

function budgetSnapshot() {
  const lock = loadLock();
  const budget = loadBudget();
  const used = Object.fromEntries(['searchPages', 'jobReads', 'sends'].map(kind => [kind, {
    in24h: countWithin(budget, kind, WINDOW_24H),
    in10min: countWithin(budget, kind, WINDOW_10MIN),
    remaining24h: Math.max(0, DAILY_BUDGET[kind] - countWithin(budget, kind, WINDOW_24H)),
  }]));
  const last = lastActionAt(budget);
  return {
    port: PORT,
    lock,
    night: isNightHour(),
    paceMultiplier: paceMultiplier(),
    lastActionAt: last ? new Date(last).toISOString() : '',
    used,
    consecutiveEmptyJd: budget.consecutiveEmptyJd || 0,
    limits: { operating24h: DAILY_BUDGET, hardCeiling24h: HARD_CEILING, burst10min: BURST_LIMIT, minGapMs: MIN_GAP_MS },
  };
}

module.exports = {
  PORT, LOCK_FILE, BUDGET_FILE, SECURITY_JS_EXPR, WINDOW_24H, WINDOW_10MIN, DAILY_BUDGET,
  HARD_CEILING, BURST_LIMIT, NIGHT_PACE, sleepMs, rndInt, humanPause, isNightHour,
  paceMultiplier, matchSecurityPage, loadLock, writeLock, assertNotLocked, throwSecurity,
  unlockRefusal, loadBudget, saveBudget, countWithin, lastActionAt, reserveAction,
  noteEmptyJd, resetEmptyJd, budgetSnapshot,
};
