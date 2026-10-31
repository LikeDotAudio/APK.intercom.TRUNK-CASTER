// Regenerates patches/*.patch. Usage (bash, from the repo root):
//   W=<scratch>; for f in RUST-RUNTIME/src/html.rs RUST-RUNTIME/Cargo.toml RUST-RUNTIME/build.rs RUST-RUNTIME/src/util.rs Dockerfile .dockerignore rebuild.py TYPESCRIPT/package.json; do
//     mkdir -p "$W/a/$(dirname $f)" "$W/b/$(dirname $f)"; sed "s/\r$//" "$f" > "$W/a/$f"; cp "$W/a/$f" "$W/b/$f"; done
//   node TYPESCRIPT/config/tools/mkpatch.cjs "$W"   # edits b/ by anchor (const names, not line numbers)
//   git diff --no-index a/<f> b/<f> per file, then strip the a/ b/ prefixes (see HANDOFF.md)
const fs = require("fs");
const B = process.argv[2] + "/b/", A = process.argv[2] + "/a/";
const rd = (f) => fs.readFileSync(B + f, "utf8").replace(/\r\n/g, "\n");
const wr = (f, s) => fs.writeFileSync(B + f, s);
const lf = (f) => fs.writeFileSync(A + f, fs.readFileSync(A + f, "utf8").replace(/\r\n/g, "\n"));
function sub(s, a, b, f) { if (!s.includes(a)) throw new Error(f + ": anchor not found: " + a.slice(0, 60)); return s.replace(a, b); }
const BT = "`";

// html.rs: feature-gated include_str! next to each raw-string const
{ const f = "RUST-RUNTIME/src/html.rs"; lf(f); let s = rd(f);
  const map = { JS: "core.js", GLOBE_JS: "globe.js", DISCOVERY_JS: "page-globe.js", EDITOR_JS: "page-panel-editor.js", RELAY_JS: "page-relay.js" };
  for (const [c, out] of Object.entries(map)) {
    s = sub(s, "\nconst " + c + ": &str = r#\"",
      "\n// Built by TYPESCRIPT/config/build.ts from the TypeScript sources (cargo feature " + BT + "ts-bundles" + BT + ").\n" +
      "#[cfg(feature = \"ts-bundles\")]\nconst " + c + ": &str = include_str!(\"../../TYPESCRIPT/dist/web/" + out + "\");\n" +
      "#[cfg(not(feature = \"ts-bundles\"))]\nconst " + c + ": &str = r#\"", f);
  }
  wr(f, s); }

// Cargo.toml
{ const f = "RUST-RUNTIME/Cargo.toml"; let s = rd(f);
  s = s + "\n[features]\n# Serve the page scripts bundled from TYPESCRIPT/ (dist/web/*.js, built by\n# " + BT + "npm run build" + BT + " in TYPESCRIPT/) instead of the inline raw strings in html.rs.\nts-bundles = []\n";
  wr(f, s); }

// build.rs
{ const f = "RUST-RUNTIME/build.rs"; let s = rd(f);
  s = sub(s, "    println!(\"cargo:rerun-if-changed=../TRUNK-CASTER-SDK/src\");\n}",
`    println!("cargo:rerun-if-changed=../TRUNK-CASTER-SDK/src");

    // With the ts-bundles feature the page scripts come from TYPESCRIPT/dist/web
    // (include_str! in html.rs). A new bundle must give a new TC_BUILD so open
    // pages flush their cache and reload. Node is NOT run from here: the Docker
    // image builds the bundles in its own stage and rebuild.py runs npm run build.
    // Watching named files (not the directory) keeps a missing dist/ from
    // re-running this script, and so re-stamping TC_BUILD, on every build.
    if std::env::var_os("CARGO_FEATURE_TS_BUNDLES").is_some() {
        let dist = std::path::Path::new("../TYPESCRIPT/dist/web");
        for f in ["core.js", "globe.js", "page-globe.js", "page-panel-editor.js", "page-relay.js"] {
            let p = dist.join(f);
            if !p.is_file() {
                panic!("feature ts-bundles: {} is missing; run npm run build in TYPESCRIPT/ first", p.display());
            }
            println!("cargo:rerun-if-changed={}", p.display());
        }
    }
}`, f);
  wr(f, s); }

// util.rs
{ const f = "RUST-RUNTIME/src/util.rs"; lf(f); let s = rd(f);
  s = sub(s, "    let mut f = fs::OpenOptions::new().create(true).append(true).open(path)?;\n    writeln!(f, \"{line}\")\n",
`    let mut f = fs::OpenOptions::new().create(true).append(true).open(path)?;
    // One write_all of line + newline: writeln! issues the text and the newline
    // as separate writes, and two runtimes appending to the same file glued
    // records together (3,989 such lines in labels/renames/gpio.jsonl, 2026-10-21).
    let mut buf = String::with_capacity(line.len() + 1);
    buf.push_str(line);
    buf.push('\\n');
    f.write_all(buf.as_bytes())
`, f);
  wr(f, s); }

// Dockerfile
{ const f = "Dockerfile"; let s = rd(f);
  s = sub(s, `# ---- build stage ----------------------------------------------------------
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY TRUNK-CASTER-SDK TRUNK-CASTER-SDK
COPY RUST-RUNTIME RUST-RUNTIME
COPY TRUNK-SIMULATOR/frame-sim TRUNK-SIMULATOR/frame-sim
RUN cd RUST-RUNTIME && cargo build --release && cargo test --release 2>&1 | tail -2`,
`# ---- web stage: the page scripts, from TypeScript ---------------------------
# Typechecks every TYPESCRIPT/ area and bundles the browser entries into
# TYPESCRIPT/dist/web (config/build.ts). Only dist/ leaves this stage; node is
# not in the final images.
FROM node:24-bookworm-slim AS web
WORKDIR /src/TYPESCRIPT
COPY TYPESCRIPT/package.json TYPESCRIPT/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY TYPESCRIPT/ ./
RUN npm run typecheck && npm run build

# ---- build stage ----------------------------------------------------------
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY TRUNK-CASTER-SDK TRUNK-CASTER-SDK
COPY RUST-RUNTIME RUST-RUNTIME
COPY TRUNK-SIMULATOR/frame-sim TRUNK-SIMULATOR/frame-sim
COPY --from=web /src/TYPESCRIPT/dist TYPESCRIPT/dist
RUN cd RUST-RUNTIME && cargo build --release --features ts-bundles && cargo test --release --features ts-bundles 2>&1 | tail -2`, f);
  wr(f, s); }

// .dockerignore
{ const f = ".dockerignore"; let s = rd(f);
  s = sub(s, "!TRUNK-SIMULATOR/frame-sim/\n", "!TRUNK-SIMULATOR/frame-sim/\n!TYPESCRIPT/\n", f);
  s = s + "# The web stage runs npm ci and builds dist/ itself.\n**/node_modules/\nTYPESCRIPT/dist/\n**/*.tsbuildinfo\nTYPESCRIPT/**/HANDOFF.*\n";
  wr(f, s); }

// rebuild.py
{ const f = "rebuild.py"; let s = rd(f);
  s = sub(s, "    python rebuild.py --no-check     skip the local cargo check\n",
             "    python rebuild.py --no-check     skip the local TypeScript build and cargo check\n", f);
  s = sub(s, "CRATES = [\"RUST-RUNTIME\", os.path.join(\"TRUNK-SIMULATOR\", \"frame-sim\")]\n",
             "CRATES = [\"RUST-RUNTIME\", os.path.join(\"TRUNK-SIMULATOR\", \"frame-sim\")]\nTS_DIR = os.path.join(ROOT, \"TYPESCRIPT\")\n", f);
  s = sub(s, "def cargo_check():\n",
`def ts_build():
    """Typecheck the TypeScript areas, validate the configs and bundle the page
    scripts into TYPESCRIPT/dist/web, so cargo check --features ts-bundles sees
    them. Docker builds its own copy; this is the seconds-fast local gate.
    Returns True when the bundles were built."""
    if not os.path.isfile(os.path.join(TS_DIR, "package.json")):
        return False
    npm = shutil.which("npm")
    if npm is None:
        log("npm not found on this machine; skipping the TypeScript build (Docker will build it)")
        return False
    if not os.path.isdir(os.path.join(TS_DIR, "node_modules")):
        log("npm ci  TYPESCRIPT")
        if subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=TS_DIR).returncode != 0:
            die("npm ci failed in TYPESCRIPT; the containers were left as they are")
    for script in ("typecheck", "validate-config", "build"):
        log("npm run %s" % script)
        if subprocess.run([npm, "run", "--silent", script], cwd=TS_DIR).returncode != 0:
            die("npm run %s failed; the containers were left as they are" % script)
    log("TypeScript builds")
    return True


def cargo_check(features=None):
`, f);
  s = sub(s, "        r = subprocess.run([\"cargo\", \"check\", \"--quiet\"], cwd=path)\n",
`        cmd = ["cargo", "check", "--quiet"]
        if features and crate == "RUST-RUNTIME":
            cmd += ["--features", features]
        r = subprocess.run(cmd, cwd=path)
`, f);
  s = sub(s, "    if not args.no_check:\n        cargo_check()\n",
`    if not args.no_check:
        web = ts_build()
        cargo_check("ts-bundles" if web else None)
`, f);
  wr(f, s); }

// package.json
{ const f = "TYPESCRIPT/package.json"; let s = rd(f);
  s = sub(s, "    \"typecheck\": \"tsc -b\",\n",
`    "typecheck": "tsc -b",
    "build": "node --experimental-strip-types --no-warnings config/build.ts",
    "build:min": "node --experimental-strip-types --no-warnings config/build.ts --minify",
    "validate-config": "node --experimental-strip-types --no-warnings config/validate-config.ts --no-logs",
    "validate-logs": "node --experimental-strip-types --no-warnings config/validate-config.ts",
`, f);
  wr(f, s); }
console.log("ok");
