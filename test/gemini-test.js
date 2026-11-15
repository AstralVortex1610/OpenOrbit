// Gemini (AI Studio) compatibility: base URL fix, models/ prefix, clean tool schemas, thought_signature echo.
const assert = require('assert');
const http = require('http');
const { fixGoogleUrl, fixModelName } = require('../src/store');
const { Agent } = require('../src/agent');
const { TOOL_SCHEMAS } = require('../src/tools');

assert.strictEqual(fixGoogleUrl('https://generativelanguage.googleapis.com/v1beta'), 'https://generativelanguage.googleapis.com/v1beta/openai');
assert.strictEqual(fixGoogleUrl('https://generativelanguage.googleapis.com/'), 'https://generativelanguage.googleapis.com/v1beta/openai');
assert.strictEqual(fixGoogleUrl('https://generativelanguage.googleapis.com/v1beta/openai/'), 'https://generativelanguage.googleapis.com/v1beta/openai/');
assert.strictEqual(fixGoogleUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
assert.strictEqual(fixModelName('models/gemini-4-hydrogen', 'https://generativelanguage.googleapis.com/v1beta/openai'), 'gemini-4-hydrogen');
assert.strictEqual(fixModelName(' gemini-4-hydrogen ', 'https://x'), 'gemini-4-hydrogen');

const g = Agent._geminiTools(TOOL_SCHEMAS);
for (const t of g) {
  const p = t.function.parameters;
  if (p) assert.ok(Object.keys(p.properties || {}).length, t.function.name + ' has empty properties');
  assert.ok(!JSON.stringify(p || {}).includes('"additionalProperties"'), t.function.name);
}
assert.strictEqual(g.length, TOOL_SCHEMAS.length);

// thought_signature survives the stream
(async () => {
  let got;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      got = { url: req.url, body: JSON.parse(b) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'memory_list', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG' } } }] } }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  }).listen(0);
  const port = srv.address().port;
  const a = Object.create(Agent.prototype);
  a.emit = () => {};
  const s = { baseUrl: `http://127.0.0.1:${port}/generativelanguage.googleapis.com/v1beta/openai`, apiKey: 'k', model: 'gemini-4-hydrogen' };
  const r = await a._complete(s, [{ role: 'user', content: 'hi' }], 'm1', false, false);
  assert.strictEqual(r.toolCalls[0].extra_content.google.thought_signature, 'SIG');
  assert.ok(got.body.tools.every(t => !t.function.parameters || Object.keys(t.function.parameters.properties || {}).length));
  srv.close();
  console.log('gemini-test ok');
})().catch(e => { console.error(e); process.exit(1); });
