// Sandbox (v0.13.0): commands run in Orbit's own Linux, files outside shared folders need the user's OK,
// shares mount with the right access, copies back to the PC are approved, cleanup reports space freed,
// and sandbox tools only appear when it's on. Uses a fake wsl.exe (test/fake-wsl) on PATH.
process.env.ORBIT_SANDBOX_TEST = '1';
const path = require('path'); const fs = require('fs'); const os = require('os');
const Module = require('module'); const orig = Module._load;
Module._load = function (r, ...a) { if (r === 'electron') return { shell: {}, nativeImage: null }; return orig.call(this, r, ...a); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-sb-'));
process.env.FAKE_LOG = path.join(tmp, 'wsl.log');
process.env.ORBIT_SANDBOX_ROOT = path.join(tmp, 'linux');
process.env.PATH = '/tmp/fakewsl:' + process.env.PATH;
const { Store } = require('../src/store'); const { Sandbox } = require('../src/sandbox'); const { buildTools, allSchemas } = require('../src/tools');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };
(async () => {
  const store = new Store(path.join(tmp, 'data'), null);
  const app = { getPath: () => path.join(tmp, 'data') };
  const sb = new Sandbox({ store, app, emit: () => {} });
  const asks = []; let answer = true;
  const agent = { store, sandbox: sb, hub: null, requestApproval: async (lane, title, detail) => { asks.push(title + ' | ' + detail); return answer; } };
  assert(!allSchemas(agent).some(t => /^sandbox_/.test(t.function.name)), 'sandbox tools hidden while it is off');
  store.saveSettings({ sandboxOn: true });
  const st = await sb.status();
  assert(st.state === 'ready', 'status ready: ' + st.text);
  assert(allSchemas(agent).some(t => t.function.name === 'sandbox_share'), 'sandbox tools shown when on and ready');
  const T = buildTools(agent, { id: 'main' });

  const r = await T.run_command({ command: 'echo hi-from-linux' });
  assert(/exit code 0 \(sandbox, in \/home\/orbit\/work\/tmp\/main\)/.test(r) && /hi-from-linux/.test(r), 'run_command runs in the sandbox scratch folder');
  asks.length = 0; answer = false;
  const w = await T.run_command({ command: 'echo win', where: 'windows' });
  assert(asks.length === 1 && /declined/.test(w), 'a Windows command needs the user\'s OK');

  const share = path.join(tmp, 'Projects'); fs.mkdirSync(share); fs.writeFileSync(path.join(share, 'a.txt'), 'shared file');
  const secret = path.join(tmp, 'Private'); fs.mkdirSync(secret); fs.writeFileSync(path.join(secret, 'b.txt'), 'private');
  asks.length = 0; answer = false;
  let err = ''; try { await T.read_file({ path: path.join(secret, 'b.txt') }); } catch (e) { err = e.message; }
  assert(asks.length === 1 && /didn't allow/.test(err), 'reading an unshared file asks first, and no means no');

  asks.length = 0; answer = true;
  const sr = await T.sandbox_share({ path: share, mode: 'read', why: 'to read your project' });
  assert(asks.length === 1 && /\/mnt\/win\/Projects/.test(sr), 'sharing asks, then gives the sandbox path: ' + sr);
  const mounts = fs.readFileSync(process.env.FAKE_LOG + '.stdin', 'utf8');
  assert(/mount -t drvfs .*Projects.* -o ro,uid=1000/.test(mounts), 'read-only share mounts ro');
  asks.length = 0;
  assert((await T.read_file({ path: path.join(share, 'a.txt') })) === 'shared file' && asks.length === 0, 'reading a shared file needs no prompt');
  asks.length = 0; answer = false;
  err = ''; try { await T.write_file({ path: path.join(share, 'a.txt'), content: 'x' }); } catch (e) { err = e.message; }
  assert(asks.length === 1 && fs.readFileSync(path.join(share, 'a.txt'), 'utf8') === 'shared file', 'writing in a read-only share asks first');
  await sb.share(share, 'full');
  assert(/-o rw,metadata/.test(fs.readFileSync(process.env.FAKE_LOG + '.stdin', 'utf8')), 'full access share mounts rw');
  asks.length = 0;
  await T.write_file({ path: path.join(share, 'a.txt'), content: 'changed' });
  assert(asks.length === 0 && fs.readFileSync(path.join(share, 'a.txt'), 'utf8') === 'changed', 'full access edits in place without prompts');

  // a file made in the sandbox, copied to the PC
  const lin = path.join(process.env.ORBIT_SANDBOX_ROOT, 'home/orbit/work'); fs.mkdirSync(lin, { recursive: true }); fs.writeFileSync(path.join(lin, 'report.pdf'), 'PDF');
  const pen = path.join(tmp, 'PenDrive'); fs.mkdirSync(pen);
  asks.length = 0; answer = true;
  const ap = await T.sandbox_apply({ from: '/home/orbit/work/report.pdf', to: path.join(pen, 'report.pdf') });
  assert(asks.length === 1 && /Copied/.test(ap) && fs.readFileSync(path.join(pen, 'report.pdf'), 'utf8') === 'PDF', 'copy to the PC is approved, then lands');
  assert((await T.write_file({ path: '/home/orbit/work/n.txt', content: 'linux' })) && fs.existsSync(path.join(lin, 'n.txt')), 'Linux paths are files in the sandbox');

  const c = await T.sandbox_cleanup({});
  assert(/12 MB freed/.test(c), 'cleanup reports space freed');
  assert(/find \/home\/orbit\/work\/tmp -mindepth 1 -maxdepth 1 -mtime \+1/.test(fs.readFileSync(process.env.FAKE_LOG + '.stdin', 'utf8')) && !/\/mnt\/win/.test(fs.readFileSync(process.env.FAKE_LOG + '.stdin', 'utf8').split('before=')[1]), 'cleanup never touches shared folders');
  await sb.endTask('w1');
  sb.stop();
  console.log('\nall sandbox checks passed'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
