// Settings must survive Windows file locks: a failed read never turns into "empty settings".
const path = require('path'); const fs = require('fs'); const os = require('os');
const { Store } = require('../src/store'); const { Phone } = require('../src/phone');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-st-'));
let st = new Store(dir, null);
st.saveSettings({ baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder', apiKey: 'sk-or-1', ntfyEnabled: true, telegramToken: '123:abc' });
// 1. ntfy-style partial saves keep the brain
st.saveSettings({ ntfyTopic: Phone.newTopic() }); st.saveSettings({ ntfyServer: 'https://ntfy.sh', ntfyEnabled: false }); st.saveSettings({ telegramPairCode: '123456' });
let s = st.getSettings();
assert(s.model === 'qwen/qwen3-coder' && s.apiKey === 'sk-or-1' && s.baseUrl.includes('openrouter') && s.telegramToken === '123:abc', 'partial saves keep brain + telegram token');
// 2. Restart while settings.json is locked/unreadable: falls back to the backup copy, then a ntfy patch doesn't wipe it
const f = path.join(dir, 'settings.json');
fs.renameSync(f, f + '.moved'); fs.mkdirSync(f); // reading a directory fails like a locked file
st = new Store(dir, null);
s = st.getSettings();
assert(s.model === 'qwen/qwen3-coder' && s.apiKey === 'sk-or-1', 'unreadable file -> restored from backup');
fs.rmdirSync(f);
st.saveSettings({ ntfyTopic: 'orbit-after-lock' });
st = new Store(dir, null); s = st.getSettings();
assert(s.model === 'qwen/qwen3-coder' && s.apiKey === 'sk-or-1' && s.ntfyTopic === 'orbit-after-lock', 'patch after a lock keeps everything');
// 3. Both copies unreadable: refuse instead of writing a blank file
fs.rmSync(f); fs.mkdirSync(f); fs.rmSync(f + '.bak'); fs.mkdirSync(f + '.bak');
st = new Store(dir, null); let threw = false; try { st.saveSettings({ ntfyTopic: 'x' }); } catch (e) { threw = !!e.unreadable; }
assert(threw, 'never overwrites settings it could not read');
// 4. A UI save with blank brain fields (bad form state) keeps the saved brain
fs.rmSync(f, { recursive: true }); fs.rmSync(f + '.bak', { recursive: true }); fs.renameSync(f + '.moved', f);
st = new Store(dir, null); st.saveSettings({ baseUrl: '', model: '' }); s = st.getSettings();
assert(s.model === 'qwen/qwen3-coder', 'blank brain fields never erase the saved brain');
// 5. Telegram restart never leaves two pollers
const ph = new Phone({ store: { getSettings: () => ({ telegramEnabled: true, telegramToken: 't' }) }, onAnswer() {}, onMessage() {} });
let polls = 0; ph._tg = (m, b, sig) => { polls++; return new Promise((res, rej) => sig.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))); };
ph.restart(); ph._key = null; ph.restart(); ph._key = null; ph.restart();
setTimeout(() => { assert(polls === 3 && ph.tgGen > 0, 'old pollers aborted (' + polls + ' starts)'); ph.restart(); assert(polls === 3, 'unchanged settings do not restart the connection'); ph.stopAll(); console.log('PASS settings-store-test'); process.exit(0); }, 200);
