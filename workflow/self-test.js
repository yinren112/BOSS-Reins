const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PORT, WINDOW_24H, WINDOW_10MIN, DAILY_BUDGET, HARD_CEILING, BURST_LIMIT, NIGHT_PACE,
  rndInt, isNightHour, paceMultiplier, matchSecurityPage, writeLock, assertNotLocked,
  loadBudget, countWithin, reserveAction, lastActionAt, loadLock, unlockRefusal,
} = require('./safety');
const { parseCliArgs, positionals, jobIdOf, isRealJobUrl } = require('./cli-args');
const {
  blankJob, preScreenJob, candidateRemoteRejectReason, activityRank, assessRemote,
  matchProfile, priorContactReason, targetRejectReason,
} = require('./job-domain');
const {
  parseJobBody, normalizeStructuredPage, hydrateLegacyStructured, reviewIntegrityIssues,
  assertReadableDescription, unreadableJobMessage,
} = require('./jd-domain');
const { conversationStatus, resumeTrigger } = require('./conversation-domain');
const { scoreProjectJob, companyAgeMonths } = require('./project-scoring');
const { buildPlan, planRejectReason, recheckItem, hashOf, sendCounts, reasonBucket } = require('./dispatch');
const { isClosedJobText, isExpiredJobRedirect } = require('./page-flows');
const { validateOpener, assertSendReady, detectSendBlock, aiToneReason, openerGapReason, assertOpenerFits, factAnchorReason, openerRepetitionReason, openerLengthReason, parseFactCards, pickFactCard } = require('./opener-service');
const { verifyFrom, sentVerification } = require('./delivery-verification');
const now = () => new Date().toISOString();
const HARD_URL_ONLY_RE = /\/403\.html|[?&]code=(32|36|37)(?:&|$)|\/web\/passport\/|账户存在异常行为|暂时限制访问|访问受限/i;

function createSelfTest({ reviewPayload, jobWorkbenchPayload, onlineCommands }) {
  const ONLINE_COMMANDS = onlineCommands;
  return async function selfTest({ quiet = false } = {}) {
  const launcherRoot = path.resolve(__dirname, '..');
  const batch = fs.readFileSync(path.join(launcherRoot, 'start-boss-browser.bat'));
  assert.ok(batch.every(byte => byte < 128), 'BAT 入口保持 ASCII，避免 CMD 编码误读');
  assert.ok(!/(?<!\r)\n/.test(batch.toString()), 'BAT 必须使用 CRLF 换行');
  assert.equal(fs.readFileSync(path.join(launcherRoot, 'start-boss-browser.ps1')).subarray(0, 3).toString('hex'), 'efbbbf', '中文 PS1 必须带 UTF-8 BOM，兼容 Windows PowerShell 5.1');
  assert.deepEqual(positionals(['--tab=abc', '--key=Escape', 'chat']), ['chat'], '位置参数不得依赖选项顺序');
  assert.deepEqual(parseCliArgs(['--tab','abc','chat','--full','--key','Escape']), { options:{tab:'abc',key:'Escape'}, flags:new Set(['full']), positionals:['chat'] }, '选项必须同时兼容 --name=value 与 --name value');
  assert.equal(parseCliArgs(['--text=启用招呼语']).options.text, '启用招呼语');
  assert.equal(jobIdOf('https://www.zhipin.com/job_detail/abc_123.html'), 'abc_123');
  assert.equal(isRealJobUrl('https://www.zhipin.com/job_detail/abc_123.html?ka=search'), true);
  assert.equal(isRealJobUrl('https://www.zhipin.com/job_detail/'), false, '页脚占位链接不能算真实岗位');
  assert.deepEqual(verifyFrom([{ verify: { inputEmpty: true, hasMyMsg: true, hasSongda: true } }]), { inputEmpty: true, hasMyMsg: true, hasSongda: true });
  const parsed = parseJobBody('招聘中\nAI全栈开发 20-40K\n公司基本信息\n某公司\n职位描述\n支持全程远程办公');
  assert.deepEqual(parsed, { title: 'AI全栈开发', company: '某公司', salary: '20-40K', remoteEvidence: '支持全程远程办公' });
  assert.equal(conversationStatus({ lastMessage: '暂时不考虑远程亲' }), 'closed');
  assert.equal(conversationStatus({ lastMessage: '可以先看下样片嘛' }), 'boss_last_review');
  assert.equal(conversationStatus({ lastMessage: '这边你之前做的，提升内容产出效率多少，问答准确率，降低人工工时这块有了解过吗' }), 'boss_last_review');
  assert.equal(conversationStatus({ lastMessage: 'Hello，你这边最近还考虑不' }), 'boss_last_review');
  assert.equal(conversationStatus({ lastMessage: '您的附件简历 开发简... 已发送给Boss点击查看附件' }), 'system_notice');
  assert.equal(conversationStatus({ lastMessage: '张三的微信号：example_wx' }), 'contact_shared');
  assert.equal(conversationStatus({ lastMessage: '需要有经验的呢' }), 'closed');
  assert.equal(conversationStatus({ lastMessage: '' }), 'needs_inspect');
  assert.equal(resumeTrigger(''), 'inspect');
  assert.equal(resumeTrigger('暂时不用发简历'), 'review');
  assert.deepEqual(
    sentVerification({ inputEmpty: true, identityMatchCount: 1, matchedText: true, readOrDelivered: true, companyVisible: true }),
    { inputEmpty: true, identityMatched: true, delivered: true, companyVisible: true },
  );
  // 2026-07-25 修复：不再靠聊天列表文案唯一性判定——85 池只有 5 套模板，文案重复是常态。
  // 就算同一文案在列表里出现多次（旧逻辑的 exactMessageCount>1 会误判失败），只要按 encryptBossId
  // 精确定位到目标招聘者会话且该会话最后一条确实是本人发的这条文本，就算核验通过。
  assert.equal(
    Object.values(sentVerification({ inputEmpty: true, identityMatchCount: 1, matchedText: true, readOrDelivered: true, companyVisible: true })).every(Boolean),
    true,
    '文案重复不该导致误判失败，只要能用招聘者身份唯一定位到对应会话',
  );
  // identity 定位不到（比如没解析出 encryptBossId）时必须如实判定失败，不能悄悄放宽标准
  assert.equal(Object.values(sentVerification({ inputEmpty: true, identityMatchCount: 0, matchedText: false, readOrDelivered: false, companyVisible: true })).every(Boolean), false);
  const sameBoss = { version: 1, jobs: [], conversations: [{ encryptBossId: 'boss-a', encryptJobId: 'old-job', company: '甲公司', name: '张三' }] };
  assert.match(priorContactReason(sameBoss, { jobId: 'new-job', recruiter: { encryptBossId: 'boss-a', company: '甲公司', name: '张三' } }), /招聘者/);
  assert.equal(priorContactReason(sameBoss, { jobId: 'new-job', recruiter: { encryptBossId: 'boss-b', company: '甲公司', name: '李四' } }), '');
  assert.match(priorContactReason(sameBoss, { jobId: 'old-job', recruiter: { encryptBossId: 'boss-b', company: '乙公司', name: '王五' } }), /岗位/);
  assert.match(priorContactReason({ jobs: [], conversations: [] }, { jobId: 'new-job', recruiter: { isFriend: true } }), /已沟通/);
  assert.equal(activityRank('本周活跃'), 70);
  assert.equal(activityRank('3月内活跃'), 30);
  assert.equal(detectSendBlock('请先完善在线简历后再沟通'), '');
  assert.match(detectSendBlock('请先交换微信后再沟通'), /交换联系方式/);
  assert.equal(isClosedJobText('该职位已关闭'), true);
  // 岗位失效跳转不得被当成安全事件（2026-07-26 误报熔断复盘）
  assert.equal(isExpiredJobRedirect('https://www.zhipin.com/'), true);
  assert.equal(isExpiredJobRedirect('https://www.zhipin.com/web/geek/jobs'), true);
  assert.equal(isExpiredJobRedirect('https://www.zhipin.com/web/geek/job'), true);
  assert.equal(isExpiredJobRedirect('https://www.zhipin.com/web/passport/login'), false);
  assert.equal(isExpiredJobRedirect('https://www.zhipin.com/403.html'), false);
  assert.equal(isExpiredJobRedirect('https://evil.example.com/'), false);
  assert.equal(isClosedJobText('正常招聘中'), false);
  assert.equal(matchProfile('React前端开发'), 'frontend');
  assert.equal(matchProfile('微信小程序兼职'), 'miniprogram');
  assert.equal(matchProfile('新媒体运营', '', 'ai-agent'), '');
  const screenLedger = { jobs: [], conversations: [] };
  const activeJob = blankJob('active');
  const quietJob = blankJob('quiet');
  screenLedger.jobs.push(activeJob, quietJob);
  preScreenJob(screenLedger, activeJob, { title: 'React前端开发', text: 'React前端开发 远程 100-150元/时', activityText: '今日活跃' });
  preScreenJob(screenLedger, quietJob, { title: 'React前端开发', text: 'React前端开发 远程 100-150元/时', activityText: '' });
  assert.equal(activeJob.preScreen.status, 'priority');
  assert.equal(quietJob.preScreen.status, 'priority');
  assert.equal(activeJob.preScreen.score, quietJob.preScreen.score);
  assert(activeJob.preScreen.activityRank > quietJob.preScreen.activityRank);
  const lowPay = blankJob('low');
  screenLedger.jobs.push(lowPay);
  preScreenJob(screenLedger, lowPay, { title: '小程序开发', text: '小程序开发 40-50元/时' });
  assert.notEqual(lowPay.preScreen.status, 'reject');
  assert.equal(lowPay.decisions.at(-1).stage, 'pre_screen');
  assert.equal(assessRemote('Python 后端（可居家/远程）', '【全职】负责接口开发').status, 'pass');
  assert.equal(assessRemote('Python 后端（可居家/远程）', '该岗位必须到岗办公').status, 'fail');
  assert.equal(assessRemote('Python 后端', '支持远程面试，入职后坐班').status, 'pending');
  const legacy = blankJob('legacy');
  legacy.title = '远程前端';
  legacy.jd = { status: 'read', text: '招聘中\n远程前端 3-5K\n公司基本信息\n甲公司\n职位描述\n【全职】\n负责页面开发\n公司介绍\n简介' };
  const hydrated = hydrateLegacyStructured(legacy);
  assert.equal(hydrated.jd.structured.description.includes('负责页面开发'), true);
  assert.equal(hydrated.jd.remoteHint, '远程前端');
  const validOpener = '您好，我独立完成并持续维护过可上线的微信小程序，覆盖前后端、支付、测试和部署，有独立交付和持续维护真实产品的经验。如果觉得合适，可以发给您我的个人作品集网站和简历。';
  assert.equal(validateOpener(validOpener), validOpener);
  assert.throws(() => validateOpener('您好，我有多年经验，能够快速完成开发。如果觉得合适，可以发给您我的个人作品集网站和简历。'), /未确认经历/);
  assert.throws(() => validateOpener('您好，我做过可上线的微信小程序，不走长期坐班模式。'), /生硬防备词/);
  const projectOpener = '您好，你们这边小程序是自己团队做，还是找人按项目交付？我这边可以按模块报固定价，先做一块给你看效果。';
  assert.equal(validateOpener(projectOpener, { allowQuestion: true }), projectOpener);
  const projectJob = blankJob('project-score');
  projectJob.title = '影院小程序开发';
  projectJob.jd = { status:'read', structured:{ description:'找个人做一个影院小程序，支持全程远程交付，按项目结算验收。', incomplete:false } };
  assert.equal(scoreProjectJob(projectJob, { layer:'jd' }).status, 'eligible');
  const fdeJob = blankJob('fde-project-reject');
  fdeJob.title = 'AI内容生产FDE';
  fdeJob.jd = { status:'read', structured:{ description:'进入客户业务现场完成 AI 内容生产交付。', incomplete:false } };
  assert.match(targetRejectReason(fdeJob), /FDE/);
  assert.equal(scoreProjectJob(fdeJob, { layer:'jd' }).status, 'hard_reject');
  const rejectedProject = blankJob('project-score-reject');
  rejectedProject.title = '网站开发';
  rejectedProject.jd = { status:'read', structured:{ description:'维护现有系统，要求3年以上经验，本科以上，配合团队迭代。', incomplete:false } };
  assert.equal(scoreProjectJob(rejectedProject, { layer:'jd' }).score, 0);
  const smallTeamSenior = blankJob('small-team-senior-project');
  smallTeamSenior.title = '资深小程序开发';
  smallTeamSenior.jd = { status:'read', structured:{ description:'10人创业团队找个人定制一个微信小程序，项目制，全程线上交付，要求3年以上经验。', businessInformation:'0-20人', incomplete:false } };
  assert.equal(scoreProjectJob(smallTeamSenior, { layer:'jd' }).status, 'eligible');
  const scoringRejects = [
    ['ordinary-staffing', '全栈工程师', '负责公司平台功能开发，配合产品和测试团队敏捷迭代，支持远程办公。'],
    ['non-development', '软件产品经理', '远程项目制，负责软件需求和开发团队协调，按项目结算。'],
    ['maintenance', '小程序开发', '远程兼职维护现有小程序，长期迭代和修复 Bug。'],
    ['wrong-stack', 'Java 全栈外包', '小团队找个人远程承接商城项目，按项目结算，后端必须使用 Java Spring Boot。'],
    ['onsite', '网站定制开发（线下+远程）', '找人定制企业官网，项目制，可线下加远程开发。'],
  ];
  for (const [id, title, description] of scoringRejects) {
    const job = blankJob(id);
    job.title = title;
    job.jd = { status:'read', structured:{ description, incomplete:false } };
    assert.equal(scoreProjectJob(job, { layer:'jd' }).status, 'hard_reject', id);
  }
  const orderPoolStackMismatch = blankJob('order-pool-stack-mismatch');
  orderPoolStackMismatch.title = '各类小程序开发（线上）';
  orderPoolStackMismatch.jd = { status:'read', structured:{ description:'长期线上接单，为甲方开发 APP、小程序和网页，按客户需求定价，在线兼职接单，要求 Java、C++、Spring。', incomplete:false } };
  const orderPoolResult = scoreProjectJob(orderPoolStackMismatch, { layer:'jd' });
  assert.equal(orderPoolResult.status, 'eligible');
  assert(orderPoolResult.signals.some(item => item.code === 'order_pool_stack_mismatch'));
  const cooperationInterest = blankJob('cooperation-interest');
  cooperationInterest.title = 'Python 数据分析师';
  cooperationInterest.jd = { status:'read', structured:{ description:'我们开发了一些自动化电商软件，有合作意向的也可以聊聊。', incomplete:false } };
  const cooperationResult = scoreProjectJob(cooperationInterest, { layer:'jd' });
  assert.equal(cooperationResult.status, 'eligible');
  assert(cooperationResult.signals.some(item => item.code === 'cooperation_interest'));
  assert(cooperationResult.signals.some(item => item.code === 'remote_unconfirmed_ask'), '合作意向岗位未写远程时提示开场白询问，而不是人工复核');
  // v7：远程没写明但也没要求到岗 → 允许发送，开场白问一句（不再 hard reject）
  const noRemote = blankJob('no-remote-ask');
  noRemote.title = '软件定制开发';
  noRemote.jd = { status:'read', structured:{ description:'找团队定制一套库存软件，按项目验收，工作地点另行沟通。', incomplete:false } };
  const noRemoteResult = scoreProjectJob(noRemote, { layer:'jd' });
  assert.equal(noRemoteResult.status, 'eligible', '无到岗证据的项目岗位不得因远程缺失淘汰');
  assert.equal(noRemoteResult.remoteSuggestion, 'negotiable');
  assert(noRemoteResult.askInOpener.includes('remote'));

  // ===== 两单真实成交的 JD 是筛选规则的回归基准：任何一版规则把它们判成不可发送，就是规则错了 =====
  // 成交一：成交案例甲「AI应用开发工程师(兼职·远程·按单结算)」，2026-08-12 发送，成交采集工具 2000 + 后续 5000/3000 单。
  const dealCheTao = blankJob('deal-chetao');
  dealCheTao.title = 'AI应用开发工程师(兼职·远程·按单结算)';
  dealCheTao.company = '示例甲智能科技';
  dealCheTao.salary = '8000-25000元/月';
  dealCheTao.recruiter = { name:'甲某', title:'股东' };
  dealCheTao.jd = { status:'read', structured:{ incomplete:false,
    description:'工作周期：长期兼职 每周工期：无要求 工作时间：不限 ⼯作时段：按单安排时间 结算⽅式：⽉结 招聘截止时间：2026-10-10 我们做AI+行业应⽤落地,也做小程序、管理系统、网站 现在单子多,固定的几个人排不过来 想找几个能长期接的兼职 怎么合作 按单结算,一单一结,不坐班不打卡 需求和原型我们出,报价一起定 做完客户验收通过就结,不拖 接什么活 企业内部的AI应用:智能客服、文档问答、内容生成、自动化流程 给老系统加AI功能 小程序、管理系统、企业网站 什么人合适 能独立做完一个完整项目的 Python或Node或Java任一门熟 调过大模型接口的优先,ComfyUI、Dify、n8n这类玩过的优先 没做过AI但后端底子扎实的也可以聊,我们带一段 时间上 不要求全天在线,但接了的单要按约定时间交 接单量自己定,一个月接一单也行 先从一个小单开始,双方都合适再谈长期',
    businessInformation:'公司名称 示例甲智能科技有限公司 法定代表人 甲某 成立日期 2026-07-31 企业类型 有限责任公司（自然人独资） 经营状态 开业 注册资金 50万元',
    address:'东莞某产业园', experience:'1-3年', education:'学历不限' } };
  const cheTaoResult = scoreProjectJob(dealCheTao, { layer:'jd', at:new Date('2026-08-12') });
  assert.equal(cheTaoResult.status, 'eligible', `成交单一被判淘汰：${JSON.stringify(cheTaoResult.hardRejects)}`);
  assert.equal(cheTaoResult.remoteSuggestion, 'pass');
  assert(cheTaoResult.signals.some(x => x.code === 'direct_project_cooperation'));
  assert(!cheTaoResult.hardRejects.some(x => x.code === 'core_stack_mismatch'), '「Python或Node或Java任一门熟」不是核心栈错位');
  // 成交二：成交案例乙「微信社交小程序开发员 7-8K 惠州 包吃包住」，2026-08-17 发送，加微信后成交全款。
  // 这条 JD 没写远程、没写项目制、还是 HR 中转——旧口径下它会被当成「普通招聘」淘汰。
  const dealGongyou = blankJob('deal-gongyou');
  dealGongyou.title = '微信社交小程序开发员';
  dealGongyou.company = '示例乙科技有限公司';
  dealGongyou.salary = '7-8K';
  dealGongyou.recruiter = { name:'乙先生', title:'人事经理' };
  dealGongyou.jd = { status:'read', structured:{ incomplete:false,
    description:'⼯作内容：负责微信社交⼩程序前后端开发、包括UI界⾯设计、完成正常上线 每月薪资：7000 职位福利：（包吃/包住） 学历要求：本科 工作年限：1⽉ 任职要求：自备电脑、与老板沟通开发要点',
    businessInformation:'公司名称 示例乙科技有限公司 法定代表人 乙某 成立日期 2026-06-01 企业类型 有限责任公司（自然人独资） 经营状态 开业 注册资金 1万元',
    address:'惠州某高新区', education:'本科' } };
  const gongyouResult = scoreProjectJob(dealGongyou, { layer:'jd', at:new Date('2026-08-17') });
  assert.equal(gongyouResult.status, 'eligible', `成交单二被判淘汰：${JSON.stringify(gongyouResult.hardRejects)}`);
  assert.equal(gongyouResult.remoteSuggestion, 'negotiable', '未写远程且无到岗要求 → negotiable，不是 fail');
  assert(gongyouResult.signals.some(x => x.code === 'owner_product'), '新公司 + 自备电脑 + 与老板沟通 = 老板自建产品');
  assert.deepEqual(gongyouResult.askInOpener, ['remote', 'settlement']);
  assert.equal(companyAgeMonths('成立日期 2026-06-01', new Date('2026-08-17')), 2);
  // 成交二的真实开场白必须通过全部门禁（含去 AI 感和远程问句）
  dealGongyou.review = { remote:{ status:'negotiable', evidence:'JD未写远程；开场白询问能否远程/异地协作' }, pay:{ status:'pass', evidence:'每月薪资7000' }, risk:{ status:'pass', evidence:'真实用工方示例乙科技有限公司，职责为小程序前后端与上线，未见硬红线' } };
  const gongyouOpener = '您好，我独立完成并持续维护过微信小程序，覆盖前后端、数据库、支付、测试和部署，熟悉按需求沟通后推进社交类小程序开发与上线，远程协作方式可以沟通。如果觉得合适，可以发给您我的个人作品集网站和简历。';
  assert.equal(validateOpener(gongyouOpener), gongyouOpener);
  assert.doesNotThrow(() => assertOpenerFits(dealGongyou, gongyouOpener));
  assert.doesNotThrow(() => assertSendReady(dealGongyou), 'remote=negotiable + pay/risk pass 必须可发送');
  assert.match(openerGapReason(dealGongyou, '您好，我独立做过微信小程序，可以按模块报固定价做完验收再付。方便发下需求清单吗？'), /远程/, 'JD 未写远程时开场白必须带远程问句');
  // 到岗/坐班仍然是硬淘汰
  const onsiteOwner = blankJob('onsite-owner');
  onsiteOwner.title = '微信小程序开发';
  onsiteOwner.jd = { status:'read', structured:{ description:'老板直接对接，开发一个商城小程序，需到岗坐班。', businessInformation:'成立日期 2026-07-01 注册资金 5万元', incomplete:false } };
  assert.equal(scoreProjectJob(onsiteOwner, { layer:'jd' }).status, 'hard_reject');
  assert(scoreProjectJob(onsiteOwner, { layer:'jd' }).hardRejects.some(x => x.code === 'onsite_required'));
  // 普通补员即使公司小也不放行：没有具体交付物
  const smallStaffing = blankJob('small-staffing');
  smallStaffing.title = '前端开发工程师';
  smallStaffing.jd = { status:'read', structured:{ description:'负责公司产品前端页面日常开发，配合产品和测试团队敏捷迭代。', businessInformation:'成立日期 2026-05-01 注册资金 10万元', incomplete:false } };
  assert.equal(scoreProjectJob(smallStaffing, { layer:'jd' }).status, 'hard_reject');

  // 去 AI 感门禁：套话词、长顿号串、双分号、超长
  assert.match(aiToneReason('您好，我具备稳定的远程按单交付能力，期待与您合作。'), /套话词/);
  assert.match(aiToneReason('您好，我做过前端、后端、数据库、支付、测试、部署、运维的全套工作。'), /顿号串/);
  assert.match(aiToneReason('您好，我做过小程序；也做过网站；还做过爬虫。'), /分号/);
  assert.equal(aiToneReason('您好，我独立做过两个微信小程序并上线，可以按模块报固定价，验收后付。你们这个能线上做吗？'), '');
  assert.throws(() => validateOpener('您好，作为一名全栈开发者，我可以为您提供一站式的小程序开发服务，助力业务增长。'), /AI 感/);

  // 9-05：事实锚点、未确认技术、同日重复
  assert.match(factAnchorReason('您好，我做过多套微信小程序与后台系统，可以按模块报价验收，远程协作方式可以沟通吗？'), /锚点/, '「做过多套」没有任何可核验内容');
  assert.equal(factAnchorReason('您好，我独立做过并上线维护微信小程序，手写过微信支付 v3 对接，可以按模块报固定价。这个能远程做吗？'), '');
  assert.equal(factAnchorReason('您好，我给客户做过 demo-iot 设备接入平台，可以按模块报价。能线上做吗？'), '');
  assert.match(factAnchorReason('您好，我主力用 Next.js 和 Supabase，做过 RLS 权限策略。支持远程审计吗？'), /Supabase/);
  assert.match(factAnchorReason('您好，我能快速跑通影刀流程，做过两千多个账号的采集。能远程吗？'), /影刀/);
  // 9-05 晚：禁写数字、通用问句、事实卡选行、同日锚点限频
  assert.match(factAnchorReason('您好，我做过含200项测试的系统，之前9999元项目也是独立完成。能远程吗？'), /禁写数字/, '具体数字不再算锚点');
  assert.match(factAnchorReason('您好，我交付过含30个页面的小程序，可以按模块报价。能线上做吗？'), /禁写数字/, '页面数不再算锚点');
  assert.match(factAnchorReason('您好，我做过 demo-iot 设备平台，可以按模块报价。目前主要需要开发哪一类软件系统？'), /问题太通用/);
  assert.match(factAnchorReason('您好，我独立做过高并发 API 聚合与控频熔断系统。能远程吗？'), /高并发/, '虚构的网关项目');
  assert.equal(factAnchorReason('您好，我给客户做过商品数据采集工具，遇验证码自动停、断点续跑。派单发到哪个平台，要界面吗，能线上做吗？'), '');
  const factCards = parseFactCards(require('fs').readFileSync(require('./reins-config').loadConfig().factsFile, 'utf8'));
  assert(factCards.length >= 6, '事实卡至少 6 行');
  assert(factCards.every(card => card.primary && card.secondary && card.questions.length >= 2), '每行都有首选、备选和至少两个好问题');
  assert(factCards.every(card => !require('./reins-config').loadConfig().opener.bannedNumbers.test(card.primary + card.secondary)), '事实卡本身不能含禁写数字');
  assert.equal(pickFactCard(factCards, { title: 'Python 程序员', jd: { structured: { description: '写一个 Python 派单小工具，有现有可以参考' } } }).type, '采集自动化');
  assert.equal(pickFactCard(factCards, { title: '数字门铃，楼宇对讲系统软件外包', jd: { structured: { description: '外包' } } }).type, '物联网硬件');
  assert.equal(pickFactCard(factCards, { title: '程序员', jd: { structured: { description: '写点东西' } } }).type, '后端管理系统', '无命中回落后端行');
  const anchorLedger = { jobs: [1, 2, 3, 4, 5].map(i => ({ jobId: `an${i}`, opener: { message: `您好，我做过 demo-iot 设备平台第${i}套，协议定了吗？`, generatedAt: '2026-09-05T01:00:00.000Z' } })) };
  assert.match(openerRepetitionReason(anchorLedger, '您好，我给客户做过 demo-iot 设备接入平台，接了两家厂商设备。走哪家协议？', { today: '2026-09-05' }), /项目锚点/);
  assert.equal(openerRepetitionReason(anchorLedger, '您好，我给客户做过商品数据采集工具。采集哪个平台？', { today: '2026-09-05' }), '');
  // 9-07：收尾只问远程是本人定的写法，纯远程问句额度放宽到 8 条；带 JD 细节的业务问句仍是 ≥3 条就换说法。
  const repLedger = { jobs: [1, 2, 3].map(i => ({ jobId: `rep${i}`, outreach: { status: 'delivered', sentAt: '2026-09-04T08:00:00.000Z', message: `您好，我做过微信小程序第${i}套，可以按模块报价与验收，远程协作方式可以沟通吗？需求文档现在有吗？` } })) };
  assert.match(openerRepetitionReason(repLedger, '您好，我做过 demo-iot 设备平台，可以按模块报价，远程协作方式可以沟通吗？需求文档现在有吗？', { today: '2026-09-04' }), /问句/, '业务问句同日第 3 次要换说法');
  assert.equal(openerRepetitionReason(repLedger, '您好，我做过 demo-iot 设备平台，可以按模块报价，远程协作方式可以沟通吗？', { today: '2026-09-04' }), '', '纯远程收尾问句不受 3 次限制');
  const remoteLedger = { jobs: [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ jobId: `rem${i}`, outreach: { status: 'delivered', sentAt: '2026-09-04T08:00:00.000Z', message: `您好，我做过微信小程序第${i}套，可以按模块报价与验收，远程协作方式可以沟通吗？` } })) };
  assert.match(openerRepetitionReason(remoteLedger, '您好，我做过 demo-iot 设备平台，可以按模块报价，远程协作方式可以沟通吗？', { today: '2026-09-04' }), /问句/, '纯远程问句用满 8 条仍要换说法');
  assert.equal(openerRepetitionReason(repLedger, '您好，我做过 demo-iot 设备平台，可以按模块报价，这个能线上做吗？', { today: '2026-09-04' }), '');
  assert.equal(openerRepetitionReason(repLedger, '您好，我做过 demo-iot 设备平台，可以按模块报价，远程协作方式可以沟通吗？需求文档现在有吗？', { today: '2026-09-05' }), '', '只看当天');
  // 9-07：新写的开场白必须 120–200 字，短的靠形容词凑不过去
  assert.match(openerLengthReason('您好，我做过 demo-iot 设备平台，可以按模块报价，这个能远程做吗？'), /不足 120/);
  assert.equal(openerLengthReason('您'.repeat(150)), '');
  assert.match(openerLengthReason('您'.repeat(220)), /超过 200/);

  assert.equal(validateOpener('您好，我做过可上线的微信小程序，有完整落地经验。'), '您好，我做过可上线的微信小程序，有完整落地经验。');
  const partial = blankJob('partial');
  partial.jd = { status: 'partial', structured: { description: '截断内容', incomplete: true } };
  assert.throws(() => assertSendReady(partial), /完整结构化/);
  assert.doesNotThrow(() => assertReadableDescription('短 JD'));
  assert.throws(() => assertReadableDescription('   '), /JD 正文为空/);
  assert.equal(unreadableJobMessage({ bodyText: '登录后查看完整职位描述' }), '登录态失效或职位正文受登录限制，已停止');
  assert.equal(unreadableJobMessage({ bodyText: '职位详情加载中' }), 'JD 正文在等待窗口内未渲染，已停止');
  const ready = blankJob('ready');
  ready.title = '远程开发';
  ready.jd = { status: 'read', structured: { description: '支持全程远程办公，薪资 10-15K，真实用工方与开发职责明确', incomplete: false } };
  ready.review = { remote: { status: 'pass', evidence: '支持全程远程办公' }, pay: { status: 'pass', evidence: '薪资 10-15K' }, risk: { status: 'pass', evidence: '真实用工方与开发职责明确，未见硬红线' } };
  assert.doesNotThrow(() => assertSendReady(ready));
  // 计划/执行器：材料就绪队列 → 计划文件；发送前重验 JD 与开场白哈希
  const planMsg = '您好，看到你们要做一个社交类小程序。我自己独立做过并上线维护预约小程序，前后端、数据库和微信支付都是一个人做的，上线前按客户给的验收清单一条条对照复测，客户复测多轮无问题当天结款。可以按功能模块报固定价、验收后付，先做一块给您看。这个是可以远程做的吧？';
  const planJob = { ...blankJob('plan1'), title: '微信小程序开发员', url: 'https://www.zhipin.com/job_detail/plan1.html', company: '自测公司' };
  planJob.jd = { status: 'read', hash: 'h1', checkedAt: '2026-09-07T01:00:00.000Z', structured: { description: '负责小程序前后端开发完成上线，自备电脑，与老板沟通开发要点', incomplete: false } };
  planJob.review = { remote: { status: 'negotiable', evidence: '未写' }, pay: { status: 'pass', evidence: '7-8K' }, risk: { status: 'pass', evidence: '无' } };
  planJob.opener = { status: 'generated', message: planMsg, profile: 'miniprogram', style: 'project', jdHash: 'h1', generatedAt: '2026-09-07T02:00:00.000Z' };
  const planLedger = { jobs: [planJob, { ...planJob, jobId: 'plan2', url: 'https://www.zhipin.com/job_detail/plan2.html', opener: { ...planJob.opener, jdHash: 'old' } }], conversations: [], companies: [] };
  assert.equal(planRejectReason(planLedger, planJob), '');
  assert.match(planRejectReason(planLedger, planLedger.jobs[1]), /JD 已变化/);
  const plan = buildPlan(planLedger, { at: '2026-09-07T03:00:00.000Z' });
  assert.deepEqual(plan.items.map(i => i.jobId), ['plan1'], '开场白绑定旧 JD 的岗位不进计划');
  assert.equal(plan.rejected[0].jobId, 'plan2');
  assert.equal(buildPlan(planLedger, { limit: 0 }).items.length, 0, '--limit 按剩余额度截断');
  assert.equal(recheckItem(planLedger, plan.items[0]).job.jobId, 'plan1');
  assert.match(recheckItem({ ...planLedger, jobs: [{ ...planJob, opener: { ...planJob.opener, message: planMsg + '改' } }] }, plan.items[0]).reason, /被改动/);
  assert.match(recheckItem({ ...planLedger, jobs: [{ ...planJob, jd: { ...planJob.jd, hash: 'h2' } }] }, plan.items[0]).reason, /JD 已变化/);
  assert.equal(hashOf('a').length, 16);
  assert.equal(reasonBucket('开场白缺事实锚点：x'), '锚点');
  assert.equal(reasonBucket('开场白同日重复：问句「x」今天已用 3 次'), '同日重复');
  const countLedger = { jobs: [{ outreach: { status: 'delivered', sentAt: '2026-09-07T01:00:00.000Z' } }, { outreach: { status: 'delivered', sentAt: '2026-09-02T01:00:00.000Z' } }, { outreach: { status: 'skipped_communicated', sentAt: '2026-09-07T01:00:00.000Z' } }] };
  assert.deepEqual(sendCounts(countLedger, { now: Date.parse('2026-09-07T05:00:00.000Z') }), { sentToday: 1, sent7d: 2, daysSinceLastSend: 0 }, '跳过记录不算发送');
  assert.equal(matchSecurityPage('https://www.zhipin.com/web/passport/zp/403.html?referer=x&code=32'), true);
  assert.equal(matchSecurityPage('https://www.zhipin.com/web/geek/jobs?query=AI'), false);
  assert.equal(matchSecurityPage('captcha 安全验证'), true);
  assert.equal(matchSecurityPage('账户存在异常行为，已暂时限制访问'), true);
  // 2026-07-25 实测误报回归：BOSS 静默通过安全复核后仍把该参数留在 URL 上，光凭子串不能判定为拦截
  assert.equal(matchSecurityPage('https://www.zhipin.com/web/geek/jobs?_security_check=1_1784920737343'), false);
  assert.equal(HARD_URL_ONLY_RE.test('https://www.zhipin.com/web/geek/jobs?_security_check=1_123'), false);
  assert.equal(HARD_URL_ONLY_RE.test('https://www.zhipin.com/web/passport/zp/403.html?code=32'), true);
  const tmpLock = path.join(os.tmpdir(), `boss-lock-selftest-${process.pid}.json`);
  assert.equal(loadLock(tmpLock).locked, false);
  assert.doesNotThrow(() => assertNotLocked(tmpLock));
  writeLock('自测锁定', '证据', tmpLock);
  assert.throws(() => assertNotLocked(tmpLock), /熔断锁定/);
  fs.rmSync(tmpLock, { force: true });
  // 风控级熔断当天不得解锁；普通锁和超过 24 小时的旧锁可以解
  const severe = { locked: true, reason: '访问受限 code=32：账户存在异常行为', evidence: '', lockedAt: new Date().toISOString() };
  assert.match(unlockRefusal(severe), /当天不得解锁/);
  assert.equal(unlockRefusal({ ...severe, lockedAt: new Date(Date.now() - 3 * WINDOW_24H).toISOString() }), '');
  assert.equal(unlockRefusal({ locked: true, reason: 'check 发现安全/异常页面', lockedAt: new Date().toISOString() }), '');
  assert.equal(unlockRefusal({ locked: false }), '');

  // 预算：24 小时滚动窗口，不按自然日重置
  const tmpBudget = path.join(os.tmpdir(), `boss-budget-selftest-${process.pid}.json`);
  const stamp = (kind, minutesAgo) => ({ kind, detail: 'selftest', at: new Date(Date.now() - minutesAgo * 60000).toISOString() });
  const writeEvents = events => fs.writeFileSync(tmpBudget, JSON.stringify({ port: PORT, consecutiveEmptyJd: 0, events }));

  writeEvents([stamp('jobReads', 5), stamp('jobReads', 60), stamp('jobReads', 23 * 60), stamp('jobReads', 25 * 60)]);
  const rolled = loadBudget(tmpBudget);
  assert.equal(countWithin(rolled, 'jobReads', WINDOW_24H), 3, '25 小时前的事件必须滑出 24 小时窗口');
  assert.equal(countWithin(rolled, 'jobReads', WINDOW_10MIN), 1);
  assert.equal(lastActionAt(rolled) > 0, true);

  // 旧版漏洞回归：昨天 23:00 和今天 00:30 的动作跨了自然日，但仍在同一个 24 小时窗口内，必须一起算
  const nearMidnight = [stamp('sends', 90), stamp('sends', 30)];
  writeEvents(nearMidnight);
  assert.equal(countWithin(loadBudget(tmpBudget), 'sends', WINDOW_24H), 2);

  // 24 小时额度用完 → 拒绝
  writeEvents(Array.from({ length: DAILY_BUDGET.searchPages }, (_, i) => stamp('searchPages', 60 + i)));
  await assert.rejects(() => reserveAction('searchPages', 'x', tmpBudget), /24 小时滚动额度已用完/);

  // 10 分钟突发上限 → 拒绝（总量远未用完）
  writeEvents(Array.from({ length: BURST_LIMIT.jobReads }, (_, i) => stamp('jobReads', i * 0.1)));
  await assert.rejects(() => reserveAction('jobReads', 'x', tmpBudget), /10 分钟突发上限/);

  // 正常记账：sends 连带记一次 jobReads
  writeEvents([]);
  await reserveAction('sends', 'selftest', tmpBudget, ['jobReads']);
  const after = loadBudget(tmpBudget);
  assert.equal(countWithin(after, 'sends', WINDOW_24H), 1);
  assert.equal(countWithin(after, 'jobReads', WINDOW_24H), 1, '发送必须连带计入详情页总量');
  fs.rmSync(tmpBudget, { force: true });

  // 2026-08-10 起深夜与白天使用同一节奏和总量。
  assert.equal(isNightHour(new Date(2026, 6, 25, 23, 30)), true);
  assert.equal(isNightHour(new Date(2026, 6, 25, 3, 0)), true);
  assert.equal(isNightHour(new Date(2026, 6, 25, 14, 0)), false);
  assert.equal(paceMultiplier(new Date(2026, 6, 25, 23, 30)), NIGHT_PACE);
  assert.equal(paceMultiplier(new Date(2026, 6, 25, 14, 0)), 1);
  assert.equal(HARD_CEILING.jobReads >= DAILY_BUDGET.jobReads, true);
  assert.equal(HARD_CEILING.sends >= DAILY_BUDGET.sends, true);

  // 审岗载荷必须自带 JD 正文和审核状态：少任何一项，agent 都会退回去读 ledger.json
  const samplePayload = reviewPayload({
    jobId: 'x1', title: '远程全栈', company: 'A 公司', salary: '20-30K',
    recruiter: { activeText: '刚刚活跃', activityRank: 5 },
    jd: { status: 'read', remoteHint: '可远程', structured: { description: '负责 Node 服务端开发', benefits: '五险一金' } },
    review: { remote: { status: 'pass' } },
    outreach: { status: 'not_sent' },
  });
  assert.equal(samplePayload.description, '负责 Node 服务端开发', '审岗载荷必须带 JD 正文');
  assert.equal(samplePayload.review.remote, 'pass');
  assert.equal(samplePayload.review.pay, 'pending', '未判定的审核项要显式给出 pending');
  assert.equal(samplePayload.outreachStatus, 'not_sent');
  // jd/preflight 是离线自查入口，被熔断锁挡住就失去意义
  assert.equal(ONLINE_COMMANDS.has('jd'), false, 'jd 必须离线可用');
  assert.equal(ONLINE_COMMANDS.has('preflight'), false, 'preflight 要自己报告锁状态，不能被锁挡住');
  const { isDangerousTarget } = require('./browser');
  assert.equal(isDangerousTarget({ action:'user-resume-edit-advantage', text:'正文里可能出现确认或发送' }), false, '简历编辑入口不能因正文关键词误拦截');
  assert.equal(isDangerousTarget({ action:'resume_form_advantage_ok', text:'完成' }), true, '完成按钮会持久化简历，必须拦截');
  assert.equal(isDangerousTarget({ action:'', text:'取消' }), false, '取消动作应可直接执行');

  // 随机抖动：连抽 20 次不能全一样
  assert.equal(new Set(Array.from({ length: 20 }, () => rndInt(3000, 6500))).size > 1, true);
  if (!quiet) console.log('SELF_TEST_OK');
  return { ok: true };
}


}

module.exports = { createSelfTest };
