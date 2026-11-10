// Live ntfy round trip + mocked Telegram pairing/answer flow.
const { Phone } = require('../src/phone');
const mkStore = (o) => { let s = { ntfyServer: 'https://ntfy.sh', ...o }; return { getSettings: () => s, saveSettings: (p) => { s = { ...s, ...p }; } }; };
(async () => {
  // ntfy
  const topic = Phone.newTopic();
  let got = null, msg = null;
  const p = new Phone({ store: mkStore({ ntfyEnabled: true, ntfyTopic: topic }), onAnswer: (id, t) => (got = { id, t }), onMessage: (t) => (msg = t), log: console.log });
  p.restart();
  await new Promise(r => setTimeout(r, 2500));
  const n = await p.send({ title: 'Orbit has a question', body: 'Pizza or biryani?', id: 'ask1', choices: ['Pizza', 'Biryani'], kind: 'question' });
  // what the phone's button does:
  await fetch(`https://ntfy.sh/${topic}-reply`, { method: 'POST', body: JSON.stringify({ orbitAsk: 'ask1', answer: 'Biryani' }) });
  await new Promise(r => setTimeout(r, 2500));
  await fetch(`https://ntfy.sh/${topic}-reply`, { method: 'POST', body: 'remind me at 6' });
  await new Promise(r => setTimeout(r, 2500));
  p.stopAll();
  console.log('ntfy sent to', n, 'channel; answer:', JSON.stringify(got), 'free message:', msg);
  const ntfyOk = got && got.id === 'ask1' && got.t === 'Biryani' && msg === 'remind me at 6';

  // Telegram (mocked API)
  const sent = []; const updates = [];
  global.fetch = async (url, opt) => {
    const method = url.split('/').pop(); const body = JSON.parse(opt.body || '{}');
    if (method === 'getUpdates') { await new Promise(r => setTimeout(r, 50)); return { json: async () => ({ ok: true, result: updates.splice(0) }) }; }
    sent.push({ method, body }); return { json: async () => ({ ok: true, result: {} }) };
  };
  const store = mkStore({ telegramEnabled: true, telegramToken: 'x', telegramPairCode: '424242', telegramChatId: '' });
  let tg = null, tgMsg = null;
  const t = new Phone({ store, onAnswer: (id, a) => (tg = { id, a }), onMessage: (m) => (tgMsg = m) });
  t.restart();
  updates.push({ update_id: 1, message: { chat: { id: 999 }, text: 'hello' } });             // stranger before pairing
  await new Promise(r => setTimeout(r, 200));
  updates.push({ update_id: 2, message: { chat: { id: 777 }, text: '424242' } });            // pairing
  await new Promise(r => setTimeout(r, 200));
  await t.send({ title: 'Orbit needs your OK', body: 'Delete temp files?', id: 'ap1', choices: ['Approve', 'Deny'], kind: 'approval' });
  updates.push({ update_id: 3, callback_query: { id: 'cb', data: 'ap1|0', message: { chat: { id: 777 }, message_id: 5 } } });
  await new Promise(r => setTimeout(r, 200));
  updates.push({ update_id: 4, message: { chat: { id: 888 }, text: 'i am a stranger' } });   // ignored
  updates.push({ update_id: 5, message: { chat: { id: 777 }, text: "what's on my plate today" } });
  await new Promise(r => setTimeout(r, 300));
  t.stopAll();
  const tgOk = store.getSettings().telegramChatId === '777' && tg && tg.id === 'ap1' && tg.a === 'Approve' && tgMsg === "what's on my plate today" && sent.some(s => s.body.reply_markup);
  console.log('telegram paired:', store.getSettings().telegramChatId, 'answer:', JSON.stringify(tg), 'msg:', tgMsg);
  console.log(ntfyOk && tgOk ? 'PHONE PASS' : 'PHONE FAIL');
  process.exit(0);
})();
