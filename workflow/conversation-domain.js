function conversationStatus(item) {
  const ours = /status/.test(item.statusClass || '');
  if (ours) return /read/.test(item.statusClass) ? 'ours_last_read' : 'ours_last_delivered';
  const message = String(item.lastMessage || '');
  if (!message.trim()) return 'needs_inspect';
  if (/您的附件简历.*已发送给Boss|对方已同意，您的附件简历已发送给对方|附件简历请求已发送/.test(message)) return 'system_notice';
  if (/的(?:微信号|手机号)[：:]/.test(message)) return 'contact_shared';
  if (/^(?:不好意思|不可以)[啊哦]?$|不.{0,2}合适|不接受|不考虑|暂不|抱歉|对不起|已招到|停止招聘|不(?:支持|接受|可以)远程|早日找到|需(?:要)?有.{0,20}经验(?:的呢|.{0,6}谢谢)/.test(message)) return 'closed';
  // 对话状态只描述最后一条消息的归属，不推断“需要我们回复”。历史快照也不能成为当前待办。
  return 'boss_last_review';
}

function currentConversations(ledger) {
  const syncAt = ledger.conversationSyncAt;
  return syncAt ? ledger.conversations.filter(item => item.checkedAt === syncAt) : ledger.conversations;
}

function resumeTrigger(message) {
  const text = String(message || '');
  if (!text.trim()) return 'inspect';
  if (/^(?:不好意思|不可以)[啊哦]?$|不.{0,2}合适|不接受|不考虑|暂不|抱歉|对不起|已招到|停止招聘|不(?:支持|接受|可以)远程|早日找到|需有.{0,20}经验.{0,6}谢谢/.test(text)) return 'closed';
  if (/附件简历.*已发送|已发送给Boss|已发送给对方/.test(text)) return 'already_sent';
  if (/(?:不用|不需要|无需|先别|暂时不(?:用|要)).{0,8}(?:发|发送|提供)?.{0,5}(?:简历|附件)|(?:简历|附件).{0,8}(?:不用|不需要|无需|先别|暂时不(?:用|要))/.test(text)) return 'review';
  if (/简历|附件|发我|发一份|看下资料|资料发/.test(text)) return 'explicit';
  if (/聊一聊|聊聊|有兴趣|进一步沟通|可以沟通|方便沟通|介绍一下|两个方向|研究方向/.test(text)) return 'positive';
  return 'review';
}

function conversationRoleMismatch(row, job) {
  const message = String(row.lastMessage || '');
  const title = String(job?.title || row.jobTitle || '');
  const roleSignals = ['管培生', 'Java', '前端', '后端', '全栈', '产品经理', '产品助理', '运营', '销售', '客服', '测试', '算法', '数据标注', '短视频', '主播'];
  const conflicts = roleSignals.filter(signal => new RegExp(signal, 'i').test(message) && !new RegExp(signal, 'i').test(title));
  return conflicts.length ? {
    code: 'conversation_job_mismatch',
    message: `对方消息提到“${conflicts.join('、')}”，但聊天职位标题为“${title || '未知'}”；回复或发简历前先确认实际岗位`,
  } : null;
}

module.exports = { conversationStatus, currentConversations, resumeTrigger, conversationRoleMismatch };
