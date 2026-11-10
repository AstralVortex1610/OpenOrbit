// Protocol test for Live voice against mock Gemini Live and GPT-Live servers.
const { WebSocketServer } = require('ws');
const assert = require('assert');
const gsrv = new WebSocketServer({ port: 18931 });
const osrv = new WebSocketServer({ port: 18932 });
process.env.ORBIT_GEMINI_URL = 'ws://127.0.0.1:18931/g';
process.env.ORBIT_OPENAI_URL = 'ws://127.0.0.1:18932/o';
const { Live } = require('../src/live');

const settings = { liveEngine: 'gemini', liveGeminiKey: 'AIzaTEST', liveOpenaiKey: 'sk-test', userName: 'Affan', liveGeminiVoice: 'Kore', liveOpenaiVoice: 'gleam', talkFirst: false };
const store = { getSettings: () => settings, readMemory: () => '# About me\n- JEE student', getThread: () => [{ ui: true, role: 'user', content: 'hi' }] };
const asked = [];
const agent = { ask: async (req, src, display) => { asked.push({ req, src, display }); await new Promise(r => setTimeout(r, 50)); return '**Done.** Opened Chrome. ```x```'; } };
const events = [];
const live = new Live({ store, agent, emit: (e) => events.push(e) });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(20); } };

(async () => {
  // ---------- Gemini ----------
  let gmsgs = [], gsock, gurl;
  gsrv.on('connection', (s, req) => { gsock = s; gurl = req.url; s.on('message', m => gmsgs.push(JSON.parse(m))); });
  const st = await live.start();
  assert.equal(st.engine, 'gemini'); assert.equal(st.inRate, 16000);
  await until(() => gmsgs.length);
  const setup = gmsgs[0].setup;
  assert(gurl.includes('key=AIzaTEST'), 'key in url');
  assert.equal(setup.model, 'models/gemini-3.8-live');
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(setup.tools[0].functionDeclarations[0].behavior, 'NON_BLOCKING');
  assert(setup.systemInstruction.parts[0].text.includes('JEE student'));
  live.audio(Buffer.alloc(640)); await wait(50);
  assert.equal(gmsgs.length, 1, 'no audio before setupComplete');
  gsock.send(JSON.stringify({ setupComplete: {} }));
  await until(() => events.some(e => e.type === 'state' && e.state === 'listening'));
  live.audio(new Uint8Array(640).buffer); await until(() => gmsgs.length === 2);
  assert.equal(gmsgs[1].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(Buffer.from(gmsgs[1].realtimeInput.audio.data, 'base64').length, 640);
  gsock.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'open ' } } }));
  gsock.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'chrome' } } }));
  gsock.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] }, outputTranscription: { text: 'Sure, one sec.' } } }));
  gsock.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'fc1', name: 'orbit_task', args: { request: 'Find my physics notes and open them' } }] } }));
  gsock.send(JSON.stringify({ serverContent: { interrupted: true } }));
  await until(() => gmsgs.some(m => m.toolResponse));
  const tr = gmsgs.find(m => m.toolResponse).toolResponse.functionResponses[0];
  assert.equal(tr.id, 'fc1'); assert.equal(tr.response.scheduling, 'WHEN_IDLE');
  assert(!tr.response.result.includes('**') && tr.response.result.includes('code is in the chat'), tr.response.result);
  assert.equal(asked[0].req, 'Find my physics notes and open them'); assert.equal(asked[0].src, 'voice');
  assert(events.some(e => e.type === 'caption' && e.who === 'you' && e.text === 'open chrome'));
  assert(events.some(e => e.type === 'audio' && e.data.length === 480));
  assert(events.some(e => e.type === 'flush'));
  assert(events.some(e => e.type === 'state' && e.state === 'working'));
  // Instant actions skip the agent: quick_action, and a plain "open X" sent as orbit_task.
  const nAsked = asked.length;
  gsock.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'fq1', name: 'quick_action', args: { action: 'search', query: 'jee main dates' } }] } }));
  gsock.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'fq2', name: 'orbit_task', args: { request: 'Open Spotify' } }] } }));
  await until(() => gmsgs.filter(m => m.toolResponse && /^fq/.test(m.toolResponse.functionResponses[0].id)).length === 2);
  const q1 = gmsgs.find(m => m.toolResponse && m.toolResponse.functionResponses[0].id === 'fq1').toolResponse.functionResponses[0];
  const q2 = gmsgs.find(m => m.toolResponse && m.toolResponse.functionResponses[0].id === 'fq2').toolResponse.functionResponses[0];
  assert.equal(q1.response.result, 'Searched Google for jee main dates.');
  assert(/spotify/i.test(q2.response.result) && q2.response.scheduling === 'INTERRUPT', JSON.stringify(q2));
  assert.equal(asked.length, nAsked, 'quick actions never reach the agent');
  assert(events.some(e => e.type === 'quick' && e.action === 'search'));
  assert(setup.tools[0].functionDeclarations[1].name === 'quick_action');
  // goAway with a resumption handle reconnects with that handle
  gsock.send(JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: 'H123' } }));
  await wait(30);
  const before = gmsgs.length;
  gsock.send(JSON.stringify({ goAway: { timeLeft: '1s' } }));
  await until(() => gmsgs.length > before && gmsgs[gmsgs.length - 1].setup);
  assert.equal(gmsgs[gmsgs.length - 1].setup.sessionResumption.handle, 'H123');
  console.log('gemini: setup, audio, captions, async tool, interrupt, resume OK');
  live.stop(); await wait(100);

  // ---------- OpenAI GPT-Live ----------
  settings.liveEngine = 'openai'; events.length = 0; asked.length = 0;
  let omsgs = [], osock, oauth;
  osrv.on('connection', (s, req) => { osock = s; oauth = req.headers.authorization; s.on('message', m => omsgs.push(JSON.parse(m))); });
  const st2 = await live.start();
  assert.equal(st2.inRate, 24000);
  await until(() => omsgs.length);
  assert.equal(oauth, 'Bearer sk-test');
  const ss = omsgs[0];
  assert.equal(ss.type, 'session.start'); assert.equal(ss.session.model, 'gpt-live-1');
  assert.deepEqual(ss.session.audio, { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'gleam' } });
  assert.equal(ss.session.delegation.type, 'client');
  osock.send(JSON.stringify({ type: 'session.started', session: { id: 's1' } }));
  await until(() => events.some(e => e.state === 'listening'));
  live.audio(Buffer.alloc(960)); await until(() => omsgs.length === 2);
  assert.equal(omsgs[1].type, 'session.input_audio.append');
  osock.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'What is on my ' }));
  osock.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'calendar?' }));
  osock.send(JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.alloc(200).toString('base64') }));
  osock.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'item_d1', type: 'delegation', target: 'client' } }));
  await until(() => asked.length);
  live.onAgentEvent({ type: 'tool_start', name: 'web_search', label: 'Searching the web' });
  await until(() => omsgs.some(m => m.type === 'session.commentary.append'));
  const think = omsgs.find(m => m.type === 'session.thinking.append');
  assert.equal(think.delegation_id, 'item_d1');
  const com = omsgs.find(m => m.type === 'session.commentary.append');
  assert.equal(com.delegation_id, 'item_d1'); assert(com.content.includes('Opened Chrome'));
  assert(asked[0].req.includes('User: What is on my calendar?')); assert.equal(asked[0].display, 'What is on my calendar?');
  // GPT-Live: "pause the music" is handled instantly, no agent call.
  const nA2 = asked.length; const nC = omsgs.filter(m => m.type === 'session.commentary.append').length;
  live._endTurn();
  osock.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Google latest AI news' }));
  osock.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'item_d2', type: 'delegation', target: 'client' } }));
  await until(() => omsgs.filter(m => m.type === 'session.commentary.append').length > nC);
  assert.equal(asked.length, nA2); assert(omsgs.filter(m => m.type === 'session.commentary.append').pop().content.includes('Searched Google for latest ai news'));
  osock.send(JSON.stringify({ type: 'error', error: { message: 'minor' } }));
  await until(() => events.some(e => e.type === 'error' && !e.fatal));
  live.stop();
  await until(() => omsgs.some(m => m.type === 'session.close'));
  osock.send(JSON.stringify({ type: 'session.closed', reason: 'close_requested' }));
    console.log('openai: session.start, audio, transcript, client delegation, progress, commentary, close OK');

  // ---------- config fallbacks ----------
  assert.equal(Live.config({ liveEngine: 'gemini', liveOpenaiKey: 'x' }).engine, 'openai');
  assert.equal(Live.config({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'AIza' }).ready, true);
  assert.equal(Live.config({}).ready, true); assert.equal(Live.config({}).brain, false); // the built-in voice starts even with no brain
  console.log('PASS');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
