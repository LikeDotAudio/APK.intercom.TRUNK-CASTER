import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertInlineSafe, buildAll, discoverEntries, ENTRIES } from "../build.ts";

const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("every html.rs JS const has exactly one bundle", () => {
  const consts = ENTRIES.map((e) => e.replaces).sort();
  assert.deepEqual(consts, ["DISCOVERY_JS", "EDITOR_JS", "GLOBE_JS", "JS", "RELAY_JS"]);
  assert.equal(new Set(discoverEntries(tsRoot).map((e) => e.out)).size, discoverEntries(tsRoot).length);
});

test("assertInlineSafe refuses </script in any case", () => {
  assert.throws(() => assertInlineSafe("x.js", 'a="</SCRIPT>"'));
  assert.doesNotThrow(() => assertInlineSafe("x.js", 'a="<\\/script>"'));
});

test("buildAll bundles IIFEs that are inline-safe, with a manifest", async () => {
  const out = mkdtempSync(join(tmpdir(), "tc-web-"));
  try {
    const built = await buildAll(tsRoot, out, true);
    const manifest: unknown = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    assert.ok(typeof manifest === "object" && manifest !== null && "bundles" in manifest);
    for (const b of built.filter((x) => x.status === "built")) {
      const code = readFileSync(join(out, b.out), "utf8");
      assert.match(code, /^\(\(\) => \{|^"use strict";\s*\(\(\) => \{|^\(\(\)=>\{|^"use strict";\(\(\)=>\{/);
      assert.equal(b.sha256.length, 64);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
