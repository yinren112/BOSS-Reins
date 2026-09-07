function verifyFrom(value) {
  const rows = Array.isArray(value) ? value : [value];
  const verify = rows.find(x => x && x.verify)?.verify || value?.verify || {};
  return {
    inputEmpty: verify.inputEmpty === true,
    hasMyMsg: verify.hasMyMsg === true,
    hasSongda: verify.hasSongda === true,
  };
}

function companyEvidenceTerms(name) {
  const full = String(name || '').trim();
  const withoutLegal = full.replace(/(?:有限责任公司|股份有限公司|集团有限公司|有限公司|公司|个体工商户|工作室)$/g, '').replace(/工程$/g, '');
  const withoutPlace = withoutLegal.replace(/^(?:北京|上海|天津|重庆|南京|广州|深圳|杭州|苏州|武汉|成都|西安|郑州|长沙|合肥|厦门|福州|济南|青岛|宁波|新疆|云南|山东|山西|浙江|江苏|福建|广东|广西|四川|贵州|湖北|湖南|河南|河北|安徽|陕西|甘肃|青海|辽宁|吉林|黑龙江|海南|江西|内蒙古|宁夏|西藏|南平市建阳区)/, '');
  const brand = withoutPlace.replace(/(?:信息科技|网络科技|智能科技|科技工程|工程科技|科技服务|信息技术|技术服务|文化传媒|健康管理|教育咨询服务)$/g, '');
  return [...new Set([full, withoutLegal, withoutPlace, brand].filter(term => term.length >= 3))];
}

function normalizeDeliveryText(value) {
  return String(value || '')
    .replace(/&ndash;|&#8211;/g, '–')
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&ldquo;|&#8220;|&#x201c;/gi, '“')
    .replace(/&rdquo;|&#8221;|&#x201d;/gi, '”')
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

function buildDeliveryVerifyExpr(msgExpr, targetBossIdExpr, targetJobIdExpr, companyTermsExpr) {
  return `(async()=>{
   try {
    const msg=${msgExpr};
    const targetBossId=${targetBossIdExpr};
    const targetJobId=${targetJobIdExpr};
    const companyTerms=${companyTermsExpr};
    const normalize=value=>String(value||'').replace(/&ndash;|&#8211;/g,'–').replace(/&mdash;|&#8212;/g,'—').replace(/&ldquo;|&#8220;|&#x201c;/gi,'“').replace(/&rdquo;|&#8221;|&#x201d;/gi,'”').replace(/&quot;|&#34;|&#x22;/gi,'"').replace(/&amp;/g,'&').trim();
    const findMatches=()=>{
      let vm=document.querySelector('.friend-content-warp')?.__vue__;
      while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;
      const sources=vm?.$props?.dataSources||vm?.dataSources||[];
      return targetBossId?sources.filter(s=>s&&String(s.encryptBossId||'')===targetBossId):[];
    };
    let matches=[],entry,confirmed=false,delivered=false;
    for(let attempt=0;attempt<15;attempt++){
      matches=findMatches();
      entry=matches[0];
      confirmed=!!(entry&&entry.lastIsSelf&&normalize(entry.lastText)===normalize(msg));
      delivered=confirmed&&Number(entry.lastMsgStatus||0)>=1;
      if(delivered)break;
      if(attempt<14)await new Promise(r=>setTimeout(r,1000));
    }
    const input=document.querySelector('#chat-input');
    return {
      inputEmpty:(input?.innerText||'').trim()==='',
      identityMatchCount:matches.length,
      matchedText:confirmed,
      readOrDelivered:delivered,
      jobMatched:confirmed&&String(entry.encryptJobId||'')===String(targetJobId||''),
      companyVisible:companyTerms.some(term=>document.body.innerText.includes(term))
    };
   } catch (e) {
     return { error: 'js-exception: ' + (e && e.message || String(e)) };
   }
  })()`;
}

function sentVerification(sent) {
  return {
    inputEmpty: sent?.inputEmpty === true,
    identityMatched: sent?.identityMatchCount === 1 && sent?.matchedText === true,
    delivered: sent?.readOrDelivered === true,
    companyVisible: sent?.jobMatched === true || sent?.companyVisible === true,
  };
}

module.exports = { verifyFrom, companyEvidenceTerms, normalizeDeliveryText, buildDeliveryVerifyExpr, sentVerification };
