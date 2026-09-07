const { targetRejectReason, assessRemote } = require('./job-domain');

// v7（2026-09-04）：以两单真实成交（成交案例甲「兼职·远程·按单结算」、成交案例乙「微信社交小程序开发员 7-8K 惠州」）
// 为回归基准重写口径。核心变化：
//  1. 「远程未写明」不再是硬淘汰，只要没有明确到岗/坐班/驻场，就允许发送，由开场白问一句远程/线上协作；
//  2. 新增「老板自建产品」信号：新公司/小注册资金/自备电脑/与老板直接沟通 + 具体软件交付物，等价于合作信号；
//  3. 「Python 或 Node 或 Java 任一门」这类多选栈不算核心栈错位；
//  4. 接单池、合作意向、老板自建产品三类都直接可发送，不再挂「人工复核」。
const VERSION = 7;
const now = () => new Date().toISOString();

const DELIVERABLE_NOUN = '(?:网站|官网|独立站|商城|软件|系统|小程序|公众号|APP|自动化工具|自动化流程|脚本|工作流|智能体|Agent|爬虫|数据采集工具|管理系统|AI\\s*应用)';
const CUSTOM_DELIVERABLE = new RegExp([
  `(?:定制|开发|搭建|建设|制作|实现|交付|承接|做一(?:个|套)|也做|做|接).{0,40}${DELIVERABLE_NOUN}`,
  `${DELIVERABLE_NOUN}.{0,40}(?:定制|开发|搭建|建设|制作|实现|交付|承接|从\\s*0\\s*到\\s*1|独立完成|上线)`,
  `(?:单子|接单|派单|订单).{0,60}${DELIVERABLE_NOUN}`,
  `能独立做完(?:一个)?完整项目`,
].join('|'), 'i');
const DIRECT_COOP_SIGNAL = /按单(?:结算|计费|安排)|一单一结|按项目(?:结算|合作|验收|付款|交付)|找(?:个人|人|团队|开发者|工作室).{0,12}(?:定制|开发|做|承接)|项目制|项目合作|短期项目|兼职项目|一次性交付|固定(?:价|报价)|外包|包干|完工结|验收(?:通过)?(?:就|后|即)?结|接单|订单|派单|单子多|为甲方.{0,40}(?:开发|制作|搭建|完成)|按需求.{0,20}(?:定价|报价|结算)|报价一起定|寻求.{0,30}(?:开发者|工程师|开发团队)|个人开发者|独立承接/i;
const COOPERATION_INTEREST_SIGNAL = /合作意向|合作可谈|欢迎合作|可以聊聊|有意向(?:的)?(?:也)?(?:可以|可)?聊|兼职合作|支持兼职(?:形式)?|按(?:客户|实际)需求(?:承接|开发|定制)|长期(?:接|合作)的兼职/i;
// 老板自己想做一个产品、直接找人做：公司很新、注册资金很小、自然人独资/个体户/工作室、自备电脑、与老板直接沟通。
// 成交案例乙那单（成交）就是这个形态：JD 只有 60 字，写了「自备电脑、与老板沟通开发要点」，公司成立两个多月，注册资金 1 万。
const OWNER_PRODUCT_SIGNAL = /与老板(?:直接)?(?:沟通|对接)|(?:直接)?(?:对接|沟通)老板|老板直接(?:沟通|对接|带)|自备电脑|自带电脑|个体工商户|工作室|自然人独资|注册资金\s*(?:[1-9]|[1-4]\d|50)\s*万/i;
const REMOTE_DELIVERY_SIGNAL = /远程(?:交付|合作|项目|兼职|开发)|线上(?:交付|合作|项目|兼职|开发|接单)|在线(?:接单|兼职|外包|开发|项目)|不坐班|不打卡|不要求全天在线/i;
const SETTLEMENT_SIGNAL = /按单(?:结算|计费)|一单一结|按项目(?:结算|付款)|验收(?:通过)?(?:就|后|即)?(?:结|付)|完工结|日结|周结|月结|固定(?:价|报价)|报价|结算/i;
const ORDER_POOL_SIGNAL = /(?:接单|派单|订单|单子多)|(?:长期|在线|线上|远程)(?:兼职|外包)|(?:按|依据)客户需求.{0,20}(?:定价|报价|结算)|按单(?:结算|计费)/i;
const ONSITE_SIGNAL = /线下\s*[+＋和与/]\s*远程|远程\s*[+＋和与/]\s*线下|(?<!无需|不需|免)到岗|必须坐班|驻场|现场办公|到公司(?:上班|办公|坐班)/i;
const NON_DEVELOPMENT_TITLE = /剪辑|文案|运营|测试|产品经理|助理|顾问|推广|设计师|制作师|评测|访谈|讲师|合伙|合作伙伴|漫画|图片生成|安全员|数据采集兼职|佣金|提成|分红|股权/i;
const HARD_REJECTS = [
  { code: 'maintenance_only', label: '维护现有系统或长期迭代', re: /维护\s*(?:现有|已有|原有|老|旧)\s*(?:系统|平台|网站|项目)|(?:现有|已有|自有).{0,20}(?:维护|迭代|[Bb]ug修复)|日常(?:功能)?维护|长期维护|持续迭代|后期维护|版本迭代|二次开发/i },
  { code: 'team_iteration', label: '团队补员或跨部门长期协作', re: /配合\s*(?:团队|他人|研发团队)\s*(?:进行)?\s*(?:开发|迭代)|与(?:开发|研发|产品|设计|测试)团队.{0,12}(?:协作|配合|联调)|参与\s*需求评审|跨部门(?:沟通|协作|协调)|推动(?:设计|研发|测试|产品).{0,20}团队|敏捷迭代/i },
];
const STACK_MISMATCHES = [
  { label:'Java/Spring', re:/\bJava\b|Spring\s*Boot|SpringBoot/i },
  { label:'PHP/ThinkPHP/Laravel', re:/\bPHP\b|ThinkPHP|Laravel/i },
  { label:'Qt/C++/FreeCAD', re:/\bQt\b|C\+\+|FreeCAD/i },
  { label:'Flutter/Dart', re:/Flutter|\bDart\b/i },
  { label:'原生 iOS/Android', re:/\bSwift\b|Objective-?C|Kotlin|iOS\s*(?:原生|开发)|Android\s*(?:原生|开发)/i },
  { label:'量化交易', re:/量化(?:交易|策略|回测)|交易策略脚本/i },
  { label:'uni-app', re:/uni-?app/i },
  { label:'WordPress/Shopify', re:/WordPress|WooCommerce|Shopify/i },
  { label:'Go/MATLAB/PLC/单片机', re:/\bGolang\b|Go\s*语言|MATLAB|PLC|单片机/i },
  { label:'Coze/Dify/ComfyUI/LangGraph', re:/Coze|Dify|ComfyUI|LangGraph/i },
  { label:'安卓系统开发', re:/安卓系统/i },
];
// 本人主栈；一行里同时出现主栈和「任一/或/均可」时，白名单外的栈只是备选，不算错位。
const ACCEPTED_STACK = /Python|Node(?:\.js)?|TypeScript|JavaScript|React|Vue|Next\.js|FastAPI|Fastify|PostgreSQL/i;
const ALTERNATIVE_MARK = /任一|任意(?:一门|一种)?|之一|其中一种|或|均可|皆可|都可以|都行|不限(?:语言|技术栈)|(?:优先|加分)(?!.{0,6}必须)/i;

function sourceText(job, layer = 'jd') {
  const structured = job?.jd?.structured || {};
  const cardEvidence = (job?.preScreen?.reasons || []).flatMap(item => [item.message, item.evidence]);
  const fields = layer === 'jd'
    ? [job.title, job.company, job.salary, structured.title, structured.company, structured.salary,
      structured.description, structured.benefits, structured.companyIntroduction, structured.businessInformation,
      structured.address, structured.experience, structured.education, (structured.tags || []).join(' '),
      structured.recruiter?.title, structured.recruiter?.activeText, job.recruiter?.title, job.recruiter?.activeText]
    : [job.title, job.company, job.salary, job.jd?.remoteHint, job.recruiter?.title, job.recruiter?.activeText, ...cardEvidence];
  return fields.filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
}

function firstMatch(re, text) {
  const match = String(text || '').match(re);
  return match ? match[0].slice(0, 100) : '';
}

function companySize(text) {
  const match = String(text || '').match(/(?:0-20|20-99|50-99|100-499|500-999|1000-9999|10000|\d+\s*(?:-|至)\s*\d+|\d+\s*以上)\s*人/i);
  if (!match) return '';
  const value = Number(match[0].match(/\d+/)?.[0] || 10000);
  return { label: match[0], under100: value < 100 };
}

// 工商信息里的成立日期距今不到 12 个月：刚开公司就来招开发，多半是老板想做自己的第一个产品。
function companyAgeMonths(text, at = new Date()) {
  const match = String(text || '').match(/成立(?:日期|时间)\s*[:：]?\s*(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})?/);
  if (!match) return null;
  const founded = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3] || 1));
  if (Number.isNaN(founded.getTime())) return null;
  return (at.getFullYear() - founded.getFullYear()) * 12 + (at.getMonth() - founded.getMonth());
}

function stackMismatch(job, text) {
  const title = String(job?.title || '');
  const requirementLines = String(text || '').split(/[。；]/).filter(line => /任职|要求|必须|精通|熟练|掌握|技术栈|前端|后端|基于|熟\b|任一|或/.test(line));
  for (const item of STACK_MISMATCHES) {
    const evidence = [title, ...requirementLines].find(line => item.re.test(line));
    if (!evidence) continue;
    // 「Python或Node或Java任一门熟」「Java/Python 均可」：主栈在选项里，不算错位。
    if (ACCEPTED_STACK.test(evidence) && ALTERNATIVE_MARK.test(evidence)) continue;
    return { label:item.label, evidence:evidence.slice(0, 100) };
  }
  return null;
}

function informationCompleteness(job) {
  const structured = job?.jd?.structured || {};
  const fields = [structured.description, structured.companyIntroduction || structured.businessInformation,
    structured.salary || job.salary, structured.experience, structured.education, structured.recruiter?.name || job.recruiter?.name];
  return { score:fields.filter(value => String(value || '').trim()).length, fields:fields.map((value, index) => value ? ['JD正文', '公司信息', '薪资', '经验', '学历', '招聘者'][index] : '').filter(Boolean) };
}

function scoreProjectJob(job, { layer = job?.jd?.status === 'read' && job?.jd?.structured?.description ? 'jd' : 'card', at = new Date() } = {}) {
  const text = sourceText(job, layer);
  const hardRejects = HARD_REJECTS.filter(item => item.re.test(text)).map(item => ({ code: item.code, label: item.label, evidence: firstMatch(item.re, text) }));
  const size = companySize(`${text}\n${job?.jd?.text || ''}`);
  const ageMonths = companyAgeMonths(text, at);
  const customEvidence = firstMatch(CUSTOM_DELIVERABLE, text);
  const cooperationEvidence = firstMatch(DIRECT_COOP_SIGNAL, text);
  const cooperationInterestEvidence = firstMatch(COOPERATION_INTEREST_SIGNAL, text);
  const ownerSignalEvidence = firstMatch(OWNER_PRODUCT_SIGNAL, text) || (ageMonths !== null && ageMonths < 12 ? `公司成立 ${ageMonths} 个月` : '');
  const remote = assessRemote(job?.title || '', text);
  const remoteDeliveryEvidence = firstMatch(REMOTE_DELIVERY_SIGNAL, text);
  const onsiteEvidence = firstMatch(ONSITE_SIGNAL, text);
  const settlementEvidence = firstMatch(SETTLEMENT_SIGNAL, text);
  const customDelivery = !!customEvidence;
  const directCooperation = !!cooperationEvidence;
  const cooperationInterest = !!cooperationInterestEvidence;
  const ownerProduct = customDelivery && !!ownerSignalEvidence;
  const remoteBlocked = !!onsiteEvidence || remote.status === 'fail';
  const remoteConfirmed = !remoteBlocked && (remote.status === 'pass' || (remote.status !== 'fail' && !!remoteDeliveryEvidence));
  const smallTeam = !!size?.under100 || ownerProduct || /小团队|初创团队|创业团队|团队规模.{0,10}(?:[1-9]|[1-9]\d)\s*人/i.test(text);
  const cooperationBasis = directCooperation || cooperationInterest || ownerProduct;
  if (layer !== 'jd') hardRejects.push({ code:'complete_jd_required', label:'必须读取完整 JD 后判断项目客户', evidence:'' });
  if (NON_DEVELOPMENT_TITLE.test(String(job?.title || ''))) hardRejects.push({ code:'non_development_role', label:'不是网站/软件/小程序开发交付岗位', evidence:job.title || '' });
  if (!customDelivery) hardRejects.push({ code:'missing_custom_deliverable', label:'没有明确的网站/软件/小程序等定制交付物', evidence:'' });
  if (!cooperationBasis) hardRejects.push({ code:'missing_direct_project_cooperation', label:'没有按项目合作、合作意向或老板自建产品的信号', evidence:'' });
  if (remoteBlocked) hardRejects.push({ code:'onsite_required', label:'明确要求线下/到岗/坐班/驻场', evidence:onsiteEvidence || remote.evidence || '' });
  if (size && Number(size.label.match(/\d+/)?.[0] || 0) >= 500) hardRejects.push({ code:'company_500_plus', label:'公司规模 500 人及以上', evidence:size.label });
  const experience = firstMatch(/(?:3|4|5|6|7|8|9|1\d)\s*年(?:以上|及以上)|资深/i, text);
  if (experience && !(smallTeam && customDelivery && cooperationBasis)) hardRejects.push({ code:'senior_without_small_team_project', label:'资深/3年以上且不是小团队定制项目', evidence:experience });
  const mismatch = stackMismatch(job, text);
  const orderPool = customDelivery && cooperationBasis && !remoteBlocked && ORDER_POOL_SIGNAL.test(text);
  if (mismatch && !orderPool && !cooperationInterest) hardRejects.push({ code:'core_stack_mismatch', label:`核心技术栈不符：${mismatch.label}`, evidence:mismatch.evidence });
  const existingReject = targetRejectReason(job);
  if (existingReject) hardRejects.push({ code: 'existing_target_rule', label: existingReject, evidence: job.title || existingReject });
  const completeness = informationCompleteness(job);
  // 开场白必须补问的空白：远程没写就问远程/线上协作；结算没写就带一句按项目/按模块报价验收。
  const askInOpener = [
    !remoteConfirmed && 'remote',
    !settlementEvidence && !directCooperation && 'settlement',
  ].filter(Boolean);
  const projectSignals = [
    customDelivery && { code:'custom_deliverable', label:'明确的定制软件交付物', evidence:customEvidence },
    directCooperation && { code:'direct_project_cooperation', label:'明确按项目找个人或团队交付', evidence:cooperationEvidence },
    cooperationInterest && !directCooperation && { code:'cooperation_interest', label:'明确合作意向/兼职合作', evidence:cooperationInterestEvidence },
    ownerProduct && { code:'owner_product', label:'老板自建产品：新公司/小资金/自备电脑/直接对接老板', evidence:ownerSignalEvidence },
    remoteConfirmed && { code:'remote_delivery', label:'明确远程/线上交付', evidence:remote.evidence || remoteDeliveryEvidence },
    !remoteConfirmed && !remoteBlocked && { code:'remote_unconfirmed_ask', label:'远程未写明但无到岗要求：review 记 negotiable，开场白问一句远程/线上协作' },
    !settlementEvidence && !directCooperation && { code:'settlement_unconfirmed_ask', label:'结算方式未写明：开场白带一句按项目/按模块报价验收' },
    mismatch && (orderPool || cooperationInterest) && { code:'order_pool_stack_mismatch', label:`接单池/合作意向，核心栈错位不淘汰：${mismatch.label}`, evidence:mismatch.evidence },
    experience && smallTeam && customDelivery && cooperationBasis && { code:'small_team_seniority_relaxed', label:'小团队定制项目，忽略资深/年限描述' },
  ].filter(Boolean);
  return {
    version: VERSION,
    layer,
    status:hardRejects.length ? 'hard_reject' : 'eligible',
    score:hardRejects.length ? 0 : completeness.score,
    hardRejects,
    signals:[...projectSignals, ...completeness.fields.map(label => ({ code:'complete_field', label }))],
    remoteSuggestion: remoteBlocked ? 'fail' : remoteConfirmed ? 'pass' : 'negotiable',
    askInOpener,
    companySize: size?.label || '',
    companyAgeMonths: ageMonths,
    recruiterTitle:String(job?.recruiter?.title || job?.jd?.structured?.recruiter?.title || ''),
    scoredAt: now(),
  };
}

function projectStyle(job) {
  return scoreProjectJob(job).status === 'eligible';
}

module.exports = { VERSION, HARD_REJECTS, sourceText, scoreProjectJob, projectStyle, informationCompleteness, companyAgeMonths, stackMismatch };
