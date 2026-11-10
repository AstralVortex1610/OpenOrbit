// Bundles Orbit Voice's worker (transformers.js + kokoro-js + phonemizer) into one browser file.
const esbuild = require('esbuild');
const path = require('path');
const root = path.join(__dirname, '..');
const stub = path.join(__dirname, 'empty-stub.js');
require('fs').writeFileSync(stub, 'export default {}; export const resolve = (...a) => a.join("/");\n');
esbuild.build({
  entryPoints: [path.join(root, 'renderer/voice/worker-src.js')],
  outfile: path.join(root, 'renderer/voice/worker.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome130', minify: true, legalComments: 'none',
  alias: {
    '@huggingface/transformers': path.join(root, 'node_modules/@huggingface/transformers/dist/transformers.web.js'),
    'fs/promises': stub, path: stub, fs: stub,
    'kokoro-node': path.join(root, 'node_modules/kokoro-js/dist/kokoro.js'),
  },
  define: { __ORT_VERSION__: JSON.stringify(require(path.join(root, 'node_modules/onnxruntime-web/package.json')).version) },
  logLevel: 'warning',
}).then(() => { const st = require('fs').statSync(path.join(root, 'renderer/voice/worker.js')); console.log('voice worker bundled', (st.size / 1e6).toFixed(1), 'MB'); })
  .catch(() => process.exit(1));
