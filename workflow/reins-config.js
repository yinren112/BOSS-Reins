// 个人化配置的唯一入口。代码里不允许再出现任何具体的人名、链接、项目名、数字。
// 读取顺序：REINS_CONFIG 环境变量指定的文件 > 仓库根目录 reins.config.json（gitignore）> reins.config.example.json。
// 事实文件（facts.md）和岗位方向（profiles.json）同样走「真实文件 > example」的回退，
// 所以自测永远跑在 example 数据上，真实数据不会进仓库。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveWithFallback(name) {
  const real = path.join(ROOT, name);
  if (fs.existsSync(real)) return real;
  const example = path.join(ROOT, name.replace(/(\.[a-z]+)$/i, '.example$1'));
  if (fs.existsSync(example)) return example;
  throw new Error(`缺少 ${name}，也没有对应的 example 文件`);
}

let cached = null;
function loadConfig() {
  if (cached) return cached;
  const file = process.env.REINS_CONFIG
    ? path.resolve(ROOT, process.env.REINS_CONFIG)
    : resolveWithFallback('reins.config.json');
  const raw = readJson(file);
  const opener = raw.opener || {};
  const toRegex = (list, flags = 'i') => new RegExp((list || []).filter(Boolean).join('|') || '(?!)', flags);
  cached = {
    file,
    isExample: /\.example\.json$/.test(file),
    loginName: String(raw.loginName || ''),
    cycleStart: Date.parse(raw.cycleStart || '2000-01-01T00:00:00Z'),
    allowedLinks: (raw.links?.allowed || []).map(String),
    resumes: { development: '', aiAgent: '', adjacent: '', ...(raw.resumes || {}) },
    factsFile: resolveWithFallback(raw.factsFile || 'facts.md'),
    profilesFile: resolveWithFallback(raw.profilesFile || 'profiles.json'),
    opener: {
      min: Number(opener.min) || 120,
      max: Number(opener.max) || 200,
      factAnchorList: opener.factAnchors || [],
      factAnchor: toRegex(opener.factAnchors),
      bannedNumberList: opener.bannedNumbers || [],
      bannedNumbers: toRegex(opener.bannedNumbers, ''),
      unconfirmedTech: toRegex(opener.unconfirmedTech),
      bannedClaims: toRegex(opener.bannedClaims),
      anchorKeys: Object.entries(opener.anchorKeys || {}).map(([key, pattern]) => [key, new RegExp(pattern, 'i')]),
      bannedNumbersHint: (opener.bannedNumbersHint || []).join('/'),
    },
  };
  return cached;
}

// 开场白里允许出现的链接：只认配置里列出的作品主页/GitHub，其余一律拒
function linkAllowed(text, config = loadConfig()) {
  const urls = String(text || '').match(/(?:https?:\/\/|www\.)?(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s）)]*)?/gi) || [];
  return urls.every(url => config.allowedLinks.some(allowed => url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').startsWith(allowed)));
}

// 「（作品：…）」是程序统一追加的后缀，门禁比较正文前先剥掉
const stripPortfolioSuffix = text => String(text || '').replace(/（作品：[^）\n]*）/g, '');

module.exports = { ROOT, loadConfig, linkAllowed, stripPortfolioSuffix, resolveWithFallback };
