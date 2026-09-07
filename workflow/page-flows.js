const { jobIdOf } = require('./cli-args');
const { CDP, httpJson } = require('./cdp');
const { PORT, SECURITY_JS_EXPR, humanPause, sleepMs } = require('./safety');

const isClosedJobText = text => /职位已关闭|职位已下线|招聘已结束/.test(String(text || ''));

function jobPageExpression() {
  return `(()=>{
    const text=(el)=>(el?.innerText||'').replace(/\\s+/g,' ').trim();
    const section=(name)=>{const heading=[...document.querySelectorAll('.job-detail h2,.job-detail h3,.job-detail .job-sec-title')].find(x=>text(x)===name);const box=heading?.closest('.detail-section-item,.job-detail-section,.job-sec,.job-box')||heading?.parentElement;return box?text(box).replace(name,'').trim():''};
    const b=document.querySelector('.btn-startchat');const description=text(document.querySelector('.job-sec-text'));const primary=text(document.querySelector('.job-primary'));const recruiterBox=document.querySelector('.job-boss-info');const recruiterNameEl=recruiterBox?.querySelector('.name');const recruiterState=text(recruiterBox?.querySelector('.boss-active-time,.boss-online-tag'));const recruiterName=recruiterNameEl?text(recruiterNameEl).replace(recruiterState,'').trim():'';const recruiterAttr=text(recruiterBox?.querySelector('.boss-info-attr'));const attrParts=recruiterAttr.split('·').map(x=>x.trim()).filter(Boolean);const bodyText=document.body?.innerText||'';const businessInformation=section('工商信息');const registeredCompany=(businessInformation.match(/公司名称\\s+(.+?)\\s+法定代表人/)||bodyText.match(/工商信息\\s+公司名称\\s+(.+?)\\s+法定代表人/)||[])[1]||'';const displayCompany=attrParts[0]||'';const salary=(description.match(/\\d+(?:\\.\\d+)?-\\d+(?:\\.\\d+)?(?:K(?:·\\d+薪)?|元\\/(?:时|天|月))/i)||bodyText.match(/\\d+(?:\\.\\d+)?-\\d+(?:\\.\\d+)?(?:K(?:·\\d+薪)?|元\\/(?:时|天|月))/i)||[])[0]||'';
    return JSON.stringify({url:location.href,bodyText,security:${SECURITY_JS_EXPR},structured:{title:document.querySelector('.job-banner h1[title]')?.getAttribute('title')||text(document.querySelector('.job-banner h1')),company:(!/\\.\\.\\.|…/.test(displayCompany)||!registeredCompany)?displayCompany:registeredCompany,salary,description,benefits:[...new Set([...(document.querySelector('.job-tags')?.querySelectorAll('span,li')||[])].map(text).filter(Boolean))].join('、'),companyIntroduction:section('公司介绍'),businessInformation,address:section('工作地址'),experience:(primary.match(/经验不限|应届生|\\d+-\\d+年|\\d+年以上/)||[])[0]||'',education:(primary.match(/学历不限|初中|中专|高中|大专|本科|硕士|博士/)||[])[0]||'',tags:[...new Set([...(document.querySelector('.job-tags')?.querySelectorAll('span,li')||[])].map(text).filter(Boolean))],recruiter:{name:recruiterName,title:attrParts.slice(1).join(' · '),activeText:recruiterState},incomplete:/登录查看完整内容|登录后查看完整职位描述/.test(description)},button:{text:text(b),redirectUrl:b?.getAttribute('redirect-url')||'',isFriend:b?.dataset?.isfriend||''}});
  })()`;
}

async function waitForJobPage(cdp, id, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let page = {};
  while (Date.now() < deadline) {
    page = JSON.parse(await cdp.eval(jobPageExpression(), Math.min(6000, Math.max(1500, deadline - Date.now()))) || '{}');
    const sameJob = jobIdOf(page.url) === id;
    const hasBody = String(page.structured?.description || '').trim().length > 0;
    const settledRedirect = !sameJob && page.url && page.url !== 'about:blank' && page.bodyText?.length > 100;
    // BOSS 打开详情偶尔会短暂经过 passport/security 路由；等导航稳定后再熔断，持续安全页仍会在超时后返回给调用方。
    if (page.security) { await sleepMs(250); continue; }
    if ((sameJob && (hasBody || isClosedJobText(page.bodyText))) || settledRedirect) return page;
    await sleepMs(250);
  }
  return page;
}

async function waitForSearchResults(cdp, timeoutMs = 18000, previousSignature = '') {
  const deadline = Date.now() + timeoutMs;
  let state = {};
  while (Date.now() < deadline) {
    state = await cdp.eval(`(()=>{const body=(document.body?.innerText||'').replace(/\\s+/g,' ').trim();const real=a=>/\\/job_detail\\/[\\w~-]+\\.html(?:[?#]|$)/.test(a.href)&&a.offsetParent!==null&&!a.closest('header,.zp-header,footer,.footer');const cards=[...document.querySelectorAll('.job-card-wrapper,.job-card-box,.job-list-box,li')].filter(card=>[...card.querySelectorAll('a[href*="/job_detail/"]')].some(real));const ids=new Set([...document.querySelectorAll('a[href*="/job_detail/"]')].filter(real).map(a=>(a.href.match(/job_detail\\/([\\w~-]+)\\.html/)||[])[1]).filter(Boolean));const empty=/暂无相关职位|没有找到相关职位|暂无职位|换个关键词/.test(body);const shell=!!document.querySelector('input[placeholder*="职位"],input[placeholder*="搜索"],.job-search-wrapper,.search-box');const ordered=[...ids];return {url:location.href,security:${SECURITY_JS_EXPR},count:ids.size,cards:cards.length,ids:ordered,signature:ordered.join('|'),empty,shell,bodyChars:body.length}})()`);
    const loaded = state.count > 0 && state.cards > 0;
    if (state.security || state.empty || (loaded && (!previousSignature || state.signature !== previousSignature))) return state;
    await sleepMs(250);
  }
  return state;
}

function chatStateExpression() {
  return ['(()=>{','const visible=el=>!!el&&el.offsetParent!==null&&(()=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0})();',"const route=location.pathname.includes('/web/geek/chat');","const shell=!!document.querySelector('.friend-content-warp,.chat-container,.chat-content,.chat-panel');","const pool=[...document.querySelectorAll('#chat-input,textarea,[contenteditable=true]')].filter(visible);","const input=pool.find(x=>x.id==='chat-input')||pool.find(x=>{const meta=String(x.className||'')+' '+String(x.getAttribute('placeholder')||'')+' '+String(x.getAttribute('data-placeholder')||'');return x.isContentEditable||meta.includes('输入')||meta.includes('消息')||meta.toLowerCase().includes('message')||meta.toLowerCase().includes('chat-input')})||null;","return {input:!!input,chat:!!input&&(route||shell),route,shell,url:location.href,inputSelector:input?(input.id||input.tagName+'.'+String(input.className||'').split(' ')[0]):'',bodyText:(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,1200)};",'})()'].join('');
}

async function waitForChatReady(originalCdp, redirectUrl = '', maxRounds = 25, preExistingTabIds = new Set()) {
  let active = originalCdp;
  const connections = [originalCdp];
  const tabIds = new Set([originalCdp.tabId]);
  let redirectAttempts = 0;
  let lastProbe = {};
  for (let index = 0; index < maxRounds; index++) {
    await humanPause(800, 1400);
    await active.eval(`(function(){const cancel=[...document.querySelectorAll('button,a,span')].find(x=>{const t=(x.innerText||'').trim();return t==='取消'&&/隐私保护|安全风险/.test(document.body.innerText);});if(cancel){cancel.click();return 'closed';}return 'none';})()`).catch(() => 'probe-failed');
    const dismissed = await active.eval(`(function(){const body=document.body.innerText||'';if(!/完善在线简历|请先完善(在线)?简历|简历不完整|去完善简历|完善简历后/.test(body))return false;const ok=[...document.querySelectorAll('button,a,span')].find(x=>x.offsetParent&&(x.innerText||'').trim()==='好的');if(!ok)return false;ok.click();return true;})()`).catch(() => false);
    if (dismissed) { await humanPause(300, 700); continue; }
    lastProbe = await active.eval(chatStateExpression()).catch(error => ({ input:false, chat:false, url:'', bodyText:'', error:error.message }));
    if (lastProbe?.input && lastProbe?.chat) return { cdp:active, connections, tabIds:[...tabIds], probe:lastProbe };
    const tabs = await httpJson(`http://127.0.0.1:${PORT}/json`).catch(() => []);
    const popup = tabs.find(tab => tab.type === 'page' && tab.id !== active.tabId && !preExistingTabIds.has(tab.id) && /(?:^|\.)zhipin\.com$/.test((() => { try { return new URL(tab.url || '').hostname; } catch { return ''; } })()) && /\/web\/geek\/chat/.test(tab.url || ''));
    if (popup && popup.id !== active.tabId) {
      const next = new CDP(PORT); await next.connectPage(tab => tab.id === popup.id); next.tabId = popup.id; active = next; connections.push(next); tabIds.add(popup.id); continue;
    }
    if (redirectUrl && active === originalCdp && redirectAttempts < 4) {
      try {
        const friendState = await originalCdp.eval(`(()=>{const b=document.querySelector('.btn-startchat');return {onJob:/\\/job_detail\\//.test(location.pathname),text:(b?.innerText||'').trim(),isFriend:b?.dataset?.isfriend||''}})()`).catch(() => ({}));
        if (friendState.onJob && !/继续/.test(friendState.text || '') && friendState.isFriend !== 'true') continue;
        const target = new URL(redirectUrl, 'https://www.zhipin.com/'); const current = new URL(lastProbe.url || 'https://www.zhipin.com/'); const missingSelection = /\/web\/geek\/chat/.test(current.pathname) && !current.searchParams.get('id') && !lastProbe.input;
        if (target.hostname === current.hostname && /\/web\/geek\/chat/.test(target.pathname) && (friendState.onJob || missingSelection)) { await active.navigate(target.href); redirectAttempts++; await humanPause(1200, 2200); }
      } catch {}
    }
  }
  return { cdp:active, connections, tabIds:[...tabIds], probe:lastProbe };
}

function isExpiredJobRedirect(url) {
  try { const parsed = new URL(String(url || '')); return /(^|\.)zhipin\.com$/.test(parsed.hostname) && (parsed.pathname === '/' || parsed.pathname === '' || /^\/web\/geek\/jobs?\/?$/.test(parsed.pathname)); } catch { return false; }
}

module.exports = { jobPageExpression, waitForJobPage, waitForSearchResults, chatStateExpression, waitForChatReady, isClosedJobText, isExpiredJobRedirect };
