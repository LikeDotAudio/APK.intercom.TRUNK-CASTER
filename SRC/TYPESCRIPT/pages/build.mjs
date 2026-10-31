// Bundle every page entry into dist/ (one IIFE per page). Run from TYPESCRIPT/:
//   node pages/build.mjs
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entries = readdirSync(join(here, 'src/entries')).filter((f) => f.endsWith('.ts')).map((f) => join(here, 'src/entries', f));
await build({ entryPoints: entries, bundle: true, format: 'iife', target: 'es2020', charset: 'utf8', outdir: join(here, 'dist'), logLevel: 'info' });
