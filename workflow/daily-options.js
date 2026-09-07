const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.BOSS_CDP_PORT || 9222);
const FILE = path.join(DATA_DIR, `daily-options.${PORT}.json`);
const RESUME_MODES = ['off', 'explicit', 'positive'];
const RESUME_MAPPING = require('./reins-config').loadConfig().resumes;

const now = () => new Date().toISOString();
const chinaDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

function loadDailyOptions() {
  let value = {};
  try { value = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const current = value.date === chinaDate();
  return {
    date: current ? value.date : chinaDate(),
    resumeMode: current && RESUME_MODES.includes(value.resumeMode) ? value.resumeMode : 'unset',
    needsChoice: !(current && RESUME_MODES.includes(value.resumeMode)),
    resumeMapping: RESUME_MAPPING,
    updatedAt: current ? value.updatedAt || '' : '',
  };
}

function saveDailyOptions(mode) {
  if (!RESUME_MODES.includes(mode)) throw new Error(`--resume 只能是 ${RESUME_MODES.join('/')}`);
  fs.writeFileSync(FILE, JSON.stringify({ date: chinaDate(), resumeMode: mode, resumeMapping: RESUME_MAPPING, updatedAt: now() }, null, 2));
  return loadDailyOptions();
}

module.exports = { RESUME_MODES, RESUME_MAPPING, loadDailyOptions, saveDailyOptions };
