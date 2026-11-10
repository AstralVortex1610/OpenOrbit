const { contextBridge } = require('electron');
let handler = () => {};
const tasks = [
  { id: 'morning-brief', name: 'Morning brief', kind: 'daily', time: '07:30', enabled: true, prompt: 'Give me my morning brief…', lastRun: new Date().toISOString() },
  { id: 'check-in', name: 'Check-in', kind: 'interval', everyHours: 3, enabled: false, prompt: 'Quiet check-in…' },
  { id: 'physics', name: 'Revise physics', kind: 'daily', time: '18:00', enabled: true, prompt: 'Remind Affan to revise rotational motion for 45 minutes.' },
];
contextBridge.exposeInMainWorld('orbit', {
  getSettings: async () => ({ userName: 'Affan', hasKey: true, keyPreview: 'sk-a…9f2c', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', transcribeModel: 'whisper-1', approvalMode: 'risky', dailyTokenCap: 2000000, maxSteps: 25, hotkey: 'Control+Shift+O', closeToTray: true, theme: 'dark', browserChannel: 'msedge', phoneWhen: 'away', phoneIdleMinutes: 3, ntfyEnabled: true, ntfyTopic: 'orbit-k3v9x2mq7tpa', telegramEnabled: true, hasTelegramToken: true, telegramChatId: '', telegramPairCode: '583104', wakeWord: false }),
  listModels: async () => ({ ok: true, models: ['deepseek-chat', 'deepseek-reasoner'] }), saveSettings: async (s) => s, testConnection: async () => ({ ok: true, message: 'ok' }),
  getThread: async () => [], clearThread: async () => true, send: async () => true, stop: async () => true, stopLane: async () => true, googleConnect: async () => ({ ok: true }), googleDisconnect: async () => ({}),
  answerApproval: async () => true, answerQuestion: async () => true,
  getTasks: async () => tasks, toggleTask: async () => tasks, deleteTask: async () => tasks, runTask: async () => true,
  listMemory: async () => [{ name: 'USER.md', size: 200, updated: Date.now() }], readMemory: async () => '# About me', writeMemory: async () => true, openMemoryFolder: async () => true,
  getUsage: async () => ({ tokensToday: 48210 }), transcribe: async () => '', info: async () => ({ version: '0.1.0' }),
  win: { minimize() {}, maximize() {}, close() {} },
  on: (ch, fn) => { if (ch === 'agent:event') handler = fn; },
});
contextBridge.exposeInMainWorld('__demo5', () => {
  const e = handler;
  e({ type: 'busy', busy: true });
  e({ type: 'user_message', id: 'u1', text: 'Compare the 3 best laptops under 80k for coding and make me a table' });
  e({ type: 'tool_start', id: 'm1', name: 'start_task', args: {}, label: 'Starting background task: Lenovo Yoga Slim 7' }); e({ type: 'tool_end', id: 'm1', ok: true, preview: '' });
  e({ type: 'tool_start', id: 'm2', name: 'start_task', args: {}, label: 'Starting background task: ASUS Zenbook 14' }); e({ type: 'tool_end', id: 'm2', ok: true, preview: '' });
  e({ type: 'tool_start', id: 'm3', name: 'start_task', args: {}, label: 'Starting background task: MacBook Air M4' }); e({ type: 'tool_end', id: 'm3', ok: true, preview: '' });
  e({ type: 'tool_start', id: 'm4', name: 'wait_tasks', args: {}, label: 'Waiting for background tasks' });
  e({ type: 'worker', id: 't1', lane: 't1', label: 'Lenovo Yoga Slim 7', state: 'running', step: 'Browsing flipkart.com' });
  e({ type: 'worker', id: 't2', lane: 't2', label: 'ASUS Zenbook 14', state: 'running', step: 'Searching: Zenbook 14 OLED price India' });
  e({ type: 'worker', id: 't3', lane: 't3', label: 'MacBook Air M4', state: 'running', step: 'Reading apple.com/in' });
  e({ type: 'user_message', id: 'u2', text: 'btw when is my physics test?', side: true, lane: 'side-1' });
  e({ type: 'tool_start', id: 's1', name: 'calendar_events', args: {}, label: 'Checking your calendar', lane: 'side-1' }); e({ type: 'tool_end', id: 's1', ok: true, preview: '', lane: 'side-1' });
  e({ type: 'assistant_end', id: 's2', text: "Friday at 9 am. I'm still pulling laptop prices, about a minute left.", side: true, lane: 'side-1' });
  e({ type: 'lane_done', lane: 'side-1' });
});
contextBridge.exposeInMainWorld('__demo', () => {
  const e = handler;
  e({ type: 'busy', busy: true });
  e({ type: 'user_message', id: 'u1', text: "What's taking up space on my C drive?" });
  e({ type: 'tool_start', id: 't1', name: 'run_command', args: {}, label: 'Running: Get-ChildItem C:\\Users\\Affan -Directory | sort size' });
  e({ type: 'tool_end', id: 't1', ok: true, preview: '' });
  e({ type: 'tool_start', id: 't2', name: 'memory_append', args: {}, label: 'Remembering in USER.md' });
  e({ type: 'tool_end', id: 't2', ok: true, preview: '' });
  e({ type: 'assistant_end', id: 'a1', text: "Your **Downloads** folder is the culprit at 38 GB, mostly old installers.\n\n| Folder | Size |\n|---|---|\n| Downloads | 38.2 GB |\n| AppData\\Local\\Temp | 11.6 GB |\n| Videos | 9.4 GB |\n\nI'd clear Temp first, it's safe and frees 11 GB.", interim: true });
  e({ type: 'approval', id: 'p1', title: 'Run this command?', detail: 'Remove-Item "$env:TEMP\\*" -Recurse -Force' });
  e({ type: 'tool_start', id: 't3', name: 'ask_user', args: {}, label: 'Asking you' });
});
