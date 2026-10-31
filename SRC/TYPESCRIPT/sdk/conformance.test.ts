/**
 * Conformance against what the Rust runtime actually wrote to disk.
 * Read-only. Skips any file that is not there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Layout } from "./folders.ts";
import * as wb from "./wardbeck.ts";
import { wavDecode, RATE } from "./voice.ts";
import {
  ASSEMBLED_KEYS,
  CAPTURE_KEYS,
  CONNECTION_KEYS,
  CROSSPOINT_EVENT_KEYS,
  CROSSPOINT_SETTINGS_KEYS,
  CROSSPOINT_SNAPSHOT_KEYS,
  DAY_SCHEDULE_KEYS,
  FADER_KEYS,
  FADER_DEFAULTED,
  FRAME_DEFAULTED,
  CONNECTION_DEFAULTED,
  SITE_DEFAULTED,
  SAMPLE_DEFAULTED,
  CAPTURE_DEFAULTED,
  FRAME_KEYS,
  GAIN_EVENT_KEYS,
  GAIN_SET_KEYS,
  GLOBE_CONFIG_KEYS,
  GPIO_EVENT_KEYS,
  LABEL_KEYS,
  OLYMPICS_KEYS,
  PREFERENCE_KEYS,
  PRODUCTION_KEYS,
  RELAY_CONFIG_KEYS,
  RELAY_SNAPSHOT_KEYS,
  RENAME_DISPATCH_KEYS,
  RENAME_TRANSPORT_KEYS,
  RUN_SUMMARY_KEYS,
  SAMPLE_KEYS,
  SIM_RUN_KEYS,
  SITE_KEYS,
  TIMELINE_KEYS,
  USER_RECORD_KEYS,
  checkKeys,
  type Presence,
} from "./schema.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const L = new Layout(ROOT, path.join);

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf8")) as unknown;
}
function firstLines(p: string, n: number): string[] {
  return readFileSync(p, "utf8").split("\n").filter((x) => x.trim() !== "").slice(0, n);
}
function lastLines(p: string, n: number): string[] {
  return readFileSync(p, "utf8").split("\n").filter((x) => x.trim() !== "").slice(-n);
}
/** Older files that rely on serde defaults, reported (not failed): what TS readers must default. */
const defaultedSeen = new Map<string, number>();
function expectKeys(what: string, obj: unknown, spec: Readonly<Record<string, Presence>>, serdeDefaulted: readonly string[] = []): void {
  const r = checkKeys(obj, spec, serdeDefaulted);
  assert.deepEqual({ missing: r.missing, unknown: r.unknown }, { missing: [], unknown: [] }, what);
  for (const k of r.defaulted) {
    const key = `${what.replace(/\d+/g, "N")}.${k}`;
    defaultedSeen.set(key, (defaultedSeen.get(key) ?? 0) + 1);
  }
}
function obj(o: unknown, k: string): unknown {
  return (o as Record<string, unknown>)[k];
}

const has = (p: string): boolean => existsSync(p);

test("fader.json is a Fader", { skip: !has(L.fader()) }, () => {
  const f = readJson(L.fader());
  expectKeys("fader", f, FADER_KEYS, FADER_DEFAULTED);
  expectKeys("fader.day", obj(f, "day"), DAY_SCHEDULE_KEYS);
  expectKeys("fader.day.olympics", obj(obj(f, "day"), "olympics"), OLYMPICS_KEYS);
  for (const p of obj(f, "productions") as unknown[]) expectKeys("production", p, PRODUCTION_KEYS);
});

test("advertisements are Frames", { skip: !has(L.advertisement()) }, () => {
  const files = readdirSync(L.advertisement()).filter((f) => f.endsWith(".json")).slice(0, 40);
  assert.ok(files.length > 0);
  for (const f of files) {
    const fr = readJson(path.join(L.advertisement(), f));
    expectKeys(f, fr, FRAME_KEYS, FRAME_DEFAULTED);
    const labels = obj(fr, "port_labels") as Record<string, unknown> | undefined;
    for (const v of Object.values(labels ?? {})) expectKeys(`${f} label`, v, LABEL_KEYS);
  }
});

test("crosspoints.json / settings.json / deltas.jsonl", { skip: !has(L.crosspointsJson()) }, () => {
  expectKeys("crosspoints.json", readJson(L.crosspointsJson()), CROSSPOINT_SNAPSHOT_KEYS);
  if (has(L.crosspointSettings())) expectKeys("settings.json", readJson(L.crosspointSettings()), CROSSPOINT_SETTINGS_KEYS);
  if (has(L.crosspointDeltas())) for (const l of firstLines(L.crosspointDeltas(), 50)) expectKeys("delta", JSON.parse(l), CROSSPOINT_EVENT_KEYS);
});

test("gpio.jsonl / renames.jsonl", () => {
  if (has(L.gpioLog())) for (const l of lastLines(L.gpioLog(), 50)) expectKeys("gpio", JSON.parse(l), GPIO_EVENT_KEYS);
  if (has(L.renamesLog())) for (const l of lastLines(L.renamesLog(), 50)) expectKeys("rename", JSON.parse(l), RENAME_DISPATCH_KEYS);
});

test("checkin.wb and wardbeck.log lines all parse and round-trip", { skip: !has(L.checkinFile()) }, () => {
  let n = 0;
  const files = [L.checkinFile(), ...(has(L.wardbeckLog()) ? [L.wardbeckLog()] : [])];
  for (const file of files) {
    for (const text of lastLines(file, 2000)) {
      const r = wb.parse(text);
      assert.ok(r.ok, `${path.basename(file)}: ${text}`);
      assert.equal(wb.format(r.line), text.trim(), "format(parse(x)) === x");
      n++;
    }
  }
  assert.ok(n > 0);
});

test("TRUNK-USERS records", { skip: !has(L.users()) }, () => {
  const files = readdirSync(L.users()).filter((f) => f.endsWith(".json")).slice(-40);
  for (const f of files) {
    const u = readJson(path.join(L.users(), f));
    expectKeys(f, u, USER_RECORD_KEYS);
  }
});

test("usage state.json connections", { skip: !has(L.usageState()) }, () => {
  const st = readJson(L.usageState());
  const conns = obj(st, "connections");
  const list = Array.isArray(conns) ? conns : Object.values((conns ?? {}) as Record<string, unknown>);
  for (const c of list.slice(0, 50)) expectKeys("connection", c, CONNECTION_KEYS, CONNECTION_DEFAULTED);
});

test("relay.json / relay state.json", { skip: !has(L.relayConfig()) }, () => {
  expectKeys("relay.json", readJson(L.relayConfig()), RELAY_CONFIG_KEYS);
  if (has(L.relayState())) expectKeys("relay state", readJson(L.relayState()), RELAY_SNAPSHOT_KEYS);
});

test("globe.json / sites.json / preferences.jsonl / vendor-policy.json", () => {
  if (has(L.globeConfig())) expectKeys("globe.json", readJson(L.globeConfig()), GLOBE_CONFIG_KEYS);
  if (has(L.sites())) for (const s of (obj(readJson(L.sites()), "sites") as unknown[]).slice(0, 50)) expectKeys("site", s, SITE_KEYS, SITE_DEFAULTED);
  if (has(L.preferences())) for (const l of lastLines(L.preferences(), 50)) expectKeys("preference", JSON.parse(l), PREFERENCE_KEYS);
  if (has(L.vendorPolicy())) {
    const r = obj(readJson(L.vendorPolicy()), "renames") as Record<string, unknown>;
    for (const v of Object.values(r)) expectKeys("rename transport", v, RENAME_TRANSPORT_KEYS);
  }
});

test("timeline, runs and captures", () => {
  if (has(L.timeline())) {
    const t = readJson(L.timeline());
    expectKeys("timeline", t, TIMELINE_KEYS);
    for (const s of (obj(t, "samples") as unknown[]).slice(-20)) expectKeys("sample", s, SAMPLE_KEYS, SAMPLE_DEFAULTED);
  }
  if (has(L.runsDir())) {
    for (const f of readdirSync(L.runsDir()).filter((x) => x.endsWith(".json")).slice(-5)) {
      const r = readJson(path.join(L.runsDir(), f));
      expectKeys(f, r, SIM_RUN_KEYS);
      expectKeys(`${f} fader`, obj(r, "fader"), FADER_KEYS, FADER_DEFAULTED);
      expectKeys(`${f} summary`, obj(r, "summary"), RUN_SUMMARY_KEYS);
    }
  }
  if (has(L.capturesDir())) {
    for (const f of readdirSync(L.capturesDir()).filter((x) => x.endsWith(".json"))) {
      const c = readJson(path.join(L.capturesDir(), f));
      expectKeys(f, c, CAPTURE_KEYS, CAPTURE_DEFAULTED);
      expectKeys(`${f} fader`, obj(c, "fader"), FADER_KEYS, FADER_DEFAULTED);
    }
  }
});

test("gains.jsonl / voices.jsonl / voice WAVs", () => {
  const gains = path.join(L.usage(), "gains.jsonl");
  if (has(gains)) {
    for (const l of lastLines(gains, 50)) {
      const g = JSON.parse(l) as unknown;
      expectKeys("gain", g, GAIN_EVENT_KEYS);
      expectKeys("gain.set", obj(g, "set"), GAIN_SET_KEYS);
    }
  }
  const voices = path.join(L.usage(), "voices");
  if (has(path.join(voices, "voices.jsonl"))) for (const l of lastLines(path.join(voices, "voices.jsonl"), 50)) expectKeys("voice", JSON.parse(l), ASSEMBLED_KEYS);
  if (has(voices)) {
    for (const f of readdirSync(voices).filter((x) => x.endsWith(".wav")).slice(0, 10)) {
      const w = wavDecode(new Uint8Array(readFileSync(path.join(voices, f))));
      assert.ok(w !== undefined, f);
      assert.equal(w.rate, RATE, f);
    }
  }
});

test("report serde-defaulted fields seen on disk", () => {
  console.log("serde-defaulted fields absent in files on disk:", JSON.stringify(Object.fromEntries(defaultedSeen)));
});
