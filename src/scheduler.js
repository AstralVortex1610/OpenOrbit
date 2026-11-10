// Orbit — scheduler: daily, interval and one-time tasks that wake Orbit up on its own.
class Scheduler {
  constructor({ store, run }) {
    this.store = store;
    this.run = run;
    this.timer = null;
    this.busy = new Set();
  }
  start() {
    this.timer = setInterval(() => this.tick(), 30 * 1000);
    setTimeout(() => this.tick(), 5000);
  }
  reload() { /* tasks are re-read every tick */ }

  isDue(t, now) {
    if (!t.enabled) return false;
    const last = t.lastRun ? new Date(t.lastRun) : null;
    if (t.kind === 'once') return !last && new Date(t.at) <= now;
    if (t.kind === 'interval') {
      const ms = (Number(t.everyHours) || 3) * 3600 * 1000;
      if (!last) return true;
      return now - last >= ms;
    }
    if (t.kind === 'daily' || t.kind === 'weekly') {
      const [h, m] = String(t.time || '08:00').split(':').map(Number);
      const target = new Date(now); target.setHours(h, m || 0, 0, 0);
      if (now < target) return false;
      if (t.kind === 'weekly' && Array.isArray(t.days) && !t.days.includes(now.getDay())) return false;
      return !last || last < target;
    }
    return false;
  }

  async tick() {
    const now = new Date();
    for (const t of this.store.getTasks()) {
      if (this.busy.has(t.id) || !this.isDue(t, now)) continue;
      await this.fire(t);
    }
  }

  async fire(t) {
    this.busy.add(t.id);
    this.store.updateTask(t.id, { lastRun: new Date().toISOString(), ...(t.kind === 'once' ? { enabled: false } : {}) });
    try { await this.run(t); } catch (e) { console.error('task failed', t.id, e); }
    finally { this.busy.delete(t.id); }
  }

  runNow(id) {
    const t = this.store.getTasks().find(x => x.id === id);
    if (t && !this.busy.has(id)) this.fire({ ...t, kind: t.kind === 'once' ? 'once' : t.kind });
  }
}

module.exports = { Scheduler };
