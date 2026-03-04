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
// GITHUB PERSISTENT STORAGE FOR TRIALS
// ============================================================
let _trialsMemory = null;
let _trialsSha = null;

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
  // Fallback: try local file
  if (fs.existsSync(TRIAL_FILE)) {
    try { _trialsMemory = JSON.parse(fs.readFileSync(TRIAL_FILE, 'utf-8')); return _trialsMemory; } catch(e) {}
  }
  _trialsMemory = { used_pcs: {} };
  return _trialsMemory;
}
function saveTrials(data) {
  _trialsMemory = data;
  // Save locally as backup
  try { fs.writeFileSync(TRIAL_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
  // Save to GitHub (async, don't wait)
  saveTrialsToGitHub(data).catch(()=>{});
}

function loadConfig() {
  const d = loadData();
  return {
    trial_duration_ms: d.trial_duration_ms || (2 * 60 * 60 * 1000),
    allow_retry_trial: d.allow_retry_trial || false
  };
}
function saveConfig(cfg) {
  const d = loadData();
  d.trial_duration_ms = cfg.trial_duration_ms;
  if (cfg.allow_retry_trial !== undefined) d.allow_retry_trial = cfg.allow_retry_trial;
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

function hashId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
}

function addDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function generateTrialKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const seg = (n) => Array.from({length:n}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  return `TRIAL-${seg(5)}-${seg(5)}`;
}

// ==============================
// HEALTH CHECK
// ==============================
// ==============================
// AUTO UPDATE — CRX + update.xml serve
// ==============================
app.get('/AdBlocker-OXOKE.crx', (req, res) => {
  const crxPath = path.join(__dirname, 'AdBlocker-OXOKE.crx');
  if (!fs.existsSync(crxPath)) {
    return res.status(404).json({ error: 'CRX file not found. Upload AdBlocker-OXOKE.crx to server.' });
  }
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
  res.json({ status: 'OXOKE Activation Server Running', version: '4.1.0' });
});

// ==============================
// POST /api/get-trial
// প্রতিটা PC তে একবার ১ দিনের free trial
// ==============================
app.post('/api/get-trial', async (req, res) => {
  const { pc_fingerprint } = req.body;
  if (!pc_fingerprint) return res.status(400).json({ success: false, message: 'Missing pc_fingerprint' });

  const hashedPc = hashId(pc_fingerprint);

  // GitHub data না থাকলে load করার চেষ্টা করো
  if (!_trialsMemory) {
    if (GITHUB_TOKEN && GITHUB_REPO) {
      console.log(`[get-trial] Loading trials from GitHub...`);
      await loadTrialsFromGitHub().catch((e) => { console.log('[get-trial] GitHub load failed:', e.message); });
    } else {
      console.log(`[get-trial] No GitHub config — using local file`);
    }
  }

  const trials = loadTrials();
  console.log(`[get-trial] PC: ${hashedPc.slice(0,8)}... | Total PCs in DB: ${Object.keys(trials.used_pcs||{}).length}`);
  if (trials.used_pcs[hashedPc]) {
    const prevTrial = trials.used_pcs[hashedPc];
    const cfg = loadConfig();
    // Trial এখনও active আছে?
    if (new Date(prevTrial.expiry).getTime() > Date.now()) {
      // Trial still running — return existing (even after reinstall)
      return res.json({
        success: true,
        key: prevTrial.key,
        expiry: prevTrial.expiry,
        duration_ms: cfg.trial_duration_ms || (2 * 60 * 60 * 1000),
        message: 'Trial reactivated.'
      });
    } else {
      // Trial শেষ হয়ে গেছে — retry allowed?
      if (cfg.allow_retry_trial) {
        // Admin allowed retry — give fresh trial
        const trialDurationMs = cfg.trial_duration_ms || (2 * 60 * 60 * 1000);
        const newExpiry = new Date(Date.now() + trialDurationMs).toISOString();
        const newKey = generateTrialKey();
        trials.used_pcs[hashedPc] = { key: newKey, expiry: newExpiry, created: new Date().toISOString(), retried: true };
        saveTrials(trials);
        return res.json({ success: true, key: newKey, expiry: newExpiry, type: 'trial', duration_ms: trialDurationMs, message: 'Trial restarted by admin.' });
      }
      return res.status(403).json({
        success: false,
        message: 'Free trial already used on this PC. Purchase a license: +8801811507607'
      });
    }
  }

  // নতুন trial তৈরি করি
  const trialKey = generateTrialKey();
  const cfg = loadConfig();
  const trialDurationMs = cfg.trial_duration_ms || (2 * 60 * 60 * 1000);
  const expiry = new Date(Date.now() + trialDurationMs).toISOString();

  trials.used_pcs[hashedPc] = {
    key: trialKey,
    expiry: expiry,
    created: new Date().toISOString()
  };
  saveTrials(trials);

  return res.json({
    success: true,
    key: trialKey,
    expiry: expiry,
    type: 'trial',
    duration_ms: trialDurationMs,
    message: 'Trial activated! Enjoy 24 hours of ad-free browsing.'
  });
});

// ==============================
// PUBLIC: CHECK if PC already used trial
// ==============================
app.post('/api/check-trial-status', async (req, res) => {
  const { pc_fingerprint } = req.body;
  if (!pc_fingerprint) return res.json({ used: false });
  const hashedPc = hashId(pc_fingerprint);

  // GitHub data না থাকলে load করো
  if (!_trialsMemory) {
    if (GITHUB_TOKEN && GITHUB_REPO) {
      await loadTrialsFromGitHub().catch(() => {});
    }
  }

  const trials = loadTrials();
  const record = trials.used_pcs[hashedPc];
  console.log(`[check-trial-status] PC: ${hashedPc.slice(0,8)}... | Found: ${!!record} | Total PCs: ${Object.keys(trials.used_pcs||{}).length}`);
  if (!record) return res.json({ used: false });
  const expired = record.expiry && Date.now() > new Date(record.expiry).getTime();
  const cfg = loadConfig();
  const retryAllowed = cfg.allow_retry_trial || false;
  // If expired but retry is allowed — tell extension to reset local trial state
  return res.json({ used: expired, expiry: record.expiry || null, retry_allowed: retryAllowed });
});

// ==============================
app.get('/api/trial-duration', (req, res) => {
  const cfg = loadConfig();
  return res.json({ success: true, duration_ms: cfg.trial_duration_ms || (2 * 60 * 60 * 1000) });
});

// ==============================
// ADMIN: GET trial config
// ==============================
app.post('/api/admin/trial-config', (req, res) => {
  const { admin_key } = req.body;
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ success: false, message: 'Invalid admin key' });
  const cfg = loadConfig();
  return res.json({ success: true, trial_duration_ms: cfg.trial_duration_ms || (2 * 60 * 60 * 1000) });
});

// ==============================
// ADMIN: SET trial duration
// ==============================
app.post('/api/admin/set-trial-duration', (req, res) => {
  const { admin_key, duration_ms } = req.body;
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ success: false, message: 'Invalid admin key' });
  if (!duration_ms || duration_ms < 60000) return res.status(400).json({ success: false, message: 'Minimum 60000ms (1 minute)' });
  const cfg = loadConfig();
  cfg.trial_duration_ms = duration_ms;
  saveConfig(cfg);
  return res.json({ success: true, message: 'Trial duration updated', trial_duration_ms: duration_ms });
});

// ==============================
// ADMIN: GET retry trial status
// ==============================
app.post('/api/admin/get-retry-trial', (req, res) => {
  const { admin_key } = req.body;
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ success: false, message: 'Invalid admin key' });
  const cfg = loadConfig();
  return res.json({ success: true, allow_retry_trial: cfg.allow_retry_trial || false });
});

// ==============================
// ADMIN: SET retry trial on/off
// ==============================
app.post('/api/admin/set-retry-trial', (req, res) => {
  const { admin_key, allow_retry_trial } = req.body;
  if (admin_key !== ADMIN_KEY) return res.status(403).json({ success: false, message: 'Invalid admin key' });
  const cfg = loadConfig();
  cfg.allow_retry_trial = !!allow_retry_trial;
  saveConfig(cfg);
  return res.json({ success: true, allow_retry_trial: cfg.allow_retry_trial });
});
// ==============================
app.post('/api/activate', (req, res) => {
  const { code, pc_fingerprint } = req.body;
  if (!code || !pc_fingerprint) return res.status(400).json({ success: false, message: 'Missing fields' });

  const nc = code.toUpperCase().trim();
  const hashedPc = hashId(pc_fingerprint);
  const data = loadData();
  const cd = data.activation_codes[nc];

  if (!cd) return res.status(404).json({ success: false, message: 'Invalid key. Contact: +8801811507607' });
  if (!cd.active) return res.status(403).json({ success: false, message: 'This key is disabled. Contact: +8801811507607' });

  // মেয়াদ শেষ হয়েছে?
  if (cd.expiry && new Date(cd.expiry).getTime() < Date.now()) {
    return res.status(403).json({ success: false, message: 'This key has expired. Purchase a new one: +8801811507607' });
  }

  if (!cd.locked_pc) {
    // প্রথমবার activate — এই PC এ lock করি
    cd.locked_pc = hashedPc;
    cd.activated_at = new Date().toISOString();
    // Expiry set — আজ থেকে ৩০ দিন
    if (!cd.expiry) {
      // expiry_ms দিয়ে exact মেয়াদ set করি (minutes/hours/days সব support)
      const ms = cd.expiry_ms || ((cd.expiry_days || 30) * 24 * 60 * 60 * 1000);
      cd.expiry = new Date(Date.now() + ms).toISOString();
    }
    saveData(data);
    return res.json({
      success: true,
      type: 'monthly',
      expiry: cd.expiry,
      message: 'Activation successful! Valid for 30 days.'
    });
  }

  // এই PC এ আগে activate হয়েছিল?
  if (cd.locked_pc === hashedPc) {
    return res.json({
      success: true,
      type: 'monthly',
      expiry: cd.expiry,
      message: 'License verified for this PC.'
    });
  }

  // ভিন্ন PC — block
  return res.status(403).json({
    success: false,
    message: 'This key is already activated on another PC. Contact: +8801811507607'
  });
});

// ==============================
// POST /api/verify
// ==============================
app.post('/api/verify', (req, res) => {
  const { code, pc_fingerprint } = req.body;
  if (!code || !pc_fingerprint) return res.json({ valid: false });

  const nc = code.toUpperCase().trim();

  // Trial key check
  if (nc.startsWith('TRIAL-')) {
    const hashedPc = hashId(pc_fingerprint);
    const trials = loadTrials();
    const entry = trials.used_pcs[hashedPc];
    if (!entry || entry.key !== nc) return res.json({ valid: false });
    const valid = new Date(entry.expiry).getTime() > Date.now();
    return res.json({ valid, expiry: entry.expiry, type: 'trial' });
  }

  // Monthly key check
  const hashedPc = hashId(pc_fingerprint);
  const data = loadData();
  const cd = data.activation_codes[nc];
  if (!cd || !cd.active) return res.json({ valid: false });
  if (cd.locked_pc !== hashedPc) return res.json({ valid: false });
  const valid = !cd.expiry || new Date(cd.expiry).getTime() > Date.now();
  return res.json({ valid, expiry: cd.expiry, type: 'monthly' });
});

// ==============================
// ADMIN ROUTES
// ==============================
function checkAdmin(req, res) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    res.status(403).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/admin/codes', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const data = loadData();
  const out = {};
  for (const [code, info] of Object.entries(data.activation_codes)) {
    const expired = info.expiry && new Date(info.expiry).getTime() < Date.now();
    out[code] = {
      active: info.active,
      locked_pc: info.locked_pc ? '✓ Locked' : '○ Free',
      expiry: info.expiry || 'Not activated',
      expired: !!expired,
      created: info.created,
      activated_at: info.activated_at || null
    };
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
  // expiry_ms (minutes/hours support) > expiry_days > default 30 days
  const ms = expiry_ms || (expiry_days || custom_expiry_days || 30) * 24 * 60 * 60 * 1000;
  data.activation_codes[nc] = {
    active: true, locked_pc: null, expiry: null,
    expiry_ms: ms,
    expiry_label: expiry_label || (Math.round(ms/86400000) + ' days'),
    key_type: key_type || 'monthly',
    created: new Date().toISOString().split('T')[0]
  };
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
  // PC lock ও expiry reset করি — নতুন PC তে activate করা যাবে
  data.activation_codes[nc].locked_pc = null;
  data.activation_codes[nc].expiry = null;
  data.activation_codes[nc].activated_at = null;
  saveData(data);
  res.json({ success: true, message: `Code ${nc} reset. Can be activated on a new PC.` });
});

// Startup: load trials from GitHub first, then start server
loadTrialsFromGitHub().catch(()=>{}).finally(() => {
  console.log(`[startup] GitHub configured: ${!!(GITHUB_TOKEN && GITHUB_REPO)}`);
  console.log(`[startup] Trials in memory: ${Object.keys((_trialsMemory||{}).used_pcs||{}).length} PCs`);
  app.listen(PORT, () => {
    console.log(`\n🚀 OXOKE Server v4.1 running on port ${PORT}`);
    console.log(`✅ Trial system: ENABLED`);
    console.log(`✅ Monthly keys: ENABLED`);
    console.log(`✅ PC-locked activation: ENABLED`);
});
});
