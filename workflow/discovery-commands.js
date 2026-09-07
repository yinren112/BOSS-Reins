const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const { PORT, SECURITY_JS_EXPR, reserveAction, throwSecurity, humanPause } = require('./safety');
const SEARCH_SESSION_FILE = path.join(DATA_DIR, `search-session.${PORT}.json`);
const FAVORITES_SESSION_FILE = path.join(DATA_DIR, `favorites-session.${PORT}.json`);
const RECOMMEND_SESSION_FILE = path.join(DATA_DIR, `recommend-session.${PORT}.json`);
const cdpLib = () => require('./cdp');
const { arg, positionals, positional, jobIdOf, isRealJobUrl } = require('./cli-args');
const { loadLedger, saveLedger } = require('./ledger-store');
const {
  PROFILES, blankJob, addDecision, activityRank, matchProfile, parseSearchCard,
  isCurrentFavorite, discoverySourceRank, isCurrentCycleJob, preScreenJob,
  priorContactReason, ensureJob, expiryReason,
} = require('./job-domain');
const { waitForSearchResults } = require('./page-flows');
const now = () => new Date().toISOString();

function loadFavoritesSession() {
  try { return JSON.parse(fs.readFileSync(FAVORITES_SESSION_FILE, 'utf8')); } catch { return {}; }
}

function saveFavoritesSession(value) {
  fs.writeFileSync(FAVORITES_SESSION_FILE, JSON.stringify(value, null, 2));
}

// 一条命令只读取一页收藏。扫描期间使用临时来源，最后一页才原子替换
// favorite:current；中途退出不会把上次完整收藏快照截断成一页。
async function favorites(requestedPage = '') {
  const { openTab, closeTab } = cdpLib();
  const favoritePage = String(requestedPage || arg('page') || '1');
  if (!/^\d+$/.test(favoritePage) || Number(favoritePage) < 1) throw new Error('--page 必须是正整数');
  const favoriteUrl = `https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=${encodeURIComponent(favoritePage)}&tag=4`;
  const cdp = await openTab(favoriteUrl, PORT);
  try {
    await cdp.waitFor(`document.querySelectorAll('a[href*="personal_interest_job_"]').length>0||/暂无收藏|没有收藏|还没有收藏/.test(document.body?.innerText||'')`, { timeoutMs: 18000, description: '收藏岗位卡片' });
    const savedRaw = await cdp.eval(`JSON.stringify((()=>{const visible=x=>x&&x.offsetParent!==null;const pageNumbers=[...document.querySelectorAll('a[href^="javascript"]')].filter(visible).filter(x=>/^\\d+$/.test((x.innerText||'').trim())).map(x=>Number((x.innerText||'').trim())).filter(Number.isFinite);return {url:location.href,security:${SECURITY_JS_EXPR},totalPages:Math.max(1,...pageNumbers),links:[...document.querySelectorAll('a[href*="/job_detail/"]')].filter(a=>!a.href.includes('personal_added_job')).map(a=>{const card=a.closest('li,.job-card-wrapper,.job-card-box,.job-list-box')||a.parentElement;return {url:a.href,title:(a.innerText||'').replace(/\\s+/g,' ').trim(),text:(card?.innerText||a.innerText||'').replace(/\\s+/g,' ').trim()}}).filter(x=>x.title)}})())`);
    const savedPage = JSON.parse(savedRaw || '{}');
    if (savedPage.security) throwSecurity('收藏列表页进入安全验证', savedPage.url || '');
    const savedJobs = [...new Map((savedPage.links || []).filter(x => /[?&]ka=personal_interest_job_/i.test(x.url)).map(x => [jobIdOf(x.url), x]).filter(([id]) => id)).values()];
    const ledger = loadLedger();
    let session = loadFavoritesSession();
    if (favoritePage === '1' || !session.scanId) {
      for (const job of ledger.jobs) job.sources = (job.sources || []).filter(source => !source.startsWith('favorite:scan:'));
      session = { scanId: String(Date.now()), page: 0, totalPages: Number(savedPage.totalPages || 1), ids: [], startedAt: now() };
    } else if (Number(favoritePage) !== Number(session.page || 0) + 1) {
      throw new Error(`收藏扫描应继续第 ${Number(session.page || 0) + 1} 页；请运行 favorites-next，或用 favorites --page=1 重新开始`);
    }
    const scanSource = `favorite:scan:${session.scanId}`;
    for (const link of savedJobs) {
      const job = ensureJob(ledger, jobIdOf(link.url), link.url);
      const parsed = parseSearchCard(link);
      if (!job.title && parsed.title) job.title = parsed.title;
      if (!job.salary && parsed.salary) job.salary = parsed.salary;
      job.sources = [...new Set([...(job.sources || []), scanSource])];
      job.discovery = { ...job.discovery, favoriteSeenAt: now() };
      preScreenJob(ledger, job, { title: link.title, text: link.text });
    }
    session = { ...session, page: Number(favoritePage), totalPages: Math.max(Number(session.totalPages || 1), Number(savedPage.totalPages || 1)), ids: [...new Set([...(session.ids || []), ...savedJobs.map(link => jobIdOf(link.url)).filter(Boolean)])], updatedAt: now() };
    const complete = session.page >= session.totalPages;
    if (complete) {
      const currentIds = new Set(session.ids);
      for (const job of ledger.jobs) {
        job.sources = (job.sources || []).filter(source => source !== 'favorite:current' && !source.startsWith('favorite:scan:'));
        if (currentIds.has(job.jobId)) {
          job.sources.push('favorite:current');
          if (job.preScreen?.status !== 'reject' && !(job.preScreen?.reasons || []).some(reason => reason.code === 'favorite_interest')) {
            job.preScreen = {
              ...job.preScreen,
              status: 'priority',
              score: Number(job.preScreen?.score || 0) + 40,
              reasons: [...(job.preScreen?.reasons || []), { code: 'favorite_interest', message: '用户当前收藏，视为明确兴趣信号并优先读取', evidence: job.title }],
              checkedAt: now(),
            };
          }
        }
      }
      try { fs.unlinkSync(FAVORITES_SESSION_FILE); } catch {}
    } else {
      saveFavoritesSession(session);
    }
    saveLedger(ledger);
    console.log(JSON.stringify({
      url: savedPage.url,
      page: session.page,
      totalPages: session.totalPages,
      pageJobs: savedJobs.length,
      accumulated: session.ids.length,
      complete,
      nextCommand: complete ? 'node workflow/boss.js favorite-status' : 'node workflow/boss.js favorites-next',
      sample: savedJobs.slice(0, 3).map(link => ({ jobId: jobIdOf(link.url), title: link.title })),
      ...(process.argv.includes('--full') ? { jobs: savedJobs } : {}),
    }, null, 2));
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function favoritesNext() {
  const session = loadFavoritesSession();
  if (!session.scanId || !session.page) throw new Error('没有可继续的收藏扫描；请先运行 favorites --page=1');
  if (Number(session.page) >= Number(session.totalPages || 1)) throw new Error('收藏扫描已经完成；请运行 favorites --page=1 开始新快照');
  return favorites(Number(session.page) + 1);
}

// 离线汇总当前收藏的首次联系状态。状态来自 read 时的岗位页 isFriend 加完整会话数据，
// 不因岗位是否远程、是否资深或是否通过预筛而提前排除。
function favoriteStatus() {
  const ledger = loadLedger();
  const jobs = ledger.jobs.filter(job => (job.sources || []).includes('favorite:current'));
  const first = [];
  const continuing = [];
  for (const job of jobs) {
    const reason = priorContactReason(ledger, job);
    const row = { jobId: job.jobId, title: job.title, company: job.company, recruiter: job.recruiter?.name || '', status: reason ? 'continuing' : 'first_contact', reason: reason || '未发现该岗位或招聘者的既有会话' };
    (reason ? continuing : first).push(row);
  }
  const limit = process.argv.includes('--full') ? jobs.length : Math.min(100, Number(arg('limit') || 20));
  console.log(JSON.stringify({ total: jobs.length, firstContact: first.length, continuingCount: continuing.length, showingPerGroup: limit, first: first.slice(0, limit), continuing: continuing.slice(0, limit) }, null, 2));
}

function favoriteQueue() {
  const ledger = loadLedger();
  const rows = ledger.jobs.filter(job => (job.sources || []).includes('favorite:current') && job.outreach?.status === 'not_sent')
    .map(job => ({ jobId: job.jobId, title: job.title, company: job.company, jdStatus: job.jd?.status || 'unread', recruiter: job.recruiter?.name || '', opener: job.opener?.status || 'none' }));
  const limit = process.argv.includes('--full') ? rows.length : Math.min(100, Number(arg('limit') || 20));
  console.log(JSON.stringify({ total: rows.length, showing: Math.min(limit, rows.length), rows: rows.slice(0, limit) }, null, 2));
}

// 审岗所需的全部字段（含 JD 正文）。review 要求"从 JD 里引证据"，正文就必须能直接拿到；
// 否则 agent 只能去翻 data/ledger.json——单个岗位约 5KB，几百个岗位足以吃掉整个上下文窗口。

async function search() {
  const query = positional() || arg('query');
  const page = Number(arg('page') || 1);
  const requestedProfile = arg('profile');
  if (requestedProfile && !PROFILES[requestedProfile]) throw new Error(`未知岗位方向 ${requestedProfile}；可用：${Object.keys(PROFILES).join('/')}`);
  if (!query) throw new Error('需要搜索词');
  if (arg('pages')) throw new Error('--pages 已移除：为保证每条命令只有一个在线动作，请先运行 search，再逐次运行 search-next');
  // 2026-07-21 查明：搜索是 SPA，?page= 参数被忽略（p1/p2/p3 内容完全相同）。
  // 旧版允许 page=1–10，结果是白烧预算 + 重复数据 + discovery.page 记录失真。翻页只能在页面内点分页按钮。
  if (page !== 1) throw new Error('搜索页 ?page= 参数被 SPA 忽略，翻页必须在页面内点分页按钮；此处只接受 page=1，不要用它翻页');
  await reserveAction('searchPages', `${query} 第${page}页`);
  // 2026-07-26 用户裁定：优先打 BOSS 新发的活跃岗。--sort=latest 走平台的「最新发布」排序（sortType=1），
  // 默认仍是综合排序。翻页照旧只能在页面内点分页按钮，这里不碰 ?page=。
  const sortParam = arg('sort') === 'latest' ? '&sortType=1' : '';
  const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query)}&city=100010000${sortParam}`;
  const { CDP, listTabs, openTab } = cdpLib();
  let cdp;
  // 每次 search 只读取第一页；续页由 search-next 每条命令推进一次。
  const maxPages = 1;
  let waterfall = false;
  let lastDomCount = 0;
  let capturedIds = [];
  try {
    const prior = loadSearchSession();
    const reusable = (await listTabs(PORT)).find(tab => tab.id === prior.tabId);
    if (reusable) {
      cdp = new CDP(PORT);
      await cdp.connectTarget(reusable);
      await cdp.navigate(url);
    } else {
      cdp = await openTab(url, PORT);
    }
    const initialState = await waitForSearchResults(cdp);
    if (initialState.security) throwSecurity('搜索页进入安全验证', `${query} 第1页`);
    const totals = { found: 0, fresh: 0, counts: { priority: 0, review: 0, reject: 0 } };
    for (let curPage = 1; curPage <= maxPages; curPage++) {
      if (curPage > 1) {
        await reserveAction('searchPages', `${query} 第${curPage}页`);
        if (!waterfall) {
          const moved = await cdp.eval(`(() => {
            const target = String(${curPage});
            const els = [...document.querySelectorAll('a,li,span,button')].filter(x => x.offsetParent);
            const numEl = els.find(x => (x.innerText || '').trim() === target && x.closest('[class*="pag"],[class*="page"],ul,nav'));
            if (numEl) { numEl.click(); return 'num'; }
            const next = els.find(x => /下一页/.test(x.innerText || ''));
            if (next) { next.click(); return 'next'; }
            return 'none';
          })()`);
          if (moved === 'none') waterfall = true; // 没有分页按钮 → 按瀑布流处理（2026-07-28 实测搜索结果为无限滚动）
          else await waitForSearchResults(cdp, 15000, lastDomCount);
        }
        if (waterfall) {
          await cdp.eval(`window.scrollTo(0, document.body.scrollHeight);1`);
          const loaded = await waitForSearchResults(cdp, 12000, lastDomCount);
          const grown = loaded.count || 0;
          if (grown <= lastDomCount) { console.log('瀑布流已到底，停止翻页'); break; }
        }
      }
      const raw = await cdp.eval(`JSON.stringify({url:location.href,security:${SECURITY_JS_EXPR},links:[...document.querySelectorAll('a[href*="/job_detail/"]')].map(a=>{const card=a.closest('li,.job-card-wrapper,.job-card-box,.job-list-box')||a.parentElement;const online=!!card?.querySelector('.boss-online-icon,[class*="boss-online"]');return {url:a.href,title:(a.innerText||'').trim(),text:(card?.innerText||a.innerText||'').trim(),activityText:online?'在线':((card?.innerText||'').match(/(?:在线|刚刚活跃|今日活跃|今天活跃|三日内活跃|本周活跃|本月活跃|\\d+[天周月]内活跃)/)?.[0]||'')}}).filter(x=>x.title)})`);
      const result = JSON.parse(raw || '{}');
      result.links = await extractSearchLinks(cdp);
      if (result.security) throwSecurity('搜索页进入安全验证', `${query} 第${curPage}页`);
      const unique = new Map((result.links || []).map(x => [jobIdOf(x.url), x]).filter(([id]) => id));
      capturedIds = [...unique.keys()];
      if (!unique.size && curPage === 1) throw new Error('搜索页没有可读取岗位，按空结果停止，不继续翻页');
      if (!unique.size) { console.log(`第 ${curPage} 页没有岗位，停止翻页`); break; }
      const ledger = loadLedger();
      let fresh = 0;
      const counts = { priority: 0, review: 0, reject: 0 };
      for (const [id, link] of unique) {
        const existed = ledger.jobs.some(x => x.jobId === id);
        const job = ensureJob(ledger, id, link.url);
        job.sources = [...new Set([...(job.sources || []), `search:${query}`])];
        const capturedAt = now();
        job.discovery = {
          ...job.discovery,
          firstSeenAt: job.discovery?.firstSeenAt || capturedAt,
          lastSeenAt: capturedAt,
          query,
          page: curPage,
        };
        const screened = preScreenJob(ledger, job, link, requestedProfile);
        counts[screened.status]++;
        if (!existed) fresh++;
      }
      ledger.runs.push({ id: `search-${Date.now()}`, type: 'search', source: query, profile: requestedProfile || 'auto', page: curPage, found: unique.size, fresh, counts, at: now() });
      saveLedger(ledger);
      // 瀑布流模式下卡片是累计的，合计只按增量算，避免重复计数
      const domDelta = waterfall ? unique.size - lastDomCount : unique.size;
      lastDomCount = unique.size;
      totals.found += domDelta;
      totals.fresh += fresh;
      totals.counts.priority += counts.priority;
      totals.counts.review += counts.review;
      totals.counts.reject += counts.reject;
      console.log(`${query} 第 ${curPage} 页：${waterfall ? `新增卡片 ${domDelta}，` : ''}${unique.size} 个岗位，台账新增 ${fresh}；优先 ${counts.priority}，待看 ${counts.review}，预筛淘汰 ${counts.reject}`);
      if (!waterfall && unique.size < 10) { console.log('本页岗位不足 10 个，判断为最后一页，停止翻页'); break; }
      if (waterfall && domDelta === 0) { console.log('瀑布流无新增卡片，停止翻页'); break; }
    }
    if (maxPages > 1) console.log(`${query} 合计：${totals.found} 个岗位，新增 ${totals.fresh}`);
    saveSearchSession({ tabId: cdp.tabId, query, sort: arg('sort') === 'latest' ? 'latest' : 'default', requestedProfile: requestedProfile || '', page: 1, mode: 'unknown', currentIds: capturedIds, seenIds: capturedIds, signature: initialState.signature, updatedAt: now() });
    console.log(`续页：node workflow/boss.js search-next；结束后：node workflow/boss.js search-close；tab=${cdp.tabId}`);
  } finally {
    cdp?.close();
  }
}

async function harvestCurrent() {
  const source = positional() || arg('source') || '当前兼职推荐流';
  const tabId = arg('tab');
  await reserveAction('searchPages', source);
  const { CDP, listTabs } = cdpLib();
  const tab = (await listTabs(PORT)).find(item => (tabId ? item.id === tabId : /\/web\/geek\/jobs/.test(item.url || '')));
  if (!tab) throw new Error('没有找到当前 BOSS 职位结果页；先打开兼职结果流再运行 harvest-current');
  const cdp = new CDP(PORT);
  try {
    await cdp.connectTarget(tab);
    const state = await waitForSearchResults(cdp, 12000);
    if (state.security) throwSecurity('当前职位结果页进入安全验证', source);
    const links = await extractSearchLinks(cdp);
    const result = storeSearchLinks(links, { query: source, page: 1, sourcePrefix: 'current-feed', runType: 'current-feed' });
    console.log(JSON.stringify({ ...result.summary, source, tabId: tab.id, note: '已收录当前页面已加载的全部真实岗位卡片；继续下滚后可再次运行本命令收录新增卡片' }, null, 2));
  } finally {
    cdp.close();
  }
}

function loadSearchSession() {
  try { return JSON.parse(fs.readFileSync(SEARCH_SESSION_FILE, 'utf8')); } catch { return {}; }
}

function saveSearchSession(value) {
  fs.writeFileSync(SEARCH_SESSION_FILE, JSON.stringify(value, null, 2));
}

async function extractSearchLinks(cdp) {
  const raw = await cdp.eval(`JSON.stringify([...document.querySelectorAll('a[href*="/job_detail/"]')].map(a=>{const card=a.closest('li,.job-card-wrapper,.job-card-box,.job-list-box')||a.parentElement;const online=!!card?.querySelector('.boss-online-icon,[class*="boss-online"]');return {url:a.href,title:(a.innerText||'').trim(),text:(card?.innerText||a.innerText||'').trim(),activityText:online?'在线':((card?.innerText||'').match(/(?:在线|刚刚活跃|今日活跃|今天活跃|三日内活跃|本周活跃|本月活跃|\\d+[天周月]内活跃)/)?.[0]||''),visible:a.offsetParent!==null,peripheral:!!a.closest('header,.zp-header,footer,.footer')}}))`);
  return (JSON.parse(raw || '[]')).filter(link => link.visible && !link.peripheral && isRealJobUrl(link.url) && link.title);
}

function storeSearchLinks(links, { query, requestedProfile = '', page = 1, onlyIds = [], sourcePrefix = 'search', runType = 'search' }) {
  let unique = new Map(links.map(link => [jobIdOf(link.url), link]).filter(([id]) => id));
  const visibleIds = [...unique.keys()];
  if (onlyIds.length) {
    const allowed = new Set(onlyIds);
    unique = new Map([...unique].filter(([id]) => allowed.has(id)));
  }
  if (!visibleIds.length) throw new Error('搜索页没有真实岗位卡片，已停止且不会把页脚链接记入台账');
  const ledger = loadLedger();
  let fresh = 0;
  const counts = { priority: 0, review: 0, reject: 0 };
  for (const [id, link] of unique) {
    const existed = ledger.jobs.some(job => job.jobId === id);
    const job = ensureJob(ledger, id, link.url);
    job.sources = [...new Set([...(job.sources || []), `${sourcePrefix}:${query}`])];
    const capturedAt = now();
    job.discovery = { ...job.discovery, firstSeenAt: job.discovery?.firstSeenAt || capturedAt, lastSeenAt: capturedAt, query, page };
    const screened = preScreenJob(ledger, job, link, requestedProfile);
    counts[screened.status]++;
    if (!existed) fresh++;
  }
  ledger.runs.push({ id: `${runType}-${Date.now()}`, type: runType, source: query, profile: requestedProfile || 'auto', page, found: unique.size, visible: visibleIds.length, fresh, counts, at: now() });
  saveLedger(ledger);
  return { visibleIds, capturedIds: [...unique.keys()], summary: { query, page, captured: unique.size, visible: visibleIds.length, fresh, counts } };
}

async function searchNext() {
  const session = loadSearchSession();
  if (!session.tabId || !session.query) throw new Error('没有可继续的搜索会话；请先运行 search <关键词>');
  const { CDP, listTabs } = cdpLib();
  const tab = (await listTabs(PORT)).find(item => item.id === session.tabId);
  if (!tab) throw new Error('上次搜索标签已关闭；请重新运行 search <关键词>');
  const cdp = new CDP(PORT);
  try {
    await cdp.connectTarget(tab);
    const route = await cdp.eval(`(()=>{const u=new URL(location.href);return {path:u.pathname,query:u.searchParams.get('query')||''}})()`);
    if (route.path !== '/web/geek/jobs' || route.query !== session.query) {
      try { fs.unlinkSync(SEARCH_SESSION_FILE); } catch {}
      throw new Error(`上次搜索标签已被其他页面占用，旧断点已清理；请重新运行 search "${session.query}"`);
    }
    const before = await waitForSearchResults(cdp);
    if (before.security) throwSecurity('搜索页进入安全验证', `${session.query} 续页`);
    const nextPage = Number(session.page || 1) + 1;
    await reserveAction('searchPages', `${session.query} 第${nextPage}页`);
    const movement = await cdp.eval(`(()=>{const visible=x=>x&&x.offsetParent!==null;const disabled=x=>x.matches?.('[disabled],.disabled,.is-disabled')||x.getAttribute?.('aria-disabled')==='true'||/disabled/.test(String(x.className||''));const els=[...document.querySelectorAll('a,button,li,span')].filter(visible);const next=els.find(x=>/^(下一页|下一页 >|>)$/.test((x.innerText||x.getAttribute?.('aria-label')||'').trim())&&x.closest('[class*="pag"],[class*="page"],nav,ul'));if(next&&!disabled(next)){next.click();return 'page';}window.scrollTo(0,document.body.scrollHeight);return 'waterfall';})()`);
    const after = await waitForSearchResults(cdp, 15000, before.signature);
    if (after.security) throwSecurity('搜索页进入安全验证', `${session.query} 续页`);
    if (!after.signature || after.signature === before.signature) {
      await cdpLib().closeTab(session.tabId, PORT);
      try { fs.unlinkSync(SEARCH_SESSION_FILE); } catch {}
      console.log(JSON.stringify({ query: session.query, page: session.page, movement, end: true, reason: '职位集合未变化', closed:true, next:'node workflow/boss.js job-sources' }, null, 2));
      return;
    }
    const links = await extractSearchLinks(cdp);
    const seen = new Set(session.seenIds || session.currentIds || []);
    const visibleIds = links.map(link => jobIdOf(link.url)).filter(Boolean);
    const newIds = visibleIds.filter(id => !seen.has(id));
    const onlyIds = movement === 'waterfall' ? newIds : [];
    if (movement === 'waterfall' && !onlyIds.length) {
      await cdpLib().closeTab(session.tabId, PORT);
      try { fs.unlinkSync(SEARCH_SESSION_FILE); } catch {}
      console.log(JSON.stringify({ query: session.query, page: session.page, movement, end: true, reason: '瀑布流没有新增真实岗位', closed:true, next:'node workflow/boss.js job-sources' }, null, 2));
      return;
    }
    const result = storeSearchLinks(links, { query: session.query, requestedProfile: session.requestedProfile || '', page: nextPage, onlyIds });
    const seenIds = [...new Set([...(session.seenIds || []), ...result.visibleIds])];
    saveSearchSession({ ...session, page: nextPage, mode: movement, currentIds: result.visibleIds, seenIds, signature: after.signature, updatedAt: now() });
    console.log(JSON.stringify({ ...result.summary, movement, continuation: 'node workflow/boss.js search-next', tabId: session.tabId }, null, 2));
  } finally {
    cdp.close();
  }
}

async function searchClose() {
  const session = loadSearchSession();
  if (session.tabId) await cdpLib().closeTab(session.tabId, PORT);
  try { fs.unlinkSync(SEARCH_SESSION_FILE); } catch {}
  console.log(JSON.stringify({ closed: !!session.tabId, tabId: session.tabId || '', query: session.query || '' }, null, 2));
}

function loadRecommendSession() {
  try { return JSON.parse(fs.readFileSync(RECOMMEND_SESSION_FILE, 'utf8')); } catch { return {}; }
}

function saveRecommendSession(value) {
  fs.writeFileSync(RECOMMEND_SESSION_FILE, JSON.stringify(value, null, 2));
}

async function activeRecommendationExpectation(cdp) {
  const value = await cdp.eval(`(()=>{const items=[...document.querySelectorAll('a[href="javascript:;"],li[ka^="target_position_"]')].filter(x=>x.offsetParent!==null);const active=items.find(x=>{const chain=[x,x.parentElement,x.parentElement&&x.parentElement.parentElement].filter(Boolean);return chain.some(n=>String(n.className||'').split(/\\s+/).some(c=>['active','selected','cur'].includes(c)))&&/（[^）]+）|\\([^)]*\\)/.test((x.innerText||'').trim())});return (active&&active.innerText||'').replace(/\\s+/g,' ').trim()})()`);
  return String(value || '推荐职位（当前页面）');
}

// 无关键词的职位页才是 BOSS 的推荐职位流；一条命令只采集当前一屏/一页。
async function recommendations() {
  await reserveAction('searchPages', '推荐职位 第1批');
  const { CDP, listTabs, openTab } = cdpLib();
  let cdp;
  let phase = '连接推荐职位标签';
  try {
    const prior = loadRecommendSession();
    const reusable = (await listTabs(PORT)).find(tab => tab.id === prior.tabId);
    if (reusable) {
      cdp = new CDP(PORT);
      await cdp.connectTarget(reusable);
      phase = '导航到无关键词职位页';
      await cdp.navigate('https://www.zhipin.com/web/geek/jobs');
    } else {
      phase = '打开无关键词职位页';
      cdp = await openTab('https://www.zhipin.com/web/geek/jobs', PORT);
    }
    phase = '等待真实推荐岗位卡';
    const state = await waitForSearchResults(cdp);
    if (state.security) throwSecurity('推荐职位页进入安全验证', '推荐职位 第1批');
    phase = '提取真实推荐岗位卡';
    const links = await extractSearchLinks(cdp);
    if (!links.length) throw new Error('推荐职位页没有真实岗位卡片，按空结果停止');
    phase = '识别当前推荐期望';
    const expectation = await activeRecommendationExpectation(cdp);
    phase = '写入推荐候选与续跑状态';
    const result = storeSearchLinks(links, { query: expectation, page: 1, sourcePrefix: 'recommendation', runType: 'recommendation' });
    saveRecommendSession({ tabId: cdp.tabId, expectation, page: 1, mode: 'unknown', currentIds: result.visibleIds, seenIds: result.visibleIds, signature: state.signature, updatedAt: now() });
    console.log(JSON.stringify({ ...result.summary, source: 'recommendations', expectation, continuation: 'node workflow/boss.js recommendations-next', close: 'node workflow/boss.js recommendations-close', tabId: cdp.tabId }, null, 2));
  } catch (error) {
    throw new Error(`推荐职位失败（${phase}）：${error.message || error}`);
  } finally {
    cdp?.close();
  }
}

async function recommendationsNext() {
  const session = loadRecommendSession();
  if (!session.tabId || !session.expectation) throw new Error('没有可继续的推荐职位会话；请先运行 recommendations');
  const { CDP, listTabs } = cdpLib();
  const tab = (await listTabs(PORT)).find(item => item.id === session.tabId);
  if (!tab) throw new Error('上次推荐职位标签已关闭；请重新运行 recommendations');
  const cdp = new CDP(PORT);
  try {
    await cdp.connectTarget(tab);
    const route = await cdp.eval(`(()=>{const u=new URL(location.href);return {path:u.pathname,query:u.searchParams.get('query')||''}})()`);
    if (route.path !== '/web/geek/jobs' || route.query) {
      try { fs.unlinkSync(RECOMMEND_SESSION_FILE); } catch {}
      throw new Error('推荐专用标签已被其他页面占用，旧断点已清理；请重新运行 recommendations');
    }
    const before = await waitForSearchResults(cdp);
    if (before.security) throwSecurity('推荐职位页进入安全验证', `${session.expectation} 续页`);
    const nextPage = Number(session.page || 1) + 1;
    await reserveAction('searchPages', `推荐职位 第${nextPage}批`);
    const movement = await cdp.eval(`(()=>{const visible=x=>x&&x.offsetParent!==null;const disabled=x=>x.matches?.('[disabled],.disabled,.is-disabled')||x.getAttribute?.('aria-disabled')==='true'||/disabled/.test(String(x.className||''));const els=[...document.querySelectorAll('a,button,li,span')].filter(visible);const next=els.find(x=>/^(下一页|下一页 >|>)$/.test((x.innerText||x.getAttribute?.('aria-label')||'').trim())&&x.closest('[class*="pag"],[class*="page"],nav,ul'));if(next&&!disabled(next)){next.click();return 'page';}window.scrollTo(0,document.body.scrollHeight);return 'waterfall';})()`);
    const after = await waitForSearchResults(cdp, 15000, before.signature);
    if (after.security) throwSecurity('推荐职位页进入安全验证', `${session.expectation} 续页`);
    if (!after.signature || after.signature === before.signature) {
      await cdpLib().closeTab(session.tabId, PORT);
      try { fs.unlinkSync(RECOMMEND_SESSION_FILE); } catch {}
      console.log(JSON.stringify({ source: 'recommendations', expectation: session.expectation, page: session.page, movement, end: true, reason: '职位集合未变化', closed:true, next:'node workflow/boss.js job-sources' }, null, 2));
      return;
    }
    const links = await extractSearchLinks(cdp);
    const seen = new Set(session.seenIds || session.currentIds || []);
    const visibleIds = links.map(link => jobIdOf(link.url)).filter(Boolean);
    const newIds = visibleIds.filter(id => !seen.has(id));
    const onlyIds = movement === 'waterfall' ? newIds : [];
    if (movement === 'waterfall' && !onlyIds.length) {
      await cdpLib().closeTab(session.tabId, PORT);
      try { fs.unlinkSync(RECOMMEND_SESSION_FILE); } catch {}
      console.log(JSON.stringify({ source: 'recommendations', expectation: session.expectation, page: session.page, movement, end: true, reason: '瀑布流没有新增真实岗位', closed:true, next:'node workflow/boss.js job-sources' }, null, 2));
      return;
    }
    const result = storeSearchLinks(links, { query: session.expectation, page: nextPage, onlyIds, sourcePrefix: 'recommendation', runType: 'recommendation' });
    const seenIds = [...new Set([...(session.seenIds || []), ...result.visibleIds])];
    saveRecommendSession({ ...session, page: nextPage, mode: movement, currentIds: result.visibleIds, seenIds, signature: after.signature, updatedAt: now() });
    console.log(JSON.stringify({ ...result.summary, source: 'recommendations', expectation: session.expectation, movement, continuation: 'node workflow/boss.js recommendations-next', tabId: session.tabId }, null, 2));
  } finally {
    cdp.close();
  }
}

async function recommendationsClose() {
  const session = loadRecommendSession();
  if (session.tabId) await cdpLib().closeTab(session.tabId, PORT);
  try { fs.unlinkSync(RECOMMEND_SESSION_FILE); } catch {}
  console.log(JSON.stringify({ closed: !!session.tabId, tabId: session.tabId || '', expectation: session.expectation || '' }, null, 2));
}

async function companyJobs() {
  const name = positional();
  const ledger = loadLedger();
  const company = ledger.companies.find(x => x.name === name);
  if (!company?.url) throw new Error(`公司池中没有 ${name} 或缺少入口链接`);
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab(company.url, PORT);
  try {
    await cdp.waitFor(`document.readyState!=='loading'&&(/查看(全部|所有)职位/.test(document.body?.innerText||'')||[...document.querySelectorAll('a[href*="/job_detail/"]')].some(a=>{const p=new URL(a.href).pathname;return p.startsWith('/job_detail/')&&p.endsWith('.html')&&a.offsetParent!==null&&!a.closest('header,.zp-header,footer,.footer')}))`, { timeoutMs: 15000, description: '公司职位入口' });
    let allJobsUrl = await cdp.eval(`(()=>{const a=[...document.querySelectorAll('a')].find(x=>/查看(全部|所有)职位/.test((x.innerText||'').trim()));return a?.href||''})()`);
    if (allJobsUrl) { await cdp.navigate(allJobsUrl); await cdp.waitFor(`[...document.querySelectorAll('a[href*="/job_detail/"]')].some(a=>{const p=new URL(a.href).pathname;return p.startsWith('/job_detail/')&&p.endsWith('.html')&&a.offsetParent!==null&&!a.closest('header,.zp-header,footer,.footer')})||/暂无职位/.test(document.body?.innerText||'')`, { timeoutMs: 15000, description: '公司全部职位' }); }
    const raw = await cdp.eval(`JSON.stringify({url:location.href,security:${SECURITY_JS_EXPR}})`);
    const page = JSON.parse(raw || '{}');
    if (page.security) throwSecurity('公司职位页进入安全验证', name);
    const links = await extractSearchLinks(cdp);
    const unique = new Map(links.map(x => [jobIdOf(x.url), x]).filter(([id]) => id));
    let fresh = 0;
    const counts = { priority: 0, review: 0, reject: 0 };
    for (const job of ledger.jobs) job.sources = (job.sources || []).filter(source => source !== `company:${name}`);
    for (const [id, link] of unique) {
      const existed = ledger.jobs.some(job => job.jobId === id);
      const job = ensureJob(ledger, id, link.url);
      const parsed = parseSearchCard(link);
      if (!job.title) job.title = parsed.title || link.title;
      if (!job.salary) job.salary = parsed.salary;
      job.sources = [...new Set([...(job.sources || []), `company:${name}`])];
      job.discovery = { ...job.discovery, companySeenAt: now() };
      const screened = preScreenJob(ledger, job, link);
      counts[screened.status]++;
      if (!existed) fresh++;
    }
    company.jobsUrl = page.url;
    company.checkedAt = now();
    ledger.runs.push({ id: `company-jobs-${Date.now()}`, type: 'company-jobs', source: name, found: unique.size, fresh, counts, at: now() });
    saveLedger(ledger);
    console.log(JSON.stringify({ company: name, url: page.url, found: unique.size, fresh, counts, nextCommand: `node workflow/boss.js candidates --source="company:${name}" --sort=complete --limit=20` }, null, 2));
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

function jobSources() {
  const ledger = loadLedger();
  const searchSession = loadSearchSession();
  const recommendSession = loadRecommendSession();
  const favoritesSession = loadFavoritesSession();
  const lastRun = type => [...(ledger.runs || [])].reverse().find(run => run.type === type) || null;
  const sources = [
    { priority: 1, source: 'replies/interactions', purpose: '先处理对方已回复、谁看过我和对我感兴趣的高意向入口', commands: ['node workflow/boss.js replies', 'node workflow/boss.js interactions'], resumable: false, lastRun: lastRun('interactions') },
    { priority: 2, source: 'favorites', purpose: '用户主动收藏，优先级高于固定岗位名称；完整快照共多页', command: favoritesSession.scanId ? 'node workflow/boss.js favorites-next' : 'node workflow/boss.js favorites --page=1', resumable: true, currentSnapshot: ledger.jobs.filter(job => (job.sources || []).includes('favorite:current')).length, progress: favoritesSession.scanId ? { page: favoritesSession.page, totalPages: favoritesSession.totalPages, accumulated: favoritesSession.ids?.length || 0 } : null },
    { priority: 3, source: 'recommendations', purpose: '无关键词职位页按当前期望给出的推荐流', command: recommendSession.tabId ? 'node workflow/boss.js recommendations-next' : 'node workflow/boss.js recommendations', resumable: true, progress: recommendSession.tabId ? { page: recommendSession.page, expectation: recommendSession.expectation, seen: recommendSession.seenIds?.length || 0 } : null, lastRun: lastRun('recommendation') },
    { priority: 4, source: 'search', purpose: '关键词补漏；可用 --sort=latest 优先新发布岗位', command: searchSession.tabId ? 'node workflow/boss.js search-next' : 'node workflow/boss.js search <关键词> --sort=latest', resumable: true, progress: searchSession.tabId ? { query: searchSession.query, page: searchSession.page, seen: searchSession.seenIds?.length || 0 } : null, lastRun: lastRun('search') },
    { priority: 5, source: 'company-jobs', purpose: '从已确认值得跟进的公司池读取当前在招岗位', command: 'node workflow/boss.js company-jobs <公司名>', resumable: false, companies: (ledger.companies || []).filter(company => company.url).map(company => company.name), lastRun: lastRun('company-jobs') },
    { priority: 6, source: 'related', purpose: '每次 read 详情时顺带收录页面上的相关岗位，不额外打开页面', command: 'node workflow/boss.js read <jobId> --jd', resumable: false, lastRun: lastRun('related') },
  ];
  console.log(JSON.stringify({ mode: 'offline', sources, nextAfterDiscovery: 'node workflow/boss.js candidates --sort=complete --limit=20' }, null, 2));
}
module.exports = {
  loadFavoritesSession,
  favorites,
  favoritesNext,
  favoriteStatus,
  favoriteQueue,
  search,
  harvestCurrent,
  loadSearchSession,
  extractSearchLinks,
  storeSearchLinks,
  searchNext,
  searchClose,
  loadRecommendSession,
  recommendations,
  recommendationsNext,
  recommendationsClose,
  companyJobs,
  jobSources,
};
