// A tiny MCP server over stdio for tests: tools echo (read-only) and create_note (writes).
const rl = require('readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
    { name: 'create_note', description: 'Create a note', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
  ] } });
  if (m.method === 'tools/call') return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `${m.params.name}:${JSON.stringify(m.params.arguments)}:${process.env.SECRET || ''}` }] } });
  if (m.id != null) out({ jsonrpc: '2.0', id: m.id, result: {} });
});
