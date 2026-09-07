const { CDP, activateTab, listTabs, openTab, sleep } = require('./cdp');

const ROUTES = {
  home: 'https://www.zhipin.com/',
  jobs: 'https://www.zhipin.com/web/geek/jobs',
  companies: 'https://www.zhipin.com/gongsi/',
  campus: 'https://www.zhipin.com/school/',
  returnee: 'https://www.zhipin.com/returnee_jobs/',
  'overseas-jobs': 'https://www.zhipin.com/overseas/',
  'accessible-jobs': 'https://www.zhipin.com/accessible_job/',
  'app-download': 'https://app.zhipin.com/',
  content: 'https://youle.zhipin.com/recommend/selected/',
  chat: 'https://www.zhipin.com/web/geek/chat',
  resume: 'https://www.zhipin.com/web/geek/resume',
  recommend: 'https://www.zhipin.com/web/geek/jobs',
  'job-recommendations': 'https://www.zhipin.com/web/geek/jobs',
  'communicated-jobs': 'https://www.zhipin.com/web/geek/recommend',
  favorites: 'https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=1&tag=4',
  settings: 'https://www.zhipin.com/web/geek/notify-set',
  'common-phrases': 'https://www.zhipin.com/web/geek/notify-set?type=replySet',
  'greeting-settings': 'https://www.zhipin.com/web/geek/notify-set?type=greetSet',
  notifications: 'https://www.zhipin.com/web/geek/notify-set?type=messageNotice',
  account: 'https://www.zhipin.com/web/geek/account?type=home',
  'account-management': 'https://www.zhipin.com/web/geek/account?type=accountSet',
  permissions: 'https://www.zhipin.com/web/geek/account?type=authManage',
  identity: 'https://www.zhipin.com/web/geek/account?type=identityCheck',
  'personal-info': 'https://www.zhipin.com/web/geek/account?type=personalInfoManage',
  'login-devices': 'https://www.zhipin.com/web/geek/account?type=loginEquipmentManage',
  privacy: 'https://www.zhipin.com/web/geek/privacy-set?type=privacySet&from=1',
  visibility: 'https://www.zhipin.com/web/geek/privacy-set?type=shieldPosition',
  blacklist: 'https://www.zhipin.com/web/geek/privacy-set?type=bossBlacklist',
  personalization: 'https://www.zhipin.com/web/geek/privacy-set?type=personalRecommend',
  rules: 'https://www.zhipin.com/web/geek/rule-center',
};

const ROUTE_READY_LABELS = {
  home: '首页主体正文',
  jobs: '搜索框与筛选壳；带查询时还需真实岗位卡或明确空结果',
  companies: '公司频道正文与公司入口',
  campus: '校园招聘频道正文',
  returnee: '海归/留学生招聘频道正文',
  'overseas-jobs': '海外职位频道正文',
  'accessible-jobs': '无障碍招聘频道正文',
  'app-download': 'BOSS 直聘 APP 下载正文',
  content: '有了职场内容频道正文',
  chat: '消息壳与 Vue virtual-list 数据或明确空会话',
  resume: '在线简历主体、个人优势/期望职位与附件管理',
  recommend: '当前期望职位对应的真实推荐岗位卡或明确空结果',
  'job-recommendations': '当前期望职位对应的真实推荐岗位卡或明确空结果',
  'communicated-jobs': '个人中心“沟通过”岗位列表与分页',
  favorites: 'personal_interest_job 收藏卡或明确空收藏状态',
  settings: '消息设置主体',
  'common-phrases': 'replySet 路由与添加常用语/明确空常用语',
  'greeting-settings': 'greetSet 路由与启用招呼语',
  notifications: 'messageNotice 路由与允许新消息通知',
  account: 'account home 路由与账号安全首页正文',
  'account-management': 'accountSet 路由与绑定手机',
  permissions: 'authManage 路由与位置权限',
  identity: 'identityCheck 路由与邮箱验证',
  'personal-info': 'personalInfoManage 路由与个人信息浏览导出',
  'login-devices': 'loginEquipmentManage 路由与最近登录时间',
  privacy: 'privacySet 路由与添加屏蔽公司说明',
  visibility: 'shieldPosition 路由与对全部 Boss 隐藏简历',
  blacklist: 'bossBlacklist 路由与已拉黑 Boss 说明',
  personalization: 'personalRecommend 路由与个性化职位推荐',
  rules: '规则中心正文',
};

function capabilities() {
  const roleFor = alias => alias === 'favorites' ? 'favorites'
    : alias === 'communicated-jobs' ? 'communicated-jobs'
    : ['recommend','job-recommendations'].includes(alias) ? 'jobs'
    : ['companies','campus','returnee','overseas-jobs','accessible-jobs','app-download','content'].includes(alias) ? 'public-navigation'
    : ['settings','common-phrases','greeting-settings','notifications','account','account-management','permissions','identity','personal-info','login-devices','privacy','visibility','blacklist','personalization','rules'].includes(alias) ? 'settings'
      : alias;
  return {
    mode:'offline',
    routes:Object.entries(ROUTES).map(([alias, url]) => ({ alias, url, role:roleFor(alias), readySignal:ROUTE_READY_LABELS[alias] || '页面业务正文' })),
    genericControls:{
      inspect:'browser-snapshot [--full]',
      navigate:'browser-open <alias|BOSS_URL> [--full]',
      click:'browser-click (--selector=<CSS>|--text=<exact>) --dry-run；执行时可加 --expect-text/--expect-selector/--expect-absent',
      openEditor:'browser-click --selector=<stable ka selector>',
      fill:'browser-fill (--selector=<CSS>|--text=<field label or placeholder>) [--dry-run]',
      select:'browser-select --selector=<CSS> --option=<exact> [--dry-run]',
      toggle:'browser-toggle (--selector=<CSS>|--text=<label>) --state=on|off [--dry-run]',
    },
    argumentSyntax:'所有带值选项同时支持 --name=value 与 --name value；选项可放在位置参数前后',
    tabSelection:'未给 --tab 时优先当前 focused/visible 且已登录、非安全页的 BOSS 标签；返回 tabSelection 说明选择依据',
    businessControls:{ conversation:'conversation-open/conversation-reply', resume:'resume-send --dry-run|--auto', firstOutreach:'save-opener + ai-send --use-saved', jobSources:'job-sources/recommendations/favorites/interactions/company-jobs', job:'search/read/jd/review/list/candidates' },
    mutationBoundary:'发送、发简历、完成、保存、提交、更新、删除、确认等动作必须使用业务命令或显式 --allow-action，并在操作后回读',
  };
}

const DANGEROUS_ACTION_RE = /发送|发简历|立即沟通|继续沟通|打招呼|投递|保存|完成|提交|更新|确定|确认|删除|注销|退出账号|清空|解除|同意|拒绝|交换/;
const SAFE_EDITOR_ENTRY_RE = /^(?:user-resume-edit-|custom_add_btn_)/;

function isDangerousTarget(target = {}) {
  // 简历编辑容器包含整段正文，正文自然出现“确认/发送”时不能误判为保存按钮。
  // 稳定 ka 只负责打开编辑器；编辑器中的保存/确认按钮仍由危险动作门禁拦截。
  if (SAFE_EDITOR_ENTRY_RE.test(String(target.action || ''))) return false;
  return DANGEROUS_ACTION_RE.test(String(target.text || ''));
}
const SECURITY_EXPR = `(()=>{const body=document.body?.innerText||'';return location.pathname.includes('/403.html')||/[?&]code=(32|36|37)(?:&|$)/.test(location.href)||location.pathname.includes('/web/passport/')||!!document.querySelector('.security-check,.verify-wrap,.captcha')||/账户存在异常行为|暂时限制访问|访问受限/.test(body)})()`;

// 导航等待同时识别安全页。否则页面已经跳到 403/passport 时仍会等业务 DOM 到超时，
// 外层也拿不到 snapshot.security，无法按规则立即写持久熔断锁。
function readyOrSecurity(expression) {
  return `((${expression})||${SECURITY_EXPR})`;
}

async function isSecurity(cdp) {
  return !!(await cdp.eval(SECURITY_EXPR));
}

async function waitForStableUi(cdp, { timeoutMs = 3200, intervalMs = 180 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stable = 0;
  while (Date.now() < deadline) {
    if (await isSecurity(cdp)) return { security:true };
    const signature = await cdp.eval(`(()=>{const body=(document.body?.innerText||'').replace(/\\s+/g,' ').trim();const fields=[...document.querySelectorAll('input,textarea,select,[contenteditable=true]')].filter(el=>el.offsetParent!==null).map(el=>String(el.value??el.innerText??'').slice(0,120));const toggles=[...document.querySelectorAll('.ui-switch,[role=switch],input[type=checkbox]')].filter(el=>el.offsetParent!==null).map(el=>String(el.className)+'|'+el.getAttribute('aria-checked')+'|'+el.checked);const dialogs=[...document.querySelectorAll('[role=dialog],.boss-dialog,.dialog-wrap,.popover-wrap')].filter(el=>el.offsetParent!==null).map(el=>(el.innerText||'').slice(0,120));return JSON.stringify({url:location.href,ready:document.readyState,bodyLength:body.length,head:body.slice(0,500),tail:body.slice(-300),fields,toggles,dialogs})})()`);
    if (signature === previous) stable += 1;
    else { previous = signature; stable = 0; }
    if (stable >= 2) return { stable:true };
    await sleep(intervalMs);
  }
  return { stable:false, warning:'页面已满足业务就绪，但语义状态在等待窗口内仍持续变化' };
}

function assertBossUrl(input) {
  const route = ROUTES[input] || input;
  let url;
  try { url = new URL(route); } catch { throw new Error(`未知页面 ${input}；可用：${Object.keys(ROUTES).join('/')}`); }
  if (url.protocol !== 'https:' || !/(^|\.)zhipin\.com$/.test(url.hostname)) throw new Error('browser-open 只允许进入 BOSS zhipin.com 页面');
  return url.href;
}

function snapshotExpression(limit = 20) {
  return `(()=>{
    const visible=el=>!!el&&el.offsetParent!==null&&(()=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0})();
    const text=el=>(el?.innerText||el?.textContent||'').replace(/\\s+/g,' ').trim();
    const selectorFor=el=>{if(el.id)return '#'+CSS.escape(el.id);const tag=el.tagName.toLowerCase();for(const attr of ['ka','name','placeholder','aria-label','data-placeholder']){const value=el.getAttribute(attr);if(value){const candidate=tag+'['+attr+'='+JSON.stringify(String(value))+']';try{if(document.querySelectorAll(candidate).length===1)return candidate}catch{}}}const classes=[...el.classList].filter(x=>x&&!/^(active|selected|disabled|cur|hover)$/.test(x)).slice(0,2);if(classes.length){const candidate=tag+'.'+classes.map(CSS.escape).join('.');try{if(document.querySelectorAll(candidate).length===1)return candidate}catch{}}return ''};
    const body=document.body?.innerText||'';
    const publicNav=/^(?:app|youle)\\.zhipin\\.com$/.test(location.hostname)||/^\\/(?:gongsi|school|returnee_jobs|overseas|accessible_job)(?:\\/|$)/.test(location.pathname);
    const role=publicNav?'public-navigation':location.pathname.includes('/web/geek/chat')?'chat':location.pathname.includes('/job_detail/')?'job-detail':location.pathname.includes('/web/geek/jobs')?'jobs':location.pathname.includes('/web/geek/resume')?'resume':/\\/web\\/geek\\/(notify-set|privacy-set|account|rule-center)/.test(location.pathname)?'settings':location.pathname.includes('/web/geek/recommend')&&new URL(location.href).searchParams.get('tag')==='4'?'favorites':location.pathname.includes('/web/geek/recommend')?'communicated-jobs':location.pathname==='/'?'home':'other';
    const contextRoot=(role==='chat'?document.querySelector('.chat-conversation'):role==='job-detail'?document.querySelector('.job-detail,.job-box,.job-banner'):role==='resume'?document.querySelector('.resume-container'):role==='settings'?document.querySelector('#main,.setting-content,.page-container'):role==='jobs'?document.querySelector('.job-list-container,.job-list-box,.search-job-result'):document.querySelector('#main'))||document.body;
    const security=${SECURITY_EXPR};
    const links=[...document.querySelectorAll('a[href]')].filter(el=>visible(el)&&!el.closest('header,.zp-header,footer,.footer')).map((el,index)=>({index,text:text(el).slice(0,80),href:el.href,selector:selectorFor(el)})).filter(x=>x.text||x.href).slice(0,${limit});
    const buttons=[...document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')].filter(visible).map((el,index)=>({index,text:(text(el)||el.value||el.getAttribute('aria-label')||'').slice(0,80),disabled:!!el.disabled,selector:selectorFor(el)})).filter(x=>x.text).slice(0,${limit});
    const actions=[...document.querySelectorAll('[ka*="edit"],[ka*="add"],[aria-label],[title]')].filter(el=>visible(el)&&!el.closest('footer,.footer')).map((el,index)=>{const action=el.getAttribute('ka')||el.getAttribute('aria-label')||el.getAttribute('title')||'';const raw=text(el)||el.getAttribute('aria-label')||el.getAttribute('title')||'';const compact=/^(?:user-resume-edit-|custom_add_btn_)/.test(action)?action+': '+raw.slice(0,55):raw.slice(0,100);return {index,text:compact,action,tag:el.tagName.toLowerCase(),selector:selectorFor(el)}}).filter(x=>x.action&&x.selector).slice(0,${limit});
    const seenClickables=new Set();
    const clickables=[...document.querySelectorAll('[role=tab],li,label,[tabindex]')].filter(el=>visible(el)&&!el.matches('a,button,input,textarea,select')&&!el.querySelector('a[href],button,input,textarea,select')).filter(el=>{const value=text(el);if(!value||value.length>140||seenClickables.has(value))return false;seenClickables.add(value);return true}).map((el,index)=>({index,text:text(el),tag:el.tagName.toLowerCase(),selector:selectorFor(el)})).slice(0,${limit});
    const fieldContext=el=>{const direct=el.getAttribute('aria-label')||el.placeholder||el.getAttribute('data-placeholder')||'';if(direct)return direct;const byFor=el.id?document.querySelector('label[for='+JSON.stringify(el.id)+']'):null;if(byFor&&text(byFor))return text(byFor);let node=el.parentElement;for(let i=0;i<5&&node;i++,node=node.parentElement){const value=text(node);if(value.length>=2&&value.length<=220)return value}return ''};
    const fields=[...document.querySelectorAll('input,textarea,select,[contenteditable=true]')].filter(visible).map((el,index)=>({index,tag:el.tagName.toLowerCase(),type:el.type||'',name:el.name||'',id:el.id||'',placeholder:el.placeholder||el.getAttribute('data-placeholder')||'',context:fieldContext(el).slice(0,220),value:el.matches('[contenteditable=true]')?text(el).slice(0,120):String(el.value||'').slice(0,120),disabled:!!el.disabled,selector:selectorFor(el)})).slice(0,${Math.min(limit, 50)});
    const toggleText=el=>{let node=el;for(let i=0;i<6&&node;i++,node=node.parentElement){const value=text(node);if(value.length>=2&&value.length<=320)return value}return ''};
    const toggles=[...document.querySelectorAll('.ui-switch,[role=switch],input[type=checkbox]')].filter(visible).map((el,index)=>({index,text:toggleText(el).slice(0,180),checked:el.matches('input')?!!el.checked:el.getAttribute('aria-checked')==='true'||el.classList.contains('ui-switch-checked')||el.classList.contains('checked'),disabled:!!el.disabled||el.getAttribute('aria-disabled')==='true',selector:selectorFor(el)})).slice(0,${Math.min(limit, 30)});
    const dialogs=[...document.querySelectorAll('[role=dialog],.boss-dialog,.dialog-wrap,.popover-wrap')].filter(visible).map((el,index)=>({index,text:text(el).slice(0,500),selector:selectorFor(el)})).slice(0,10);
    const realJobLinks=[...document.querySelectorAll('a[href*="/job_detail/"]')].filter(a=>visible(a)&&/\\/job_detail\\/[\\w~-]+\\.html(?:[?#]|$)/.test(a.href)&&!a.closest('header,.zp-header,footer,.footer')).length;
    return {url:location.href,title:document.title,role,ready:document.readyState,loggedIn:${JSON.stringify(require('./reins-config').loadConfig().loginName)}!==''&&body.includes(${JSON.stringify(require('./reins-config').loadConfig().loginName)}),security,context:text(contextRoot).slice(0,${limit > 40 ? 5000 : 1800}),body:body.replace(/\\s+/g,' ').trim().slice(0,${limit > 40 ? 5000 : 900}),counts:{links:document.querySelectorAll('a[href]').length,buttons:document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]').length,actions:actions.length,clickables:clickables.length,fields:document.querySelectorAll('input,textarea,select,[contenteditable=true]').length,toggles:toggles.length,dialogs:dialogs.length,jobLinks:realJobLinks},links,buttons,actions,clickables,fields,toggles,dialogs};
  })()`;
}

function pageResult(snapshot, full = false) {
  if (full) return snapshot;
  return { url:snapshot.url, title:snapshot.title, role:snapshot.role, ready:snapshot.ready, loggedIn:snapshot.loggedIn, security:snapshot.security };
}

function interactionResult(snapshot, full = false) {
  if (full) return snapshot;
  return {
    ...pageResult(snapshot),
    context:String(snapshot.context || '').slice(0, 420),
    counts:snapshot.counts,
    buttons:snapshot.buttons,
    fields:snapshot.fields,
    toggles:snapshot.toggles,
    dialogs:snapshot.dialogs,
  };
}

function navigationResult(snapshot, full = false) {
  if (full) return snapshot;
  return { ...interactionResult(snapshot), actions:snapshot.actions, clickables:snapshot.clickables };
}

function readyExpressionFor(url) {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  if (parsed.hostname === 'app.zhipin.com') return `(()=>{const body=document.body?.innerText||'';return document.readyState==='complete'&&/BOSS直聘|下载|APP/.test(body)&&body.length>120})()`;
  if (parsed.hostname === 'youle.zhipin.com') return `(()=>{const body=document.body?.innerText||'';return document.readyState==='complete'&&/有了|职场|精选/.test(body)&&body.length>120})()`;
  if (pathname.startsWith('/gongsi')) return `(()=>{const body=document.body?.innerText||'';return /公司|热门企业|企业招聘/.test(body)&&document.querySelectorAll('a[href]').length>5})()`;
  if (pathname.startsWith('/school')) return `(()=>{const body=document.body?.innerText||'';return /校园招聘|应届生|校招/.test(body)&&body.length>180})()`;
  if (pathname.startsWith('/returnee_jobs')) return `(()=>{const body=document.body?.innerText||'';return /海归|留学生|留学人才/.test(body)&&body.length>180})()`;
  if (pathname.startsWith('/overseas')) return `(()=>{const body=document.body?.innerText||'';return /海外|境外|全球/.test(body)&&body.length>180})()`;
  if (pathname.startsWith('/accessible_job')) return `(()=>{const body=document.body?.innerText||'';return /无障碍|残障|就业/.test(body)&&body.length>180})()`;
  if (pathname.includes('/web/geek/jobs')) {
    return `(()=>{const body=document.body?.innerText||'';const shell=!!document.querySelector('input[placeholder*="职位"],input[placeholder*="搜索"],.job-search-wrapper,.search-box');const real=a=>/\\/job_detail\\/[\\w~-]+\\.html(?:[?#]|$)/.test(a.href)&&a.offsetParent!==null&&!a.closest('header,.zp-header,footer,.footer');const cards=[...document.querySelectorAll('.job-card-wrapper,.job-card-box,.job-list-box,li')].some(x=>[...x.querySelectorAll('a[href*="/job_detail/"]')].some(real));return shell&&(cards||/暂无相关职位|没有找到相关职位|暂无职位|换个关键词/.test(body)||!new URL(location.href).searchParams.get('query'))})()`;
  }
  if (pathname.includes('/web/geek/chat')) {
    return `(()=>{const shell=!!document.querySelector('.friend-content-warp,.user-list,.chat-container');let vm=document.querySelector('.friend-content-warp')?.__vue__;while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;const rows=vm?.$props?.dataSources||vm?.dataSources||[];const body=document.body?.innerText||'';return shell&&(rows.length>0||/暂无沟通|还没有沟通|暂无消息/.test(body))})()`;
  }
  if (pathname.includes('/web/geek/resume')) {
    return `(()=>{const t=document.body?.innerText||'';return !/正在加载中/.test(t)&&!!document.querySelector('.resume-container,.resume-box,.resume-attachment')&&/个人优势|期望职位/.test(t)&&/附件管理/.test(t)})()`;
  }
  if (pathname.includes('/web/geek/notify-set')) {
    const type = parsed.searchParams.get('type');
    if (type === 'greetSet') {
      return `(()=>{const body=document.body?.innerText||'';return new URL(location.href).searchParams.get('type')==='greetSet'&&/聊天的招呼语|启用招呼语/.test(body)})()`;
    }
    if (type === 'replySet') {
      return `(()=>{const body=document.body?.innerText||'';return new URL(location.href).searchParams.get('type')==='replySet'&&/添加常用语|您还没有常用回复语/.test(body)})()`;
    }
    if (type === 'messageNotice') {
      return `(()=>{const body=document.body?.innerText||'';return new URL(location.href).searchParams.get('type')==='messageNotice'&&body.includes('允许新消息通知')})()`;
    }
    return `/消息通知|打招呼语|设置/.test(document.body?.innerText||'')`;
  }
  if (pathname.includes('/web/geek/privacy-set')) {
    const type = parsed.searchParams.get('type') || 'privacySet';
    const marker = {
      privacySet: '添加屏蔽公司后',
      shieldPosition: '对全部Boss隐藏简历',
      bossBlacklist: '对于已拉黑的Boss',
      personalRecommend: '个性化职位推荐',
    }[type] || '隐私保护';
    return `(()=>{const body=document.body?.innerText||'';return new URL(location.href).searchParams.get('type')===${JSON.stringify(type)}&&body.includes(${JSON.stringify(marker)})})()`;
  }
  if (pathname.includes('/web/geek/account')) {
    const type = parsed.searchParams.get('type') || 'home';
    const marker = {
      home: '在此可管理自己的信息',
      accountSet: '绑定手机',
      authManage: '位置权限',
      identityCheck: '邮箱验证',
      personalInfoManage: '个人信息浏览与导出',
      loginEquipmentManage: '最近登录时间',
    }[type] || '账号与安全中心';
    return `(()=>{const body=document.body?.innerText||'';return new URL(location.href).searchParams.get('type')===${JSON.stringify(type)}&&body.includes(${JSON.stringify(marker)})})()`;
  }
  if (pathname.includes('/web/geek/rule-center')) {
    return `document.readyState==='complete'&&/规则|协议|安全/.test(document.body?.innerText||'')`;
  }
  if (pathname.includes('/web/geek/recommend')) {
    if (parsed.searchParams.get('tag') === '4') {
      return `(()=>{const body=document.body?.innerText||'';return document.querySelectorAll('a[href*="personal_interest_job_"]').length>0||/暂无收藏|没有收藏|还没有收藏/.test(body)})()`;
    }
    return `(()=>{const body=document.body?.innerText||'';const realJob=[...document.querySelectorAll('a[href*="/job_detail/"]')].some(a=>/\\/job_detail\\/[\\w~-]+\\.html/.test(a.href)&&a.offsetParent!==null&&!a.closest('header,.zp-header,footer,.footer'));return realJob||/暂无推荐职位|暂时没有为你推荐|没有更多职位/.test(body)})()`;
  }
  if (pathname.includes('/job_detail/')) {
    return `!!document.querySelector('.job-sec-text,.job-detail,.btn-startchat')||/职位已关闭|职位已下线/.test(document.body?.innerText||'')`;
  }
  return `document.readyState==='complete'&&!!document.body&&document.body.innerText.length>200`;
}

async function attachTab({ port = 9222, tabId = '', prefer = '' } = {}) {
  const tabs = (await listTabs(port)).filter(tab => /(^|\.)zhipin\.com$/.test((() => { try { return new URL(tab.url || '').hostname; } catch { return ''; } })()));
  if (!tabs.length) throw new Error(`${port} 没有已登录的 BOSS 标签`);
  let selectedBy = '';
  let preferred;
  if (tabId) {
    preferred = tabs.find(tab => tab.id === tabId);
    selectedBy = 'explicit-tab';
  } else {
    const pool = prefer ? tabs.filter(tab => (tab.url || '').includes(prefer)) : tabs;
    const matchedPreferredRoute = !!(prefer && pool.length);
    if (prefer && !matchedPreferredRoute) {
      const url = new URL(prefer, 'https://www.zhipin.com').href;
      const cdp = await openTab(url, port);
      return { cdp, tab:{ id:cdp.tabId, url, selectedBy:'opened-preferred-route' }, tabs };
    }
    const candidates = pool.length ? pool : tabs;
    const scored = [];
    for (const tab of candidates) {
      const probe = new CDP(port);
      try {
        await probe.connectTarget(tab);
        const state = await probe.eval(`(()=>{const body=document.body?.innerText||'';return {focused:document.hasFocus(),visibility:document.visibilityState,loggedIn:${JSON.stringify(require('./reins-config').loadConfig().loginName)}!==''&&body.includes(${JSON.stringify(require('./reins-config').loadConfig().loginName)})&&!/登录后查看|立即登录/.test(body),security:${SECURITY_EXPR},ready:document.readyState}})()`, 4000);
        const score = (state.security ? -1000 : 0) + (state.loggedIn ? 100 : 0) + (state.focused ? 60 : 0) + (state.visibility === 'visible' ? 30 : 0) + (state.ready === 'complete' ? 10 : 0) + (!/\/chongqing\/?(?:\?|$)/.test(tab.url || '') ? 2 : 0);
        scored.push({ tab, state, score });
      } catch {
        scored.push({ tab, state:{}, score:-2000 });
      } finally {
        probe.close();
      }
    }
    scored.sort((a, b) => b.score - a.score);
    preferred = scored[0]?.tab;
    const state = scored[0]?.state || {};
    selectedBy = `${matchedPreferredRoute ? 'preferred-route' : prefer ? 'preferred-route-fallback' : 'active-work-tab'}:${state.focused ? 'focused' : state.visibility === 'visible' ? 'visible' : 'ranked'}`;
  }
  if (!preferred) throw new Error(`找不到 BOSS 标签 ${tabId || prefer}`);
  const cdp = new CDP(port);
  await cdp.connectTarget(preferred);
  return { cdp, tab: { ...preferred, selectedBy }, tabs };
}

async function snapshot({ port = 9222, tabId = '', full = false } = {}) {
  const { cdp, tab } = await attachTab({ port, tabId });
  try {
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { tabId: tab.id, tabSelection:tab.selectedBy, ...navigationResult(snapshot, full) };
  } finally {
    cdp.close();
  }
}

async function inspectTabs({ port = 9222 } = {}) {
  const tabs = (await listTabs(port)).filter(tab => /zhipin\.com/.test(tab.url || ''));
  const rows = [];
  for (const tab of tabs) {
    const cdp = new CDP(port);
    try {
      await cdp.connectTarget(tab);
      const state = await cdp.eval(`(()=>{const body=document.body?.innerText||'';return {url:location.href,title:document.title,ready:document.readyState,focused:document.hasFocus(),visibility:document.visibilityState,loggedIn:${JSON.stringify(require('./reins-config').loadConfig().loginName)}!==''&&body.includes(${JSON.stringify(require('./reins-config').loadConfig().loginName)}),security:${SECURITY_EXPR},body:body.replace(/\\s+/g,' ').slice(0,180)}})()`);
      const score = (state.security ? -1000 : 0) + (state.loggedIn ? 100 : 0) + (state.focused ? 60 : 0) + (state.visibility === 'visible' ? 30 : 0) + (state.ready === 'complete' ? 10 : 0) + (!/\/chongqing\/?(?:\?|$)/.test(state.url || '') ? 2 : 0);
      rows.push({ tabId: tab.id, score, ...state });
    } catch (error) {
      rows.push({ tabId: tab.id, url: tab.url, title: tab.title, error: error.message });
    } finally {
      cdp.close();
    }
  }
  const recommended = [...rows].filter(row => !row.error).sort((a,b)=>b.score-a.score)[0];
  return { port, count: rows.length, recommendedTabId:recommended?.tabId||'', recommendedReason:recommended?(recommended.focused?'focused':recommended.visibility==='visible'?'visible':'ranked'):'', tabs: rows };
}

async function open({ port = 9222, tabId = '', destination, full = false } = {}) {
  const url = assertBossUrl(destination);
  const { cdp, tab } = await attachTab({ port, tabId });
  try {
    await activateTab(tab.id, port).catch(() => {});
    await cdp.navigate(url);
    await cdp.waitFor(readyOrSecurity(readyExpressionFor(url)), { timeoutMs: 20000, intervalMs: 300, description: `BOSS 页面 ${destination}可操作或出现安全页` });
    const stability = await waitForStableUi(cdp);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { tabId: tab.id, tabSelection:tab.selectedBy, stability, ...navigationResult(snapshot, full) };
  } finally {
    cdp.close();
  }
}

function conditionExpression({ expectText = '', expectSelector = '', expectAbsent = '' } = {}) {
  return `(()=>{const body=document.body?.innerText||'';const expectText=${JSON.stringify(expectText)},expectSelector=${JSON.stringify(expectSelector)},expectAbsent=${JSON.stringify(expectAbsent)};const visible=el=>!!el&&el.offsetParent!==null;const checks={};try{if(expectText)checks.text=body.includes(expectText);if(expectSelector)checks.selector=visible(document.querySelector(expectSelector));if(expectAbsent)checks.absent=!visible(document.querySelector(expectAbsent));return {valid:true,passed:Object.values(checks).every(Boolean),checks,url:location.href}}catch(error){return {valid:false,passed:false,error:String(error.message||error),checks,url:location.href}}})()`;
}

async function click({ port = 9222, tabId = '', selector = '', text = '', index = 0, contains = false, allowAction = false, dryRun = false, expectText = '', expectSelector = '', expectAbsent = '', full = false } = {}) {
  if (!selector && !text) throw new Error('browser-click 需要 --selector 或 --text');
  if (!dryRun && !allowAction && DANGEROUS_ACTION_RE.test(text || selector)) throw new Error('该控件可能产生发送、保存或删除等外部动作；请使用对应业务命令，或明确加 --allow-action');
  const { cdp, tab } = await attachTab({ port, tabId });
  try {
    await activateTab(tab.id, port).catch(() => {});
    const before = await cdp.eval(`({url:location.href,title:document.title,body:(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,1200)})`);
    const gate = await cdp.eval(`(()=>{const selector=${JSON.stringify(selector)},wanted=${JSON.stringify(text)},nth=${Number(index)||0},contains=${contains ? 'true' : 'false'};const visible=el=>!!el&&el.offsetParent!==null;const tx=el=>(el.innerText||el.textContent||el.value||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim();let pool=selector?[...document.querySelectorAll(selector)].filter(visible):[...document.querySelectorAll('a,button,[role=button],[tabindex],label,li,span,div')].filter(visible).filter(el=>contains?tx(el).includes(wanted):tx(el)===wanted);if(contains)pool.sort((a,b)=>tx(a).length-tx(b).length);const el=pool[nth];return el?{found:true,text:tx(el),tag:el.tagName,action:el.getAttribute('ka')||el.getAttribute('aria-label')||el.getAttribute('title')||'',role:el.getAttribute('role')||'',type:el.getAttribute('type')||''}:{found:false,candidates:pool.slice(0,10).map(tx)}})()`);
    if (!gate?.found) throw new Error(`未找到可点击控件：${text || selector}`);
    const dangerous = isDangerousTarget(gate);
    const hasPostcondition = !!(expectText || expectSelector || expectAbsent);
    const precondition = hasPostcondition ? await cdp.eval(conditionExpression({ expectText, expectSelector, expectAbsent })) : null;
    if (precondition && !precondition.valid) throw new Error(`后置条件选择器无效，尚未点击：${JSON.stringify(precondition)}`);
    if (dryRun) {
      const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
      return { action:{dryRun:true,target:gate,dangerous,requiresAllowAction:dangerous}, precondition, tabId:tab.id, tabSelection:tab.selectedBy, ...interactionResult(snapshot, full) };
    }
    if (!allowAction && dangerous) throw new Error(`目标控件“${gate.text}”可能产生发送、保存或删除等外部动作；请使用对应业务命令，或明确加 --allow-action`);
    const result = await cdp.eval(`(()=>{const selector=${JSON.stringify(selector)};const wanted=${JSON.stringify(text)};const nth=${Number(index)||0};const contains=${contains ? 'true' : 'false'};const visible=el=>!!el&&el.offsetParent!==null&&(()=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0})();const tx=el=>(el.innerText||el.textContent||el.value||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim();let pool=selector?[...document.querySelectorAll(selector)].filter(visible):[...document.querySelectorAll('a,button,[role=button],[tabindex],label,li,span,div')].filter(visible).filter(el=>contains?tx(el).includes(wanted):tx(el)===wanted);if(contains)pool.sort((a,b)=>tx(a).length-tx(b).length);const el=pool[nth];if(!el)return {clicked:false,candidates:pool.slice(0,10).map(tx)};el.scrollIntoView({block:'center'});el.focus();for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){const C=type.startsWith('pointer')&&globalThis.PointerEvent?PointerEvent:MouseEvent;el.dispatchEvent(new C(type,{bubbles:true,cancelable:true,view:window,button:0,buttons:type.endsWith('down')?1:0,pointerType:'mouse'}))}return {clicked:true,text:tx(el).slice(0,160),action:el.getAttribute('ka')||el.getAttribute('aria-label')||el.getAttribute('title')||'',tag:el.tagName};})()`);
    if (!result?.clicked) throw new Error(`未找到可点击控件：${text || selector}`);
    await sleep(450);
    const after = await cdp.eval(`({url:location.href,title:document.title,body:(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,1200)})`);
    if (after.url !== before.url) await cdp.waitFor(readyOrSecurity(readyExpressionFor(after.url)), { timeoutMs: 20000, intervalMs: 300, description: '点击后业务页面或安全页' });
    const stability = await waitForStableUi(cdp);
    const postcondition = hasPostcondition ? await cdp.eval(conditionExpression({ expectText, expectSelector, expectAbsent })) : null;
    if (postcondition && !postcondition.passed) throw new Error(`点击已执行，但后置条件失败：${JSON.stringify(postcondition)}`);
    if (postcondition) postcondition.newlySatisfied = !precondition?.passed && postcondition.passed;
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { action: result, stability, postcondition, changed:after.url!==before.url||after.title!==before.title||after.body!==before.body, before:{url:before.url,title:before.title}, tabId: tab.id, tabSelection:tab.selectedBy, ...interactionResult(snapshot, full) };
  } finally {
    cdp.close();
  }
}

async function scroll({ port = 9222, tabId = '', selector = '', y = 0, direction = 'down', full = false } = {}) {
  const { cdp, tab } = await attachTab({ port, tabId });
  try {
    await activateTab(tab.id, port).catch(() => {});
    const result = await cdp.eval(`(()=>{const selector=${JSON.stringify(selector)};const requested=${Number(y)||0};const sign=${JSON.stringify(direction)}==='up'?-1:1;const delta=(requested||Math.round(innerHeight*0.8))*sign;if(selector){const el=document.querySelector(selector);if(!el)return {scrolled:false};const inner=el.scrollHeight>el.clientHeight+4;if(inner){el.scrollBy({top:delta,behavior:'instant'});return {scrolled:true,target:selector,container:true,delta,scrollTop:el.scrollTop,scrollHeight:el.scrollHeight}}el.scrollIntoView({block:'center'});return {scrolled:true,target:selector,container:false,x:scrollX,y:scrollY}}scrollBy({top:delta,behavior:'instant'});return {scrolled:true,delta,x:scrollX,y:scrollY}})()`);
    if (!result?.scrolled) throw new Error(`未找到滚动目标：${selector}`);
    await sleep(350);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { action: result, tabId: tab.id, tabSelection:tab.selectedBy, ...navigationResult(snapshot, full) };
  } finally { cdp.close(); }
}

async function back({ port = 9222, tabId = '', full = false } = {}) {
  const { cdp, tab } = await attachTab({ port, tabId });
  try {
    const before = await cdp.eval(`location.href`);
    await activateTab(tab.id, port).catch(() => {});
    await cdp.eval(`history.back();true`);
    await cdp.waitFor(`location.href!==${JSON.stringify(before)}`, { timeoutMs: 12000, description: '浏览器返回' });
    const url = await cdp.eval(`location.href`);
    await cdp.waitFor(readyOrSecurity(readyExpressionFor(url)), { timeoutMs: 20000, intervalMs: 300, description: '返回后业务页面或安全页' });
    const stability = await waitForStableUi(cdp);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { before, stability, tabId: tab.id, tabSelection:tab.selectedBy, ...navigationResult(snapshot, full) };
  } finally { cdp.close(); }
}

async function wait({ port = 9222, tabId = '', selector = '', text = '', timeoutMs = 15000, full = false } = {}) {
  if (!selector && !text) throw new Error('browser-wait 需要 --selector 或 --text');
  const { cdp, tab } = await attachTab({ port, tabId });
  try {
    const expression = selector
      ? `!!document.querySelector(${JSON.stringify(selector)})`
      : `(document.body?.innerText||'').includes(${JSON.stringify(text)})`;
    await cdp.waitFor(readyOrSecurity(expression), { timeoutMs:Math.min(30000,Math.max(1000,Number(timeoutMs)||15000)), intervalMs:250, description:`${selector||text}或安全页` });
    const stability = await waitForStableUi(cdp);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { stability, tabId: tab.id, tabSelection:tab.selectedBy, ...navigationResult(snapshot, full) };
  } finally { cdp.close(); }
}

async function hover({ port = 9222, tabId = '', selector = '', text = '', index = 0, full = false } = {}) {
  if (!selector && !text) throw new Error('browser-hover 需要 --selector 或 --text');
  const { cdp, tab } = await attachTab({ port, tabId });
  try {
    await activateTab(tab.id, port).catch(() => {});
    const result = await cdp.eval(`(()=>{const selector=${JSON.stringify(selector)},wanted=${JSON.stringify(text)},nth=${Number(index)||0};const visible=el=>!!el&&el.offsetParent!==null;const tx=el=>(el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim();const pool=selector?[...document.querySelectorAll(selector)].filter(visible):[...document.querySelectorAll('a,button,[role=button],li,span,div')].filter(visible).filter(el=>tx(el)===wanted);const el=pool[nth];if(!el)return {hovered:false,candidates:pool.slice(0,10).map(tx)};el.scrollIntoView({block:'center'});for(const type of ['pointerover','mouseover','pointerenter','mouseenter','mousemove']){const C=type.startsWith('pointer')&&globalThis.PointerEvent?PointerEvent:MouseEvent;el.dispatchEvent(new C(type,{bubbles:!type.endsWith('enter'),cancelable:true,view:window,pointerType:'mouse'}))}return {hovered:true,text:tx(el),tag:el.tagName}})()`);
    if (!result?.hovered) throw new Error(`未找到悬停目标：${text || selector}`);
    await sleep(450);
    const stability = await waitForStableUi(cdp);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { action:result, stability, tabId:tab.id, tabSelection:tab.selectedBy, ...navigationResult(snapshot, full) };
  } finally { cdp.close(); }
}

async function key({ port = 9222, tabId = '', key = '', full = false } = {}) {
  const allowed = new Set(['Enter','Escape','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Backspace','Delete']);
  if (!allowed.has(key)) throw new Error(`browser-key 不支持 ${key}；可用：${[...allowed].join('/')}`);
  const { cdp, tab } = await attachTab({ port, tabId });
  try {
    await activateTab(tab.id, port).catch(() => {});
    const code = key.startsWith('Arrow') ? key : key;
    await cdp.command('Input.dispatchKeyEvent', { type:'keyDown', key, code });
    await cdp.command('Input.dispatchKeyEvent', { type:'keyUp', key, code });
    await sleep(300);
    const stability = await waitForStableUi(cdp);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { action:{key}, stability, tabId:tab.id, tabSelection:tab.selectedBy, ...navigationResult(snapshot, full) };
  } finally { cdp.close(); }
}

async function toggle({ port = 9222, tabId = '', selector = '', text = '', state = '', dryRun = false, full = false } = {}) {
  if (!selector && !text) throw new Error('browser-toggle 需要 --selector 或 --text');
  if (!['on','off'].includes(state)) throw new Error('browser-toggle 需要 --state=on|off');
  const { cdp, tab } = await attachTab({ port, tabId });
  try {
    await activateTab(tab.id, port).catch(() => {});
    const result = await cdp.eval(`(async()=>{const selector=${JSON.stringify(selector)},wanted=${JSON.stringify(text)},desired=${state === 'on' ? 'true' : 'false'},dryRun=${dryRun ? 'true' : 'false'};const visible=el=>!!el&&el.offsetParent!==null;const tx=el=>(el?.innerText||el?.textContent||'').replace(/\\s+/g,' ').trim();const context=el=>{let node=el;for(let i=0;i<6&&node;i++,node=node.parentElement){const value=tx(node);if(value.includes(wanted))return value}return ''};let el=selector?document.querySelector(selector):[...document.querySelectorAll('.ui-switch,[role=switch],input[type=checkbox]')].filter(visible).find(x=>context(x));if(!el||!visible(el))return {error:'开关不存在'};const checked=()=>el.matches('input')?!!el.checked:el.getAttribute('aria-checked')==='true'||el.classList.contains('ui-switch-checked')||el.classList.contains('checked');const before=checked();if(dryRun)return {dryRun:true,before,desired,wouldChange:before!==desired,text:context(el).slice(0,180)};if(before!==desired){el.click();for(let i=0;i<20&&checked()!==desired;i++)await new Promise(r=>setTimeout(r,150))}return {before,checked:checked(),changed:before!==checked(),text:context(el).slice(0,180)}})()`);
    if (result.error || (!dryRun && result.checked !== (state === 'on'))) throw new Error(`开关回读失败：${JSON.stringify(result)}`);
    const stability = dryRun ? null : await waitForStableUi(cdp);
    const persisted = dryRun ? null : await cdp.eval(`(()=>{const selector=${JSON.stringify(selector)},wanted=${JSON.stringify(text)};const visible=el=>!!el&&el.offsetParent!==null;const tx=el=>(el?.innerText||el?.textContent||'').replace(/\\s+/g,' ').trim();const context=el=>{let node=el;for(let i=0;i<6&&node;i++,node=node.parentElement){if(tx(node).includes(wanted))return true}return false};const el=selector?document.querySelector(selector):[...document.querySelectorAll('.ui-switch,[role=switch],input[type=checkbox]')].filter(visible).find(context);if(!el||!visible(el))return null;return el.matches('input')?!!el.checked:el.getAttribute('aria-checked')==='true'||el.classList.contains('ui-switch-checked')||el.classList.contains('checked')})()`);
    if (!dryRun && persisted !== (state === 'on')) throw new Error(`开关稳定后状态回退：目标=${state}，实际=${persisted}`);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { action:{...result,desired:state === 'on',persisted,verified:dryRun?null:persisted === (state === 'on')}, stability, recovery:dryRun?null:{state:result.before?'on':'off'}, tabId:tab.id, tabSelection:tab.selectedBy, ...interactionResult(snapshot, full) };
  } finally { cdp.close(); }
}

async function navigateConversation(cdp, { bossId = '', jobId = '', company = '', name = '' } = {}) {
  if (!bossId && !jobId && !company && !name) throw new Error('conversation-open 需要 --boss-id/--job-id，或唯一的 --company/--name');
  await cdp.navigate(ROUTES.chat);
  await cdp.waitFor(readyOrSecurity(`(()=>{let vm=document.querySelector('.friend-content-warp')?.__vue__;while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;return (vm?.$props?.dataSources||vm?.dataSources||[]).length})()`), { timeoutMs:18000, description:'消息虚拟列表数据或安全页' });
  if (await isSecurity(cdp)) return { security:true };
  const target = await cdp.eval(`(()=>{let vm=document.querySelector('.friend-content-warp')?.__vue__;while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;const rows=vm?.$props?.dataSources||vm?.dataSources||[];const bossId=${JSON.stringify(bossId)},jobId=${JSON.stringify(jobId)},company=${JSON.stringify(company)},name=${JSON.stringify(name)};const matches=rows.filter(s=>(!bossId||String(s.encryptBossId||'')===bossId)&&(!jobId||String(s.encryptJobId||'')===jobId)&&(!company||String(s.brandName||'')===company)&&(!name||String(s.name||'')===name));if(matches.length!==1)return {count:matches.length,candidates:matches.slice(0,8).map(s=>({company:s.brandName||'',name:s.name||'',bossId:s.encryptBossId||'',jobId:s.encryptJobId||''}))};const s=matches[0];return {count:1,company:s.brandName||'',name:s.name||'',bossId:s.encryptBossId||'',jobId:s.encryptJobId||'',lastMessage:s.lastText||'',lastIsSelf:!!s.lastIsSelf,lastMsgStatus:Number(s.lastMsgStatus||0),url:'/web/geek/chat?id='+encodeURIComponent(s.friendId||'')+'&jobId='+encodeURIComponent(s.encryptJobId||'')+'&securityId='+encodeURIComponent(s.encryptBossId||'')}})()`);
  if (target.count !== 1) throw new Error(`会话匹配数量 ${target.count}，必须唯一：${JSON.stringify(target.candidates || [])}`);
  await cdp.navigate(new URL(target.url, 'https://www.zhipin.com').href);
  await cdp.waitFor(readyOrSecurity(`(()=>{const t=document.querySelector('.chat-conversation')?.innerText||'';return !!document.querySelector('#chat-input')&&(t.includes(${JSON.stringify(target.company)})||t.includes(${JSON.stringify(target.name)}))})()`), { timeoutMs:18000, description:'精确目标会话或安全页' });
  if (await isSecurity(cdp)) return { security:true };
  await cdp.waitFor(`(()=>{const root=document.querySelector('.chat-conversation');const t=root?.innerText||'';return !!root&&(root.querySelectorAll('li').length>0||t.length>140||/暂无消息|还没有消息/.test(t))})()`, { timeoutMs:6000, intervalMs:200, description:'目标会话消息正文' }).catch(() => {});
  return target;
}

async function inspectConversation(cdp) {
  return cdp.eval(`(()=>{
    const root=document.querySelector('.chat-conversation');
    const clean=value=>String(value||'').replace(/\\s+/g,' ').trim();
    const rawLines=String(root?.innerText||'').split(/\\n+/).map(clean).filter(Boolean);
    const viewIndex=rawLines.findIndex(line=>line==='查看职位');
    const headerLines=rawLines.slice(0,viewIndex>=0?viewIndex:Math.min(12,rawLines.length));
    const salaryIndex=headerLines.findIndex(line=>/^(?:\\d+(?:\\.\\d+)?-\\d+(?:\\.\\d+)?K(?:·\\d+薪)?|\\d+-\\d+元\\/(?:天|时)|薪资面议)$/i.test(line));
    const jobHeader={name:headerLines[0]||'',company:headerLines[1]||'',recruiterRole:headerLines[2]||'',title:salaryIndex>0?headerLines[salaryIndex-1]:'',salary:salaryIndex>=0?headerLines[salaryIndex]:'',location:salaryIndex>=0?headerLines[salaryIndex+1]||'':'',lines:headerLines.slice(0,12)};
    const text=clean(root?.innerText||'');
    const seen=new Set();
    const visibleRows=[...(root?.querySelectorAll('li')||[])].filter(el=>el.offsetParent!==null);
    const messages=visibleRows.map(el=>clean(el.innerText)).filter(value=>value&&value.length<=600&&!seen.has(value)&&seen.add(value)).slice(-12);
    const myMessages=visibleRows.filter(el=>el.classList.contains('item-myself')).map(el=>clean(el.innerText)).filter(value=>value&&value.length<=600).slice(-12);
    const incomingMessages=visibleRows.filter(el=>!el.classList.contains('item-myself')).map(el=>clean(el.innerText)).filter(value=>value&&value.length<=600).slice(-12);
    const incomingTail=incomingMessages.slice(-8).join(' ');
    const tail=text.slice(-1200);
    const resumePrompt=/我想要一份您的附件简历|(?:请|麻烦|方便|可以|能否|能不能).{0,8}(?:发|发送|提供).{0,8}(?:附件)?简历|(?:简历|附件).{0,10}(?:发我|发一份|看一下|看下|提供一下)/.test(incomingTail);
    const resumeToolReady=!![...document.querySelectorAll('[d-c="62009"].toolbar-btn')].find(el=>el.offsetParent!==null&&!el.classList.contains('unable'));
    const loaded=messages.length>0||/暂无消息|还没有消息/.test(text);
    return { loaded, jobHeader, textTail:text.slice(-1600), messages, myMessages, incomingMessages, explicitResumeRequest:resumePrompt, hasResumeConsentPrompt:resumePrompt&&/拒绝\\s*同意/.test(tail), resumeToolReady };
  })()`);
}

async function openConversation({ port = 9222, tabId = '', bossId = '', jobId = '', company = '', name = '', full = false } = {}) {
  const { cdp, tab } = await attachTab({ port, tabId, prefer: '/web/geek/chat' });
  try {
    await activateTab(tab.id, port).catch(() => {});
    const target = await navigateConversation(cdp, { bossId, jobId, company, name });
    if (target.security) {
      const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
      return { target:null, conversation:null, warning:'精确会话导航进入安全/异常页面', tabId:tab.id, tabSelection:tab.selectedBy, ...pageResult(snapshot, full) };
    }
    let conversation = await inspectConversation(cdp);
    for (let i = 0; i < 10 && !conversation.loaded; i++) {
      await sleep(500);
      conversation = await inspectConversation(cdp);
    }
    const inputEmpty = await cdp.eval(`(()=>((document.querySelector('#chat-input')?.innerText||'').trim()===''))()`);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { target:{company:target.company,name:target.name,bossId:target.bossId,jobId:target.jobId,lastMessage:target.lastMessage,lastIsSelf:target.lastIsSelf,lastMsgStatus:target.lastMsgStatus}, conversation, inputEmpty, warning:conversation.loaded?'':'目标会话已定位，但消息正文仍未渲染；不要发送，稍后重试 conversation-open', tabId:tab.id, tabSelection:tab.selectedBy, ...pageResult(snapshot, full) };
  } finally { cdp.close(); }
}

async function replyConversation({ port = 9222, tabId = '', bossId = '', jobId = '', company = '', name = '', message = '', messages = [], expectedLastMessage = '', allowOursLast = false, full = false } = {}) {
  const outgoing = (messages.length ? messages : [message]).map(value => String(value || '').trim()).filter(Boolean);
  if (!outgoing.length) throw new Error('conversation-reply 需要非空消息');
  const { cdp, tab } = await attachTab({ port, tabId, prefer: '/web/geek/chat' });
  try {
    await activateTab(tab.id, port).catch(() => {});
    const target = await navigateConversation(cdp, { bossId, jobId, company, name });
    if (target.security) {
      const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
      return { target:null, verify:null, tabId:tab.id, tabSelection:tab.selectedBy, ...pageResult(snapshot, full) };
    }
    if (target.lastIsSelf && !allowOursLast) throw new Error(`当前最后一条仍是本人消息，禁止无回复续发：${target.lastMessage}`);
    if (expectedLastMessage && String(target.lastMessage || '').trim() !== String(expectedLastMessage).trim()) throw new Error(`会话出现新消息，请先重新 replies/conversation-open：${target.lastMessage}`);
    const sent = await cdp.eval(`(async()=>{const messages=${JSON.stringify(outgoing)};const results=[];for(const message of messages){const input=document.querySelector('#chat-input');const button=document.querySelector('button.btn-send');if(!input||!button)return {error:'输入框或发送按钮不存在',results};input.focus();input.innerHTML='';const div=document.createElement('div');div.innerText=message;input.appendChild(div);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:message}));await new Promise(r=>setTimeout(r,300));if(button.disabled||button.classList.contains('disabled'))return {error:'发送按钮不可用',results};button.click();let matched=false,lastMsgStatus=0;for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,500));let vm=document.querySelector('.friend-content-warp')?.__vue__;while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;const rows=vm?.$props?.dataSources||vm?.dataSources||[];const row=rows.find(s=>String(s.encryptBossId||'')===${JSON.stringify(target.bossId)}&&String(s.encryptJobId||'')===${JSON.stringify(target.jobId)});matched=!!(row?.lastIsSelf&&(row.lastText||'').trim()===message);lastMsgStatus=matched?Number(row.lastMsgStatus||0):0;if(matched&&lastMsgStatus>=1)break}const result={message,inputEmpty:(document.querySelector('#chat-input')?.innerText||'').trim()==='',matched,delivered:matched&&lastMsgStatus>=1,lastMsgStatus};results.push(result);if(!result.inputEmpty||!result.delivered)return {error:'消息核验失败',results}}return {inputEmpty:true,matched:true,delivered:true,lastMsgStatus:results.at(-1)?.lastMsgStatus||0,results}})()`);
    if (sent.error || !sent.inputEmpty || !sent.matched || !sent.delivered) throw new Error(`回复核验失败：${JSON.stringify(sent)}`);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { target:{company:target.company,name:target.name,bossId:target.bossId,jobId:target.jobId}, message:outgoing.at(-1), messages:outgoing, verify:sent, tabId:tab.id, tabSelection:tab.selectedBy, ...pageResult(snapshot, full) };
  } finally { cdp.close(); }
}

async function sendResume({ port = 9222, tabId = '', bossId = '', jobId = '', company = '', name = '', resume = '', allowPositive = false, dryRun = false, full = false } = {}) {
  if (!String(resume).trim()) throw new Error('resume-send 需要 --resume=精确附件名');
  const { cdp, tab } = await attachTab({ port, tabId, prefer: '/web/geek/chat' });
  try {
    await activateTab(tab.id, port).catch(() => {});
    const target = await navigateConversation(cdp, { bossId, jobId, company, name });
    if (target.security) {
      const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
      return { target:null, verify:null, resume:String(resume).trim(), tabId:tab.id, tabSelection:tab.selectedBy, ...pageResult(snapshot, full) };
    }
    const base = String(resume).trim().replace(/\.pdf$/i, '');
    let conversation = await inspectConversation(cdp);
    for (let i = 0; i < 10 && !conversation.loaded; i++) {
      await sleep(500);
      conversation = await inspectConversation(cdp);
    }
    const alreadySent = [
      `您的附件简历 ${base} 已发送给Boss`,
      `附件简历 ${base} 已发送给对方`,
      `附件简历请求已发送 ${String(resume).trim()}`,
      `${String(resume).trim()} 点击预览附件简历`,
    ].some(marker => conversation.textTail.includes(marker));
    if (alreadySent) return { skipped:'already_sent', target, resume:String(resume).trim(), tabId:tab.id, tabSelection:tab.selectedBy };
    const resumeDeclined = /(?:不用|不需要|无需|先别|暂时不(?:用|要)).{0,8}(?:发|发送|提供)?.{0,5}(?:简历|附件)|(?:简历|附件).{0,8}(?:不用|不需要|无需|先别|暂时不(?:用|要))/.test(target.lastMessage || '');
    if (resumeDeclined) throw new Error(`对方最后一条明确不需要简历/附件，禁止发送：${target.lastMessage}`);
    const explicit = !target.lastIsSelf && (/简历|附件/.test(target.lastMessage || '') || conversation.explicitResumeRequest);
    if (!explicit && !allowPositive) throw new Error(`对方最后一条未明确索要简历，禁止自动发送：${target.lastMessage}`);
    const triggerEvidence = { listLastMessage:target.lastMessage, explicitResumeRequest:conversation.explicitResumeRequest, hasResumeConsentPrompt:conversation.hasResumeConsentPrompt, textTail:conversation.textTail };
    let resumeToolReady = !!conversation.resumeToolReady;
    for (let i = 0; i < 12 && !resumeToolReady; i++) {
      await sleep(250);
      resumeToolReady = await cdp.eval(`!![...document.querySelectorAll('[d-c="62009"].toolbar-btn')].find(el=>el.offsetParent!==null&&!el.classList.contains('unable'))`);
    }
    if (!resumeToolReady && conversation.hasResumeConsentPrompt) {
      const consentAction = await cdp.eval(`(()=>{const visible=el=>el.offsetParent!==null;const buttons=[...document.querySelectorAll('button,a,span,[role=button]')].filter(visible);const agree=buttons.filter(el=>(el.innerText||'').trim()==='同意');const reject=buttons.filter(el=>(el.innerText||'').trim()==='拒绝');return {required:true,agreeCount:agree.length,rejectCount:reject.length,warning:'点击同意可能先发送 BOSS 在线简历；附件工具栏当前尚未解锁'}})()`);
      if (dryRun) return { dryRun:true, target:{company:target.company,name:target.name,bossId:target.bossId,jobId:target.jobId}, triggerEvidence, resume:String(resume).trim(), consentAction, attachmentCheck:{deferred:true,reason:'需先处理 BOSS 正式简历同意卡片'}, tabId:tab.id, tabSelection:tab.selectedBy };
      throw new Error(`BOSS 正式简历同意卡片尚未处理，当前不会自动点击“同意”：${JSON.stringify(consentAction)}`);
    }
    if (dryRun) {
      const attachmentCheck = await cdp.eval(`(async()=>{
        const resume=${JSON.stringify(String(resume).trim())};
        const fire=el=>{el.scrollIntoView({block:'center'});for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){const C=type.startsWith('pointer')&&globalThis.PointerEvent?PointerEvent:MouseEvent;el.dispatchEvent(new C(type,{bubbles:true,cancelable:true,view:window,button:0,pointerType:'mouse'}))}};
        const tool=[...document.querySelectorAll('[d-c="62009"].toolbar-btn')].find(el=>el.offsetParent!==null&&!el.classList.contains('unable'));
        if(!tool)return {error:'发简历按钮未解锁'};
        fire(tool);
        for(let i=0;i<20&&!document.querySelector('.choose-resume-dialog');i++)await new Promise(r=>setTimeout(r,250));
        const dialog=document.querySelector('.choose-resume-dialog');
        if(!dialog)return {error:'简历选择框未出现'};
        const available=[...dialog.querySelectorAll('.resume-list .list-item')].map(row=>(row.querySelector('.resume-name')?.innerText||'').trim()).filter(Boolean);
        const matchCount=available.filter(name=>name===resume).length;
        const close=[...dialog.querySelectorAll('button,a,span,i,[class*="close"]')].find(el=>el.offsetParent!==null&&(/关闭|取消/.test((el.innerText||el.getAttribute('aria-label')||'').trim())||/close/.test(String(el.className||''))));
        if(close)fire(close);else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
        return {matchedResume:resume,matchCount,available};
      })()`);
      if (attachmentCheck.error || attachmentCheck.matchCount !== 1) throw new Error(`简历干运行检查失败：${JSON.stringify(attachmentCheck)}`);
      return { dryRun:true, target:{company:target.company,name:target.name,bossId:target.bossId,jobId:target.jobId}, triggerEvidence, resume:String(resume).trim(), attachmentCheck, tabId:tab.id, tabSelection:tab.selectedBy };
    }
    const result = await cdp.eval(`(async()=>{const resume=${JSON.stringify(String(resume).trim())};const fire=el=>{el.scrollIntoView({block:'center'});for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){const C=type.startsWith('pointer')&&globalThis.PointerEvent?PointerEvent:MouseEvent;el.dispatchEvent(new C(type,{bubbles:true,cancelable:true,view:window,button:0,pointerType:'mouse'}))}};const tool=[...document.querySelectorAll('[d-c="62009"].toolbar-btn')].find(e=>e.offsetParent!==null&&!e.classList.contains('unable'));if(!tool)return {error:'发简历按钮未解锁'};fire(tool);for(let i=0;i<20&&!document.querySelector('.choose-resume-dialog');i++)await new Promise(r=>setTimeout(r,250));const dialog=document.querySelector('.choose-resume-dialog');if(!dialog)return {error:'简历选择框未出现'};const rows=[...dialog.querySelectorAll('.resume-list .list-item')];const matches=rows.filter(row=>(row.querySelector('.resume-name')?.innerText||'').trim()===resume);if(matches.length!==1)return {error:'附件名必须唯一',available:rows.map(row=>(row.querySelector('.resume-name')?.innerText||'').trim())};fire(matches[0]);await new Promise(r=>setTimeout(r,250));const button=dialog.querySelector('.btn-confirm');if(!button||button.disabled)return {error:'附件发送按钮不可用'};fire(button);const base=resume.replace(/\\.pdf$/i,'');let matched=false,lastMessage='',lastMsgStatus=0;for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,500));let vm=document.querySelector('.friend-content-warp')?.__vue__;while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;const rows=vm?.$props?.dataSources||vm?.dataSources||[];const row=rows.find(s=>String(s.encryptBossId||'')===${JSON.stringify(target.bossId)}&&String(s.encryptJobId||'')===${JSON.stringify(target.jobId)});lastMessage=row?.lastText||'';matched=!!(row?.lastIsSelf&&String(lastMessage).includes('附件简历')&&String(lastMessage).includes(base));lastMsgStatus=matched?Number(row.lastMsgStatus||0):0;if(matched&&lastMsgStatus>=1)return {matched:true,delivered:true,lastMessage,lastMsgStatus}}return {matched,delivered:false,lastMessage,lastMsgStatus}})()`);
    if (result.error || !result.matched || !result.delivered) throw new Error(`简历发送核验失败：${JSON.stringify(result)}`);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { target:{company:target.company,name:target.name,bossId:target.bossId,jobId:target.jobId}, triggerEvidence, resume:String(resume).trim(), verify:result, tabId:tab.id, tabSelection:tab.selectedBy, ...pageResult(snapshot, full) };
  } finally { cdp.close(); }
}

async function fill({ port = 9222, tabId = '', selector = '', text = '', value, dryRun = false, full = false } = {}) {
  if (!selector && !text) throw new Error('browser-fill 需要 --selector 或 --text');
  if (!dryRun && (value === undefined || value === null)) throw new Error('browser-fill 需要 BOSS_VALUE 环境变量或 --value');
  const { cdp, tab } = await attachTab({ port, tabId });
  try {
    await activateTab(tab.id, port).catch(() => {});
    const result = await cdp.eval(`(()=>{const selector=${JSON.stringify(selector)},wanted=${JSON.stringify(text)};const visible=el=>!!el&&el.offsetParent!==null;const tx=el=>(el?.innerText||el?.textContent||'').replace(/\\s+/g,' ').trim();const context=el=>{const direct=el.getAttribute('aria-label')||el.placeholder||el.getAttribute('data-placeholder')||'';if(direct)return direct;const byFor=el.id?document.querySelector('label[for='+JSON.stringify(el.id)+']'):null;if(byFor&&tx(byFor))return tx(byFor);let node=el.parentElement;for(let i=0;i<5&&node;i++,node=node.parentElement){const value=tx(node);if(value.length>=2&&value.length<=220)return value}return ''};const all=[...document.querySelectorAll('input,textarea,select,[contenteditable=true]')].filter(visible);let pool=selector?[document.querySelector(selector)].filter(visible):all.filter(el=>{const direct=[el.getAttribute('aria-label'),el.placeholder,el.getAttribute('data-placeholder'),el.name,el.id].filter(Boolean);return direct.includes(wanted)||context(el)===wanted||context(el).includes(wanted)});if(pool.length!==1)return {filled:false,error:'字段必须唯一',count:pool.length,candidates:pool.slice(0,12).map(el=>({tag:el.tagName.toLowerCase(),placeholder:el.placeholder||el.getAttribute('data-placeholder')||'',context:context(el).slice(0,160)}))};const el=pool[0];const proposed=${value == null ? 'null' : JSON.stringify(String(value))},dryRun=${dryRun ? 'true' : 'false'};const current=el.matches('input,textarea,select')?String(el.value||''):el.isContentEditable?String(el.innerText||''):'';const base={tag:el.tagName,id:el.id||'',name:el.name||'',placeholder:el.placeholder||el.getAttribute('data-placeholder')||'',context:context(el).slice(0,220),current:current.slice(0,240)};if(dryRun)return {...base,dryRun:true,found:true,proposed:proposed===null?null:proposed.slice(0,240),wouldChange:proposed===null?null:current!==proposed};const value=proposed;el.focus();if(el.matches('input,textarea,select')){const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(el,value);else el.value=value;}else if(el.isContentEditable){el.innerText=value;}else return {filled:false};el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));el.dispatchEvent(new Event('change',{bubbles:true}));return {...base,filled:true,value:String(el.value||el.innerText||'').slice(0,240)};})()`);
    if (result?.error || (!dryRun && (!result?.filled || result.value !== String(value))) || (dryRun && !result?.found)) throw new Error(`填写后 DOM 回读失败：${selector || text}；${JSON.stringify(result)}`);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { action:{...result,domVerified:dryRun?null:result.value===String(value),persisted:false}, recovery:dryRun?null:{value:result.current}, tabId: tab.id, tabSelection:tab.selectedBy, ...interactionResult(snapshot, full) };
  } finally {
    cdp.close();
  }
}

async function select({ port = 9222, tabId = '', selector = '', text = '', option = '', dryRun = false, full = false } = {}) {
  if (!selector && !text) throw new Error('browser-select 需要 --selector 或 --text');
  if (!String(option).trim()) throw new Error('browser-select 需要 --option');
  const { cdp, tab } = await attachTab({ port, tabId });
  try {
    await activateTab(tab.id, port).catch(() => {});
    const result = await cdp.eval(`(async()=>{
      const selector=${JSON.stringify(selector)},wanted=${JSON.stringify(text)},option=${JSON.stringify(String(option).trim())},dryRun=${dryRun ? 'true' : 'false'};
      const visible=el=>!!el&&el.offsetParent!==null&&(()=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0})();
      const tx=el=>(el?.innerText||el?.textContent||el?.value||'').replace(/\\s+/g,' ').trim();
      const context=el=>{let node=el;for(let i=0;i<6&&node;i++,node=node.parentElement){const value=tx(node);if(value.includes(wanted))return value}return ''};
      let control=selector?document.querySelector(selector):[...document.querySelectorAll('select,[role=combobox],.ui-select,.dropdown,.select')].filter(visible).find(el=>tx(el).includes(wanted)||context(el));
      if(control?.matches('input'))control=control.closest('div[ka*="edit"],[role=combobox],.ui-select,.dropdown,.select')||control;
      if(!control||!visible(control))return {error:'下拉控件不存在'};
      if(control.tagName==='SELECT'){
        const choices=[...control.options];
        const match=choices.find(x=>x.value===option||tx(x)===option);
        if(!match)return {error:'选项不存在',available:choices.map(x=>({text:tx(x),value:x.value})).slice(0,30)};
        const before=control.value;
        if(dryRun)return {dryRun:true,found:true,before,proposed:match.value,text:tx(match),wouldChange:before!==match.value,available:choices.map(x=>({text:tx(x),value:x.value})).slice(0,30)};
        control.value=match.value;
        control.dispatchEvent(new Event('input',{bubbles:true}));
        control.dispatchEvent(new Event('change',{bubbles:true}));
        await new Promise(r=>setTimeout(r,300));
        return {selected:true,before,value:control.value,text:tx(match),changed:before!==control.value};
      }
      const current=[...control.querySelectorAll('input')].find(el=>String(el.value||'').trim()===option);
      if(current)return dryRun?{dryRun:true,found:true,before:option,proposed:option,wouldChange:false,alreadySelected:true}:{selected:true,before:option,value:option,text:option,changed:false,alreadySelected:true};
      const fire=el=>{el.scrollIntoView({block:'center'});for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){const C=type.startsWith('pointer')&&globalThis.PointerEvent?PointerEvent:MouseEvent;el.dispatchEvent(new C(type,{bubbles:true,cancelable:true,view:window,button:0,pointerType:'mouse'}))}};
      const trigger=control.querySelector('.ui-cascader-selection,.ui-select-selection,[role=combobox],input')||control;
      fire(trigger);await new Promise(r=>setTimeout(r,350));
      const visibleOptions=[...document.querySelectorAll('[role=option],.ui-select-item,.ui-select-dropdown li,.dropdown-menu li,.option-list li,.menu-item,li')].filter(visible);
      const pool=visibleOptions.filter(el=>tx(el)===option);
      if(pool.length!==1)return {error:'可见选项必须唯一',count:pool.length,candidates:pool.slice(0,20).map(tx)};
      const before=tx(control);if(dryRun){fire(trigger);return {dryRun:true,found:true,before,proposed:option,wouldChange:!before.includes(option),available:[...new Set(visibleOptions.map(tx).filter(Boolean))].slice(0,30)}}fire(pool[0]);await new Promise(r=>setTimeout(r,400));
      return {selected:true,before,value:tx(control),text:option,changed:before!==tx(control)};
    })()`);
    if (result.error || (!dryRun && !result.selected) || (dryRun && !result.found)) throw new Error(`下拉选择失败：${JSON.stringify(result)}`);
    const stability = dryRun ? null : await waitForStableUi(cdp);
    const verified = dryRun ? null : result.alreadySelected || result.value === String(option) || String(result.value || '').includes(String(option));
    if (!dryRun && !verified) throw new Error(`下拉选择后未回读到目标值：目标=${option}，实际=${JSON.stringify(result)}`);
    const snapshot = await cdp.eval(snapshotExpression(full ? 120 : 20));
    return { action:{...result,verified}, stability, recovery:dryRun?null:{value:result.before}, tabId:tab.id, tabSelection:tab.selectedBy, ...interactionResult(snapshot, full) };
  } finally { cdp.close(); }
}

module.exports = { ROUTES, back, capabilities, click, fill, hover, inspectTabs, isDangerousTarget, key, open, openConversation, replyConversation, scroll, select, sendResume, snapshot, toggle, wait };
