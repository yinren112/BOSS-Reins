const browser = require('./browser');
const { arg, positional } = require('./cli-args');
const { PORT, throwSecurity } = require('./safety');

const hasFlag = name => process.argv.includes(`--${name}`);
const print = value => console.log(JSON.stringify(value, null, 2));
const assertSafe = (result, message) => {
  if (result.security) throwSecurity(message, `${result.url} ${result.title}`);
  return result;
};
const common = () => ({ port: PORT, tabId: arg('tab'), full: hasFlag('full') });

async function browserTabs() {
  const result = await browser.inspectTabs({ port: PORT });
  const security = result.tabs.filter(tab => tab.security);
  if (security.length) throwSecurity('browser-tabs 发现安全/异常页面', security.map(tab => `${tab.url} ${tab.title}`).join(' ; '));
  print(result);
}

function capabilities() {
  print(browser.capabilities());
}

async function browserSnapshot() {
  print(assertSafe(await browser.snapshot(common()), 'browser-snapshot 发现安全/异常页面'));
}

async function browserOpen() {
  const destination = positional() || arg('url') || arg('route');
  if (!destination) throw new Error('browser-open 需要页面别名或 BOSS URL');
  print(assertSafe(await browser.open({ ...common(), destination }), 'browser-open 进入安全/异常页面'));
}

async function browserClick() {
  const result = await browser.click({
    ...common(), selector: arg('selector'), text: arg('text'), index: Number(arg('index') || 0),
    contains: hasFlag('contains'), allowAction: hasFlag('allow-action'), dryRun: hasFlag('dry-run'),
    expectText: arg('expect-text'), expectSelector: arg('expect-selector'), expectAbsent: arg('expect-absent'),
  });
  print(assertSafe(result, 'browser-click 后进入安全/异常页面'));
}

async function browserFill() {
  const hasEnvValue = Object.prototype.hasOwnProperty.call(process.env, 'BOSS_VALUE');
  const hasArgValue = process.argv.some(token => token === '--value' || token.startsWith('--value='));
  const value = hasEnvValue ? process.env.BOSS_VALUE : hasArgValue ? arg('value') : undefined;
  const result = await browser.fill({ ...common(), selector:arg('selector'), text:arg('text'), value, dryRun:hasFlag('dry-run') });
  print(assertSafe(result, 'browser-fill 后进入安全/异常页面'));
}

async function browserSelect() {
  const result = await browser.select({ ...common(), selector:arg('selector'), text:arg('text'), option:arg('option'), dryRun:hasFlag('dry-run') });
  print(assertSafe(result, 'browser-select 后进入安全/异常页面'));
}

async function browserScroll() {
  const result = await browser.scroll({ ...common(), selector:arg('selector'), y:Number(arg('y') || 0), direction:arg('direction') || 'down' });
  print(assertSafe(result, 'browser-scroll 后进入安全/异常页面'));
}

async function browserBack() {
  print(assertSafe(await browser.back(common()), 'browser-back 后进入安全/异常页面'));
}

async function browserWait() {
  const result = await browser.wait({ ...common(), selector:arg('selector'), text:arg('text'), timeoutMs:Number(arg('timeout') || 15000) });
  print(assertSafe(result, 'browser-wait 发现安全/异常页面'));
}

async function browserHover() {
  const result = await browser.hover({ ...common(), selector:arg('selector'), text:arg('text'), index:Number(arg('index') || 0) });
  print(assertSafe(result, 'browser-hover 后进入安全/异常页面'));
}

async function browserKey() {
  const result = await browser.key({ ...common(), key:arg('key') || positional() });
  print(assertSafe(result, 'browser-key 后进入安全/异常页面'));
}

async function browserToggle() {
  const result = await browser.toggle({ ...common(), selector:arg('selector'), text:arg('text'), state:arg('state'), dryRun:hasFlag('dry-run') });
  print(assertSafe(result, 'browser-toggle 后进入安全/异常页面'));
}

module.exports = {
  capabilities, browserTabs, browserSnapshot, browserOpen, browserClick, browserFill,
  browserSelect, browserScroll, browserBack, browserWait, browserHover, browserKey, browserToggle,
};
