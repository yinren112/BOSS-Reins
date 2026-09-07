const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { loadConfig, linkAllowed, stripPortfolioSuffix } = require('./reins-config');
const CONFIG = loadConfig();
const FACTS_FILE = CONFIG.factsFile;
const { PROFILES, matchProfile, priorContactReason, explicitWorkflowStopReason } = require('./job-domain');
const { reviewIntegrityIssues, readyRejectReason } = require('./jd-domain');
const { projectStyle, scoreProjectJob } = require('./project-scoring');
// 去 AI 感门禁（2026-09-04）：两单成交的开场白都在 100 字上下、只讲 1-2 个交付事实、一句话收尾。
// 这里只拦「一眼看出是模板」的写法：套话词、堆砌名词的长顿号串、连续分号、成对的空洞对仗。
const AI_TONE_WORDS = /具备.{0,12}(?:能力|经验)|赋能|助力|高效(?:率)?地?|全方位|一站式|深耕|致力于|丰富的|资深|专业团队|欢迎随时|期待与您|期待合作|竭诚|不仅.{0,20}而且|无论.{0,12}还是|作为一名|我可以为您|为您提供|保驾护航|落地闭环|完美|高度契合|高度匹配|稳定(?:可靠)?的?(?:远程)?(?:按单)?交付能力/;
function aiToneReason(value) {
  const tone = value.match(AI_TONE_WORDS);
  if (tone) return `套话词「${tone[0]}」`;
  const longList = value.match(/(?:[^、，。；？！\s]{1,12}、){5,}/);
  if (longList) return `顿号串太长（≥6 项）：「${longList[0].slice(0, 30)}…」`;
  if ((value.match(/；/g) || []).length >= 2) return '两个以上分号，像分点罗列';
  if (value.length > 200) return `超过 200 字（当前 ${value.length}）`;
  return '';
}

function validateOpener(message, { allowQuestion = true } = {}) {
  const raw = String(message || '').replace(/^["“]|["”]$/g, '').trim();
  if (!linkAllowed(raw, CONFIG)) throw new Error('开场白只能附带配置里列出的作品主页或 GitHub 链接');
  const value = stripPortfolioSuffix(raw).replace(/\s+/g, ' ').trim();
  if (value.length < 20 || value.length > 250) throw new Error(`开场白正文长度必须在 20–250 字之间，当前 ${value.length} 字`);
  const banned = value.match(CONFIG.opener.bannedClaims);
  if (banned) throw new Error(`开场白含未确认经历或生硬防备词：${banned[0]}`);
  const tone = aiToneReason(value);
  if (tone) throw new Error(`开场白 AI 感过重：${tone}`);
  return value;
}

// 2026-09-07：开场白从「40–110 字一句话」改成「120–200 字讲透一件事」。
// 原因：100 字只够写「我做过 X，按模块报价，能远程吗」，老板看不出和其他人的差别；
// 200 字够写清楚一个交付事实的具体做法和验收方式，竞争力体现在细节上，不是形容词上。
// 只在新写/新生成时卡，validateOpener 仍放行历史文案（成交两单的原文都不到 120 字）。
const OPENER_MIN = CONFIG.opener.min;
const OPENER_MAX = CONFIG.opener.max;
function openerLengthReason(message) {
  const value = stripPortfolioSuffix(message).replace(/\s+/g, ' ').trim();
  if (value.length < OPENER_MIN) return `只有 ${value.length} 字，不足 ${OPENER_MIN}：把选中项目的做法、验收方式再写具体一层，别靠形容词凑`;
  if (value.length > OPENER_MAX) return `${value.length} 字，超过 ${OPENER_MAX}：删掉复述 JD 的部分，只留自己做过的事`;
  return '';
}

// 项目筛选说远程/结算没写明时，开场白必须把这句问出来——案例乙那单（JD 未写远程、7-8K 惠州）就是靠
// 「远程协作方式可以沟通」这半句把老板接进来的。缺这句直接拒存/拒发。
const REMOTE_ASK = /远程|线上|异地|不用到场|不用到岗|不坐班|协作方式|在哪(?:里)?(?:做|办公)/;
const SETTLEMENT_ASK = /报价|结算|按项目|按模块|按功能|验收|固定价|一口价|工期/;
function openerGapReason(job, message) {
  const value = String(message || '');
  const gaps = scoreProjectJob(job).askInOpener || [];
  if (job.review?.remote?.status === 'negotiable' && !gaps.includes('remote')) gaps.push('remote');
  // 只有远程是硬要求；结算没写明只给建议（案例乙那单开场白没提报价也成交了，报价是加微信后聊出来的）。
  if (gaps.includes('remote') && !REMOTE_ASK.test(value)) return 'JD 未写远程，开场白要带一句远程/线上协作是否可以';
  return '';
}
function openerAdvice(job, message) {
  const gaps = scoreProjectJob(job).askInOpener || [];
  if (gaps.includes('settlement') && !SETTLEMENT_ASK.test(String(message || ''))) return 'JD 未写结算：可以带一句按项目/按模块报固定价、验收后付（建议，不拦截）';
  return '';
}
// 9-05 复盘加的三道门：
//  1. 锚点——开场白必须带一个能核验的东西（项目名、数字、开源）。9-04 晚上 20 条全是「我做过多套…」，0 条有锚点；
//     成交两单的开场白一条有 开源项目名，一条有「前后端、数据库、支付、测试和部署」这种具体覆盖面。
//  2. 未确认技术——Supabase/RLS/影刀 这类事实源里没有的技术名混进去过，validateOpener 原来只拦 MySQL/Redis。
//  3. 同日重复——「远程协作方式可以沟通吗？」一天里用了 11 次，同一个招聘者圈子里会撞见。
// 9-05 晚二次复盘：80 条就绪开场白里约 30 条写「N 项测试」、约 32 条写「固定金额」、约 25 条写「N 个页面」——
// 锚点门禁被同一组数字刷过去了，对老板既没说服力又立了低价锚。现在：裸数字不再算锚点，三个数字直接禁写，
// 锚点必须是事实卡里的项目名或场景词，且同一项目锚点同日 ≥5 次拒绝，逼着按 JD 类型换事实。
// 全部来自 reins.config.json：事实锚点、禁写数字、未确认技术名、项目锚点键。代码里不写任何具体项目。
const FACT_ANCHOR = CONFIG.opener.factAnchor;
const BANNED_NUMBERS = CONFIG.opener.bannedNumbers;
const UNCONFIRMED_TECH = CONFIG.opener.unconfirmedTech;
// 「目前主要做哪类系统」这种不看 JD 也能问的问题一律拒，问题必须是读过这份 JD 才问得出的。
const GENERIC_QUESTION = /主要(?:需要|在)?(?:做|开发|对接|负责)哪(?:一|几)?[类种个]|目前(?:主要|手头)(?:在|需要)?(?:做|开发)(?:什么|哪)|哪[类种](?:系统|软件|业务|前端|功能|工具|开发)|有什么需求|具体(?:需求|要做什么)|方便(?:先)?线上沟通吗|方便沟通吗/;
// 事实卡的项目锚点键：同日同一项目用满额度就必须换一个项目讲
const ANCHOR_KEYS = CONFIG.opener.anchorKeys;
const anchorKeyOf = value => (ANCHOR_KEYS.find(([, re]) => re.test(String(value || ''))) || [''])[0];
function factAnchorReason(value) {
  const text = String(value || '');
  const tech = text.match(UNCONFIRMED_TECH);
  if (tech) return `提到事实源未确认的技术「${tech[0]}」；只能写事实文件里有的`;
  const num = text.match(BANNED_NUMBERS);
  if (num) return `禁写数字「${num[0].trim()}」：${CONFIG.opener.bannedNumbersHint || '这类数字'}对老板没有说服力，换成事实卡里的场景描述`;
  if (!FACT_ANCHOR.test(text)) return '没有可核验的锚点：第一句必须用事实卡命中行的首选或备选事实（项目名或场景词）';
  const generic = text.match(GENERIC_QUESTION);
  if (generic) return `问题太通用「${generic[0]}」：必须问读过这份 JD 才问得出的事（见事实卡「好问题」列）`;
  return '';
}
// 问句逐条比较：「…，远程协作方式可以沟通吗？目前主要做哪些功能？」拆成两句，任一句今天用满额度就拒。
// 2026-09-07：只问远程是本人明确定的收尾方式——对方还没答应合作就追问业务细节不合适——
// 所以纯远程问句单独给一份更宽的额度，业务问句仍是 ≥3 次就换说法。
const questionsOf = value => (String(value || '').replace(/（作品：[^）]*）/g, '').match(/[^，,。；;！!？?]+[？?]/g) || []).map(q => q.replace(/\s+/g, ''));
const JD_SPECIFIC_HINT = /需求|文档|原型|清单|模块|接口|设备|协议|数据|页面|图表|格式|样本|参考|阶段|里程碑|几个|哪些|多少|是新|二开|现有|哪一?块|先做|先接|知识库/;
const isRemoteOnlyQuestion = q => REMOTE_ASK.test(q) && !JD_SPECIFIC_HINT.test(q);
const openingOf = value => String(value || '').replace(/^您好[，,]?/, '').replace(/\s+/g, '').slice(0, 12);
// 同一天里开头 12 字或业务问句用满额度就拒，逼着换说法；纯远程收尾问句走上面更宽的额度。
function openerRepetitionReason(ledger, message, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const questions = questionsOf(message);
  const opening = openingOf(message);
  const anchorKey = anchorKeyOf(message);
  const sameQuestion = new Map();
  let sameOpening = 0;
  let sameAnchor = 0;
  let todayTotal = 0;
  for (const job of ledger?.jobs || []) {
    const used = job.outreach?.message || job.opener?.message || '';
    const at = job.outreach?.sentAt || job.opener?.generatedAt || '';
    if (!used || !at.startsWith(today)) continue;
    todayTotal++;
    const usedQuestions = new Set(questionsOf(used));
    for (const q of questions) if (usedQuestions.has(q)) sameQuestion.set(q, (sameQuestion.get(q) || 0) + 1);
    if (opening && openingOf(used) === opening) sameOpening++;
    if (anchorKey && anchorKeyOf(used) === anchorKey) sameAnchor++;
  }
  const remoteLimit = Number(process.env.REMOTE_QUESTION_LIMIT || 8);
  const hit = [...sameQuestion.entries()].find(([q, n]) => n >= (isRemoteOnlyQuestion(q) ? remoteLimit : 3));
  if (hit) return `问句「${hit[0]}」今天已用 ${hit[1]} 次，换个问法`;
  if (sameOpening >= 3) return `开头「${opening}…」今天已用 ${sameOpening} 次，换个切入`;
  // 锚点额度随当天体量走：8 个事实卡项目 × 固定 5 条 = 40 条上限，一天要发 100 条时必然被卡死，
  // 上一轮就是靠 ANCHOR_LIMIT 环境变量硬绕过去的（结果某一个项目一天用了 18 次）。
  // 改成按当天总量均摊，既不会卡死批量作业，也不会让某一个项目独占。
  const maxAnchor = Number(process.env.ANCHOR_LIMIT || Math.max(5, Math.ceil(todayTotal / Math.max(1, ANCHOR_KEYS.length))));
  if (sameAnchor >= maxAnchor) return `项目锚点「${anchorKey}」今天已用 ${sameAnchor} 次（今日上限 ${maxAnchor}），改用事实卡里另一行/备选事实`;
  return '';
}
function assertOpenerFresh(ledger, message) {
  const anchor = factAnchorReason(message);
  if (anchor) throw new Error(`开场白缺事实锚点：${anchor}`);
  const repeat = openerRepetitionReason(ledger, message);
  if (repeat) throw new Error(`开场白同日重复：${repeat}`);
}

function assertOpenerFits(job, message) {
  const reason = openerGapReason(job, message);
  if (reason) throw new Error(`开场白缺关键问句：${reason}`);
}

function openerStyle(job) {
  return projectStyle(job) ? 'project' : 'standard';
}

function assertSendReady(job) {
  if (job.jd?.status !== 'read' || job.jd?.liveStatus === 'partial' || !job.jd?.structured?.description || job.jd.structured.incomplete) throw new Error('未读取完整结构化 JD');
  if (!['pass', 'negotiable'].includes(job.review?.remote?.status)) throw new Error('remote 尚未审核为明确远程或可沟通远程');
  for (const field of ['pay', 'risk']) if (job.review?.[field]?.status !== 'pass') throw new Error(`${field} 尚未通过审核`);
  const integrityIssues = reviewIntegrityIssues(job);
  if (integrityIssues.length) throw new Error(`审核证据与 JD 冲突：${integrityIssues.map(issue => `${issue.field}:${issue.message}`).join('；')}`);
  const workflowStop = explicitWorkflowStopReason(job);
  if (workflowStop) throw new Error(`岗位已明确停止：${workflowStop}`);
  const recoverableMarked = process.argv.includes('--resume-chat') && job.outreach?.status === 'skipped_communicated' && job.opener?.status === 'generated';
  if (!['not_sent', 'chat_created_not_sent'].includes(job.outreach?.status) && !recoverableMarked) throw new Error(`该岗位状态为 ${job.outreach?.status || 'unknown'}，禁止再次发送`);
}

function assertAiReady(ledger, job) {
  assertSendReady(job);
  const queueReason = readyRejectReason(job);
  if (queueReason) throw new Error(`岗位不在当前发送范围：${queueReason}`);
  const resuming = job.outreach?.status === 'chat_created_not_sent' || process.argv.includes('--resume-chat');
  const reason = resuming ? '' : priorContactReason(ledger, job);
  if (reason) throw new Error(reason);
}

// 只识别无法在当前页面关闭的硬性拦截；“完善在线简历”的“好的”提示会在发送页内关闭后继续。
function detectSendBlock(text) {
  if (!text) return '';
  if (/交换(微信|手机号)|请先绑定(微信|手机)|先交换/.test(text)) return 'BOSS 要求先交换联系方式才能沟通';
  return '';
}

// 事实卡：从 事实与表达边界.md 的「开场白事实卡」表逐行读取；按 JD 关键词打分选一行，
// 并把该行项目在事实文件里的完整条目一起给模型。小模型拿到整份事实文件会挑最顺手的数字，
// 所以第一句只允许用命中行的首选/备选事实。
function parseFactCards(facts) {
  const section = facts.split(/^### 开场白事实卡/m)[1] || '';
  const rows = section.split('\n').filter(line => /^\|/.test(line)).slice(2);
  return rows.map(line => line.split('|').slice(1, -1).map(cell => cell.trim())).filter(cells => cells.length >= 6).map(cells => ({
    type: cells[0], keywords: cells[1].split(/\s+/).filter(Boolean), project: cells[2], primary: cells[3], secondary: cells[4], questions: cells[5].split('／').map(q => q.trim()).filter(Boolean),
  }));
}
function projectDetail(facts, projectName) {
  const lines = facts.split('\n');
  const key = projectName.split(' ')[0];
  const start = lines.findIndex(line => /^- \*\*/.test(line) && line.includes(key));
  if (start < 0) return '';
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length && /^\s{2,}- /.test(lines[i]); i++) block.push(lines[i]);
  return block.join('\n');
}
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function pickFactCard(cards, job) {
  const title = String(job.title || '');
  const description = String(job.jd?.structured?.description || '');
  let best = null;
  for (const card of cards) {
    let score = 0;
    for (const kw of card.keywords) {
      const re = new RegExp(escapeRegExp(kw), 'i');
      if (re.test(title)) score += 3;
      if (re.test(description)) score += 1;
    }
    if (!best || score > best.score) best = { card, score };
  }
  if (!best || best.score === 0) best = { card: cards.find(card => card.type === '后端管理系统') || cards[0], score: 0 };
  return best.card;
}
function buildOpenerPrompt(job, profileId, { rejectedReason = '' } = {}) {
  const profile = PROFILES[profileId] || PROFILES[matchProfile(job.title, job.jd?.structured?.description || '')];
  if (!profile) throw new Error('岗位未匹配任何开场白方向');
  const facts = fs.readFileSync(FACTS_FILE, 'utf8');
  const cards = parseFactCards(facts);
  if (!cards.length) throw new Error(`${path.basename(FACTS_FILE)} 缺少「开场白事实卡」表`);
  const card = pickFactCard(cards, job);
  const detail = projectDetail(facts, card.project);
  const forbidden = (facts.split(/^## 禁止声称/m)[1] || '').split(/^## /m)[0].trim();
  const structured = job.jd?.structured || {};
  const askGaps = [...(scoreProjectJob(job).askInOpener || []), ...(job.review?.remote?.status === 'negotiable' ? ['remote'] : [])];
  return [
    '你只负责写一条像真人独立开发者发给老板的 BOSS 首次打招呼。不调用工具，不解释，只输出正文一行。',
    '【结构，三句，缺一句就算失败】',
    '第一句：用下面「本单只能用的事实」里的首选或备选事实之一，改写成老板听得懂的话，并且展开到具体做法——这个项目里你到底做了哪几块、怎么做的、最后怎么验收的。只能讲这一个项目，不能换项目，不能加别的项目，不能写形容词。这一句是全文最长的一句，竞争力靠这里的细节，不靠夸自己。',
    '第二句：怎么合作。按模块/按功能报固定价、验收后付，并补一个只有做过这类活才说得出的交付细节（例如先拿对方现有参考跑个样本再报价、先做一块给对方看、先出需求文档和报价再动手）。',
    '第三句：一个问题，一句话能答的。对方还没答应合作，不要追问业务细节——JD 没写远程时，问一句“这个能不能远程/线上做”就够了。只有 JD 已经写明远程时，才从下面「好问题」里选一条改写。任何时候都禁止问“目前主要做哪类系统/有什么需求/方便沟通吗”这类不看 JD 也能问的话。',
    '【硬规则】',
    `1. 中文单行，${OPENER_MIN}-${OPENER_MAX} 字，以“您好，”开头，句号分句，不用分号，顿号串最多 3 项。字数不是靠形容词和客套凑出来的，是靠第一句里项目的真实细节撑出来的；写不满就再想一个该项目里真实发生过的做法。`,
    '2. 像微信里给老板发消息：不写“具备…能力/赋能/高效/全方位/一站式/深耕/期待合作/欢迎随时/作为一名/为您提供/稳定交付”，不复述 JD 里的职责词，不夸对方项目。',
    `3. 永久禁写数字${CONFIG.opener.bannedNumbersHint ? '：' + CONFIG.opener.bannedNumbersHint : ''}。要说成交就说过程：客户复测多轮无问题、验收当天结款。`,
    '4. 技术名只能写「本单只能用的事实」里出现过的；没出现的一律不写。',
    '5. 严禁虚构年限、模型训练/微调、成熟 RAG、大规模分布式、团队管理、Web3；严禁“不走坐班/入职/提成”这类防备词；不写链接，链接由程序追加。',
    askGaps.includes('remote') ? '6.【必须】JD 没写远程：第三句就是“这个能不能远程/线上做”，语气随意，不要声称岗位支持远程，不用再追加业务问题。' : '6. JD 已写远程，第三句改问一个读过这份 JD 才问得出的具体问题。',
    askGaps.includes('settlement') ? '7.【必须】JD 没写结算：第二句写明“按项目/按模块报固定价，验收后付”。' : '',
    rejectedReason ? `【上一稿被拒，原因：${rejectedReason}。重写时必须消除这个问题。】` : '',
    `【本单只能用的事实】类型：${card.type}；项目：${card.project}`,
    `首选事实：${card.primary}`,
    `备选事实：${card.secondary}`,
    `好问题：${card.questions.join('／')}`,
    detail ? `该项目可展开的真实细节（只能从这里挑，不能编）：\n${detail}` : '',
    `【禁止声称】\n${forbidden}`,
    `【岗位】${job.title} @ ${job.company}；方向：${profile.label}`,
    `薪资：${job.salary || structured.salary || '未显示'}；经验/学历：${structured.experience || '未显示'} / ${structured.education || '未显示'}`,
    `JD正文：${structured.description}`,
    `【输出前自检】字数够不够 ${OPENER_MIN}？第一句是否只讲了指定项目、有没有写到具体做法？有没有禁写数字？` + (askGaps.includes('remote') ? '第三句有没有问远程？' : '第三句是不是读过 JD 才问得出的？'),
    '只输出最终打招呼正文。',
  ].filter(Boolean).join('\n\n');
}

// 模型选择：BOSS_AI_MODEL 环境变量 > ~/.codex/config.toml 的 model > 兜底。
// 2026-09-05 硬编码的 gpt-5.4 已被 ChatGPT 账号拒绝（400 not supported），而 --ignore-user-config 让 codex 不读自己的配置。
function localModelName() {
  if (process.env.BOSS_AI_MODEL) return process.env.BOSS_AI_MODEL;
  try {
    const toml = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const match = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
    if (match) return match[1];
  } catch { /* 无配置文件时走兜底 */ }
  return 'gpt-5.6-luna';
}

function runLocalModel(prompt) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-opener-'));
  const outputFile = path.join(tempDir, 'opener.txt');
  try {
    const codexArgs = [
      'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'read-only', '--color', 'never', '--model', localModelName(),
      '-C', ROOT, '--output-last-message', outputFile, '-',
    ];
    const executable = process.platform === 'win32' ? 'pwsh' : 'codex';
    const executableArgs = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-File', path.join(process.env.APPDATA || '', 'npm', 'codex.ps1'), ...codexArgs]
      : codexArgs;
    const result = childProcess.spawnSync(executable, executableArgs, {
      input: prompt, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`本机 AI 生成失败：${String(result.stderr || result.stdout).slice(-500)}`);
    if (!fs.existsSync(outputFile)) throw new Error('本机 AI 未返回开场白');
    return fs.readFileSync(outputFile, 'utf8');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// 生成后过全部门禁；被拒一次就把原因喂回去重写一次，第二次仍不过才报错。
// ledger 可选：给了才做同日重复/锚点限频检查（ai-opener、ai-send 都传）。
function generateOpener(job, requestedProfile = '', ledger = null) {
  if (job.jd?.status !== 'read' || !job.jd?.structured?.description || job.jd.structured.incomplete) throw new Error('未读取完整结构化 JD');
  const profileId = matchProfile(job.title, job.jd.structured.description, requestedProfile || job.preScreen?.profile) || 'flexible-delivery';
  let rejectedReason = '';
  let raw = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    raw = runLocalModel(buildOpenerPrompt(job, profileId, { rejectedReason }));
    try {
      const message = validateOpener(raw, { allowQuestion: openerStyle(job) === 'project' });
      assertOpenerFits(job, message);
      const lengthReason = openerLengthReason(message);
      if (lengthReason) throw new Error(`开场白长度不合规：${lengthReason}`);
      const anchor = factAnchorReason(message);
      if (anchor) throw new Error(`开场白缺事实锚点：${anchor}`);
      if (ledger) {
        const repeat = openerRepetitionReason(ledger, message);
        if (repeat) throw new Error(`开场白同日重复：${repeat}`);
      }
      return { message, profileId, generator: 'codex-local', style: openerStyle(job), attempts: attempt };
    } catch (error) {
      rejectedReason = error.message;
      if (attempt === 2) throw new Error(`${error.message}（已重写一次仍不过：${String(raw).trim().slice(0, 120)}）`);
    }
  }
  throw new Error('开场白生成失败');
}


module.exports = {
  validateOpener,
  aiToneReason,
  openerGapReason,
  openerAdvice,
  openerLengthReason,
  factAnchorReason,
  anchorKeyOf,
  parseFactCards,
  pickFactCard,
  openerRepetitionReason,
  assertOpenerFresh,
  assertOpenerFits,
  openerStyle,
  assertSendReady,
  assertAiReady,
  detectSendBlock,
  buildOpenerPrompt,
  generateOpener,
};
