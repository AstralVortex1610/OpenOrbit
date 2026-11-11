// Orbit — reaching the user's phone. Two optional channels, both two-way:
//  • ntfy  (free app, no account): notifications with tap-to-answer buttons; typing in the
//          reply topic sends Orbit a message.
//  • Telegram (your own bot): messages with answer buttons; you can chat with Orbit from anywhere.
const crypto = require('crypto');

const strip = (t) => String(t || '').replace(/```[\s\S]*?```/g, '[code]').replace(/[#*_`>|]/g, '').trim();

class Phone {
  constructor({ store, onAnswer, onMessage, log }) {
    this.store = store;
    this.onAnswer = onAnswer;   // (askId, answerText) => void
    this.onMessage = onMessage; // (text, channel) => void
    this.log = log || (() => {});
    this.lastAsk = null;        // { id, choices } — free-text replies go here
    this.ntfyAbort = null;
    this.tgRunning = false;
    this.tgOffset = 0;
    this.status = { ntfy: 'off', telegram: 'off' };
  }

  s() { return this.store.getSettings(); }

  restart() {
    // Only restart what actually changed, so saving Settings doesn't drop a live connection.
    const s0 = this.s();
    const key = JSON.stringify([s0.ntfyEnabled, s0.ntfyTopic, s0.ntfyServer, s0.ntfyToken, s0.telegramEnabled, s0.telegramToken]);
    if (key === this._key && (this.ntfyAbort || this.tgRunning)) return;
    this._key = key;
    this.stopAll();
    const s = this.s();
    if (s.ntfyEnabled && s.ntfyTopic) this._listenNtfy();
    if (s.telegramEnabled && s.telegramToken) this._pollTelegram();
  }
  stopAll() {
    if (this.ntfyAbort) { this.ntfyAbort.abort(); this.ntfyAbort = null; }
    this.tgRunning = false;
    this.tgGen = (this.tgGen || 0) + 1; // any older poll loop sees a new generation and exits
    if (this.tgAbort) { this.tgAbort.abort(); this.tgAbort = null; }
    this.status = { ntfy: 'off', telegram: 'off' };
  }

  // kind: 'question' | 'approval' | 'message'
  async send({ title, body, id, choices, kind }) {
    const s = this.s();
    if (id) this.lastAsk = { id, choices: choices || [], kind };
    const jobs = [];
    if (s.ntfyEnabled && s.ntfyTopic) jobs.push(this._sendNtfy(title, body, id, choices).catch(e => this.log('ntfy send: ' + e.message)));
    if (s.telegramEnabled && s.telegramToken && s.telegramChatId) jobs.push(this._sendTelegram(title, body, id, choices).catch(e => this.log('telegram send: ' + e.message)));
    await Promise.all(jobs);
    return jobs.length;
  }

  answered(id) { if (this.lastAsk && this.lastAsk.id === id) this.lastAsk = null; }

  _route(text, channel, askId) {
    const t = String(text || '').trim();
    if (!t) return;
    const target = askId || (this.lastAsk && this.lastAsk.id);
    if (target) { this.lastAsk = null; this.onAnswer(target, t, channel); }
    else this.onMessage(t, channel);
  }

  // ---------------- ntfy ----------------
  _server() { return String(this.s().ntfyServer || 'https://ntfy.sh').replace(/\/+$/, ''); }

  async _sendNtfy(title, body, id, choices) {
    const s = this.s();
    const server = this._server();
    const replyUrl = `${server}/${s.ntfyTopic}-reply`;
    const payload = { topic: s.ntfyTopic, title: strip(title).slice(0, 120), message: strip(body).slice(0, 3500) || '(empty)', tags: ['ringed_planet'], priority: id ? 4 : 3 };
    if (id && choices && choices.length) {
      payload.actions = choices.slice(0, 3).map(c => ({ action: 'http', label: String(c).slice(0, 40), url: replyUrl, method: 'POST', body: JSON.stringify({ orbitAsk: id, answer: c }), clear: true }));
    }
    const headers = { 'Content-Type': 'application/json' };
    if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
    const r = await fetch(server, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }

  async _listenNtfy() {
    const s = this.s();
    const url = `${this._server()}/${s.ntfyTopic}-reply/json`;
    const ctrl = new AbortController();
    this.ntfyAbort = ctrl;
    let delay = 2000;
    while (!ctrl.signal.aborted) {
      try {
        const headers = {};
        if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
        const r = await fetch(url, { signal: ctrl.signal, headers });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        this.status.ntfy = 'listening'; delay = 2000;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line) continue;
            let ev; try { ev = JSON.parse(line); } catch { continue; }
            if (ev.event !== 'message') continue;
            let msg = ev.message || '';
            let askId = null;
            try { const j = JSON.parse(msg); if (j && j.orbitAsk) { askId = j.orbitAsk; msg = j.answer; } } catch {}
            try { this._route(msg, 'ntfy', askId); } catch (e) { this.log('ntfy route: ' + e.message); }
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted) break;
        this.status.ntfy = 'reconnecting'; this.log('ntfy listen: ' + e.message);
      }
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60000);
    }
  }

  // ---------------- Telegram ----------------
  _tg(method, body, signal) {
    const token = this.s().telegramToken;
    return fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal })
      .then(r => r.json());
  }

  async _sendTelegram(title, body, id, choices) {
    const s = this.s();
    const text = `${strip(title)}\n\n${strip(body)}`.slice(0, 4000);
    const msg = { chat_id: s.telegramChatId, text };
    if (id && choices && choices.length) {
      msg.reply_markup = { inline_keyboard: choices.slice(0, 6).map((c, i) => [{ text: String(c).slice(0, 60), callback_data: `${id}|${i}` }]) };
      this._tgChoices = { id, choices };
    }
    const j = await this._tg('sendMessage', msg);
    if (!j.ok) throw new Error(j.description || 'send failed');
  }

  async _pollTelegram() {
    this.tgRunning = true;
    const gen = this.tgGen = (this.tgGen || 0) + 1;
    const ctrl = this.tgAbort = new AbortController();
    let delay = 2000;
    while (this.tgRunning && gen === this.tgGen) {
      try {
        const j = await this._tg('getUpdates', { offset: this.tgOffset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, ctrl.signal);
        if (gen !== this.tgGen) break;
        if (!j.ok) throw new Error(j.description || 'getUpdates failed');
        this.status.telegram = 'listening'; delay = 2000;
        for (const u of j.result) {
          this.tgOffset = u.update_id + 1;
          await this._handleTelegram(u);
        }
      } catch (e) {
        if (ctrl.signal.aborted || gen !== this.tgGen) break;
        this.status.telegram = 'reconnecting'; this.log('telegram: ' + e.message);
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 60000);
      }
    }
  }

  async _handleTelegram(u) {
    const s = this.s();
    if (u.callback_query) {
      const q = u.callback_query;
      if (String(q.message && q.message.chat.id) !== String(s.telegramChatId)) return;
      const [id, idx] = String(q.data || '').split('|');
      const choice = this._tgChoices && this._tgChoices.id === id ? this._tgChoices.choices[Number(idx)] : null;
      await this._tg('answerCallbackQuery', { callback_query_id: q.id, text: choice ? `Sent: ${choice}` : 'Got it' });
      if (choice) {
        await this._tg('editMessageReplyMarkup', { chat_id: s.telegramChatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
        this._route(choice, 'telegram', id);
      }
      return;
    }
    const m = u.message;
    if (!m || !m.text) return;
    const chat = String(m.chat.id);
    // Pairing: only the person who sends the pairing code can talk to this Orbit.
    if (!s.telegramChatId) {
      const code = (m.text.match(/\b(\d{6})\b/) || [])[1];
      if (code && code === s.telegramPairCode) {
        this.store.saveSettings({ telegramChatId: chat });
        await this._tg('sendMessage', { chat_id: chat, text: "Paired. I'm Orbit, and I'll message you here when something needs you. You can also just text me." });
        this.onPaired && this.onPaired();
      } else {
        await this._tg('sendMessage', { chat_id: chat, text: 'Send me the 6-digit pairing code shown in Orbit → Settings → Phone.' });
      }
      return;
    }
    if (chat !== String(s.telegramChatId)) return; // ignore strangers
    if (m.text === '/start') return;
    this._route(m.text, 'telegram');
  }

  static newTopic() { return 'orbit-' + crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  static newPairCode() { return String(crypto.randomInt(100000, 999999)); }

  async test() {
    const n = await this.send({ title: 'Orbit', body: "This is Orbit. Your phone is connected. Tap a button to check replies work.", id: 'test-' + Date.now(), choices: ['Works!', 'Nope'], kind: 'question' });
    return n;
  }
}

module.exports = { Phone };
