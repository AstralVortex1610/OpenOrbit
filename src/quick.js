// Orbit — instant actions. Things that should happen the moment you say them (open an app or a site,
// search, play/pause, volume, lock) run here directly, in milliseconds, with no model loop.
// Used by Live voice: Gemini calls the quick_action tool; for GPT-Live (and as a fallback) we parse
// the user's words with parse().
const { spawn } = require('child_process');

const SITES = {
  youtube: 'https://www.youtube.com', 'youtube music': 'https://music.youtube.com', gmail: 'https://mail.google.com',
  mail: 'https://mail.google.com', google: 'https://www.google.com', 'google drive': 'https://drive.google.com', drive: 'https://drive.google.com',
  'google docs': 'https://docs.google.com', docs: 'https://docs.google.com', calendar: 'https://calendar.google.com',
  'google calendar': 'https://calendar.google.com', maps: 'https://maps.google.com', 'google maps': 'https://maps.google.com',
  chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai', gemini: 'https://gemini.google.com', github: 'https://github.com',
  'whatsapp web': 'https://web.whatsapp.com', instagram: 'https://www.instagram.com', x: 'https://x.com', twitter: 'https://x.com',
  reddit: 'https://www.reddit.com', linkedin: 'https://www.linkedin.com', netflix: 'https://www.netflix.com', hark: 'https://hark.com',
  'hugging face': 'https://huggingface.co', huggingface: 'https://huggingface.co', wikipedia: 'https://www.wikipedia.org', amazon: 'https://www.amazon.in',
};
const APPS = {
  calculator: 'calc', calc: 'calc', notepad: 'notepad', paint: 'mspaint', settings: 'ms-settings:', 'windows settings': 'ms-settings:',
  'file explorer': 'explorer', explorer: 'explorer', files: 'explorer', 'my files': 'explorer', 'task manager': 'taskmgr',
  terminal: 'wt', 'windows terminal': 'wt', 'command prompt': 'cmd', cmd: 'cmd', powershell: 'powershell',
  chrome: 'chrome', 'google chrome': 'chrome', edge: 'msedge', 'microsoft edge': 'msedge', browser: 'msedge', firefox: 'firefox',
  'vs code': 'code', vscode: 'code', 'visual studio code': 'code', code: 'code', word: 'winword', excel: 'excel', powerpoint: 'powerpnt',
  spotify: 'spotify:', whatsapp: 'whatsapp:', camera: 'microsoft.windows.camera:', store: 'ms-windows-store:', 'microsoft store': 'ms-windows-store:',
  photos: 'ms-photos:', clock: 'ms-clock:', 'snipping tool': 'ms-screenclip:', discord: 'discord:', telegram: 'tg:', steam: 'steam:',
  outlook: 'outlook', teams: 'msteams:', obs: 'obs64', 'control panel': 'control',
};
// Virtual-key media keys, sent through WScript.Shell.
const VK = { play_pause: 179, next: 176, previous: 177, stop: 178, volume_up: 175, volume_down: 174, mute: 173 };

function ps(script) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, err: 'Only works on Windows.' });
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let err = ''; p.stderr.on('data', d => (err += d));
    p.on('error', e => resolve({ ok: false, err: e.message }));
    p.on('close', code => resolve({ ok: code === 0, err: err.trim() }));
  });
}
function startDetached(target) {
  if (process.platform !== 'win32') return false;
  spawn('cmd.exe', ['/c', 'start', '', target], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  return true;
}
function openUrl(url) {
  try { const { shell } = require('electron'); if (shell && shell.openExternal) { shell.openExternal(url); return true; } } catch {}
  return startDetached(url);
}
const clean = (s) => String(s || '').toLowerCase().replace(/[.!?,]+$/g, '').replace(/^the\s+|\s+app$/g, '').trim();

// Run one instant action. Returns a short sentence for the voice to say.
async function run({ action, target, query, amount } = {}, { open } = {}) {
  action = String(action || '').toLowerCase();
  if (action === 'open') {
    const t = clean(target);
    if (!t) return 'Error: nothing to open.';
    if (/^https?:\/\//.test(t)) { openUrl(t); return `Opened ${t}.`; }
    if (SITES[t]) { openUrl(SITES[t]); return `Opened ${target}.`; }
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(t)) { openUrl('https://' + t); return `Opened ${t}.`; }
    if (APPS[t]) { startDetached(APPS[t]); return `Opening ${target}.`; }
    if (open) return await open({ target: String(target) });
    return startDetached(String(target)) ? `Asked Windows to open ${target}.` : `Error: couldn't open ${target}.`;
  }
  if (action === 'search' || action === 'youtube') {
    const q = String(query || target || '').trim();
    if (!q) return 'Error: nothing to search for.';
    const url = action === 'youtube' ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` : `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    openUrl(url);
    return action === 'youtube' ? `Searching YouTube for ${q}.` : `Searched Google for ${q}.`;
  }
  if (VK[action]) {
    const n = Math.max(1, Math.min(25, Number(amount) || (/volume_(up|down)/.test(action) ? 5 : 1)));
    const r = await ps(`$w=New-Object -ComObject WScript.Shell; 1..${n} | % { $w.SendKeys([char]${VK[action]}) }`);
    if (!r.ok) return `Error: ${r.err || 'media key failed'}`;
    return { play_pause: 'Done, toggled play.', next: 'Skipped.', previous: 'Went back.', stop: 'Stopped.', volume_up: 'Turned it up.', volume_down: 'Turned it down.', mute: 'Toggled mute.' }[action];
  }
  if (action === 'lock') { const r = await ps('rundll32.exe user32.dll,LockWorkStation'); return r.ok ? 'Locked.' : `Error: ${r.err}`; }
  return `Error: unknown quick action "${action}".`;
}

// Turn plain words into a quick action, or null when it needs the full agent.
function parse(text) {
  let t = String(text || '').toLowerCase().trim()
    .replace(/[.!?]+$/g, '')
    .replace(/^(hey |ok |okay )?orbit[, ]*/, '')
    .replace(/^(can you|could you|would you|please|pls|plz|just|bro|yo|quickly)\s+/g, '')
    .replace(/^(can you|could you|please|pls|just)\s+/g, '')
    .replace(/\s+(please|pls|plz|for me|bro|now|real quick)$/g, '').trim();
  if (!t || t.split(/\s+/).length > 12) return null;
  let m;
  if ((m = t.match(/^(?:play|search|find|look up|put on)\s+(.+?)\s+on youtube$/)) || (m = t.match(/^(?:search )?youtube (?:for )?(.+)$/))) return { action: 'youtube', query: m[1] };
  if ((m = t.match(/^(?:google|search(?: google)?(?: for)?|look up)\s+(.+)$/))) return { action: 'search', query: m[1] };
  if (/^(pause|resume|play|unpause|pause (the )?(music|song|video)|play (the )?(music|song|video)|resume (the )?(music|song))$/.test(t)) return { action: 'play_pause' };
  if (/^(next|next (song|track|video)|skip( (this|it|the))?( (song|track|one|video))?)$/.test(t)) return { action: 'next' };
  if (/^(previous|go back|previous (song|track)|last (song|track))$/.test(t)) return { action: 'previous' };
  if ((m = t.match(/^(?:turn (?:the )?volume up|volume up|turn it up|louder|increase (?:the )?volume)(?: by (\d+))?$/))) return { action: 'volume_up', amount: m[1] ? Math.ceil(m[1] / 2) : undefined };
  if ((m = t.match(/^(?:turn (?:the )?volume down|volume down|turn it down|quieter|lower (?:the )?volume|decrease (?:the )?volume)(?: by (\d+))?$/))) return { action: 'volume_down', amount: m[1] ? Math.ceil(m[1] / 2) : undefined };
  if (/^(mute|unmute)( (the )?(sound|volume|audio|laptop|pc))?$/.test(t)) return { action: 'mute' };
  if (/^lock (my |the )?(pc|laptop|computer|screen)$/.test(t)) return { action: 'lock' };
  if ((m = t.match(/^(?:open|launch|start|open up|pull up|fire up)\s+(?:the |my )?(.+?)(?: app)?$/))) {
    const target = m[1].trim();
    // Only the obvious ones: a known app/site, a domain, or one or two plain words.
    if (SITES[clean(target)] || APPS[clean(target)] || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(target) || (target.split(/\s+/).length <= 2 && !/\b(and|then|file|folder|last|latest|recent|email|document|that|it)\b/.test(target))) return { action: 'open', target };
  }
  return null;
}

const QUICK_ACTIONS = ['open', 'search', 'youtube', 'play_pause', 'next', 'previous', 'stop', 'volume_up', 'volume_down', 'mute', 'lock'];
module.exports = { run, parse, QUICK_ACTIONS, SITES, APPS };
