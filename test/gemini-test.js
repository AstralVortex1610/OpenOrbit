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

// AQ. auth keys: sent as x-goog-api-key, never Bearer; an AIza key stays Bearer; a refusal flips once.
(async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      seen.push({ auth: req.headers.authorization || '', goog: req.headers['x-goog-api-key'] || '' });
      const key = req.headers['x-goog-api-key'] || '';
      if (req.headers.authorization && /AQ\./.test(req.headers.authorization)) { res.writeHead(400); return res.end(JSON.stringify([{ error: { code: 400, message: 'Multiple authentication credentials received' } }])); }
      if (/needbearer/.test(key)) { res.writeHead(401); return res.end(JSON.stringify({ error: { message: 'API key not valid' } })); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ready' } }] }) + '\n\ndata: [DONE]\n\n');
    });
  }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/generativelanguage.googleapis.com/v1beta/openai`;
  const a = Object.create(Agent.prototype); a.emit = () => {};
  let r = await a._complete({ baseUrl: base, apiKey: 'AQ.Ab8testkey_1Mw', model: 'gemini-4-hydrogen' }, [{ role: 'user', content: 'hi' }], 'm', false, false);
  assert.strictEqual(r.content, 'ready'); assert.strictEqual(seen[0].auth, ''); assert.strictEqual(seen[0].goog, 'AQ.Ab8testkey_1Mw');
  seen.length = 0;
  r = await a._complete({ baseUrl: base, apiKey: 'AIzaSyFake123', model: 'gemini-4-hydrogen' }, [{ role: 'user', content: 'hi' }], 'm', false, false);
  assert.strictEqual(seen[0].auth, 'Bearer AIzaSyFake123');
  // the error message comes out of Google's array-form errors
  assert.strictEqual(Agent._errText(JSON.stringify([{ error: { message: 'boom' } }])), 'boom');
  // testConnection reports main + backups
  a.store = { getSettings: () => ({ baseUrl: base, apiKey: 'AQ.main', model: 'gemini-4-hydrogen', backupModels: [{ model: 'gemini-3.8-flash', baseUrl: base, apiKey: 'AQ.backup' }] }) };
  const tc = await a.testConnection();
  assert.ok(tc.ok, tc.message); assert.ok(/gemini-3\.8-flash/.test(tc.message));
  srv.close();
  console.log('gemini auth ok');
})().catch(e => { console.error(e); process.exit(1); });
