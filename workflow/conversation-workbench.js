const path = require('path');
const { RESUME_MAPPING, loadDailyOptions } = require('./daily-options');
const { conversationRoleMismatch, resumeTrigger } = require('./conversation-domain');
const { jobDescription, matchProfile } = require('./job-domain');

const FACTS_FILE = require('./reins-config').loadConfig().factsFile;

function resumeForJob(job) {
  const title = job?.title || '';
  const profile = job?.preScreen?.profile || matchProfile(title, job?.jd?.structured?.description || '');
  if (/产品|运营|测试|评测|支持|策划|编导|内容|视频生成师|训练师|文档/.test(title)) return RESUME_MAPPING.adjacent;
  if (profile === 'ai-agent') return RESUME_MAPPING.aiAgent;
  if (['frontend', 'backend', 'fullstack', 'miniprogram'].includes(profile) || /开发|前端|后端|全栈|小程序|程序员|工程师/.test(title)) return RESUME_MAPPING.development;
  return RESUME_MAPPING.adjacent;
}

function conversationCommand(row) {
  const ids = [row.encryptJobId ? `--job-id=${row.encryptJobId}` : '', row.encryptBossId ? `--boss-id=${row.encryptBossId}` : ''].filter(Boolean).join(' ');
  return `node workflow/boss.js conversation-open ${ids}`.trim();
}

function conversationReplyGuidance(row, mismatch, daily) {
  const message = String(row.lastMessage || '');
  if (mismatch) return { type:'clarify-role', requiresUserInput:false, guidance:'先确认实际招聘岗位、职责和工作方式，再决定回复内容与简历版本；不要按聊天标题直接发 Java 简历。' };
  if (/期望薪资|薪资多少|薪资要求|薪酬期望/.test(message)) return { type:'salary', requiresUserInput:true, guidance:'需要用户给出期望区间或谈薪口径；同时结合岗位地点确认全远程、远程优先或关键节点到场，不能替用户编造数字。' };
  if (/效率多少|准确率|降低.{0,8}工时|提升.{0,8}(?:效率|产出)|量化|指标|数据/.test(message)) return { type:'metrics', requiresUserInput:false, guidance:'事实源没有已验证的生产量化指标时，明确说明未做统一口径测量；分开讲已落地能力、可验证证据和入职后如何建立基线/准确率/人工工时评估，禁止编数字。' };
  if (/(?:最近|现在|目前)?还(?:在)?考虑不|还在看(?:机会|工作)/.test(message)) return { type:'availability', requiresUserInput:false, guidance:'简短确认仍在考虑，并围绕当前职位询问职责与远程安排；不要把对方较早的群发介绍当成已确认条件。' };
  if (resumeTrigger(message) === 'explicit') return { type:'resume-request', requiresUserInput:daily.needsChoice, guidance:'先按职位选择三份简历之一并干运行核对附件；当天自动简历策略未选时，不真实发送。' };
  return { type:'general', requiresUserInput:false, guidance:'根据当前问题、真实 JD 和事实源定制短回复；若事实源没有答案，明确边界并提出可验证方式。' };
}

function conversationWorkbenchPayload(ledger, row, { full = false } = {}) {
  const daily = loadDailyOptions();
  const job = ledger.jobs.find(item => item.jobId === row.encryptJobId);
  const trigger = resumeTrigger(row.lastMessage);
  const ids = [row.encryptJobId ? `--job-id=${row.encryptJobId}` : '', row.encryptBossId ? `--boss-id=${row.encryptBossId}` : ''].filter(Boolean).join(' ');
  const mismatch = conversationRoleMismatch(row, job);
  const automaticResumeAllowed = (trigger === 'explicit' && ['explicit', 'positive'].includes(daily.resumeMode)) || (trigger === 'positive' && daily.resumeMode === 'positive');
  return {
    kind:row.resumeConsentRequired ? 'resume-consent-required' : ['explicit', 'positive'].includes(trigger) ? 'resume-request' : row.status === 'needs_inspect' ? 'inspect-conversation' : 'conversation',
    dailyOptions:daily,
    conversation:row,
    warnings:mismatch ? [mismatch] : [],
    replyGuidance:conversationReplyGuidance(row, mismatch, daily),
    job:job ? {
      jobId:job.jobId, title:job.title || row.jobTitle || '', company:job.company || row.company || '',
      salary:job.salary || row.jobSalary || '', location:row.jobLocation || '', jdStatus:job.jd?.status || 'unread',
      ...(full || row.status === 'boss_last_review' ? { description:job.jd?.status === 'read' ? jobDescription(job).slice(0, full ? 12000 : 3000) : '' } : {}),
      review:job.review || {},
    } : { jobId:row.encryptJobId || '', title:row.jobTitle || '', company:row.company || '', salary:row.jobSalary || '', location:row.jobLocation || '', jdStatus:'unread', review:{} },
    resume:{ trigger, suggested:job ? resumeForJob(job) : RESUME_MAPPING.adjacent, consentRequired:!!row.resumeConsentRequired, automaticAllowedToday:automaticResumeAllowed },
    factsSource:FACTS_FILE,
    commands:{
      inspect:conversationCommand(row),
      reply:`$env:BOSS_VALUE='<用户指定的回复正文>'; node workflow/boss.js conversation-reply ${ids}`,
      resumeDryRun:`node workflow/boss.js resume-send --auto --dry-run ${ids}`,
      resumeSend:automaticResumeAllowed ? `node workflow/boss.js resume-send --auto ${ids}` : '',
    },
  };
}

module.exports = { resumeForJob, conversationCommand, conversationWorkbenchPayload };
