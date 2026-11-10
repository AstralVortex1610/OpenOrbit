// Orbit talks first: fixed hello with no brain + echo-back, brain opener note, quiet check-ins.
const assert = require('assert');
const { Live } = require('../src/live');
const mk = (settings) => {
  const ev = [];
  const store = { getSettings: () => settings, readMemory: () => '', getThread: () => [], getTasks: () => [{ name: 'JEE revision reminder' }] };
  const agent = { hub: { updates: () => [{ title: 'Bitcoin', text: 'BTC is up 3%', read: false }] }, ask: async () => 'ok' };
  return { live: new Live({ store, agent, emit: (e) => ev.push(e) }), ev };
};
(async () => {
  // 1. no brain: the call still starts, says hello, repeats what it heard
  let { live, ev } = mk({ liveEngine: 'orbit', userName: 'Affan', checkinSecs: 1 });
  const st = await live.start(); assert(live.active && live.noBrain, JSON.stringify(st));
  live.opener();
  assert(ev.some(e => e.type === 'say' && /Affan/.test(e.text) && /hear me/.test(e.text)));
  live.turn({ text: 'testing one two' });
  assert(ev.some(e => e.type === 'say' && /I heard you say: testing one two/.test(e.text)));
  // 2. quiet: it checks in by itself (at most 3 times)
  const before = ev.filter(e => e.type === 'say').length;
  await new Promise(r => setTimeout(r, 6500));
  assert(ev.filter(e => e.type === 'say').length > before, 'no check-in');
  live.stop();
  // 3. with a brain: opener goes to the model with context
  ({ live, ev } = mk({ liveEngine: 'orbit', apiKey: 'k', model: 'm', userName: 'Affan' }));
  let note = '';
  live._orbitRespond = async ({ note: n }) => { note = n; };
  await live.start(); live.opener(); live.opener();
  assert(/speak first/i.test(note) && /Bitcoin/.test(note) && /JEE revision/.test(note), note);
  live.stop();
  console.log('talk first: hello without a brain, echo-back, check-ins, brain opener with context: PASS');
  process.exit(0);
})().catch(e => { console.log('FAIL', e); process.exit(1); });
