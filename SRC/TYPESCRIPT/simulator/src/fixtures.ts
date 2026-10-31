/** Python parity fixtures produced by running the original Python modules (see HANDOFF.md). */
import { readFileSync } from "node:fs";

export interface ParityFixture {
  dump_oids: string;
  check_mibs: string;
  tcs: Record<string, { base: string; enum: Record<string, number> }>;
  ber: { tag: number; v?: string; oid?: number[]; s?: string; hex: string }[];
  message_hex: string;
  panels_default: Record<string, { alpha: string; type: string; keys: Record<string, number>; freq: number }>;
  panels_small: Record<string, { alpha: string; type: string; keys: Record<string, number>; freq: number }>;
  hsl: [number, number, number, string][];
  world_config: unknown;
  spawn_config: unknown;
  tc: Record<"hello" | "hello_ack" | "key" | "bye" | "state", string>;
}

export interface WorldFixture {
  totals: Record<string, number>;
  ndevices: number;
  trunks: number;
  tm_objects: number;
  tm_trunk_1: Record<string, unknown>;
  tm_trunk_last: Record<string, unknown>;
  device_objects: Record<string, number>;
  map_states: Record<string, unknown>[];
  summary_tm_tail: string;
  matrix_lond_sorted_oids: string[];
  lond_panel_1: string;
  lond_plan: string;
  tm_trunks_head: string;
  tm_icoms_head: string;
}

const load = <T,>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf-8")) as T;
export const parity = (): ParityFixture => load<ParityFixture>("python-parity.json");
export const world = (): WorldFixture => load<WorldFixture>("python-world.json");
