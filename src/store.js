// Orbit — local storage: settings (API key encrypted), thread, tasks, memory files, usage.
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1',
  fastModel: '',
  voiceModel: '',
  browserChannel: 'msedge',
  transcribeModel: 'whisper-1',
  userName: '',
  voiceReplies: false,
  closeToTray: true,
  startWithWindows: false,
  hotkey: 'Control+Shift+O',
  approvalMode: 'risky', // 'risky' | 'always' | 'never'
  dailyTokenCap: 2000000,
  maxSteps: 25,
  theme: 'dark',
  wakeWord: false,
  phoneWhen: 'away', // 'away' (idle or locked) | 'always' | 'never'
  phoneIdleMinutes: 3,
  ntfyEnabled: false,
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: '',
  telegramEnabled: false,
  telegramChatId: '',
  telegramPairCode: '',
  liveEngine: 'orbit', // 'orbit' (built in) | 'gemini' | 'openai'
  orbitVoice: 'af_heart',
  orbitGpu: false, // voice runs on the CPU unless turned on
  orbitTts: 'auto', // 'auto' (Phonon, Windows voice if slow/fails) | 'phonon' | 'kokoro' | 'windows'
  orbitPhononVoice: 'Easton',
  orbitWinVoice: '', // a Microsoft voice name; empty = best English one on this PC
  orbitPauseMs: 900, // silence that ends your turn
  orbitStt: 'moonshine', // 'moonshine' (fast, English) | 'whisper' (multilingual)
  readAloudButtons: true,
  liveGeminiModel: 'gemini-3.8-live',
  liveGeminiVoice: 'Aoede',
  liveOpenaiModel: 'gpt-live-1',
  liveOpenaiVoice: 'marin',
  wakeOpensLive: true,
  talkFirst: true, // Orbit speaks first on a call and checks in when it goes quiet
  autoCall: true, // open a voice call by itself when Orbit starts
  checkinSecs: 45,
  maxWorkers: 3,
  imageModel: '',
  imageBaseUrl: '',
  googleClientId: '',
  googleEmail: '',
  backupModels: [], // [{ id, model, baseUrl, apiKeyEnc }]: tried in order when the main model hits a limit
  autoUpdate: true,
};
const SECRET_KEYS = ['liveGeminiKey', 'liveOpenaiKey', 'googleClientSecret', 'googleRefresh', 'netlifyToken', 'imageApiKey'];

const DEFAULT_TASKS = [
  {
    id: 'morning-brief',
    name: 'Morning brief',
    kind: 'daily',
    time: '08:00',
    enabled: false,
    prompt: 'Give me my morning brief. Check memory for what I am working on and anything due soon, note the date, and tell me the 3 things most worth my attention today. Keep it short.',
    lastRun: null,
  },
  {
    id: 'check-in',
    name: 'Check-in',
    kind: 'interval',
    everyHours: 3,
    enabled: false,
    prompt: 'Quiet check-in. Look at memory and open tasks. If something genuinely needs me (a deadline today, a task stuck waiting on me), message me in one or two lines. If nothing does, reply with exactly NOTHING_TO_REPORT.',
    lastRun: null,
  },
];

const SEED_MEMORY = {
  'USER.md': '# About me\n\n- Name: \n- What I am working on: \n- How I like answers: short, answer first.\n',
  'ORBIT.md': '# Orbit\n\nThings Orbit has learned about how to work with me. Orbit keeps this file up to date.\n',
};

class Store {
  constructor(dir, safeStorage) {
    this.dir = dir;
    this.safe = safeStorage;
    this.memoryDir = path.join(dir, 'memory');
    this.skillsDir = path.join(dir, 'skills');
    this.workDir = path.join(dir, 'workspace');
    for (const d of [dir, this.memoryDir, this.skillsDir, this.workDir]) fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(SEED_MEMORY)) {
      const p = path.join(this.memoryDir, f);
      if (!fs.existsSync(p)) fs.writeFileSync(p, c);
    }
    const skill = path.join(this.skillsDir, 'example-skill.md');
    if (!fs.existsSync(skill)) fs.writeFileSync(skill, '# Example skill\nWhen: the user asks for a study plan.\n\nSteps:\n1. Ask which exam and how many days are left.\n2. Split topics by weight.\n3. Give a day-by-day table.\n');
  }

  _file(name) { return path.join(this.dir, name); }
  _read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(this._file(name), 'utf8')); } catch { return fallback; }
  }
  _write(name, data) {
    const p = this._file(name);
    fs.writeFileSync(p + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(p + '.tmp', p);
  }

  // ----- settings -----
  getSettings() {
    const s = { ...DEFAULT_SETTINGS, ...this._read('settings.json', {}) };
    s.apiKey = '';
    if (s.apiKeyEnc) {
      try {
        const buf = Buffer.from(s.apiKeyEnc, 'base64');
        s.apiKey = this.safe && this.safe.isEncryptionAvailable() ? this.safe.decryptString(buf) : buf.toString('utf8');
      } catch { s.apiKey = ''; }
    }
    for (const k of SECRET_KEYS) { s[k] = ''; if (s[k + 'Enc']) { try { s[k] = this._dec(s[k + 'Enc']); } catch { s[k] = ''; } } }
    s.backupModels = (Array.isArray(s.backupModels) ? s.backupModels : []).filter(b => b && b.model).map(b => {
      let apiKey = ''; if (b.apiKeyEnc) { try { apiKey = this._dec(b.apiKeyEnc); } catch {} }
      return { id: b.id, model: b.model, baseUrl: b.baseUrl || '', apiKey };
    });
    s.telegramToken = '';
    if (s.telegramTokenEnc) { try { s.telegramToken = this._dec(s.telegramTokenEnc); } catch { s.telegramToken = ''; } }
    return s;
  }
  _enc(v) { return (this.safe && this.safe.isEncryptionAvailable() ? this.safe.encryptString(v) : Buffer.from(v, 'utf8')).toString('base64'); }
  _dec(b64) { const buf = Buffer.from(b64, 'base64'); return this.safe && this.safe.isEncryptionAvailable() ? this.safe.decryptString(buf) : buf.toString('utf8'); }
  getSettingsForUI() {
    const s = this.getSettings();
    s.hasTelegramToken = !!s.telegramToken; delete s.telegramToken; delete s.telegramTokenEnc;
    for (const k of SECRET_KEYS) { const v = s[k]; s['has_' + k] = !!v; s[k + 'Preview'] = v ? v.slice(0, 4) + '…' + v.slice(-4) : ''; delete s[k]; delete s[k + 'Enc']; }
    const hasKey = !!s.apiKey;
    const masked = hasKey ? s.apiKey.slice(0, 4) + '…' + s.apiKey.slice(-4) : '';
    delete s.apiKey; delete s.apiKeyEnc;
    s.backupModels = s.backupModels.map(b => ({ id: b.id, model: b.model, baseUrl: b.baseUrl, hasKey: !!b.apiKey, keyPreview: b.apiKey ? b.apiKey.slice(0, 4) + '…' + b.apiKey.slice(-4) : '' }));
    return { ...s, hasKey, keyPreview: masked };
  }
  saveSettings(incoming) {
    const cur = this._read('settings.json', {});
    const next = { ...cur };
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k !== 'backupModels' && incoming[k] !== undefined) next[k] = incoming[k];
    if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim()) {
      const key = incoming.apiKey.trim();
      const enc = this.safe && this.safe.isEncryptionAvailable() ? this.safe.encryptString(key) : Buffer.from(key, 'utf8');
      next.apiKeyEnc = enc.toString('base64');
    }
    if (incoming.clearKey) delete next.apiKeyEnc;
    if (Array.isArray(incoming.backupModels)) {
      const old = new Map((Array.isArray(cur.backupModels) ? cur.backupModels : []).map(b => [b.id, b]));
      next.backupModels = incoming.backupModels.filter(b => b && String(b.model || '').trim()).slice(0, 8).map(b => {
        const id = b.id || Math.random().toString(36).slice(2, 10);
        const row = { id, model: String(b.model).trim(), baseUrl: String(b.baseUrl || '').trim() };
        if (typeof b.apiKey === 'string' && b.apiKey.trim()) row.apiKeyEnc = this._enc(b.apiKey.trim());
        else if (!b.clearKey && old.get(id) && old.get(id).apiKeyEnc) row.apiKeyEnc = old.get(id).apiKeyEnc;
        return row;
      });
    }
    for (const k of SECRET_KEYS) {
      if (typeof incoming[k] === 'string' && incoming[k].trim()) next[k + 'Enc'] = this._enc(incoming[k].trim());
      if (incoming['clear_' + k]) delete next[k + 'Enc'];
    }
    if (typeof incoming.telegramToken === 'string' && incoming.telegramToken.trim()) {
      next.telegramTokenEnc = this._enc(incoming.telegramToken.trim());
      next.telegramChatId = ''; // a new bot needs pairing again
    }
    this._write('settings.json', next);
  }

  // ----- thread -----
  getThread() { return this._read('thread.json', []); }
  saveThread(t) { this._write('thread.json', t.slice(-400)); }
  clearThread() { this._write('thread.json', []); }

  // ----- tasks -----
  getTasks() {
    const saved = this._read('tasks.json', null);
    if (!saved) { this._write('tasks.json', DEFAULT_TASKS); return DEFAULT_TASKS; }
    return saved;
  }
  saveTasks(t) { this._write('tasks.json', t); }
  addTask(task) { const t = this.getTasks(); t.push(task); this.saveTasks(t); return task; }
  updateTask(id, patch) { const t = this.getTasks().map(x => (x.id === id ? { ...x, ...patch } : x)); this.saveTasks(t); }
  deleteTask(id) { this.saveTasks(this.getTasks().filter(x => x.id !== id)); }

  // ----- memory -----
  _safeName(name) {
    const clean = String(name).replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '');
    return clean.endsWith('.md') ? clean : clean + '.md';
  }
  listMemory() {
    const out = [];
    const walk = (d, rel) => {
      for (const f of fs.readdirSync(d)) {
        const full = path.join(d, f);
        const r = rel ? rel + '/' + f : f;
        if (fs.statSync(full).isDirectory()) walk(full, r);
        else if (f.endsWith('.md')) out.push({ name: r, size: fs.statSync(full).size, updated: fs.statSync(full).mtimeMs });
      }
    };
    walk(this.memoryDir, '');
    return out.sort((a, b) => b.updated - a.updated);
  }
  readMemory(name) {
    try { return fs.readFileSync(path.join(this.memoryDir, this._safeName(name)), 'utf8'); } catch { return null; }
  }
  writeMemory(name, content) {
    const p = path.join(this.memoryDir, this._safeName(name));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  listSkills() {
    return fs.readdirSync(this.skillsDir).filter(f => f.endsWith('.md')).map(f => {
      const body = fs.readFileSync(path.join(this.skillsDir, f), 'utf8');
      const first = body.split('\n').find(l => l.trim()) || f;
      return { name: f.replace(/\.md$/, ''), title: first.replace(/^#\s*/, ''), when: (body.match(/^When:(.*)$/m) || [, ''])[1].trim() };
    });
  }
  readSkill(name) { try { return fs.readFileSync(path.join(this.skillsDir, this._safeName(name)), 'utf8'); } catch { return null; } }
  writeSkill(name, content) { fs.writeFileSync(path.join(this.skillsDir, this._safeName(name)), content); }

  // ----- usage -----
  getUsage() {
    const u = this._read('usage.json', {});
    const today = new Date().toISOString().slice(0, 10);
    return { today, tokensToday: (u[today] || 0), all: u };
  }
  addUsage(tokens) {
    const u = this._read('usage.json', {});
    const today = new Date().toISOString().slice(0, 10);
    u[today] = (u[today] || 0) + (tokens || 0);
    this._write('usage.json', u);
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
