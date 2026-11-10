// Built-in voice engine (main side): streaming sentences, quick actions, background tasks, barge-in, merge.
const http = require('http'); const assert = require('assert');
const Module = require('module'); const orig = Module._load;
Module._load = function (r, ...a) { if (r === 'electron') return { shell: { openExternal: async () => {} } }; return orig.call(this, r, ...a); };
const { Live } = require('../src/live');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const sse = (res, parts, gap = 30) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); let i = 0; const t = setInterval(() => { if (i < parts.length) res.write('data: ' + JSON.stringify(parts[i++]) + '\n\n'); else { clearInterval(t); res.end('data: [DONE]\n\n'); } }, gap); res.on('close', () => clearInterval(t)); };
const say = (t) => ({ choices: [{ delta: { content: t } }] });
const tool = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
const reqs = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  const j = JSON.parse(b); reqs.push(j);
  const last = j.messages[j.messages.length - 1];
  const sys = j.messages[0].content;
  assert(sys.includes('How to sound human') && j.tools.some(t => t.function.name === 'orbit_task'));
  const lu = [...j.messages].reverse().find(m => m.role === 'user').content;
  if (last.role === 'tool') return sse(res, [say('Done, it\'s open.')]);
  if (/System note.*finished/.test(lu)) return sse(res, [say('Your test is on Friday at nine.')]);
  if (/open spotify/i.test(lu)) return sse(res, [tool('q1', 'quick_action', { action: 'open', target: 'spotify' })]);
  if (/when is my test/i.test(lu)) return sse(res, [say('On it, '), say('give me a sec.'), tool('o1', 'orbit_task', { request: 'Find when the physics test is' })]);
  if (/long story/i.test(lu)) return sse(res, ['Oh wow, ', 'that sounds intense. ', 'So what happened next? ', 'Did you ', 'finish it? ', 'Tell me everything.'].map(say), 120);
  if (/i mean the second one/i.test(lu)) return sse(res, [say('Got it, the second one.')]);
  return sse(res, [say('Hmm, okay.')]);
}); });
srv.listen(0, async () => {
  const settings = { liveEngine: 'orbit', apiKey: 'k', baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, model: 'm', voiceModel: 'fast' };
  const store = { getSettings: () => settings, readMemory: () => '', getThread: () => [] };
  const asked = [];
  const agent = { _headers: () => ({ 'Content-Type': 'application/json' }), tools: { open: async ({ target }) => `Opened ${target}` }, ask: async (req, src, disp) => { asked.push([req, src, disp]); await wait(300); return 'The physics test is Friday at 9 am.'; } };
  const ev = [];
  const live = new Live({ store, agent, emit: (e) => ev.push(e) });
  assert.deepEqual(Live.config(settings), { engine: 'orbit', key: '', ready: true, brain: true });
  assert.equal(Live.config({ liveEngine: 'gemini', apiKey: 'k' }).engine, 'orbit', 'falls back to built-in voice without a voice key');
  await live.start();
  assert.equal(live.status().inRate, 16000);
  const says = () => ev.filter(e => e.type === 'say').map(e => e.text);

  // 1) quick action, then spoken confirmation
  live.turn({ text: 'open spotify', prosody: '' });
  await wait(400);
  assert(ev.some(e => e.type === 'quick' && /spotify/i.test(e.result)));
  assert.deepEqual(says(), ["Done, it's open."]);
  assert.equal(reqs[0].model, 'fast');

  // 2) background task: says "on it" right away, result spoken later
  ev.length = 0;
  live.turn({ text: 'when is my test', prosody: 'quieter than usual, talking slowly' });
  await wait(250);
  assert.deepEqual(says(), ['On it, give me a sec.']);
  assert(reqs[reqs.length - 1].messages.some(m => m.role === 'user' && m.content.includes('[voice cue: quieter than usual, talking slowly]')), 'prosody cue sent');
  await wait(700);
  assert.equal(asked[0][1], 'voice');
  assert(says().includes('Your test is on Friday at nine.'), says().join('|'));

  // 3) sentences stream out as they complete; barge-in keeps only what was heard
  ev.length = 0;
  live.turn({ text: 'so long story', prosody: '' });
  await wait(450);
  const early = says();
  assert(early[0] === 'Oh wow, that sounds intense.' || early[0] === 'Oh wow,', 'first chunk early: ' + early.join('|'));
  live.interrupt({ heard: 'Oh wow, that sounds intense.' });
  const n = says().length; await wait(700);
  assert.equal(says().length, n, 'nothing more after barge-in');
  const cut = live.history.filter(h => h.role === 'assistant').pop();
  assert(/cut off by the user/.test(cut.content) && cut.content.startsWith('Oh wow, that sounds intense.'));

  // 4) they keep talking before Orbit answers: merged into one turn
  ev.length = 0;
  live.turn({ text: 'no wait', prosody: '' });
  live.interrupt({ merge: true });
  live.turn({ text: 'i mean the second one', prosody: '' });
  await wait(300);
  const users = live.history.filter(h => h.role === 'user' && !h.note);
  assert.equal(users[users.length - 1].content, 'no wait i mean the second one');
  assert(says().includes('Got it, the second one.'));
  live.stop();
  console.log('orbit voice engine: quick action, background task + spoken result, prosody cue, streaming, barge-in, merge: PASS');
  process.exit(0);
});
