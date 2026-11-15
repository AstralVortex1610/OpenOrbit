const { contextBridge, ipcRenderer } = require('electron');
const inv = (c) => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('orbiter', {
  meta: inv('orbiter:meta'), sessions: inv('orbiter:sessions'), session: inv('orbiter:session'), create: inv('orbiter:create'),
  update: inv('orbiter:update'), remove: inv('orbiter:delete'), thread: inv('orbiter:thread'), send: inv('orbiter:send'), stop: inv('orbiter:stop'),
  checkpoints: inv('orbiter:checkpoints'), rewind: inv('orbiter:rewind'), compact: inv('orbiter:compact'), init: inv('orbiter:init'), memory: inv('orbiter:memory'),
  pickFolder: inv('orbiter:pickFolder'), openPath: inv('orbiter:openPath'), saveSettings: inv('orbiter:saveSettings'), saveTheme: inv('orbiter:saveTheme'), usage: inv('orbiter:usage'),
  win: inv('orbiter:win'), diffs: inv('orbiter:diffs'), clear: inv('orbiter:clear'),
  answerApproval: (id, ok) => ipcRenderer.invoke('approval:answer', id, ok),
  answerQuestion: (id, a) => ipcRenderer.invoke('question:answer', id, a),
  on: (cb) => { ipcRenderer.on('orbiter:event', (_e, d) => cb(d)); ipcRenderer.on('orbiter:open', (_e, id) => cb({ type: 'open_session', session: id })); },
});
