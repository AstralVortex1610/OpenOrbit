// Orbit — Passwords. Logins you give Orbit (in chat or on the Passwords screen), encrypted with
// Windows' own data protection (Electron safeStorage). The model never reads a stored password:
// browser_login types it straight into the page.
const fs = require('fs');
const path = require('path');

const hostOf = (u) => { try { return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return String(u || '').toLowerCase().trim(); } };
const sameSite = (a, b) => { a = hostOf(a); b = hostOf(b); if (!a || !b) return false; return a === b || a.endsWith('.' + b) || b.endsWith('.' + a); };
const uid = () => Math.random().toString(36).slice(2, 10);

class Passwords {
  constructor(dir, safe) { this.file = path.join(dir, 'logins.json'); this.safe = safe; }
  _read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; } }
  _write(list) { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(list, null, 1)); fs.renameSync(tmp, this.file); }
  _enc(v) { return (this.safe && this.safe.isEncryptionAvailable() ? this.safe.encryptString(String(v)) : Buffer.from(String(v), 'utf8')).toString('base64'); }
  _dec(b) { const buf = Buffer.from(b, 'base64'); return this.safe && this.safe.isEncryptionAvailable() ? this.safe.decryptString(buf) : buf.toString('utf8'); }
  // Never includes passwords.
  list(site) {
    return this._read().filter(l => !site || sameSite(l.site, site) || (l.url && sameSite(l.url, site)))
      .map(({ passEnc, ...l }) => ({ ...l, hasPassword: !!passEnc }));
  }
  save({ id, site, url, username, password, note } = {}) {
    site = hostOf(site || url);
    if (!site) throw new Error('Which website is this login for?');
    if (!username && !password) throw new Error('Give a username or a password.');
    const list = this._read();
    let row = id ? list.find(l => l.id === id) : list.find(l => l.site === site && String(l.username || '').toLowerCase() === String(username || '').toLowerCase());
    const isNew = !row;
    if (!row) { row = { id: uid(), createdAt: Date.now() }; list.push(row); }
    row.site = site; if (url !== undefined) row.url = url || ''; if (username !== undefined) row.username = String(username || '');
    if (note !== undefined) row.note = String(note || '');
    if (password) row.passEnc = this._enc(password);
    row.updatedAt = Date.now();
    this._write(list);
    return { id: row.id, site: row.site, username: row.username, isNew };
  }
  remove(id) { const list = this._read(); const n = list.filter(l => l.id !== id); this._write(n); return list.length !== n.length; }
  secret(id) { const l = this._read().find(x => x.id === id); if (!l) return null; let password = ''; if (l.passEnc) { try { password = this._dec(l.passEnc); } catch {} } return { ...l, password }; }
  // Every stored password, for scrubbing them out of anything sent to the model.
  allSecrets() { return this._read().map(l => { try { return l.passEnc ? this._dec(l.passEnc) : ''; } catch { return ''; } }).filter(p => p && p.length >= 4); }
}

module.exports = { Passwords, hostOf, sameSite };
