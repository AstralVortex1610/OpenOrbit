// Orbit — Google sign-in (Gmail + Calendar) over the official APIs.
// Desktop OAuth with PKCE and a loopback redirect: the user signs in in their own browser, Orbit keeps an
// encrypted refresh token. Needs an OAuth client of type "Desktop app" from Google Cloud (see README).
const http = require('http');
const crypto = require('crypto');

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.events'];
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = process.env.ORBIT_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const API = process.env.ORBIT_GOOGLE_API || 'https://www.googleapis.com';
const GMAIL = process.env.ORBIT_GMAIL_API || 'https://gmail.googleapis.com';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const header = (msg, name) => ((msg.payload && msg.payload.headers) || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const strip = (html) => String(html).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

class Google {
  constructor(store) { this.store = store; this.access = null; this.expires = 0; }

  connected() { const s = this.store.getSettings(); return !!(s.googleRefresh && s.googleClientId); }
  email() { return this.store.getSettings().googleEmail || ''; }
  _client() {
    const s = this.store.getSettings();
    if (!s.googleClientId) throw new Error('Add your Google OAuth client ID in Settings, then Accounts, first.');
    return { id: s.googleClientId, secret: s.googleClientSecret || '' };
  }

  // Opens the consent page and waits for Google to redirect back to a one-time local server.
  connect(openExternal, timeoutMs = 300000) {
    const c = this._client();
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    return new Promise((resolve, reject) => {
      const srv = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (!u.searchParams.has('code') && !u.searchParams.has('error')) { res.writeHead(404); return res.end(); }
        const done = (ok, msg) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body style="font-family:system-ui;background:#1a1917;color:#f4ecdf;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#e4a270">${ok ? 'Orbit is connected to Google' : 'Google sign-in failed'}</h2><p>${msg}</p><p>You can close this tab.</p></div></body></html>`);
          clearTimeout(timer); srv.close();
        };
        if (u.searchParams.get('state') !== state) { done(false, 'State mismatch.'); return reject(new Error('Sign-in state mismatch. Try again.')); }
        if (u.searchParams.get('error')) { done(false, u.searchParams.get('error')); return reject(new Error(`Google said: ${u.searchParams.get('error')}`)); }
        try {
          const tok = await this._token({ grant_type: 'authorization_code', code: u.searchParams.get('code'), code_verifier: verifier, redirect_uri: redirect });
          if (!tok.refresh_token) throw new Error('Google sent no refresh token. Remove Orbit at myaccount.google.com/permissions and connect again.');
          let email = '';
          try { email = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1], 'base64').toString()).email || ''; } catch {}
          this.store.saveSettings({ googleRefresh: tok.refresh_token, googleEmail: email });
          this.access = tok.access_token; this.expires = Date.now() + (tok.expires_in - 60) * 1000;
          done(true, email ? `Signed in as ${email}.` : 'Signed in.');
          resolve(email);
        } catch (e) { done(false, e.message); reject(e); }
      });
      let redirect = '';
      const timer = setTimeout(() => { srv.close(); reject(new Error('Google sign-in timed out.')); }, timeoutMs);
      srv.listen(0, '127.0.0.1', () => {
        redirect = `http://127.0.0.1:${srv.address().port}`;
        const q = new URLSearchParams({ client_id: c.id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent' });
        openExternal(`${AUTH}?${q}`);
      });
    });
  }

  disconnect() { this.store.saveSettings({ clear_googleRefresh: true, googleEmail: '' }); this.access = null; this.expires = 0; }

  async _token(params) {
    const c = this._client();
    const body = new URLSearchParams({ client_id: c.id, ...(c.secret ? { client_secret: c.secret } : {}), ...params });
    const r = await fetch(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google token error: ${j.error_description || j.error || r.status}`);
    return j;
  }
  async _access() {
    if (this.access && Date.now() < this.expires) return this.access;
    const s = this.store.getSettings();
    if (!s.googleRefresh) throw new Error('Google is not connected. The user can connect it in Settings, then Accounts. Use the browser instead for now.');
    const tok = await this._token({ grant_type: 'refresh_token', refresh_token: s.googleRefresh });
    this.access = tok.access_token; this.expires = Date.now() + ((tok.expires_in || 3600) - 60) * 1000;
    return this.access;
  }
  async _api(method, url, body) {
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${await this._access()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google API error ${r.status}: ${(j.error && j.error.message) || ''}`);
    return j;
  }

  // ----- Gmail -----
  async gmailSearch(query, max) {
    const n = Math.max(1, Math.min(25, Number(max) || 10));
    const list = await this._api('GET', `${GMAIL}/gmail/v1/users/me/messages?maxResults=${n}&q=${encodeURIComponent(query || '')}`);
    const ids = (list.messages || []).map(m => m.id);
    if (!ids.length) return 'No emails match.';
    const msgs = await Promise.all(ids.map(id => this._api('GET', `${GMAIL}/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    return msgs.map(m => `id ${m.id} | ${header(m, 'Date')} | From: ${header(m, 'From')} | ${header(m, 'Subject')}${(m.labelIds || []).includes('UNREAD') ? ' | UNREAD' : ''}\n  ${String(m.snippet || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')}`).join('\n');
  }
  async gmailRead(id) {
    const m = await this._api('GET', `${GMAIL}/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
    let plain = '', html = '';
    const walk = (p) => {
      if (!p) return;
      const data = p.body && p.body.data ? Buffer.from(p.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '';
      if (p.mimeType === 'text/plain' && data) plain += data;
      else if (p.mimeType === 'text/html' && data) html += data;
      (p.parts || []).forEach(walk);
    };
    walk(m.payload);
    const text = (plain || strip(html) || m.snippet || '').slice(0, 10000);
    return `From: ${header(m, 'From')}\nTo: ${header(m, 'To')}\nDate: ${header(m, 'Date')}\nSubject: ${header(m, 'Subject')}\nThread: ${m.threadId}\n\n${text}`;
  }
  async gmailSend({ to, cc, subject, body, reply_to_id, draft_only }) {
    let threadId, refs = '';
    if (reply_to_id) {
      const o = await this._api('GET', `${GMAIL}/gmail/v1/users/me/messages/${encodeURIComponent(reply_to_id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`);
      threadId = o.threadId;
      const mid = header(o, 'Message-ID');
      if (mid) refs = `In-Reply-To: ${mid}\r\nReferences: ${(header(o, 'References') + ' ' + mid).trim()}\r\n`;
      if (!subject) subject = header(o, 'Subject');
      if (subject && !/^re:/i.test(subject)) subject = 'Re: ' + subject;
    }
    const subj = /^[\x00-\x7F]*$/.test(subject || '') ? subject : `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const raw = `To: ${to}\r\n${cc ? `Cc: ${cc}\r\n` : ''}Subject: ${subj}\r\n${refs}MIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body || '').toString('base64')}`;
    const message = { raw: b64url(raw), ...(threadId ? { threadId } : {}) };
    if (draft_only) { const d = await this._api('POST', `${GMAIL}/gmail/v1/users/me/drafts`, { message }); return `Saved a draft (${d.id}) to ${to}.`; }
    const r = await this._api('POST', `${GMAIL}/gmail/v1/users/me/messages/send`, message);
    return `Sent to ${to} (message ${r.id}).`;
  }

  // ----- Calendar -----
  _tz() { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  async calendarList({ start, days, query } = {}) {
    const from = start ? new Date(start) : new Date();
    if (isNaN(from)) throw new Error('Bad start date.');
    const to = new Date(from.getTime() + Math.max(1, Math.min(60, Number(days) || 7)) * 86400000);
    const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50', ...(query ? { q: query } : {}) });
    const j = await this._api('GET', `${API}/calendar/v3/calendars/primary/events?${q}`);
    const items = j.items || [];
    if (!items.length) return 'Nothing on the calendar in that window.';
    const fmt = (t) => t.dateTime ? new Date(t.dateTime).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : `${t.date} (all day)`;
    return items.map(e => `id ${e.id} | ${fmt(e.start)} to ${e.end && e.end.dateTime ? new Date(e.end.dateTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''} | ${e.summary || '(no title)'}${e.location ? ` | ${e.location}` : ''}${e.hangoutLink ? ` | Meet: ${e.hangoutLink}` : ''}${(e.attendees || []).length ? ` | ${e.attendees.length} guests` : ''}`).join('\n');
  }
  async calendarCreate({ summary, start, end, location, description, attendees, all_day }) {
    const tz = this._tz();
    let s, e;
    if (all_day || /^\d{4}-\d{2}-\d{2}$/.test(start)) {
      const d = String(start).slice(0, 10);
      const next = new Date(new Date(d + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
      s = { date: d }; e = { date: end ? String(end).slice(0, 10) : next };
    } else {
      const norm = (t) => { const x = String(t).slice(0, 19); return /T\d{2}:\d{2}$/.test(x) ? x + ':00' : x; };
      const st = norm(start);
      const en = end ? norm(end) : new Date(new Date(st).getTime() + 3600000 - new Date(st).getTimezoneOffset() * 60000).toISOString().slice(0, 19);
      s = { dateTime: st, timeZone: tz }; e = { dateTime: en, timeZone: tz };
    }
    const body = { summary, start: s, end: e, ...(location ? { location } : {}), ...(description ? { description } : {}), ...(attendees && attendees.length ? { attendees: attendees.map(email => ({ email })) } : {}) };
    const r = await this._api('POST', `${API}/calendar/v3/calendars/primary/events${attendees && attendees.length ? '?sendUpdates=all' : ''}`, body);
    return `Added "${summary}" (${r.id}). ${r.htmlLink || ''}`;
  }
  async calendarDelete(id) { await this._api('DELETE', `${API}/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`); return `Deleted event ${id}.`; }
}

module.exports = { Google, SCOPES };
