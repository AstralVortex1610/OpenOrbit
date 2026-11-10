// A WebSocket server that accepts and then never answers (simulates a live model that never sets up).
const { WebSocketServer } = require('ws');
module.exports = () => { const s = new WebSocketServer({ port: 47391 }); s.on('connection', () => {}); return 47391; };
