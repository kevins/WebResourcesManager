// Builds the Web Resources Manager bookmarklet.
//   src/app/main.tsx --esbuild--> app bundle (the manager, with the Monaco editor, its stylesheet and its worker as text)
//   src/boot/bootstrap.ts + app as a string --esbuild--> bootstrap --deflate-raw--> base85 --> javascript: loader
// The bootstrap runs on the Dynamics page; it opens the manager's frame and runs the app inside it (src/boot).
// Outputs (dist/):
//   wrm.bookmarklet.txt        the javascript: URL to paste into a favorite
//   wrm.min.js                 the exact code the bookmarklet runs (can be pasted into the browser console)
//   wrm.debug.js               readable app bundle (--dev), handy for injecting while testing
//   Install Web Resources Manager.html   a page with the link to drag to the favorites bar
// Target browser: Microsoft Edge. Measured in Edge 155 (Dynamics Translator): javascript: favorites run up to 2,040,060
// characters and silently do nothing at 2,100,060 (Chromium caps URLs at 2 MiB when they cross processes). The build
// fails at 2,000,000 characters, leaving a margin below that cap.
// Flags: --dev (readable app, no terser), --zopfli (smaller link, slower build), --fast (skip terser).
import { build } from 'esbuild';
import { minify } from 'terser';
import { deflateRawSync, inflateRawSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPage } from './install-page.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// --out <folder>: build somewhere else than dist/ (parallel test runs); the install page is then not written.
const outArg = process.argv.indexOf('--out');
const dist = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const LIMIT = 2_000_000;
const args = new Set(process.argv.slice(2));
const DEV = args.has('--dev');
const t0 = Date.now();
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

const target = ['chrome110', 'edge110', 'firefox115', 'safari16'];

/** `import code from 'worker-code:editor'` gives the worker's bundled code as a string. */
const workerCode = {};
const workerCodePlugin = {
  name: 'worker-code',
  setup(b) {
    b.onResolve({ filter: /^worker-code:/ }, (a) => ({ path: a.path.slice('worker-code:'.length), namespace: 'worker-code' }));
    b.onLoad({ filter: /.*/, namespace: 'worker-code' }, (a) => {
      if (!(a.path in workerCode)) throw new Error(`No worker named ${a.path}`);
      return { contents: `export default ${JSON.stringify(workerCode[a.path])};`, loader: 'js' };
    });
  },
};

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target,
  charset: 'utf8',
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
  logOverride: { 'empty-import-meta': 'silent' },
  loader: { '.ttf': 'dataurl', '.svg': 'text' },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
    __DEV__: DEV ? 'true' : 'false',
    'process.env.NODE_ENV': DEV ? '"development"' : '"production"',
  },
};

// 1. The editor's worker (diffs, word-based suggestions, links), as text the app starts from a blob: address.
{
  const r = await build({ ...common, entryPoints: [join(root, 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js')], outfile: join(dist, 'editor.worker.js'), minify: true });
  workerCode.editor = r.outputFiles.find((f) => f.path.endsWith('.js')).text;
}

// 2. The app: every stylesheet it imports (Monaco's and the manager's) is collected into one, put in the frame's
// document when the app starts.
let app;
let appCss;
{
  const r = await build({
    ...common,
    entryPoints: [join(root, 'src/app/main.tsx')],
    outfile: join(dist, 'app.js'),
    minify: !DEV,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    plugins: [workerCodePlugin],
    define: { ...common.define, __BUILD__: '"dev"' },
  });
  app = r.outputFiles.find((f) => f.path.endsWith('.js')).text;
  appCss = r.outputFiles.find((f) => f.path.endsWith('.css'))?.text || '';
}
if (!DEV && !args.has('--fast')) {
  const ters = await minify(app, {
    ecma: 2020,
    module: false,
    compress: { passes: 2, pure_getters: false, keep_fargs: false, drop_debugger: true },
    mangle: true,
    format: { comments: false, ascii_only: false, wrap_func_args: false },
  });
  if (ters.code && ters.code.length < app.length) app = ters.code;
}
const css = appCss.replace(/\/\*[^*]*\*+([^/*][^*]*\*+)*\//g, '');
// The stylesheet goes in first, so the editor measures its fonts with it in place.
const inject = `(()=>{const s=document.createElement("style");s.id="wrm-css";s.textContent=${JSON.stringify(css)};(document.head||document.documentElement).appendChild(s)})();`;
const appFinal = inject + app;
// The app reads its build id from its host (window.__wrmHost.build), which the bootstrap is built with.
const build_ = createHash('sha256').update(appFinal).digest('hex').slice(0, 12);

// 3. The bootstrap, carrying the app as a string.
let boot;
{
  const r = await build({
    ...common,
    entryPoints: [join(root, 'src/boot/bootstrap.ts')],
    outfile: join(dist, 'boot.js'),
    minify: true,
    define: { ...common.define, __BUILD__: JSON.stringify(build_), __APP__: '__WRM_APP_TEXT__' },
  });
  boot = r.outputFiles.find((f) => f.path.endsWith('.js')).text;
}
const marks = boot.split('__WRM_APP_TEXT__').length - 1;
if (marks !== 1) throw new Error(`The bootstrap holds the app's place ${marks} times (expected once).`);
const code = boot.replace('__WRM_APP_TEXT__', () => JSON.stringify(appFinal));

// 4. The link: deflate-raw, base-85 text with an alphabet that is safe inside a javascript: URL and a single-quoted JS
// string (printable ASCII without " # % ' < > \ ` ^), unpacked by the browser's own DecompressionStream.
const UNSAFE = new Set(['"', '#', '%', "'", '<', '>', '\\', '`', '^']);
const ALPHA = [...Array(94)].map((_, i) => String.fromCharCode(33 + i)).filter((c) => !UNSAFE.has(c)).join('');
if (ALPHA.length !== 85) throw new Error('alphabet');
const raw = Buffer.from(code, 'utf8');
let packed = deflateRawSync(raw, { level: 9, memLevel: 9, windowBits: 15, strategy: constants.Z_DEFAULT_STRATEGY });
if (args.has('--zopfli')) {
  const { default: zopfli } = await import('@gfx/zopfli');
  const zop = await new Promise((res, rej) => zopfli.deflate(raw, { numiterations: 10 }, (e, r) => (e ? rej(e) : res(Buffer.from(r)))));
  if (zop.length < packed.length) packed = zop;
}
if (!inflateRawSync(packed).equals(raw)) throw new Error('Compression round-trip failed.');
const pad = (4 - (packed.length % 4)) % 4;
const padded = Buffer.concat([packed, Buffer.alloc(pad)]);
let enc = '';
for (let i = 0; i < padded.length; i += 4) {
  let v = padded.readUInt32BE(i);
  const g = [];
  for (let j = 0; j < 5; j++) {
    g.unshift(ALPHA[v % 85]);
    v = Math.floor(v / 85);
  }
  enc += g.join('');
}
{
  // Round-trip the decoder exactly as the loader runs it.
  const T = [];
  for (let i = 0; i < 85; i++) T[ALPHA.charCodeAt(i)] = i;
  const u = new Uint8Array((enc.length / 5) * 4);
  for (let i = 0, k = 0; i < enc.length; i += 5, k += 4) {
    let v = 0;
    for (let j = 0; j < 5; j++) v = v * 85 + T[enc.charCodeAt(i + j)];
    u[k] = v >>> 24;
    u[k + 1] = (v >>> 16) & 255;
    u[k + 2] = (v >>> 8) & 255;
    u[k + 3] = v & 255;
  }
  if (!Buffer.from(u.subarray(0, packed.length)).equals(packed)) throw new Error('Base-85 round-trip failed.');
}
// The loader decompresses with DecompressionStream, then runs the code with indirect eval; pages whose policy forbids
// eval get it as a blob: script instead.
const loader =
  "javascript:void(async()=>{try{const A='" + ALPHA + "',d='" + enc + "',T=[],u=new Uint8Array(d.length/5*4);" +
  'for(let i=0;i<85;i++)T[A.charCodeAt(i)]=i;for(let i=0,k=0;i<d.length;i+=5,k+=4){let v=0;for(let j=0;j<5;j++)v=v*85+T[d.charCodeAt(i+j)];' +
  'u[k]=v>>>24;u[k+1]=v>>>16&255;u[k+2]=v>>>8&255;u[k+3]=v&255}' +
  "const t=await new Response(new Blob([u.subarray(0," + packed.length + ")]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();" +
  "try{(0,eval)(t)}catch(e){if(!(e instanceof EvalError))throw e;const s=document.createElement('script');" +
  "s.src=URL.createObjectURL(new Blob([t],{type:'text/javascript'}));s.onerror=()=>alert('This page does not allow Web Resources Manager to run.');" +
  "document.head.appendChild(s)}}catch(e){alert('Web Resources Manager could not start: '+(e&&e.message||e))}})()";

mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'wrm.min.js'), code);
writeFileSync(join(dist, 'wrm.bookmarklet.txt'), loader);
if (DEV) writeFileSync(join(dist, 'wrm.debug.js'), code);
if (outArg < 0) writeFileSync(
  join(root, 'Install Web Resources Manager.html'),
  installPage({ bookmarklet: loader, version: pkg.version, built: new Date().toISOString().slice(0, 10), unpackedKb: (code.length / 1024).toFixed(0) }),
);

console.log(
  `web resources manager ${pkg.version} (${build_}): worker ${kb(workerCode.editor.length)} | css ${kb(css.length)} | app ${kb(app.length)} | total ${kb(code.length)} | deflated ${kb(packed.length)} | link ${loader.length.toLocaleString('en-US')} characters | ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);
if (loader.length >= LIMIT) {
  console.error(`FAIL: the bookmarklet is ${loader.length.toLocaleString('en-US')} characters; Edge needs it under ${LIMIT.toLocaleString('en-US')}.`);
  process.exit(1);
}
console.log(`OK: ${(LIMIT - loader.length).toLocaleString('en-US')} characters below the Edge limit.`);
