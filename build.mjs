/**
 * Bundle OpenMAIC's own scene components into `vendor/maic-renderer.js`.
 *
 * The components sit on the same import graph as server-only code (provider
 * config, Postgres stores, undici). None of it executes in the player, so every
 * Node builtin — subpaths included — resolves to a stub instead of failing the
 * build.
 */
import { build } from '/Users/rudylefranc/Desktop/Projects/OpenMAIC/node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const APP = process.env.OPENMAIC_DIR || '/Users/rudylefranc/Desktop/Projects/OpenMAIC';

const BUILTIN =
  /^(node:)?(fs|path|crypto|stream|assert|http|https|url|util|events|buffer|zlib|net|tls|os|querystring|worker_threads|perf_hooks|async_hooks|child_process|diagnostics_channel|string_decoder|tty|dns|console|vm|module|process|timers|constants|punycode|readline|repl|v8|cluster|dgram|domain|http2|inspector|sqlite|test|trace_events|wasi|_http_common)(\/.*)?$/;

const stubNode = {
  name: 'stub-node-builtins',
  setup(b) {
    b.onResolve({ filter: BUILTIN }, () => ({ path: resolve(here, 'src/node-stub.js') }));
  },
};

const out = await build({
  entryPoints: [resolve(here, 'src/renderer-entry.jsx')],
  bundle: true,
  format: 'iife',
  minify: true,
  outfile: resolve(here, 'vendor/maic-renderer.js'),
  loader: { '.jsx': 'jsx', '.css': 'empty' },
  alias: {
    '@': APP,
    // pnpm gives nested packages their own react link, so esbuild would bundle
    // a second React copy — two copies mean two context registries, and every
    // `useX must be used within XProvider` throws. Pin one.
    react: resolve(APP, 'node_modules/react'),
    'react-dom': resolve(APP, 'node_modules/react-dom'),
    'react/jsx-runtime': resolve(APP, 'node_modules/react/jsx-runtime'),
  },
  // Resolve React and the @openmaic/* packages out of the app's install, so the
  // player folder needs no node_modules of its own.
  nodePaths: [resolve(APP, 'node_modules')],
  absWorkingDir: APP,
  plugins: [stubNode],
  define: { 'process.env.NODE_ENV': '"production"' },
  // App modules read `process.env.*` at runtime (feature flags, public config).
  // There is no bundler-injected `process` in a plain <script>, so provide one.
  banner: {
    js: "var process=globalThis.process||(globalThis.process={env:{NODE_ENV:'production'}});"
      + "process.env=process.env||{};",
  },
  logLevel: 'error',
  metafile: true,
});
const bytes = Object.values(out.metafile.outputs)[0].bytes;
console.log(`vendor/maic-renderer.js — ${(bytes / 1e6).toFixed(1)} MB`);
