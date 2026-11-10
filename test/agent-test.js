// Headless test: fake OpenAI-compatible server + stubbed electron, runs a full tool-calling turn.
const http = require('http');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { shell: { openExternal: async () => {}, openPath: async () => '' } };
  return origLoad.call(this, req, ...rest);
};
const { Store } = require('../src/store');
const { Agent } = require('../src/agent');

let call = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    const j = JSON.parse(body);
    call++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    if (call === 1) {
      if (!j.tools || !j.messages[0].content.includes('You are Orbit')) throw new Error('bad request');
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_command', arguments: '{"comm' } }] } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"echo hello-orbit"}' } }] } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'memory_append', arguments: '{"name":"USER.md","text":"- Likes tests"}' } }] } }] });
    } else if (call === 2) {
      const tools = j.messages.filter(m => m.role === 'tool');
      if (!tools[0].content.includes('hello-orbit')) throw new Error('tool output missing: ' + tools[0].content);
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c3', function: { name: 'ask_user', arguments: '{"question":"Which one?","choices":["A","B"]}' } }] } }] });
    } else {
      sse({ choices: [{ delta: { content: 'Done. ' } }] });
      sse({ choices: [{ delta: { content: 'Ran it.' } }], usage: { total_tokens: 123 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(0, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-'));
  const store = new Store(dir, null);
  store.saveSettings({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fake', apiKey: 'sk-test' });
  const events = [];
  const agent = new Agent({ store, emit: (e) => { events.push(e); if (e.type === 'question') setTimeout(() => agent.resolvePending(e.id, { answer: 'B' }), 10); }, reachOut: () => {} });
  agent.handleUser('say hello', []);
  await new Promise(r => { const t = setInterval(() => { if (events.some(e => e.type === 'busy' && !e.busy)) { clearInterval(t); r(); } }, 50); });
  const types = events.map(e => e.type);
  console.log(types.join(' > '));
  const end = events.find(e => e.type === 'assistant_end');
  console.log('final:', end && end.text);
  console.log('memory:', store.readMemory('USER.md').includes('Likes tests'));
  console.log('usage:', store.getUsage().tokensToday);
  const ok = end && end.text === 'Done. Ran it.' && types.includes('question') && !types.includes('error');
  console.log(ok ? 'PASS' : 'FAIL');
  server.close();
  process.exit(ok ? 0 : 1);
});
