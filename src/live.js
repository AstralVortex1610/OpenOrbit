// Orbit — Live Voice. A full-duplex, speech-to-speech conversation (you can talk over it, it hears
// your tone, it laughs and reacts), with Orbit's own agent doing the real work behind it.
//
// Two engines:
//   gemini : Google Gemini Live (gemini-3.8-live). Free tier with an AI Studio key.
//            Work is handed to Orbit through one async tool, orbit_task, so it keeps talking.
//   openai : OpenAI GPT-Live (gpt-live-1), full duplex, $0.05/min. Uses client delegation:
//            GPT-Live talks, Orbit's agent (any model you picked) is the backend.
//
//   orbit  : Orbit Voice, built in. Runs on the laptop: Silero VAD + Moonshine/Whisper hear you, your own
//            chat model thinks, Kokoro speaks. No voice key, works with any brain. The ears and voice live
//            in the renderer (renderer/voice); this side does the thinking and turn-taking.
//
// Audio: the renderer captures mic PCM16 (16 kHz for Gemini, 24 kHz for OpenAI) and plays PCM16 at 24 kHz.
const WebSocket = require('ws');
const quick = require('./quick');

const GEMINI_URL = process.env.ORBIT_GEMINI_URL || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const OPENAI_URL = process.env.ORBIT_OPENAI_URL || 'wss://api.openai.com/v1/live/sessions';

const GEMINI_VOICES = ['Aoede', 'Kore', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus'];
const OPENAI_VOICES = ['marin', 'gleam', 'meridian', 'willow', 'vesper', 'nira', 'quartz'];

const uid = () => Math.random().toString(36).slice(2, 10);

function spoken(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' (code is in the chat) ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
// Symbols a voice reads badly, turned into the words a person would say.
function sayable(text) {
  return String(text || '')
    .replace(/(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d+)?)(?:\s?(L|lakh|lakhs|Cr|crore|crores|k|K)\b)?/g, (_, n, u) => `${n}${u ? ' ' + ({ L: 'lakh', Cr: 'crore', k: 'thousand', K: 'thousand' }[u] || u) : ''} rupees`)
    .replace(/\$\s?([\d,]+(?:\.\d+)?)(?:\s?(k|K|M|B|bn)\b)?/g, (_, n, u) => `${n}${u ? ' ' + ({ k: 'thousand', K: 'thousand', M: 'million', B: 'billion', bn: 'billion' }[u]) : ''} dollars`)
    .replace(/€\s?([\d,]+(?:\.\d+)?)/g, '$1 euros')
    .replace(/(\d)\s?%/g, '$1 percent')
    .replace(/(\d)\s?°\s?C\b/g, '$1 degrees').replace(/(\d)\s?°/g, '$1 degrees')
    .replace(/(\d)\.(\d)/g, '$1 point $2')
    .replace(/\s&\s/g, ' and ')
    .replace(/(\d)\s?[-–]\s?(\d)/g, '$1 to $2')
    .replace(/\be\.g\./gi, 'for example').replace(/\bi\.e\./gi, 'that is').replace(/\betc\./gi, 'and so on')
    .replace(/\bvs\.?\s/gi, 'versus ')
    .replace(/[~^{}\\]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

class Live {
  constructor({ store, agent, emit }) {
    this.store = store;
    this.agent = agent;
    this.emit = emit; // (evt) => renderer 'live:event'
    this.ws = null;
    this.engine = null;
    this.active = false;
    this.muted = false;
    this.turns = [];          // [{who:'you'|'orbit', text}] rolling transcript
    this.working = 0;         // delegated tasks in flight
    this.resumeHandle = null; // Gemini session resumption
  }

  // Which engine can run with the keys saved right now.
  static config(s) {
    // The built-in voice always starts, even with no brain yet: then it still talks and repeats what it heard,
    // so you can tell the voice itself works.
    if ((s.liveEngine || 'orbit') === 'orbit') return { engine: 'orbit', key: '', ready: true, brain: !!(s.apiKey && s.model) };
    const geminiKey = s.liveGeminiKey || (/generativelanguage\.googleapis\.com/.test(s.baseUrl || '') ? s.apiKey : '');
    const openaiKey = s.liveOpenaiKey || (/api\.openai\.com/.test(s.baseUrl || '') ? s.apiKey : '');
    let engine = s.liveEngine || 'gemini';
    if (engine === 'gemini' && !geminiKey && openaiKey) engine = 'openai';
    if (engine === 'openai' && !openaiKey && geminiKey) engine = 'gemini';
    const key = engine === 'gemini' ? geminiKey : openaiKey;
    if (!key) return { engine: 'orbit', key: '', ready: true, brain: !!(s.apiKey && s.model) }; // no voice key: fall back to the built-in voice
    return { engine, key, ready: !!key };
  }

  status() {
    const c = Live.config(this.store.getSettings());
    const eng = this.active ? this.engine : c.engine;
    return { active: this.active, engine: eng, ready: c.ready, inRate: eng === 'openai' ? 24000 : 16000, voice: this.store.getSettings().orbitVoice || 'af_heart' };
  }

  _instructions() {
    const s = this.store.getSettings();
    const name = s.userName || 'the user';
    const user = (this.store.readMemory('USER.md') || '').slice(0, 2500);
    const recent = this.store.getThread().filter(m => m.ui && typeof m.content === 'string').slice(-6)
      .map(m => `${m.role === 'user' ? name : 'Orbit'}: ${m.content.slice(0, 300)}`).join('\n');
    const handoff = this.engine === 'gemini'
      ? 'call the orbit_task tool with one clear, self-contained request'
      : 'delegate it to your backend';
    return `You are Orbit, the voice of ${name}'s personal agent, which lives on their Windows laptop.

How you talk:
- Like a sharp, warm friend on a call: short, natural, relaxed. One or two sentences at a time, then let them talk.
- Be expressive. Laugh when something is actually funny, sound pleased, surprised or concerned when it fits, and use small backchannels ("mm-hm", "yeah", "oh nice") while they talk.
- If they cut in, stop and listen. Match their energy and language; switch to Hindi or Hinglish if they do.
- Never read out lists, code, file paths or links. Give the gist and say the details are on screen.
- You are an AI, not a person. Don't pretend to have a body or feelings you don't have.

What you can do:
- Instant things (open an app or website, search Google or YouTube, play/pause, next/previous track, volume, mute, lock the PC): ${this.engine === 'gemini' ? 'call quick_action. It finishes in a blink' : 'your backend does these in a blink'}, so just say it's done in a couple of words ("Opened.", "Done.") and move on.
- You can't touch the computer yourself. For anything else that needs the laptop, its files or apps, the browser, the web, current facts, memory, reminders or scheduling, ${handoff}. Keep chatting naturally while it works.
- Never say something is done until the result comes back. If it needs ${name}'s OK, tell them to check the screen.
- Plain chit-chat, opinions and quick explanations you can answer yourself.

About ${name}:
${user || '(nothing saved yet)'}
${recent ? `\nRecent chat with Orbit:\n${recent}` : ''}`;
  }

  // ---------------- lifecycle ----------------
  async start() {
    if (this.active) return this.status();
    const s = this.store.getSettings();
    const c = Live.config(s);
    if (!c.ready) throw new Error(c.engine === 'orbit' ? 'Orbit Voice needs a brain first. Add your model in Settings.' : 'Live voice needs a Gemini or OpenAI key. Add one in Settings → Live voice.');
    this.engine = c.engine; this.key = c.key;
    this.active = true; this.muted = false; this.turns = []; this.working = 0; this.resumeHandle = null;
    this._state('connecting');
    this.noBrain = c.brain === false; this.checkins = 0; this.lastActivity = Date.now(); this.openerDone = false;
    if (this.engine === 'orbit') { this.ready = true; this.history = []; this.mergeNext = false; this._state('listening'); this._armCheckins(); return this.status(); }
    clearTimeout(this.setupT);
    this.setupT = setTimeout(() => { if (this.active && !this.ready) this._fail(`${this.engine === 'gemini' ? 'Gemini Live' : 'OpenAI GPT-Live'} didn't finish connecting. Your key may not have access to its live model. Switch Settings → Live voice to Orbit (built in), which needs no key.`); }, 20000);
    if (this.engine === 'gemini') this._openGemini();
    else this._openOpenAI();
    return this.status();
  }

  stop(reason) {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.checkinT); this.checkinT = null;
    if (this.orbitCtl) { this.orbitCtl.abort(); this.orbitCtl = null; }
    const ws = this.ws; this.ws = null;
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (this.engine === 'openai') { ws.send(JSON.stringify({ type: 'session.close' })); setTimeout(() => { try { ws.close(); } catch {} }, 3000); }
        else ws.close();
      } else if (ws) ws.terminate();
    } catch {}
    this._state('ended', reason || '');
  }

  setMuted(m) { this.muted = !!m; this._state(this.muted ? 'muted' : 'listening'); }

  // A chunk of mic audio (PCM16 mono) from the renderer.
  audio(buf) {
    if (this.engine === 'orbit') return; // the built-in voice hears you in the renderer
    if (!this.active || this.muted || !this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const b64 = Buffer.from(buf).toString('base64');
    if (this.engine === 'gemini') this._send({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } });
    else this._send({ type: 'session.input_audio.append', audio: b64 });
  }

  // Agent events, so the voice can mention approvals and quietly know what's happening.
  onAgentEvent(evt) {
    if (!this.active || !this.ready) return;
    if (this.engine === 'orbit') {
      if (evt.type === 'tool_start' && this.working) this._state('working', evt.label || evt.name);
      if (evt.type === 'approval' || evt.type === 'question') {
        const note = evt.type === 'approval' ? `Orbit needs their OK on screen for: ${evt.title}. Tell them in one short sentence to check the screen.` : `Orbit has a question on screen: ${evt.question}. Ask it out loud in one sentence; they can answer on screen.`;
        if (this.orbitBusy || this.userTalking) (this.pendingNotes || (this.pendingNotes = [])).push(note);
        else this._orbitRespond({ note });
      }
      return;
    }
    if (evt.type === 'tool_start' && this.engine === 'openai' && this.currentDelegation) {
      this._send({ type: 'session.thinking.append', event_id: 'p_' + uid(), delegation_id: this.currentDelegation, content: `In progress: ${evt.label || evt.name}` });
      this._state('working', evt.label || evt.name);
    } else if (evt.type === 'tool_start') {
      this._state('working', evt.label || evt.name);
    } else if (evt.type === 'approval' || evt.type === 'question') {
      const what = evt.type === 'approval' ? `needs your OK on screen: ${evt.title}` : `has a question on screen: ${evt.question || evt.title || ''}`;
      if (this.engine === 'openai') this._send({ type: 'session.commentary.append', event_id: 'a_' + uid(), delegation_id: this.currentDelegation || null, content: `Orbit ${what}. Ask them to check the screen.` });
      else this._send({ clientContent: { turns: [{ role: 'user', parts: [{ text: `(System note, not the user: Orbit ${what}. Briefly tell them to check the screen.)` }] }], turnComplete: true } });
    }
  }

  // ---------------- Gemini Live ----------------
  _openGemini() {
    const s = this.store.getSettings();
    const ws = this.ws = new WebSocket(`${GEMINI_URL}?key=${encodeURIComponent(this.key)}`);
    this.ready = false;
    ws.on('open', () => {
      const setup = {
        model: `models/${s.liveGeminiModel || 'gemini-3.8-live'}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.liveGeminiVoice || 'Aoede' } } },
        },
        systemInstruction: { parts: [{ text: this._instructions() }] },
        tools: [{ functionDeclarations: [{
          name: 'orbit_task',
          description: 'Hand a task to Orbit, the agent on the laptop. It can run commands, open and control apps, use the browser, search the web, read and write files, remember things, set reminders and schedule tasks. Runs in the background; keep talking while it works. Returns what Orbit did or found.',
          parameters: { type: 'OBJECT', properties: { request: { type: 'STRING', description: 'The full task in plain words, with every detail the user gave.' } }, required: ['request'] },
          behavior: 'NON_BLOCKING',
        }, {
          name: 'quick_action',
          description: 'Do an instant action on the laptop, finished in milliseconds: open an app or website, search Google or YouTube, media keys, volume, mute, lock. Use this instead of orbit_task whenever it fits.',
          parameters: { type: 'OBJECT', properties: {
            action: { type: 'STRING', enum: quick.QUICK_ACTIONS, description: 'open = app, website or file; search = Google; youtube = search YouTube.' },
            target: { type: 'STRING', description: 'For open: the app or site name, a domain, or a URL (e.g. "spotify", "gmail", "github.com").' },
            query: { type: 'STRING', description: 'For search or youtube: what to search.' },
            amount: { type: 'NUMBER', description: 'For volume: how many steps (each is 2%). Default 5.' },
          }, required: ['action'] },
        }] }],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      };
      this._send({ setup });
    });
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } this._onGemini(m); });
    ws.on('error', (e) => this._fail(e.message));
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      if (this.active && this.resumeHandle && this.reconnecting) { this.reconnecting = false; return this._openGemini(); }
      if (this.active) this._fail(reason && reason.toString() ? `Gemini closed the call: ${reason.toString().slice(0, 200)}` : `Gemini closed the call (code ${code}).`);
    });
  }

  _onGemini(m) {
    if (m.setupComplete) {
      this.ready = true; this._state('listening');
      if (this.store.getSettings().talkFirst !== false) this._send({ clientContent: { turns: [{ role: 'user', parts: [{ text: `(System note: the call just started. Speak first. ${this._openerNote()})` }] }], turnComplete: true } });
      return;
    }
    if (m.sessionResumptionUpdate && m.sessionResumptionUpdate.resumable && m.sessionResumptionUpdate.newHandle) this.resumeHandle = m.sessionResumptionUpdate.newHandle;
    if (m.goAway) { this.reconnecting = true; try { this.ws.close(); } catch {} return; }
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) { this.emit({ type: 'flush' }); this._state('listening'); }
      if (sc.modelTurn && sc.modelTurn.parts) {
        for (const p of sc.modelTurn.parts) {
          if (p.inlineData && p.inlineData.data) { this.emit({ type: 'audio', data: Buffer.from(p.inlineData.data, 'base64') }); this._speaking(); }
        }
      }
      if (sc.inputTranscription && sc.inputTranscription.text) this._caption('you', sc.inputTranscription.text);
      if (sc.outputTranscription && sc.outputTranscription.text) this._caption('orbit', sc.outputTranscription.text);
      if (sc.turnComplete) this._endTurn();
    }
    if (m.toolCall && m.toolCall.functionCalls) {
      for (const fc of m.toolCall.functionCalls) this._geminiTask(fc);
    }
  }

  async _geminiTask(fc) {
    const request = (fc.args && fc.args.request) || '';
    let result;
    if (fc.name === 'quick_action') {
      result = await this._quick(fc.args || {});
      if (!this.active || !this.ws) return;
      return this._send({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result } }] } });
    }
    // A plain "open spotify" sent as a task still goes the instant way.
    const q = fc.name === 'orbit_task' && quick.parse(request);
    if (fc.name !== 'orbit_task') result = `Unknown tool ${fc.name}.`;
    else result = q ? await this._quick(q, request) : await this._delegate(request, request);
    if (!this.active || !this.ws) { if (!q && fc.name === 'orbit_task') this._afterCall(request, result); return; }
    this._send({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result: spoken(result).slice(0, 4000), scheduling: q ? 'INTERRUPT' : 'WHEN_IDLE' } }] } }); // scheduling sits inside response, per Google's Live API docs
  }

  // ---------------- OpenAI GPT-Live ----------------
  _openOpenAI() {
    const s = this.store.getSettings();
    const ws = this.ws = new WebSocket(OPENAI_URL, { headers: { Authorization: `Bearer ${this.key}` } });
    this.ready = false;
    ws.on('open', () => {
      this._send({
        type: 'session.start',
        event_id: 'start_' + uid(),
        session: {
          model: s.liveOpenaiModel || 'gpt-live-1',
          instructions: this._instructions(),
          audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: s.liveOpenaiVoice || 'marin' } },
          delegation: { type: 'client' },
        },
      });
    });
    ws.on('unexpected-response', (_req, res) => {
      let body = ''; res.on('data', d => (body += d)); res.on('end', () => {
        let msg = body; try { const j = JSON.parse(body); msg = (j.error && j.error.message) || body; } catch {}
        this._fail(`OpenAI refused the call (HTTP ${res.statusCode}): ${String(msg).slice(0, 200)}`);
      });
    });
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } this._onOpenAI(m); });
    ws.on('error', (e) => this._fail(e.message));
    ws.on('close', () => { if (this.ws === ws && this.active) this._fail('OpenAI ended the call.'); });
  }

  _onOpenAI(m) {
    switch (m.type) {
      case 'session.started': this.ready = true; this._state('listening'); break;
      case 'session.output_audio.delta': this.emit({ type: 'audio', data: Buffer.from(m.delta, 'base64') }); this._speaking(); break;
      case 'session.input_transcript.delta': this._caption('you', m.delta); break;
      case 'session.output_transcript.delta': this._caption('orbit', m.delta); break;
      case 'session.delegation.created': this._openaiDelegation(m.delegation && m.delegation.id); break;
      case 'session.closed': this.active = false; this._state('ended'); try { this.ws && this.ws.close(); } catch {} this.ws = null; break;
      case 'error': {
        const e = m.error || {};
        // Non-fatal by default; the session stays open unless it closes.
        this.emit({ type: 'error', message: e.message || 'OpenAI reported an error.', fatal: false });
        break;
      }
    }
  }

  async _openaiDelegation(id) {
    if (!id) return;
    this.currentDelegation = id;
    const convo = this.turns.slice(-10).map(t => `${t.who === 'you' ? 'User' : 'Orbit (voice)'}: ${t.text}`).join('\n');
    const request = `Live voice conversation so far:\n${convo || '(just started)'}\n\nDo what the user is asking for in their latest turn.`;
    const lastYou = [...this.turns].reverse().find(t => t.who === 'you');
    const q = lastYou && quick.parse(lastYou.text);
    const result = q ? await this._quick(q, lastYou.text.trim()) : await this._delegate(request, lastYou ? lastYou.text.trim() : 'Voice request');
    if (!this.active || !this.ws) { if (!q) this._afterCall(lastYou ? lastYou.text.trim() : 'Voice request', result); return; }
    // GPT-Live paraphrases commentary aloud; keep each append well under its 500-token limit.
    const text = spoken(result);
    const parts = text.length > 1500 ? [text.slice(0, 1500).replace(/\s\S*$/, '') + ' (more on screen)'] : [text];
    for (const content of parts) this._send({ type: 'session.commentary.append', event_id: 'r_' + uid(), delegation_id: id, content });
    if (this.currentDelegation === id) this.currentDelegation = null;
  }

  // ---------------- Orbit Voice (built in) ----------------
  // The renderer heard a full turn. prosody: a few words on how they sounded vs. their usual.
  turn({ text, prosody }) {
    if (!this.active || this.engine !== 'orbit') return;
    text = String(text || '').trim();
    if (!text) return;
    this.lastActivity = Date.now();
    if (this.noBrain) {
      // No model yet: prove the voice loop works by saying back what it heard.
      this._caption('you', text); this._endTurn();
      this._sayFixed(`I heard you say: ${text}. My voice and hearing both work. To actually answer you, add a model in Settings.`);
      return;
    }
    const last = this.history[this.history.length - 1];
    if (this.mergeNext && last && last.role === 'user') { last.content += ' ' + text; last.cue = prosody || last.cue; }
    else this.history.push({ role: 'user', content: text, cue: prosody || '' });
    this.mergeNext = false;
    this._caption('you', text); this._endTurn();
    this._orbitRespond({});
  }

  // They talked over Orbit. heard: the part of Orbit's reply that actually played before they cut in.
  // merge: they kept talking before Orbit said anything, so treat both bits as one turn.
  interrupt({ heard, merge }) {
    if (!this.active || this.engine !== 'orbit') return;
    if (this.orbitCtl) { this.orbitCtl.abort(); this.orbitCtl = null; }
    const last = this.history[this.history.length - 1];
    if (merge) {
      if (last && last.role === 'assistant' && !last.content.trim()) this.history.pop();
      this.mergeNext = true;
    } else if (last && last.role === 'assistant') {
      last.content = heard && heard.trim() ? `${heard.trim()} — [cut off by the user here]` : '[started to answer but was cut off right away]';
    }
    this._state('listening');
  }

  talking(on) { this.userTalking = !!on; this.lastActivity = Date.now(); if (!on && !this.orbitBusy && this.pendingNotes && this.pendingNotes.length) this._orbitRespond({ note: this.pendingNotes.shift() }); }

  _orbitSystem() {
    return `${this._instructions()}

How to sound human (your words are spoken by a natural voice, so write for the ear):
- React first, then answer: "Oh nice." "Ugh, that's annoying." "Wait, really?" Then the point.
- Short spoken sentences, contractions, everyday words. Usually one or two sentences. Vary the length.
- Don't open with "Hmm" or "Okay so": the app already plays a soft "hmm" when you take a moment. Other openers ("Honestly,", "Yeah,", "Oh nice.") are fine now and then.
- No markdown, lists, emojis, URLs, or symbols. Say numbers the way people say them ("about three thirty").
- Each user turn may end with a voice cue in brackets about how they sounded (quieter, faster, flat, laughing). Let it shape your tone gently (softer if they sound tired or low, matching energy if excited). Never mention the cue itself.
- If your last reply says you were cut off, don't repeat it. Go with what they just said.
- If they're clearly still thinking or trailing off, a tiny "mm-hm, go on" is a fine reply.
- To do things: quick_action for instant actions; orbit_task for everything else on the computer or the web. Say a few words like "On it." while it works; you'll get the result later.`;
  }

  _orbitTools() {
    return [
      { type: 'function', function: { name: 'quick_action', description: 'Instant laptop action, done in milliseconds: open an app or website, Google or YouTube search, media keys, volume, mute, lock.', parameters: { type: 'object', properties: { action: { type: 'string', enum: quick.QUICK_ACTIONS }, target: { type: 'string' }, query: { type: 'string' }, amount: { type: 'number' } }, required: ['action'] } } },
      { type: 'function', function: { name: 'orbit_task', description: 'Hand a task to Orbit, the agent on the laptop (commands, apps, browser, web, files, email, calendar, memory, reminders). Runs in the background; returns right away. The result comes back later as a note.', parameters: { type: 'object', properties: { request: { type: 'string', description: 'The full task, with every detail the user gave.' } }, required: ['request'] } } },
    ];
  }

  async _orbitRespond({ note }) {
    if (!this.active) return;
    if (this.orbitCtl) this.orbitCtl.abort();
    const ctl = this.orbitCtl = new AbortController();
    if (note) this.history.push({ role: 'user', content: `(System note, not the user speaking: ${note})`, note: true });
    const s = this.store.getSettings();
    const model = s.voiceModel || s.fastModel || s.model;
    const turnId = uid();
    const reply = { role: 'assistant', content: '' };
    this.history.push(reply);
    this.orbitBusy = true;
    this._state('thinking');
    let said = false;
    const say = (t) => {
      t = spoken(t).replace(/\s+/g, ' ').trim();
      if (!t || ctl.signal.aborted) return;
      said = true;
      this.emit({ type: 'say', id: turnId, text: sayable(t) });
      this._caption('orbit', (reply.content ? ' ' : '') + t);
      reply.content += (reply.content ? ' ' : '') + t;
      this._state('speaking');
    };
    try {
      for (let round = 0; round < 3; round++) {
        const msgs = [{ role: 'system', content: this._orbitSystem() }];
        for (const h of this._window(24)) {
          if (h === reply && !h.content && !h.tool_calls) continue;
          if (h.role === 'user') msgs.push({ role: 'user', content: h.cue ? `${h.content} [voice cue: ${h.cue}]` : h.content });
          else msgs.push(h.tool_calls ? { role: 'assistant', content: h.content || null, tool_calls: h.tool_calls } : h.role === 'tool' ? h : { role: 'assistant', content: h.content });
        }
        const { text, calls } = await this._streamChat(s, model, msgs, ctl, say);
        if (ctl.signal.aborted) return;
        if (!calls.length) break;
        // Record the tool round, then answer each call.
        const callMsg = { role: 'assistant', content: text || null, tool_calls: calls };
        const idx = this.history.indexOf(reply);
        this.history.splice(idx, 0, callMsg);
        reply.content = ''; // what was said so far lives on the tool-call message
        for (const c of calls) {
          let a = {}; try { a = JSON.parse(c.function.arguments || '{}'); } catch {}
          let result;
          if (c.function.name === 'quick_action') {
            const lastYou = [...this.history].reverse().find(h => h.role === 'user' && !h.note);
            result = await this._quick(a, lastYou ? lastYou.content : '');
          } else {
            const lastYou = [...this.history].reverse().find(h => h.role === 'user' && !h.note);
            this._orbitTask(a.request || (lastYou && lastYou.content) || 'Help the user', lastYou ? lastYou.content : 'Voice request');
            result = 'Started in the background. Tell them you are on it in a few words; the result arrives later as a note.';
          }
          this.history.splice(this.history.indexOf(reply), 0, { role: 'tool', tool_call_id: c.id, content: String(result).slice(0, 2000) });
        }
        if (said && calls.every(c => c.function.name === 'orbit_task')) break; // already said "on it"
      }
    } catch (e) {
      if (e.name === 'AbortError' || ctl.signal.aborted) return;
      this.emit({ type: 'error', message: e.message, fatal: false });
      if (!said) say("I can hear you fine, but the model you picked didn't answer. The reason is on screen.");
    } finally {
      if (this.orbitCtl === ctl) {
        this.orbitCtl = null; this.orbitBusy = false;
        if (!reply.content && this.history[this.history.length - 1] === reply) this.history.pop();
        this.emit({ type: 'say_done', id: turnId });
        this.lastActivity = Date.now();
        this._endTurn();
        if (this.active) this._state(this.working ? 'working' : 'listening');
        if (this.pendingNotes && this.pendingNotes.length) { const n = this.pendingNotes.shift(); setTimeout(() => this._orbitRespond({ note: n }), 300); }
      }
    }
  }

  // ---------------- Orbit talks first ----------------
  // The renderer calls this once it can play audio. A fixed hello first (no model needed, so you
  // hear at once that the voice works), then the brain's own opener with something useful and a question.
  opener() {
    if (!this.active || this.engine !== 'orbit' || this.openerDone) return;
    this.openerDone = true;
    const s = this.store.getSettings();
    if (s.talkFirst === false) return;
    const name = s.userName || 'there';
    const h = new Date().getHours();
    const part = h < 5 ? 'Up late' : h < 12 ? 'Morning' : h < 17 ? 'Hey' : h < 22 ? 'Evening' : 'Up late';
    if (this.noBrain) { this._sayFixed(`${part}, ${name}! It's Orbit. If you can hear me, my voice works. Say something and I'll repeat it back, so we know I can hear you too.`); return; }
    this._orbitRespond({ note: this._openerNote() });
  }
  _openerNote() {
    const s = this.store.getSettings();
    const ctx = [];
    const now = new Date();
    ctx.push(`It is ${now.toLocaleString('en-IN', { weekday: 'long', hour: 'numeric', minute: '2-digit' })}.`);
    try { const ups = (this.agent.hub && this.agent.hub.updates()) || []; const fresh = ups.filter(u => !u.read).slice(0, 3); if (fresh.length) ctx.push('Unread updates: ' + fresh.map(u => `${u.title}: ${String(u.text || '').slice(0, 140)}`).join(' | ')); } catch {}
    try { const t = (this.store.getTasks() || []).filter(x => x.enabled !== false).slice(0, 4); if (t.length) ctx.push('Scheduled tasks: ' + t.map(x => x.name || x.title || x.prompt).filter(Boolean).join(', ')); } catch {}
    return `The call just started and YOU speak first, like a friend calling. Greet ${s.userName || 'them'} by name in a few words, tell them one genuinely useful thing from the context (or skip it if there is nothing), then ask one short question: what they're up to, or whether you should do something for them. Two or three short sentences, no lists. Context: ${ctx.join(' ')}`;
  }
  // When the call goes quiet, Orbit checks in by itself (a few times per call, not forever).
  _armCheckins() {
    clearInterval(this.checkinT);
    this.checkinT = setInterval(() => {
      const s = this.store.getSettings();
      const every = (Number(s.checkinSecs) || 45) * 1000;
      if (!this.active || s.talkFirst === false || this.orbitBusy || this.userTalking || this.renderSpeaking) return;
      if (Date.now() - this.lastActivity < every || this.checkins >= 3) return;
      this.checkins++; this.lastActivity = Date.now();
      if (this.noBrain) { this._sayFixed(this.checkins === 1 ? "Still here. Say anything and I'll repeat it back." : "I'm still listening whenever you're ready."); return; }
      this._orbitRespond({ note: this.checkins < 3
        ? "It's been quiet for a while. Check in like a friend would: one short line, either a useful thought, a suggestion based on what you know about them, or a quick question. Don't repeat yourself."
        : "Still quiet. Say in one short line that you'll stay quiet and they can just talk when they need you." });
    }, 5000);
  }
  _sayFixed(text) {
    const id = uid();
    this.emit({ type: 'say', id, text: sayable(text) });
    this._caption('orbit', text); this._state('speaking');
    this.emit({ type: 'say_done', id }); this._endTurn();
    this.lastActivity = Date.now();
  }
  // The renderer says when Orbit's audio is actually playing, so the screen shows Talking / Listening truthfully.
  speakingNow(on) {
    this.renderSpeaking = !!on;
    if (!on) this.lastActivity = Date.now();
    if (!this.active || this.orbitBusy) return;
    this._state(on ? 'speaking' : (this.working ? 'working' : 'listening'));
  }

  // The last n history entries, never starting on a tool result whose tool call was cut off
  // (most APIs reject that), and with any half-finished tool round dropped.
  _window(n) {
    const h = this.history.slice(-n);
    while (h.length && (h[0].role === 'tool' || (h[0].role === 'assistant' && h[0].tool_calls && !(h[1] && h[1].role === 'tool')))) h.shift();
    return h;
  }

  // A task finished after the call ended: say so out loud, and keep it in Updates.
  _afterCall(display, result) {
    const text = spoken(result || 'Done.');
    this.emit({ type: 'after_call', title: String(display || 'Voice task').slice(0, 80), text: sayable(text).slice(0, 600) });
    if (this.agent.postUpdate) this.agent.postUpdate({ kind: 'worker', title: String(display || 'Voice task').slice(0, 80), text, ok: !/^Orbit hit a problem/.test(text), target: { view: 'chat' } });
  }

  async _orbitTask(request, display) {
    const result = await this._delegate(request, display);
    if (!this.active) { this._afterCall(display, result); return; }
    const note = `The background task "${display.slice(0, 80)}" finished. Result: ${spoken(result).slice(0, 1200)}. Tell them the outcome in one or two spoken sentences.`;
    if (this.orbitBusy || this.userTalking) (this.pendingNotes || (this.pendingNotes = [])).push(note);
    else this._orbitRespond({ note });
  }

  // Streams a chat completion, handing each finished sentence to say() as soon as it's complete.
  async _streamChat(s, model, messages, ctl, say) {
    const url = String(s.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
    const headers = this.agent._headers(s);
    const body = { model, messages, tools: this._orbitTools(), tool_choice: 'auto', stream: true, temperature: 0.8 };
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) { const t = await r.text(); throw new Error(`Voice brain error (HTTP ${r.status}): ${t.slice(0, 200)}`); }
    let text = '', pending = '', buf = '';
    const calls = [];
    const flush = (force) => {
      // Cut at sentence ends; for a long first clause, cut at a comma so the voice starts sooner.
      for (;;) {
        const m = pending.match(/^([\s\S]*?[.!?…]+["')\]]*)(\s+|$)/);
        if (m && (m[2] || force)) { say(m[1]); pending = pending.slice(m[0].length); continue; }
        const c = !text.trim().length || text.length === pending.length ? pending.match(/^([\s\S]{28,}?[,;:—])\s+/) : null;
        if (c) { say(c[1]); pending = pending.slice(c[0].length); continue; }
        break;
      }
      if (force && pending.trim()) { say(pending); pending = ''; }
    };
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        const d = j.choices && j.choices[0] && j.choices[0].delta; if (!d) continue;
        if (d.content) { text += d.content; pending += d.content; flush(false); }
        if (d.tool_calls) for (const tc of d.tool_calls) {
          const k = tc.index ?? calls.length;
          if (!calls[k]) calls[k] = { id: tc.id || 'c_' + uid(), type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) calls[k].id = tc.id;
          if (tc.function && tc.function.name) calls[k].function.name += tc.function.name;
          if (tc.function && tc.function.arguments) calls[k].function.arguments += tc.function.arguments;
        }
      }
    }
    flush(true);
    return { text, calls: calls.filter(Boolean) };
  }

  // ---------------- shared ----------------
  async _quick(args, said) {
    let result;
    try { result = await quick.run(args, { open: this.agent.tools && this.agent.tools.open }); }
    catch (e) { result = `Error: ${e.message}`; }
    this.emit({ type: 'quick', action: args.action, target: args.target || args.query || '', said: said || '', result, ok: !/^Error/.test(result) });
    return result;
  }

  async _delegate(request, display) {
    this.working++;
    this._state('working', 'On it');
    let result;
    try { result = await this.agent.ask(request, 'voice', display); }
    catch (e) { result = `Orbit hit a problem: ${e.message}`; }
    this.working = Math.max(0, this.working - 1);
    if (this.active) this._state(this.working ? 'working' : 'listening');
    return result || 'Done.';
  }

  _send(obj) { try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); } catch {} }

  _state(state, detail) { this.emit({ type: 'state', state, detail: detail || '', engine: this.engine }); }

  _speaking() {
    clearTimeout(this._spkT);
    if (!this._spk) { this._spk = true; if (!this.working) this._state('speaking'); }
    this._spkT = setTimeout(() => { this._spk = false; if (this.active && !this.working) this._state(this.muted ? 'muted' : 'listening'); }, 700);
  }

  _caption(who, delta) {
    const last = this.turns[this.turns.length - 1];
    if (last && last.who === who && !last.done) last.text += delta;
    else this.turns.push({ who, text: delta.replace(/^\s+/, '') });
    if (this.turns.length > 40) this.turns.shift();
    const t = this.turns[this.turns.length - 1];
    this.emit({ type: 'caption', who, text: t.text });
  }
  _endTurn() { for (const t of this.turns) t.done = true; }

  _fail(message) {
    if (!this.active) return;
    this.emit({ type: 'error', message, fatal: true });
    this.stop(message);
  }
}

module.exports = { Live, GEMINI_VOICES, OPENAI_VOICES, sayable, spoken };
