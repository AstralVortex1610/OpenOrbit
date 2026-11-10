// Voice fixes (Nov 1): history window, approvals while talking, results after hang-up, sayable text.
const assert = require('assert');
const { Live, sayable } = require('../src/live');
const emitted = []; const updates = [];
const store = { getSettings: () => ({ apiKey: 'k', liveEngine: 'orbit' }), readMemory: () => '', getThread: () => [] };
const agent = { postUpdate: (u) => updates.push(u), ask: async () => 'Booked the 6 pm slot.' };
const live = new Live({ store, agent, emit: (e) => emitted.push(e) });
// 1. window never starts on an orphan tool result
live.history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: null, tool_calls: [{ id: 'x' }] }, { role: 'tool', tool_call_id: 'x', content: 'r' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'b' }];
let w = live._window(3); assert.equal(w[0].role, 'assistant'); assert(!w[0].tool_calls);
w = live._window(4); assert(w[0].tool_calls && w[1].role === 'tool');
// 2. approval while Orbit is talking is queued, not dropped
live.active = true; live.ready = true; live.engine = 'orbit'; live.orbitBusy = true; live.pendingNotes = [];
live.onAgentEvent({ type: 'approval', title: 'Send email to Sam' });
assert.equal(live.pendingNotes.length, 1); assert(/Send email to Sam/.test(live.pendingNotes[0]));
// 3. a task that finishes after the call ends is spoken + kept in Updates
(async () => {
  live.active = false;
  await live._orbitTask('book a slot', 'Book a slot');
  const ac = emitted.find(e => e.type === 'after_call');
  assert(ac && /6 pm/.test(ac.text)); assert.equal(updates.length, 1);
  // 4. symbols become words
  assert.equal(sayable('₹62,990 & up 2.4%'), '62,990 rupees and up 2 point 4 percent');
  console.log('voice fixes: window, queued approvals, after-call result, sayable: PASS');
})().catch(e => { console.log('FAIL', e); process.exit(1); });
