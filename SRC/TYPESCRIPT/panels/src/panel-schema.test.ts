import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintPanel, validatePanel, type Panel } from "./panel-schema.ts";
import { expandEndpoint, validateConnect } from "./connect.ts";

const PANELS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "PANELS");
const load = (f: string): unknown => JSON.parse(readFileSync(join(PANELS, f), "utf-8"));
const DECKS = ["streamdeck-mini.json", "streamdeck-mk2.json", "streamdeck-plus.json", "streamdeck-xl.json"];

for (const f of DECKS) {
  test(`${f} validates against panel.schema.json`, () => {
    const r = validatePanel(load(f));
    assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.errors));
    if (r.ok) console.log(`  ${f}: ${r.value.buttons.length} buttons, lint: ${JSON.stringify(lintPanel(r.value))}`);
  });
}

test("the four decks are lint-clean (grid, targets, pages, encoders)", () => {
  for (const f of DECKS) {
    const r = validatePanel(load(f));
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(lintPanel(r.value), [], f);
  }
});

test("connect.json validates and every endpoint expands", () => {
  const r = validateConnect(load("connect.json"));
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.errors));
  if (!r.ok) return;
  const c = r.value;
  const vars = { base_url: c.api.base_url, matrix: "LOND", port: 7, target: "PNL01", remote_icom: "PARI", remote_port: 5 };
  for (const t of [...Object.values(c.discover), ...Object.values(c.lifecycle), ...Object.values(c.buttons), c.feedback.poll]) {
    const { method, url } = expandEndpoint(t, vars);
    assert.equal(method, "GET");
    assert.ok(URL.canParse(url), url);
  }
  assert.equal(expandEndpoint(c.buttons.talk_press, vars).url, "http://127.0.0.1:8180/api/key?matrix=LOND&port=7&kind=talk&target=PNL01&state=1");
});

test("validator rejects what the schema rejects", () => {
  const good = load("streamdeck-mini.json") as Panel;
  const bad = (mut: (p: Record<string, unknown>) => void): string[] => {
    const p = structuredClone(good) as unknown as Record<string, unknown>;
    mut(p);
    const r = validatePanel(p);
    return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
  };
  assert.match(bad((p) => delete p["matrix"]).join(), /missing required property 'matrix'/);
  assert.match(bad((p) => ((p["device"] as Record<string, unknown>)["rows"] = 17)).join(), /\/device\/rows: must be <= 16/);
  assert.match(bad((p) => ((p["device"] as Record<string, unknown>)["model"] = "streamdeck-pedal")).join(), /must be one of/);
  assert.match(bad((p) => (p["port"] = 1.5)).join(), /\/port: must be an integer/);
  assert.match(bad((p) => (p["api"] = "not a uri")).join(), /must be a URI/);
  assert.match(bad((p) => (p["buttons"] = [{ row: 0, col: 0, action: "shout" }])).join(), /\/buttons\/0\/action/);
  assert.match(bad((p) => (p["pages"] = { two: "x" })).join(), /\/pages\/two: must be an array/);
  assert.match(bad((p) => (p["encoders"] = [{ index: -1, action: "none" }])).join(), /\/encoders\/0\/index: must be >= 0/);
  assert.deepEqual(bad((p) => (p["extra"] = 1)), [], "additional properties are allowed by the schema");
});

test("lint catches the hazards the schema cannot", () => {
  const p: Panel = {
    name: "t", device: { model: "generic", rows: 1, cols: 2 }, matrix: "LOND", port: 0,
    buttons: [
      { row: 0, col: 0, action: "talk" },
      { row: 0, col: 0, action: "call", target: "PARIS" },
      { row: 3, col: 0, action: "page", target: "nope" },
    ],
    encoders: [{ index: 0, action: "mic_level" }],
  };
  const msgs = lintPanel(p).map((w) => w.message).join("\n");
  for (const re of [/needs a target/, /duplicate key 0,0/, /not ICOM:port/, /outside the 1x2 grid/, /page 'nope' does not exist/, /device.encoders is 0/])
    assert.match(msgs, re);
});
