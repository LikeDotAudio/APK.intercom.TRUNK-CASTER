// build: bundle every browser entry of the TypeScript migration into
// TYPESCRIPT/dist/web/, one classic-script IIFE per Rust `const *_JS`, so
// html.rs can swap each raw-string const for include_str!(...) one at a
// time (see patches/html.rs.patch, behind the `ts-bundles` cargo feature).
//
//   node --experimental-strip-types config/build.ts              (from TYPESCRIPT/)
//   ... --outdir <dir>   default TYPESCRIPT/dist/web
//   ... --minify         smaller bundles (default off: readable, diffable)
//   ... --dry            list entries and what each replaces; build nothing
//
// Each bundle is inlined by Rust into `<script>{X}</script>`, so:
//   - format iife: the original consts were classic scripts; globals the
//     other scripts need are published on window explicitly (web-core/src/globals.ts)
//   - the output must never contain `</script`; esbuild escapes it in
//     strings, and this script verifies it
//   - no source maps (inline maps would bloat every page)
// Also writes manifest.json: entry, bytes, sha256, the const it replaces.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type BuildOptions } from "esbuild";

export interface WebEntry {
  /** Output file name in dist/web. */
  readonly out: string;
  /** Candidate entry files relative to TYPESCRIPT/; the first that exists wins. */
  readonly from: readonly string[];
  /** The raw-string const in RUST-RUNTIME/src/html.rs this bundle replaces. */
  readonly replaces: string;
  readonly area: string;
}

/** The fixed entries: one per JS const in html.rs. */
export const ENTRIES: readonly WebEntry[] = [
  { out: "core.js", from: ["web-core/src/index.ts"], replaces: "JS", area: "web-core (01)" },
  { out: "globe.js", from: ["globe/src/main.ts", "globe/src/index.ts"], replaces: "GLOBE_JS", area: "globe (02)" },
  { out: "page-globe.js", from: ["pages/src/entries/globe.ts"], replaces: "DISCOVERY_JS", area: "pages (03)" },
  { out: "page-panel-editor.js", from: ["pages/src/entries/panel-editor.ts"], replaces: "EDITOR_JS", area: "pages (03)" },
  { out: "page-relay.js", from: ["pages/src/entries/relay.ts"], replaces: "RELAY_JS", area: "pages (03)" },
];

/** Every other page entry is bundled too (page-<name>.js) for inline page scripts that are not consts yet. */
export function discoverEntries(tsRoot: string): WebEntry[] {
  const fixed = new Set(ENTRIES.flatMap((e) => e.from));
  const dir = join(tsRoot, "pages", "src", "entries");
  const extra: WebEntry[] = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
        .map((f) => `pages/src/entries/${f}`)
        .filter((p) => !fixed.has(p))
        .map((p) => ({ out: `page-${basename(p, ".ts")}.js`, from: [p], replaces: "(inline page <script>)", area: "pages (03)" }))
    : [];
  return [...ENTRIES, ...extra];
}

export interface Built {
  readonly out: string;
  readonly entry: string | undefined;
  readonly replaces: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly status: "built" | "pending";
}

export const ESBUILD_BASE: BuildOptions = {
  bundle: true,
  format: "iife",
  platform: "browser",
  // Rust serves these to current desktop browsers only.
  target: ["es2020"],
  charset: "utf8",
  legalComments: "none",
  sourcemap: false,
  logLevel: "warning",
  write: false,
};

/** `</script` anywhere would end the inline <script> early. */
export function assertInlineSafe(name: string, code: string): void {
  if (/<\/script/i.test(code)) throw new Error(`${name}: contains "</script" and cannot be inlined into <script>`);
}

export async function buildAll(tsRoot: string, outdir: string, minify: boolean): Promise<Built[]> {
  mkdirSync(outdir, { recursive: true });
  const results: Built[] = [];
  for (const e of discoverEntries(tsRoot)) {
    const entry = e.from.find((f) => existsSync(join(tsRoot, f)));
    if (!entry) {
      results.push({ out: e.out, entry: undefined, replaces: e.replaces, bytes: 0, sha256: "", status: "pending" });
      continue;
    }
    const r = await build({ ...ESBUILD_BASE, entryPoints: [join(tsRoot, entry)], minify, outfile: join(outdir, e.out) });
    const file = r.outputFiles?.[0];
    if (!file) throw new Error(`${entry}: esbuild produced no output`);
    assertInlineSafe(e.out, file.text);
    writeFileSync(join(outdir, e.out), file.text, "utf8");
    results.push({
      out: e.out, entry, replaces: e.replaces, bytes: Buffer.byteLength(file.text),
      sha256: createHash("sha256").update(file.text).digest("hex"), status: "built",
    });
  }
  const manifest = { generated_by: "TYPESCRIPT/config/build.ts", bundles: results };
  writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return results;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const i = argv.indexOf("--outdir");
  const outdir = resolve(i >= 0 && argv[i + 1] ? (argv[i + 1] ?? "") : join(tsRoot, "dist", "web"));
  if (argv.includes("--dry")) {
    for (const e of discoverEntries(tsRoot)) {
      const entry = e.from.find((f) => existsSync(join(tsRoot, f)));
      process.stdout.write(`${e.out.padEnd(24)} <- ${(entry ?? `(pending: ${e.from.join(" | ")})`).padEnd(40)} replaces ${e.replaces}\n`);
    }
  } else {
    const t0 = performance.now();
    const built = await buildAll(tsRoot, outdir, argv.includes("--minify"));
    for (const b of built) {
      process.stdout.write(`${b.status.padEnd(8)} ${b.out.padEnd(24)} ${String(b.bytes).padStart(8)} B  ${b.entry ?? "-"}  -> ${b.replaces}\n`);
    }
    process.stdout.write(`${built.filter((b) => b.status === "built").length}/${built.length} bundles in ${relative(process.cwd(), outdir) || "."} (${Math.round(performance.now() - t0)} ms)\n`);
    // Pending entries are not an error: the area has not landed yet.
  }
}
