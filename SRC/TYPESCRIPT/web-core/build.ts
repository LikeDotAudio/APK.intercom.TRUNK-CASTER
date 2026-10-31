// Bundle src/index.ts to dist/web-core.js: one IIFE that can be
// include_str!'d in place of html.rs's `JS` const. Run from TYPESCRIPT/:
//   node --experimental-strip-types web-core/build.ts
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const minify = process.argv.includes('--minify');
const out = join(here, 'dist', minify ? 'web-core.min.js' : 'web-core.js');

await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  outfile: out,
  bundle: true,
  format: 'iife',
  // The original uses ?. and optional catch binding; every page browser runs ES2020.
  target: 'es2020',
  platform: 'browser',
  charset: 'utf8',
  legalComments: 'none',
  minify,
  logLevel: 'info',
});

// The bundle is inlined inside <script>...</script> and inside a Rust format!
// string. Guard both: no "</script" and (for format!) braces are fine because
// the bundle is passed as a `{JS}` argument, not spliced into the template.
const js = readFileSync(out, 'utf8');
if (/<\/script/i.test(js)) throw new Error('bundle contains </script: would end the inline <script> early');
// Rust include_str! wants a stable file: trim the trailing newline noise only.
writeFileSync(out, js.replace(/\s+$/, '\n'));
console.log('ok', out, js.length, 'bytes');
