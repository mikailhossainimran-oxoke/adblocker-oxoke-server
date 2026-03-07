const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const TRIAL_FILE = path.join(__dirname, 'trials.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'oxoke_admin_2025';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO  = process.env.GITHUB_REPO  || '';

// ============================================================
// GITHUB PERSISTENT STORAGE
// ============================================================
let _trialsMemory = null;
let _trialsSha = null;
let _configMemory = null;
let _configSha = null;

async function ghRequest(method, path2, body) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return null;
  const https = require('https');
  const bodyStr = body ? JSON.stringify(body) : null;
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.github.com',
      path: '/repos/' + GITHUB_REPO + '/contents/' + path2,
      method: method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'OXOKE-Server',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', x => d += x);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// --- TRIALS ---
async function loadTrialsFromGitHub() {
  const res = await ghRequest('GET', 'trials.json', null);
  if (res && res.content) {
    _trialsSha = res.sha;
    _trialsMemory = JSON.parse(Buffer.from(res.content, 'base64').toString('utf8'));
    console.log('✅ Trials loaded from GitHub:', Object.keys(_trialsMemory.used_pcs||{}).length, 'PCs');
    return true;
  }
  return false;
}
async function saveTrialsToGitHub(data) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = { message: 'update trials', content, sha: _trialsSha };
  const res = await ghRequest('PUT', 'trials.json', body);
  if (res && res.content) _trialsSha = res.content.sha;
}

// --- CONFIG (GitHub persistent) ---
async function loadConfigFromGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return false;
  const res = await ghRequest('GET', 'oxoke-config.json', null);
  if (res && res.content) {
    _configSha = res.sha;
    _configMemory = JSON.parse(Buffer.from(res.content, 'base64').toString('utf8'));
    console.log('✅ Config loaded from GitHub:', JSON.stringify(_configMemory));
    return true;
  }
  return false;
}
async function saveConfigToGitHub(cfg) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  const content = Buffer.from(JSON.stringify(cfg, null, 2)).toString('base64');
  const body = { message: 'update config', content, sha: _configSha };
  const res = await ghRequest('PUT', 'oxoke-config.json', body);
  if (res && res.content) _configSha = res.content.sha;
}

app.use(cors());
app.use(express.json());

// ==============================
// DATA HELPERS
// ==============================
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const seed = path.join(__dirname, 'codes_seed.json');
    if (fs.existsSync(seed)) fs.copyFileSync(seed, DATA_FILE);
    else fs.writeFileSync(DATA_FILE, JSON.stringify({ activation_codes: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

function loadTrials() {
  if (_trialsMemory) return _trialsMemory;
  if (fs.existsSync(TRIAL_FILE)) {
    try { _trialsMemory = JSON.parse(fs.readFileSync(TRIAL_FILE, 'utf-8')); return _trialsMemory; } catch(e) {}
  }
  _trialsMemory = { used_pcs: {} };
  return _trialsMemory;
}
async function saveTrials(data) {
  _trialsMemory = data;
  try { fs.writeFileSync(TRIAL_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
  await saveTrialsToGitHub(data).catch(()=>{});
}

// CONFIG: memory → local file — GitHub সবসময় persist করে
function loadConfig() {
  if (_configMemory) return {
    trial_duration_ms:  _configMemory.trial_duration_ms  || (2 * 60 * 60 * 1000),
    trial_enabled:      _configMemory.trial_enabled      !== undefined ? _configMemory.trial_enabled      : true,
    extension_enabled:  _configMemory.extension_enabled  !== undefined ? _configMemory.extension_enabled  : true,
    unlimited_retry:    _configMemory.unlimited_retry    || false,
    allow_retry_trial:  _configMemory.allow_retry_trial  || false,
  };
  // Fallback: local data.json
  const d = loadData();
  return {
    trial_duration_ms:  d.trial_duration_ms  || (2 * 60 * 60 * 1000),
    trial_enabled:      d.trial_enabled      !== undefined ? d.trial_enabled      : true,
    extension_enabled:  d.extension_enabled  !== undefined ? d.extension_enabled  : true,
    unlimited_retry:    d.unlimited_retry    || false,
    allow_retry_trial:  d.allow_retry_trial  || false,
  };
}
function saveConfig(cfg) {
  _configMemory = cfg;
  // Local backup
  const d = loadData();
  Object.assign(d, cfg);
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
  // GitHub (async, fire and forget — but we also await in admin routes)
  saveConfigToGitHub(cfg).catch(()=>{});
}

function hashId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
}
function generateTrialKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const seg = (n) => Array.from({length:n}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  return `TRIAL-${seg(5)}-${seg(5)}`;
}

// ==============================
// AUTO UPDATE
// ==============================
app.get('/AdBlocker-OXOKE.crx', (req, res) => {
  const crxPath = path.join(__dirname, 'AdBlocker-OXOKE.crx');
  if (!fs.existsSync(crxPath)) return res.status(404).json({ error: 'CRX not found' });
  res.setHeader('Content-Type', 'application/x-chrome-extension');
  res.sendFile(crxPath);
});
app.get('/update.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.send(`<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='hanpdoglmphfojcpojbkpbdbbgidnggc'>
    <updatecheck
      codebase='https://adblocker-oxoke-server.onrender.com/AdBlocker-OXOKE.crx'
      version='${process.env.EXT_VERSION || '0.0.1'}' />
  </app>
</gupdate>`);
});
app.get('/', (req, res) => {
  res.json({ status: 'OXOKE Server Running', version: '5.0.0' });
});

// ==============================
// PUBLIC: Extension & Trial Status
// ==============================
app.get('/api/status', async (req, res) => {
  if (!_configMemory && GITHUB_TOKEN && GITHUB_REPO) await loadConfigFromGitHub().catch(()=>{});
  const cfg = loadConfig();
  return res.json({
    extension_enabled: cfg.extension_enabled !== false,
    trial_enabled:     cfg.trial_enabled     !== false
  });
});

app.get('/api/trial-duration', (req, res) => {
  const cfg = loadConfig();
  return res.json({ success: true, duration_ms: cfg.trial_duration_ms || (2 * 60 * 60 * 1000) });
});

// ==============================
// POST /api/get-trial
// ==============================
app.post('/api/get-trial', async (req, res) => {
  const { pc_fingerprint } = req.body;
  if (!pc_fingerprint) return res.status(400).json({ success: false, message: 'Missing pc_fingerprint' });

  if (!_configMemory && GITHUB_TOKEN && GITHUB_REPO) await loadConfigFromGitHub().catch(()=>{});
  const cfg = loadConfig();

  // Extension disabled?
  if (!cfg.extension_enabled) {
    return res.status(403).json({ success: false, message: 'Extension under maintenance.', maintenance: true });
  }
  // Trial globally disabled?
  if (!cfg.trial_enabled) {
    return res.status(403).json({ success: false, message: 'Free trial is currently disabled.', trial_disabled: true });
  }

  const hashedPc = hashId(pc_fingerprint);
  if (!_trialsMemory && GITHUB_TOKEN && GITHUB_REPO) await loadTrialsFromGitHub().catch(()=>{});

  const trials = loadTrials();
  console.log(`[get-trial] PC: ${hashedPc.slice(0,8)}... | Total: ${Object.keys(trials.used_pcs||{}).length}`);

  if (trials.used_pcs[hashedPc]) {
    const prev = trials.used_pcs[hashedPc];
    // Still active?
    if (new Date(prev.expiry).getTime() > Date.now()) {
      return res.json({ success: true, key: prev.key, expiry: prev.expiry, duration_ms: cfg.trial_duration_ms, message: 'Trial reactivated.' });
    }
    // Expired — retry?
    const canRetry = cfg.unlimited_retry === true || cfg.allow_retry_trial === true;
    if (canRetry) {
      const trialDurationMs = cfg.trial_duration_ms || (2 * 60 * 60 * 1000);
      const newExpiry = new Date(Date.now() + trialDurationMs).toISOString();
      const newKey = generateTrialKey();
      trials.used_pcs[hashedPc] = { key: newKey, expiry: newExpiry, created: new Date().toISOString(), retried: true };
      await saveTrials(trials);
      return res.json({ success: true, key: newKey, expiry: newExpiry, type: 'trial', duration_ms: trialDurationMs, message: 'Trial restarted.' });
    }
    return res.status(403).json({ success: false, message: 'Free trial already used. Purchase a license: +8801811507607' });
  }

  // New trial
  const trialKey = generateTrialKey();
  const trialDurationMs = cfg.trial_duration_ms || (2 * 60 * 60 * 1000);
  const expiry = new Date(Date.now() + trialDurationMs).toISOString();
  trials.used_pcs[hashedPc] = { key: trialKey, expiry, created: new Date().toISOString() };
  await saveTrials(trials);
  return res.json({ success: true, key: trialKey, expiry, type: 'trial', duration_ms: trialDurationMs, message: 'Trial activated!' });
});

// ==============================
// PUBLIC: Check trial status
// ==============================
app.post('/api/check-trial-status', async (req, res) => {
  const { pc_fingerprint } = req.body;
  if (!pc_fingerprint) return res.json({ used: false });

  if (!_configMemory && GITHUB_TOKEN && GITHUB_REPO) await loadConfigFromGitHub().catch(()=>{});
  const cfg = loadConfig();

  if (!cfg.extension_enabled) return res.json({ maintenance: true, used: false });
  if (!cfg.trial_enabled)     return res.json({ trial_disabled: true, used: false });

  const hashedPc = hashId(pc_fingerprint);
  if (!_trialsMemory && GITHUB_TOKEN && GITHUB_REPO) {
    await loadTrialsFromGitHub().catch(()=>{});
    if (!_trialsMemory) return res.json({ used: true, retry_allowed: false, reason: 'data_loading' });
  }

  const trials = loadTrials();
  const record = trials.used_pcs[hashedPc];
  if (!record) return res.json({ used: false });

  const isExpired = record.expiry && Date.now() > new Date(record.expiry).getTime();
  if (!isExpired) {
    return res.json({ used: true, active: true, expiry: record.expiry, retry_allowed: false });
  }
  const retryAllowed = cfg.unlimited_retry === true || cfg.allow_retry_trial === true;
  return res.json({ used: true, active: false, expiry: record.expiry || null, retry_allowed: retryAllowed });
});

// ==============================
// ACTIVATE / VERIFY
// ==============================
app.post('/api/activate', (req, res) => {
  const { code, pc_fingerprint } = req.body;
  if (!code || !pc_fingerprint) return res.status(400).json({ success: false, message: 'Missing fields' });
  const nc = code.toUpperCase().trim();
  const hashedPc = hashId(pc_fingerprint);
  const data = loadData();
  const cd = data.activation_codes[nc];
  if (!cd) return res.status(404).json({ success: false, message: 'Invalid key. Contact: +8801811507607' });
  if (!cd.active) return res.status(403).json({ success: false, message: 'Key disabled. Contact: +8801811507607' });
  if (cd.expiry && new Date(cd.expiry).getTime() < Date.now()) return res.status(403).json({ success: false, message: 'Key expired. Contact: +8801811507607' });
  if (!cd.locked_pc) {
    cd.locked_pc = hashedPc;
    cd.activated_at = new Date().toISOString();
    if (!cd.expiry) {
      const ms = cd.expiry_ms || ((cd.expiry_days || 30) * 24 * 60 * 60 * 1000);
      cd.expiry = new Date(Date.now() + ms).toISOString();
    }
    saveData(data);
    return res.json({ success: true, type: 'monthly', expiry: cd.expiry, message: 'Activation successful!' });
  }
  if (cd.locked_pc === hashedPc) return res.json({ success: true, type: 'monthly', expiry: cd.expiry, message: 'License verified.' });
  return res.status(403).json({ success: false, message: 'Key already activated on another PC. Contact: +8801811507607' });
});

app.post('/api/verify', (req, res) => {
  const { code, pc_fingerprint } = req.body;
  if (!code || !pc_fingerprint) return res.json({ valid: false });
  const nc = code.toUpperCase().trim();
  if (nc.startsWith('TRIAL-')) {
    const hashedPc = hashId(pc_fingerprint);
    const trials = loadTrials();
    const entry = trials.used_pcs[hashedPc];
    if (!entry || entry.key !== nc) return res.json({ valid: false });
    const valid = new Date(entry.expiry).getTime() > Date.now();
    return res.json({ valid, expiry: entry.expiry, type: 'trial' });
  }
  const hashedPc = hashId(pc_fingerprint);
  const data = loadData();
  const cd = data.activation_codes[nc];
  if (!cd || !cd.active || cd.locked_pc !== hashedPc) return res.json({ valid: false });
  const valid = !cd.expiry || new Date(cd.expiry).getTime() > Date.now();
  return res.json({ valid, expiry: cd.expiry, type: 'monthly' });
});

// ==============================
// ADMIN HELPERS
// ==============================
function checkAdmin(req, res) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) { res.status(403).json({ error: 'Unauthorized' }); return false; }
  return true;
}

app.get('/admin/codes', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const data = loadData();
  const out = {};
  for (const [code, info] of Object.entries(data.activation_codes)) {
    const expired = info.expiry && new Date(info.expiry).getTime() < Date.now();
    out[code] = { active: info.active, locked_pc: info.locked_pc ? '✓ Locked' : '○ Free', expiry: info.expiry || 'Not activated', expired: !!expired, created: info.created, activated_at: info.activated_at || null };
  }
  res.json({ total: Object.keys(out).length, codes: out });
});

app.get('/admin/trials', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const trials = loadTrials();
  const count = Object.keys(trials.used_pcs).length;
  const active = Object.values(trials.used_pcs).filter(t => new Date(t.expiry).getTime() > Date.now()).length;
  res.json({ total_trials: count, active_trials: active, data: trials.used_pcs });
});

app.post('/admin/add-code', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { code, expiry_ms, expiry_days, custom_expiry_days, expiry_label, key_type } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  const data = loadData();
  const nc = code.toUpperCase().trim();
  if (data.activation_codes[nc]) return res.status(409).json({ error: 'Already exists' });
  const ms = expiry_ms || (expiry_days || custom_expiry_days || 30) * 24 * 60 * 60 * 1000;
  data.activation_codes[nc] = { active: true, locked_pc: null, expiry: null, expiry_ms: ms, expiry_label: expiry_label || (Math.round(ms/86400000) + ' days'), key_type: key_type || 'monthly', created: new Date().toISOString().split('T')[0] };
  saveData(data);
  res.json({ success: true, code: nc, expiry_label: expiry_label });
});

app.post('/admin/disable-code', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const data = loadData();
  const nc = req.body.code.toUpperCase().trim();
  if (!data.activation_codes[nc]) return res.status(404).json({ error: 'Not found' });
  data.activation_codes[nc].active = false;
  saveData(data);
  res.json({ success: true });
});

app.post('/admin/reset-code', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const data = loadData();
  const nc = req.body.code.toUpperCase().trim();
  if (!data.activation_codes[nc]) return res.status(404).json({ error: 'Not found' });
  data.activation_codes[nc].locked_pc = null;
  data.activation_codes[nc].expiry = null;
  data.activation_codes[nc].activated_at = null;
  saveData(data);
  res.json({ success: true, message: `Code ${nc} reset.` });
});

// ==============================
// ADMIN: GET full config
// ==============================
app.post('/api/admin/get-config', async (req, res) => {
  const { admin_key } = req.body;
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ success: false });
  if (!_configMemory && GITHUB_TOKEN && GITHUB_REPO) await loadConfigFromGitHub().catch(()=>{});
  const cfg = loadConfig();
  return res.json({ success: true, config: cfg });
});

// ==============================
// ADMIN: Set trial duration
// ==============================
app.post('/api/admin/set-trial-duration', async (req, res) => {
  const { admin_key, duration_ms } = req.body;
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ success: false });
  if (!duration_ms || duration_ms < 60000) return res.status(400).json({ success: false, message: 'Minimum 60000ms' });
  if (!_configMemory && GITHUB_TOKEN && GITHUB_REPO) await loadConfigFromGitHub().catch(()=>{});
  const cfg = loadConfig();
  cfg.trial_duration_ms = duration_ms;
  saveConfig(cfg);
  await saveConfigToGitHub(cfg).catch(()=>{});
  return res.json({ success: true, trial_duration_ms: duration_ms });
});

// ==============================
// ADMIN: Set trial enabled ON/OFF
// ==============================
app.post('/api/admin/set-trial-enabled', async (req, res) => {
  const { admin_key, trial_enabled } = req.body;
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ success: false });
  if (!_configMemory && GITHUB_TOKEN && GITHUB_REPO) await loadConfigFromGitHub().catch(()=>{});
  const cfg = loadConfig();
  cfg.trial_enabled = !!trial_enabled;
  saveConfig(cfg);
  await saveConfigToGitHub(cfg).catch(()=>{});
  console.log(`[Admin] Trial enabled: ${cfg.trial_enabled}`);
  return res.json({ success: true, trial_enabled: cfg.trial_enabled });
});

// ==============================
// ADMIN: Set extension enabled ON/OFF (maintenance)
// ==============================
app.post('/api/admin/set-extension-enabled', async (req, res) => {
  const { admin_key, extension_enabled } = req.body;
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ success: false });
  if (!_configMemory && GITHUB_TOKEN && GITHUB_REPO) await loadConfigFromGitHub().catch(()=>{});
  const cfg = loadConfig();
  cfg.extension_enabled = !!extension_enabled;
  saveConfig(cfg);
  await saveConfigToGitHub(cfg).catch(()=>{});
  console.log(`[Admin] Extension enabled: ${cfg.extension_enabled}`);
  return res.json({ success: true, extension_enabled: cfg.extension_enabled });
});

// ==============================
// ADMIN: Set unlimited retry
// ==============================
app.post('/api/admin/set-unlimited-retry', async (req, res) => {
  const { admin_key, enabled } = req.body;
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ success: false });
  if (!_configMemory && GITHUB_TOKEN && GITHUB_REPO) await loadConfigFromGitHub().catch(()=>{});
  const cfg = loadConfig();
  cfg.unlimited_retry = !!enabled;
  saveConfig(cfg);
  await saveConfigToGitHub(cfg).catch(()=>{});
  return res.json({ success: true, unlimited_retry: cfg.unlimited_retry });
});

// ==============================
// ADMIN: Reset ALL trials
// ==============================
app.post('/api/admin/reset-trials', async (req, res) => {
  const { admin_key } = req.body;
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ success: false });
  const fresh = { used_pcs: {} };
  await saveTrials(fresh);
  console.log('[Admin] All trials reset');
  return res.json({ success: true, message: 'All trial history cleared.' });
});

// ==============================
// ADMIN: Reset EXPIRED trials only
// ==============================
app.post('/api/admin/reset-expired-trials', async (req, res) => {
  const { admin_key } = req.body;
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ success: false });
  if (!_trialsMemory && GITHUB_TOKEN && GITHUB_REPO) await loadTrialsFromGitHub().catch(()=>{});
  const trials = loadTrials();
  let count = 0;
  Object.keys(trials.used_pcs || {}).forEach(pc => {
    const r = trials.used_pcs[pc];
    if (r.expiry && Date.now() > new Date(r.expiry).getTime()) {
      delete trials.used_pcs[pc];
      count++;
    }
  });
  if (count > 0) await saveTrials(trials);
  console.log(`[Admin] Expired trials reset: ${count} PCs`);
  return res.json({ success: true, reset_count: count, message: `${count} টি expired PC এর trial history মুছে ফেলা হয়েছে।` });
});

// ==============================
// STARTUP
// ==============================
Promise.all([
  loadTrialsFromGitHub().catch(()=>{}),
  loadConfigFromGitHub().catch(()=>{})
]).finally(() => {
  console.log(`[startup] GitHub configured: ${!!(GITHUB_TOKEN && GITHUB_REPO)}`);
  console.log(`[startup] Config in memory: ${JSON.stringify(_configMemory)}`);
  console.log(`[startup] Trials in memory: ${Object.keys((_trialsMemory||{}).used_pcs||{}).length} PCs`);
  app.listen(PORT, () => {
    console.log(`\n🚀 OXOKE Server v5.0 running on port ${PORT}`);
  });
});
