// Orbit — real browser control. Drives the Edge or Chrome already on the laptop
// through Playwright, with its own persistent profile so sign-ins stick between tasks.
const path = require('path');
const fs = require('fs');

const SNAPSHOT_JS = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none' && r.bottom > -50 && r.top < innerHeight + 600;
  };
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=option],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true],summary,[onclick]';
  document.querySelectorAll('[data-orbit-ref]').forEach(e => e.removeAttribute('data-orbit-ref'));
  const items = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el) || n >= 180) continue;
    n++;
    el.setAttribute('data-orbit-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : tag);
    const secret = tag === 'input' && (el.type || '').toLowerCase() === 'password';
    let name = el.getAttribute('aria-label') || el.innerText || (secret ? '' : el.value) || el.placeholder || el.title || el.alt || el.name || '';
    if (!name && el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) name = l.innerText; }
    name = String(name).replace(/\s+/g, ' ').trim().slice(0, 80);
    let extra = '';
    if (tag === 'input' || tag === 'textarea') extra = el.value ? (secret ? ' value="(password filled)"' : ` value="${String(el.value).slice(0, 40)}"`) : (el.placeholder ? ` placeholder="${el.placeholder.slice(0, 40)}"` : '');
    if (el.type === 'checkbox' || el.type === 'radio') extra += el.checked ? ' [checked]' : '';
    if (el.disabled) extra += ' [disabled]';
    items.push(`[${n}] ${role} "${name}"${extra}`);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 5000);
  return { title: document.title, url: location.href, items, text, scrollY: Math.round(scrollY), height: document.documentElement.scrollHeight, vh: innerHeight };
};

class Browser {
  // parent: the main Browser. A child (a background task) gets its own tab in the parent's signed-in window.
  constructor(store, parent) { this.store = store; this.parent = parent || null; this.ctx = null; this.page = null; this.claimed = new WeakSet(); }

  async _ensure() {
    if (this.parent) {
      if (this.page && !this.page.isClosed() && this.ctx === this.parent.ctx) return this.page;
      await this.parent._ensure();
      this.ctx = this.parent.ctx;
      const p = await this.ctx.newPage();
      this.parent.claimed.add(p);
      this.page = p;
      return p;
    }
    if (this.ctx && this.page && !this.page.isClosed()) return this.page;
    if (this.ctx) { const pages = this.ctx.pages().filter(p => !p.isClosed() && !this.claimed.has(p)); if (pages.length) { this.page = pages[pages.length - 1]; return this.page; } }
    const { chromium } = require('playwright-core');
    const profile = path.join(this.store.dir, 'browser-profile');
    fs.mkdirSync(profile, { recursive: true });
    const pref = this.store.getSettings().browserChannel || 'msedge';
    const tries = [...new Set([pref, 'msedge', 'chrome', 'chromium'])];
    let lastErr;
    for (const channel of tries) {
      try {
        const opts = { headless: process.env.ORBIT_HEADLESS === '1', viewport: null, args: ['--start-maximized', '--disable-blink-features=AutomationControlled'] };
        if (process.env.ORBIT_BROWSER_PATH) opts.executablePath = process.env.ORBIT_BROWSER_PATH;
        else if (channel !== 'chromium') opts.channel = channel;
        this.ctx = await chromium.launchPersistentContext(profile, opts);
        break;
      } catch (e) { lastErr = e; this.ctx = null; }
    }
    if (!this.ctx) throw new Error(`Could not start Edge or Chrome. Install one of them. (${String(lastErr && lastErr.message).split('\n')[0]})`);
    this.ctx.on('close', () => { this.ctx = null; this.page = null; });
    this.ctx.on('page', p => { setTimeout(() => { if (!this.claimed.has(p)) this.page = p; }, 80); });
    this.page = this.ctx.pages().find(p => !this.claimed.has(p)) || await this.ctx.newPage();
    return this.page;
  }

  async _settle(p) {
    try { await p.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch {}
    try { await p.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}
  }

  async snapshot() {
    const p = await this._ensure();
    await this._settle(p);
    const s = await p.evaluate(SNAPSHOT_JS);
    const tabs = this.ctx.pages().length;
    return `Page: ${s.title}\nURL: ${s.url}${tabs > 1 ? `\nTabs open: ${tabs}` : ''}\nScroll: ${s.scrollY} of ${s.height}px\n\nInteractive elements (use the number as ref):\n${s.items.join('\n') || '(none visible)'}\n\nPage text:\n${s.text}`;
  }

  async navigate(url) {
    const p = await this._ensure();
    if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return this.snapshot();
  }

  _loc(p, ref) { return p.locator(`[data-orbit-ref="${String(ref).replace(/\D/g, '')}"]`).first(); }

  async click(ref) {
    const p = await this._ensure();
    const loc = this._loc(p, ref);
    if (!(await loc.count())) return 'Error: that ref is gone. Take a fresh browser_snapshot.';
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await loc.click({ timeout: 10000 });
    await p.waitForTimeout(600);
    return this.snapshot();
  }

  async type(ref, text, submit) {
    const p = await this._ensure();
    const loc = this._loc(p, ref);
    if (!(await loc.count())) return 'Error: that ref is gone. Take a fresh browser_snapshot.';
    const tag = await loc.evaluate(e => e.tagName.toLowerCase());
    if (tag === 'select') await loc.selectOption({ label: text }).catch(() => loc.selectOption(text));
    else { await loc.fill(''); await loc.pressSequentially(String(text), { delay: 12 }); }
    if (submit) await loc.press('Enter');
    await p.waitForTimeout(submit ? 1200 : 300);
    return this.snapshot();
  }

  // Fill a saved login into the page without the model ever seeing the password.
  async login({ username, password }, { usernameRef, passwordRef, submit = true } = {}) {
    const p = await this._ensure();
    await this._settle(p);
    const vis = async (loc) => (await loc.count()) && (await loc.isVisible().catch(() => false));
    let pass = passwordRef ? this._loc(p, passwordRef) : p.locator('input[type="password"]:visible').first();
    const hasPass = await vis(pass);
    let user = usernameRef ? this._loc(p, usernameRef) : null;
    if (!user) {
      const sel = ['input[autocomplete="username"]', 'input[type="email"]', 'input[name*="user" i]', 'input[name*="email" i]', 'input[id*="user" i]', 'input[id*="email" i]', 'input[name*="login" i]', 'input[type="tel"]', 'input[type="text"]'];
      for (const q of sel) { const l = p.locator(q + ':visible').first(); if (await vis(l)) { user = l; break; } }
    }
    const did = [];
    if (username && user && await vis(user)) {
      const cur = await user.inputValue().catch(() => '');
      if (cur !== username) { await user.fill(''); await user.pressSequentially(String(username), { delay: 15 }); }
      did.push('username');
    }
    if (hasPass && password) { await pass.fill(''); await pass.pressSequentially(String(password), { delay: 15 }); did.push('password'); }
    if (!did.length) return 'Error: no login fields on this page. Open the sign-in page first (browser_snapshot to check), or pass username_ref / password_ref.';
    if (submit) { await (hasPass ? pass : user).press('Enter').catch(() => {}); await p.waitForTimeout(1800); }
    const note = hasPass ? `Filled ${did.join(' and ')}${submit ? ' and submitted' : ''}.` : 'Filled the username and went to the next step. If the next page asks for the password, call browser_login again with the same id.';
    return note + '\n\n' + await this.snapshot();
  }

  async press(key) { const p = await this._ensure(); await p.keyboard.press(key); await p.waitForTimeout(500); return this.snapshot(); }

  async scroll(direction) {
    const p = await this._ensure();
    const dy = direction === 'up' ? -0.85 : 0.85;
    await p.evaluate(d => window.scrollBy(0, innerHeight * d), dy);
    await p.waitForTimeout(400);
    return this.snapshot();
  }

  async back() { const p = await this._ensure(); await p.goBack({ timeout: 15000 }).catch(() => {}); return this.snapshot(); }

  async tab(index) {
    await this._ensure();
    const pages = this.ctx.pages().filter(pg => this.parent ? true : !this.claimed.has(pg));
    if (index == null) return pages.map((pg, i) => `${i}: ${pg.url()}`).join('\n');
    const pg = pages[Number(index)];
    if (!pg) return 'Error: no such tab.';
    this.page = pg; await pg.bringToFront();
    return this.snapshot();
  }

  async screenshot() {
    const p = await this._ensure();
    const buf = await p.screenshot({ type: 'jpeg', quality: 65 });
    return { text: `Screenshot of ${p.url()} attached next.`, image: 'data:image/jpeg;base64,' + buf.toString('base64') };
  }

  async close() {
    if (this.parent) { if (this.page && !this.page.isClosed()) await this.page.close().catch(() => {}); this.page = null; return 'Closed this task\'s tab.'; }
    if (this.ctx) await this.ctx.close().catch(() => {}); this.ctx = null; this.page = null; return 'Browser closed. Sign-ins are kept for next time.'; }
}

module.exports = { Browser };
