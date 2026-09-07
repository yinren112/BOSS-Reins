const PROFILES = require(require('./reins-config').loadConfig().profilesFile);

const now = () => new Date().toISOString();
const CURRENT_CYCLE_START = require('./reins-config').loadConfig().cycleStart;
const REMOTE_POSITIVE = /全程远程|纯远程|全职远程|远程办公|居家办公|居家工作|在家办公|无需坐班|无需到岗|不坐班|线上办公|线上协作|远程协作|接受远程|支持远程|可远程|可居家|远程工作|远程兼职|远程项目|工作地点不限|工作时间地点不限|不在同一个城市/;
const REMOTE_NEGATIVE = /不支持远程|不接受远程(?!办公的?请勿)|不能远程|无法远程|非居家办公|必须到岗|(?<![免不]|无需?|不用)需(?:要)?到岗|(?<![免不]|无需?|不用)现场办公|驻场办公|(?<![免不]|无需?|不用)线下坐班|必须坐班|仅限本地到岗/;
const REMOTE_TITLE = /远程|居家|线上办公|线上协作/;
const REMOTE_AMBIGUOUS = /远程面试|线上面试|偶尔远程|优秀者可远程|可协商远程|远程可协商|视情况远程|部分远程|混合办公/;
const REMOTE_STANDALONE = /(?:^|[\s｜|【（(])远程(?:$|[\s｜|】）),，])/;
const TARGET_TITLE_REDLINE = /保险|贷款|培训收费|课程顾问|招生|销售|夜班|实习/;
const INTERNSHIP_ROLE_REDLINE = /实习岗位|实习生|实习岗/;
const FDE_ROLE_REDLINE = /\bFDE\b|Forward\s*Deployed|前线交付(?:工程师)?/i;
const DATA_ROLE_REDLINE = /(?:AI|大模型|模型|语音|图像|视频|文本)?标注(?:员|师)?|(?:AI|大模型|模型)训练师|训练数据|(?:AI|模型|语音|图像|视频|文本)数据采集/i;
const DATA_DEVELOPMENT_TITLE = /开发|研发|程序|软件|架构|前端|后端|全栈|爬虫|Flutter|iOS|Android|小程序|插件|工具链/i;
const INVALID_JOB_TITLE = /^(?:举报|职位已关闭|职位已下线|招聘已结束)$/;

function blankJob(id, url = '') {
  return {
    jobId:id, url:url || `https://www.zhipin.com/job_detail/${id}.html`, title:'', company:'', salary:'', sources:[],
    discovery:{ firstSeenAt:'', lastSeenAt:'', query:'', page:0 },
    preScreen:{ status:'unknown', profile:'', score:0, activityRank:0, reasons:[], checkedAt:'' },
    decisions:[], jd:{ status:'unknown', evidencePath:'', remoteHint:'', hash:'', structured:null },
    review:{ remote:{ status:'pending', evidence:'' }, pay:{ status:'pending', evidence:'' }, risk:{ status:'pending', evidence:'' } },
    opener:{ status:'none', message:'', profile:'', style:'', jdHash:'', generatedAt:'', generator:'' },
    outreach:{ status:'not_sent', message:'', evidencePath:'', verify:null },
    reply:{ status:'unknown', lastMessage:'', checkedAt:'' }, nextAction:'',
  };
}

function normalizeJob(job) {
  const base = blankJob(job.jobId, job.url);
  return {
    ...base, ...job,
    discovery:{ ...base.discovery, ...(job.discovery || {}) },
    preScreen:{ ...base.preScreen, ...(job.preScreen || {}) },
    decisions:Array.isArray(job.decisions) ? job.decisions : [],
    jd:{ ...base.jd, ...(job.jd || {}) },
    review:{
      remote:{ ...base.review.remote, ...(job.review?.remote || {}) },
      pay:{ ...base.review.pay, ...(job.review?.pay || {}) },
      risk:{ ...base.review.risk, ...(job.review?.risk || {}) },
    },
    opener:{ ...base.opener, ...(job.opener || {}) },
    outreach:{ ...base.outreach, ...(job.outreach || {}) },
    reply:{ ...base.reply, ...(job.reply || {}) },
  };
}

function addDecision(job, stage, status, code, message, evidence = '') {
  const decision = { stage, status, code, message, evidence, at:now() };
  job.decisions = (job.decisions || []).filter(item => !(item.stage === stage && item.code === code));
  job.decisions.push(decision);
  return decision;
}

function activityRank(text) {
  const value = String(text || '');
  if (/在线|刚刚活跃/.test(value)) return 100;
  if (/今日活跃|今天活跃/.test(value)) return 90;
  if (/三日内活跃|\d+天内活跃/.test(value)) return 80;
  if (/本周活跃/.test(value)) return 70;
  if (/本月活跃/.test(value)) return 50;
  if (/\d+[周月]内活跃/.test(value)) return 30;
  return 0;
}

const includesKeyword = (text, keyword) => String(text || '').toLocaleLowerCase().includes(String(keyword).toLocaleLowerCase());

function matchProfile(title, description = '', requested = '') {
  if (requested) {
    if (!PROFILES[requested]) throw new Error(`未知岗位方向 ${requested}；可用：${Object.keys(PROFILES).join('/')}`);
    const profile = PROFILES[requested];
    return [...profile.titleKeywords, ...profile.jdKeywords].some(word => includesKeyword(`${title}\n${description}`, word)) ? requested : '';
  }
  const scores = Object.entries(PROFILES).map(([id, profile]) => ({
    id,
    score:profile.titleKeywords.filter(word => includesKeyword(title, word)).length * 3 + profile.jdKeywords.filter(word => includesKeyword(description, word)).length,
  })).sort((a, b) => b.score - a.score);
  return scores[0]?.score > 0 ? scores[0].id : '';
}

function parseSearchCard(card = {}) {
  const text = String(card.text || '').replace(/\r/g, '').trim();
  const lines = text.split('\n').map(value => value.trim()).filter(Boolean);
  const salary = text.match(/(?:\d+(?:\.\d+)?-\d+(?:\.\d+)?K(?:·\d+薪)?|\d+(?:\.\d+)?-\d+(?:\.\d+)?元\/(?:时|天|月))/i)?.[0] || '';
  const linkTitle = /查看更多|查看详情|立即沟通/.test(card.title || '') ? '' : card.title;
  const title = String(linkTitle || lines.find(value => value !== salary && !/^[·•]$/.test(value) && !/查看更多|查看详情|立即沟通/.test(value)) || '').replace(salary, '').trim();
  return { title, salary, text };
}

const isCurrentFavorite = job => (job.sources || []).includes('favorite:current');
function discoverySourceRank(job) {
  const sources = job.sources || [];
  if (sources.includes('favorite:current')) return 300;
  if (sources.some(source => source.startsWith('interaction:'))) return 250;
  if (sources.some(source => source.startsWith('company:'))) return 200;
  if (sources.some(source => source.startsWith('recommendation:'))) return 150;
  if (sources.some(source => source.startsWith('related:'))) return 120;
  if (sources.some(source => source.startsWith('search:'))) return 100;
  return 0;
}
const isCurrentCycleJob = job => isCurrentFavorite(job) ||
  (job.sources || []).some(source => source.startsWith('interaction:')) ||
  [job.discovery?.lastSeenAt, job.jd?.checkedAt].some(value => value && Date.parse(value) >= CURRENT_CYCLE_START);

const jobDescription = job => String(job?.jd?.structured?.description || job?.jd?.description || job?.jd?.text || '');
function targetRejectReason(job) {
  const title = String(job?.title || '').trim();
  if (INVALID_JOB_TITLE.test(title)) return `无效岗位标题：${title}`;
  const titleHit = title.match(TARGET_TITLE_REDLINE);
  if (titleHit) return `岗位标题命中当前硬排除：${titleHit[0]}`;
  const roleText = `${title}\n${jobDescription(job)}`;
  const fdeHit = roleText.match(FDE_ROLE_REDLINE);
  if (fdeHit) return `当前不承接 FDE/现场交付岗位：${fdeHit[0]}`;
  const internshipHit = roleText.match(INTERNSHIP_ROLE_REDLINE);
  if (internshipHit) return `当前不搜索实习岗位：${internshipHit[0]}`;
  const roleHit = roleText.match(DATA_ROLE_REDLINE);
  // ponytail: 只在明确是人工标注/采集/训练岗位时拦截；开发“数据采集 App/工具”的岗位继续进入项目筛选。
  if (roleHit && !DATA_DEVELOPMENT_TITLE.test(title)) return `当前不搜索标注/训练数据岗位：${roleHit[0]}`;
  return '';
}
function explicitWorkflowStopReason(job) {
  const text = String(job?.nextAction || '').trim();
  return /^(?:不发送|不要发送|停止发送|跳过发送)|不进入发送队列|禁止发送/.test(text) ? text : '';
}
function expiryReason(job, at = new Date()) {
  if (job?.jd?.status === 'expired') return '岗位详情已失效';
  const match = `${jobDescription(job)}\n${job?.nextAction || ''}`.match(/招聘截止时间\s*[：:]?\s*(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if (!match) return '';
  const deadlineEnd = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
  return at >= deadlineEnd ? `招聘已于 ${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')} 截止` : '';
}
const queueRejectReason = job => expiryReason(job) || targetRejectReason(job) || explicitWorkflowStopReason(job);
const candidateRemoteRejectReason = () => '';

function assessRemote(title = '', description = '') {
  const bodyLines = String(description || '').split(/\r?\n|(?<=[。；])/).map(value => value.trim()).filter(Boolean);
  const negative = bodyLines.find(value => REMOTE_NEGATIVE.test(value));
  if (negative) return { status:'fail', evidence:negative, source:'body' };
  const positive = bodyLines.find(value => (REMOTE_POSITIVE.test(value) || REMOTE_STANDALONE.test(value)) && !REMOTE_AMBIGUOUS.test(value));
  if (positive) return { status:'pass', evidence:positive, source:'body' };
  const ambiguous = bodyLines.find(value => REMOTE_AMBIGUOUS.test(value));
  if (ambiguous) return { status:'pending', evidence:ambiguous, source:'ambiguous' };
  if (REMOTE_TITLE.test(String(title || '').replace(REMOTE_AMBIGUOUS, ''))) return { status:'pass', evidence:String(title).trim(), source:'title' };
  return { status:'pending', evidence:'', source:'' };
}

function conversationKey(item) {
  if (item.encryptBossId) return `boss:${item.encryptBossId}`;
  if (item.friendId) return `friend:${item.friendId}`;
  return `name:${item.company || ''}@@${item.name || ''}`;
}

function priorContactReason(ledger, job, recruiter = job.recruiter || {}) {
  if (recruiter.isFriend) return 'BOSS 标记该招聘者已沟通';
  const conversations = ledger.conversations || [];
  if (conversations.some(item => item.encryptJobId && item.encryptJobId === job.jobId)) return '该岗位已存在会话';
  if (recruiter.encryptBossId && conversations.some(item => item.encryptBossId === recruiter.encryptBossId)) return '该招聘者已存在会话';
  if (recruiter.encryptBossId && ledger.jobs.some(other => other.jobId !== job.jobId && other.recruiter?.encryptBossId === recruiter.encryptBossId && other.outreach?.status !== 'not_sent')) return '该招聘者已通过其他岗位沟通过';
  if (recruiter.name && recruiter.company && conversations.some(item => item.name === recruiter.name && item.company === recruiter.company)) return '同公司同名招聘者已存在会话';
  return '';
}

function recruiterFromButton(button = {}, name = '', company = '') {
  let encryptBossId = '';
  try { encryptBossId = new URL(button.redirectUrl || '', 'https://www.zhipin.com').searchParams.get('id') || ''; } catch {}
  return { encryptBossId, name, company, isFriend:button.isFriend === true || button.isFriend === 'true' };
}

function ensureJob(ledger, id, url = '') {
  let job = ledger.jobs.find(item => item.jobId === id);
  if (!job) {
    job = blankJob(id, url);
    ledger.jobs.push(job);
  } else {
    Object.assign(job, normalizeJob(job));
  }
  if (url) job.url = url;
  return job;
}

function preScreenJob(ledger, job, card = {}, requestedProfile = '') {
  const parsed = parseSearchCard(card);
  if (!job.title && parsed.title) job.title = parsed.title;
  if (!job.salary && parsed.salary) job.salary = parsed.salary;
  const profile = matchProfile(job.title, parsed.text, requestedProfile);
  const reasons = [];
  let status = 'review';
  let score = 0;
  const contacted = priorContactReason(ledger, job);
  const directionRedline = targetRejectReason({ ...job, jd:{ structured:{ description:parsed.text } } });
  const obviousRedline = String(job.title || '').match(/保险|贷款|销售|主播|客服|夜班|课程顾问|招生/i);
  if (!job.title || /查看更多|查看详情|立即沟通/.test(job.title)) reasons.push({ code:'missing_list_title', message:'列表链接缺少可用标题，放到队尾人工确认', evidence:parsed.text.slice(0, 100) });
  else if (contacted) { status='reject'; reasons.push({ code:'prior_contact', message:contacted, evidence:contacted }); }
  else if (directionRedline) { status='reject'; reasons.push({ code:'direction_redline', message:directionRedline, evidence:job.title }); }
  else if (obviousRedline) { status='reject'; reasons.push({ code:'title_redline', message:'岗位标题命中明确红线', evidence:obviousRedline[0] }); }
  else if (!profile) { score += 10; reasons.push({ code:'adjacent_direction', message:'未命中既有模板，但保留为可谈的相邻交付方向', evidence:job.title }); }
  else {
    score += 30;
    reasons.push({ code:'direction_match', message:`命中${PROFILES[profile].label}`, evidence:job.title });
    const remote = assessRemote(job.title, parsed.text);
    if (remote.status === 'pass') { score += 30; status='priority'; reasons.push({ code:'remote_hint', message:'列表出现真实远程信号，仍需完整 JD 核实', evidence:remote.evidence }); }
    else if (remote.status === 'fail') reasons.push({ code:'remote_negotiable', message:'列表写明到岗，保留候选并沟通能否改为远程或阶段性到场', evidence:remote.evidence });
    else reasons.push({ code:'remote_negotiable', message:remote.evidence ? '已有可协商远程信号，完整 JD 后继续沟通' : '列表未写远程，不淘汰，完整 JD 后询问能否远程', evidence:remote.evidence });
    if (job.salary) score += 10;
    if (/猎头/.test(String(job.title || ''))) reasons.push({ code:'agency_needs_client', message:'标题提示猎头，需读完整 JD 确认真实用工方是否明确', evidence:'猎头' });
  }
  if (isCurrentFavorite(job) && status !== 'reject') { score += 40; status='priority'; reasons.push({ code:'favorite_interest', message:'用户当前收藏，视为明确兴趣信号并优先读取', evidence:job.title }); }
  const rank = activityRank(card.activityText || job.jd?.structured?.recruiter?.activeText);
  job.preScreen = { status, profile, score, activityRank:rank, reasons, checkedAt:now() };
  addDecision(job, 'pre_screen', status === 'reject' ? 'reject' : 'pass', reasons[0]?.code || 'review', reasons.map(item => item.message).join('；'), reasons.map(item => item.evidence).filter(Boolean).join('；'));
  return job.preScreen;
}

module.exports = {
  PROFILES, blankJob, normalizeJob, addDecision, activityRank, matchProfile, parseSearchCard,
  isCurrentFavorite, discoverySourceRank, isCurrentCycleJob, preScreenJob, recruiterFromButton, conversationKey,
  priorContactReason, ensureJob, jobDescription, targetRejectReason, explicitWorkflowStopReason,
  expiryReason, queueRejectReason, candidateRemoteRejectReason, assessRemote,
};
