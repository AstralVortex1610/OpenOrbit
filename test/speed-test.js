// Voice speed paths: voice model routing, queue priority, parallel read-only tools.
const assert = require('assert');
const { Agent } = require('../src/agent');
let thread = [];
const settings = { apiKey: 'k', baseUrl: 'http://x', model: 'big', fastModel: 'fast', voiceModel: 'voice', maxSteps: 5 };
const store = { getSettings: () => settings, getThread: () => thread.slice(), saveThread: t => (thread = t), getUsage: () => ({ tokensToday: 0 }), addUsage() {},
  readMemory: () => '', listMemory: () => [], listSkills: () => [] };
const agent = new Agent({ store, emit() {}, reachOut() {} });
const models = []; let step = 0; const started = [];
global.fetch = async (url) => { started.push([url, Date.now()]); await new Promise(r => setTimeout(r, 200)); return { text: async () => '<html></html>' }; }; // web_search hits fetch
agent._complete = async (s, messages) => {
  models.push(s.model);
  if (step++ === 0) return { content: '', tokens: 1, toolCalls: [1, 2, 3].map(i => ({ id: 'c' + i, function: { name: 'web_search', arguments: JSON.stringify({ query: 'q' + i }) } })) };
  return { content: 'Done fast.', tokens: 1, toolCalls: [] };
};
(async () => {
  const t0 = Date.now();
  const r = await agent.ask('find three things', 'voice');
  const took = Date.now() - t0;
  assert.equal(r, 'Done fast.');
  assert.deepEqual(models, ['voice', 'voice']);
  assert(took < 450, 'three 200ms searches ran in parallel, took ' + took);
  // voice tasks don't wait for the main lane
  agent.mainBusy = true; step = 1;
  assert.equal(await agent.ask('hi', 'voice'), 'Done fast.');
  console.log('voice model, parallel tools (' + took + 'ms), priority: PASS');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
