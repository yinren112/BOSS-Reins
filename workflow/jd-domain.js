const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  activityRank, assessRemote, jobDescription, normalizeJob, queueRejectReason,
} = require('./job-domain');

const ROOT = path.resolve(__dirname, '..');

function parseJobBody(body) {
  const lines = String(body || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const recruiting = lines.indexOf('招聘中');
  const titleSalary = recruiting >= 0 ? lines[recruiting + 1] || '' : '';
  const companyAt = lines.indexOf('公司基本信息');
  const company = companyAt >= 0 ? lines[companyAt + 1] || '' : '';
  const salary = titleSalary.match(/(?:\d+(?:\.\d+)?-\d+(?:\.\d+)?K(?:·\d+薪)?|\d+-\d+元\/(?:时|天|月))/i)?.[0] || '';
  const title = salary ? titleSalary.slice(0, titleSalary.indexOf(salary)).trim() : titleSalary;
  return { title, company, salary, remoteEvidence:assessRemote(title, body).evidence };
}

function normalizeBenefits(benefits) {
  return String(benefits || '').split(/[、,，\s]+/).map(value => value.trim()).filter(Boolean).sort().join('、');
}

function jdHashOf(structured) {
  const hashSource = JSON.stringify({
    title:structured.title || '', company:structured.company || '', description:structured.description || '',
    benefits:normalizeBenefits(structured.benefits), address:structured.address || '',
    experience:structured.experience || '', education:structured.education || '',
  });
  return crypto.createHash('sha256').update(hashSource).digest('hex');
}

function normalizeStructuredPage(page) {
  const structured = page.structured || {};
  const fallback = parseJobBody(page.bodyText || '');
  structured.title ||= fallback.title;
  structured.company ||= fallback.company;
  structured.salary ||= fallback.salary;
  structured.description ||= '';
  structured.tags = Array.isArray(structured.tags) ? structured.tags : [];
  structured.recruiter = structured.recruiter || { name:'', title:'', activeText:'' };
  structured.recruiter.activityRank = activityRank(structured.recruiter.activeText);
  const remoteEvidence = assessRemote(structured.title, structured.description).evidence;
  return { structured, remoteEvidence, hash:jdHashOf(structured) };
}

function assertReadableDescription(description) {
  if (!String(description || '').trim()) throw new Error('JD 正文为空，已停止');
}

function unreadableJobMessage(page) {
  const body = String(page?.bodyText || '');
  return /登录查看完整内容|登录后查看完整职位描述|请登录/.test(body)
    ? '登录态失效或职位正文受登录限制，已停止'
    : 'JD 正文在等待窗口内未渲染，已停止';
}

function loadStoredJdBody(job) {
  if (job.jd?.text) return String(job.jd.text);
  const candidates = [job.jd?.evidencePath, path.join('archive', '2026-07-17_legacy', 'scratch', `jd_${job.jobId}.json`)].filter(Boolean);
  for (const candidate of candidates) {
    const full = path.resolve(ROOT, candidate);
    if (full === ROOT || !full.startsWith(ROOT + path.sep) || !fs.existsSync(full)) continue;
    try {
      const saved = JSON.parse(fs.readFileSync(full, 'utf8'));
      const body = saved.body || saved.bodyText || saved.text || saved.structured?.description;
      if (String(body || '').trim()) return String(body);
    } catch {}
  }
  return '';
}

function hydrateLegacyStructured(job) {
  if (job.jd?.structured?.description) return normalizeJob(job);
  const normalized = normalizeJob(job);
  const body = loadStoredJdBody(normalized);
  if (!body) return normalized;
  const start = body.indexOf('职位描述');
  const companyAt = body.indexOf('\n公司介绍', start + 4);
  const competitionAt = body.indexOf('\n竞争力分析', start + 4);
  const end = companyAt > start ? companyAt : competitionAt > start ? competitionAt : body.length;
  let description = start >= 0 ? body.slice(start + 4, end).trim() : body;
  if (competitionAt > start && companyAt < 0) description = description.replace(/\n[^\n]+\n(?:在线|刚刚活跃|今天活跃|三日内活跃|本周活跃|本月活跃)\n[^\n]+\n·\n[^\n]+$/s, '').trim();
  const primary = body.slice(0, Math.max(0, start));
  const companyIntroEnd = body.indexOf('\n工商信息', companyAt + 1);
  const addressAt = body.indexOf('\n工作地址', Math.max(companyAt, 0) + 1);
  const structured = {
    title:normalized.title, company:normalized.company, salary:normalized.salary, description, benefits:'',
    companyIntroduction:companyAt >= 0 ? body.slice(companyAt + 5, companyIntroEnd > companyAt ? companyIntroEnd : body.length).trim() : '',
    businessInformation:'', address:addressAt >= 0 ? body.slice(addressAt + 5).split('\n').filter(Boolean)[0] || '' : '',
    experience:(primary.match(/经验不限|应届生|\d+-\d+年|\d+年以上/) || [])[0] || '',
    education:(primary.match(/学历不限|初中|中专|高中|大专|本科|硕士|博士/) || [])[0] || '', tags:[],
    recruiter:{ name:normalized.recruiter?.name || '', title:normalized.recruiter?.title || '', activeText:normalized.recruiter?.activeText || '', activityRank:normalized.recruiter?.activityRank || 0 },
    incomplete:/登录查看完整内容/.test(description),
  };
  const parsed = normalizeStructuredPage({ structured, bodyText:body });
  normalized.jd = { ...normalized.jd, structured:parsed.structured, hash:parsed.hash, remoteHint:parsed.remoteEvidence };
  return normalized;
}

// pay 证据里如果出现薪资区间，必须能和岗位列表薪资对上；对不上时要求证据自己说明出处
// （常见情形：列表只显示绩效或时薪，真实待遇写在 JD 正文里）。
const PAY_SOURCE_MARKER = /JD|正文|原句|描述|底薪|试用|转正|绩效|年终|按单|日结|周结|完工|结算|折算|计价|每次|项目制|计件|工时|面议|另计|不含/;
function payRanges(text) {
  const out = [];
  // 门槛表述（「月>=8k」这类）是标准，不是这个岗位的报价，先剔除再对账
  const raw = String(text || '').replace(/(?:>=|≥|大于等于|大于|不低于|至少)\s*[0-9]+(?:\.[0-9]+)?\s*(?:[Kk千]|元\s*\/?\s*(?:月|天|小时|时))?/g, ' ');
  for (const m of raw.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*[-~至]\s*([0-9]+(?:\.[0-9]+)?)\s*([Kk千]|元?\s*\/?\s*(?:月|天|小时|时))?/g)) {
    const scale = /[Kk千]/.test(m[3] || '') ? 1000 : 1;
    out.push([Number(m[1]) * scale, Number(m[2]) * scale]);
  }
  // 带单位的单点报价（如「32元/时」「1500元/月」）也是有效对账依据，否则会把说清楚的证据误判成冲突
  for (const m of raw.matchAll(/(?<![0-9.\-~至])([0-9]+(?:\.[0-9]+)?)\s*([Kk千]|元\s*\/?\s*(?:月|天|小时|时))(?![-~至]\s*[0-9])/g)) {
    const scale = /[Kk千]/.test(m[2] || '') ? 1000 : 1;
    const value = Number(m[1]) * scale;
    out.push([value, value]);
  }
  return out;
}
const rangesOverlap = (a, b) => a[0] <= b[1] && b[0] <= a[1];

function reviewIntegrityIssues(job) {
  const issues = [];
  const description = jobDescription(job);
  const remote = job.review?.remote || {};
  const pay = job.review?.pay || {};
  const risk = job.review?.risk || {};
  const actualRemote = assessRemote(job.title, description);
  const genericEvidence = /用户明确|用户要求|收藏岗位|本轮不以远程证据|正常尝试沟通|撰写定制开场白|按收藏.*条件/;
  if (['pass', 'negotiable'].includes(remote.status) && !String(remote.evidence || '').trim()) issues.push({ field:'remote', code:'missing_remote_evidence', message:'remote 审核缺少岗位原句或协商依据', evidence:'' });
  if (pay.status === 'pass' && !String(pay.evidence || '').trim()) issues.push({ field:'pay', code:'missing_pay_evidence', message:'pay=pass 但没有薪资、工时或结算证据', evidence:'' });
  if (risk.status === 'pass' && !String(risk.evidence || '').trim()) issues.push({ field:'risk', code:'missing_risk_evidence', message:'risk=pass 但没有真实用工方、职责和红线核对证据', evidence:'' });
  if (remote.status === 'pass' && actualRemote.status !== 'pass') issues.push({ field:'remote', code:'remote_pass_without_jd_proof', message:actualRemote.status === 'fail' ? 'remote=pass 但 JD 明确否定居家/远程，应改为 fail' : 'remote=pass 但标题/JD 没有明确远程证据，应改为 negotiable 或重新审核', evidence:actualRemote.evidence || remote.evidence || '' });
  if (['pass', 'negotiable'].includes(remote.status) && genericEvidence.test(String(remote.evidence || ''))) issues.push({ field:'remote', code:'generic_remote_evidence', message:'remote 证据描述的是用户意愿，不是岗位办公方式事实', evidence:remote.evidence || '' });
  if (pay.status === 'pass' && genericEvidence.test(String(pay.evidence || ''))) issues.push({ field:'pay', code:'generic_pay_evidence', message:'pay 证据没有说明薪资、工时或结算条件', evidence:pay.evidence || '' });
  if (pay.status === 'pass') {
    const listed = payRanges(job.salary);
    const claimed = payRanges(pay.evidence);
    if (listed.length && claimed.length &&
        !claimed.some(c => listed.some(x => rangesOverlap(c, x))) &&
        !PAY_SOURCE_MARKER.test(String(pay.evidence || ''))) {
      issues.push({ field:'pay', code:'pay_evidence_conflicts_salary', message:`pay 证据的薪资和岗位列表薪资 ${job.salary} 对不上，且没有说明出处`, evidence:pay.evidence || '' });
    }
  }
  if (risk.status === 'pass' && genericEvidence.test(String(risk.evidence || ''))) issues.push({ field:'risk', code:'generic_risk_evidence', message:'risk 证据没有核对真实用工方、职责和硬红线', evidence:risk.evidence || '' });
  if (risk.status === 'pass' && /运营|客服|老师|助理/.test(job.title || '') && /(?:正价会员转化|转化提成|认可销售行业|电话销售|续费经验|完成成交|转化流量.{0,30}达成业绩|引流.{0,35}达成业绩)/.test(description)) issues.push({ field:'risk', code:'sales_disguised_as_adjacent_role', message:'岗位标题是相邻岗位，但 JD 明确承担销售转化职责', evidence:(description.match(/.{0,35}(?:正价会员转化|转化提成|认可销售行业|电话销售|续费经验|完成成交|转化流量.{0,30}达成业绩|引流.{0,35}达成业绩).{0,50}/) || [])[0] || '' });
  if (risk.status === 'pass' && /(?:每天|每日).{0,25}(?:22:00|22点)|(?:9:00|9点).{0,20}(?:22:00|22点)/.test(description)) issues.push({ field:'risk', code:'extended_daily_availability', message:'JD 要求每天持续到 22 点保持响应，需重新判断工时与夜间红线', evidence:(description.match(/.{0,40}(?:22:00|22点).{0,60}/) || [])[0] || '' });
  if (risk.status === 'pass' && !/主播|直播/.test(job.title || '') && /娱乐主播|语音主播|语音厅主播|语音直播|直播间|直播公会/.test(description)) issues.push({ field:'risk', code:'livestream_role_hidden_by_title', message:'岗位标题没有说明主播/直播，但 JD 的真实职责是直播岗位，需按真实岗位重新审核', evidence:(description.match(/.{0,45}(?:娱乐主播|语音主播|语音厅主播|语音直播|直播间|直播公会).{0,70}/) || [])[0] || '' });
  return issues;
}

const reviewsReady = job => ['pass', 'negotiable'].includes(job.review?.remote?.status) && ['pay', 'risk'].every(field => job.review?.[field]?.status === 'pass') && reviewIntegrityIssues(job).length === 0;
const openerCurrent = job => job?.opener?.status === 'generated' && !!String(job.opener?.message || '').trim() && job.opener?.jdHash === job.jd?.hash;
const readyRejectReason = job => queueRejectReason(job);

module.exports = {
  parseJobBody, normalizeBenefits, jdHashOf, normalizeStructuredPage, assertReadableDescription,
  unreadableJobMessage, loadStoredJdBody, hydrateLegacyStructured, reviewIntegrityIssues,
  reviewsReady, openerCurrent, readyRejectReason,
};
