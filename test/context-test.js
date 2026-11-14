// Context budget: input stays bounded however long the thread grows.
const assert = require('assert');
const { Agent } = require('../src/agent.js');
const C = Agent.compactContext;
const tok = (msgs) => Math.ceil(JSON.stringify(msgs).length / 4);
const img = { role: 'user', hidden: true, content: [{ type: 'text', text: '(Image)' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(200000) } }] };

// 1. A long task: one request, then 40 steps of big tool output and screenshots.
const t = [{ role: 'user', content: 'Build me the dashboard and deploy it' }];
for (let i = 0; i < 40; i++) {
  t.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'run', arguments: '{"cmd":"x"}' } }] });
  t.push({ role: 'tool', tool_call_id: 'c' + i, name: 'run', content: 'line\n'.repeat(2800) });
  if (i % 5 === 0) t.push(img);
}
const out = C(t, { max: 50, budget: 24000 });
const imgs = out.filter(m => Array.isArray(m.content)).length;
console.log('messages', out.length, 'approx tokens (text only)', tok(out.map(m => Array.isArray(m.content) ? { ...m, content: '' } : m)), 'images', imgs);
assert.strictEqual(out[0].role, 'user'); assert.strictEqual(out[0].content, 'Build me the dashboard and deploy it', 'task request pinned');
assert.ok(imgs <= 1, 'only newest screenshot');
assert.ok(tok(out.map(m => Array.isArray(m.content) ? { ...m, content: '' } : m)) < 30000, 'under budget');
// every tool result has its call in view
const ids = new Set(out.flatMap(m => (m.tool_calls || []).map(c => c.id)));
for (const m of out) if (m.role === 'tool') assert.ok(ids.has(m.tool_call_id), 'orphan tool ' + m.tool_call_id);
assert.notStrictEqual(out[1].role, 'tool');

// 2. Short chat passes through untouched.
const s = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }, { role: 'user', content: 'what is 2+2' }];
assert.deepStrictEqual(C(s), s.map(m => ({ role: m.role, content: m.content })));

// 3. Growth is flat: 40 steps vs 400 steps cost about the same.
const big = [...t]; for (let i = 40; i < 400; i++) { big.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'run', arguments: '{}' } }] }); big.push({ role: 'tool', tool_call_id: 'c' + i, name: 'run', content: 'y'.repeat(14000) }); }
const a = tok(C(t)), b = tok(C(big));
console.log('40 steps', a, '400 steps', b);
assert.ok(b < 30000);
console.log('context-test: all passed');
