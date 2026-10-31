// Inputs shared by the Rust golden generator (gen-golden.ts) and the tests.
// Change a case here, re-run the generator, commit golden.json.

import type { Series } from "../src/charts.ts";
import type { UsersPageData } from "../src/users-page.ts";

export interface LineCase { title: string; xs: number[]; series: Series[]; yMax: number | null }
export interface BarCase { title: string; cats: string[]; series: Series[] }
export interface HeatCase { title: string; labels: string[]; matrix: number[][] }

export const NASTY = `<script>alert("x")</script> & 'q'`;

export const durCases: number[] = [0, 1, 59, 60, 95, 3599, 3600, 3700, 86_399, 86_400, 90_061, 1_000_000_000];
export const durFCases: number[] = [-5, 0.9, 59.99, 95.5, NaN, 1e30];
export const hmCases: number[] = [0, 1.5, 6.5, 12.008333333, 23.9999, 23.99, 24, 25.25, -1, -0.5, 0.0001388889, 48.75];
export const niceCases: number[] = [0, -5, 0.07, 0.3, 1, 1.5, 2, 3, 5, 7, 10, 11, 99, 100, 101, 1234, 0.0042];
export const fmtCases: number[] = [
  0, -0, 1, 1.5, 0.25, 0.35, 0.05, 0.15, 2.25, 2.5, 99.95, 99.94, 100, 100.5, 101.5, 250.5, 0.5, 1.45,
  -1.5, -0.05, -0.04, 1e-7, 12345.678, 1e21, 1.5e22, NaN, Infinity, -Infinity,
];

export const mdCases: string[] = [
  "",
  "# Title\n\nPlain paragraph.\n",
  "## Section **bold** and `code`\n### Sub\n- one\n- two **unclosed\n\nafter list",
  "- a\r\n- b\r\n# skipped\r\ntext with trailing spaces   \r\n",
  `${NASTY}\n- ${NASTY}\n## \`<b>\` **&**`,
  "line\u0085\n\u{A0}\nno-bom\u{FEFF}\n**a**b**c**`d`e`",
  "-not a bullet\n##not heading\n- \n-  double space",
  "ünïcødé ✓ 😀 **ß**",
];

const XS = [0, 60, 120, 180, 240, 300, 360];
export const lineCases: LineCase[] = [
  { title: "empty", xs: [], series: [], yMax: null },
  { title: "one sample", xs: [5], series: [["live", "var(--used)", [3]]], yMax: null },
  {
    title: "Live lines, parked lines and trunks over the capture",
    xs: XS,
    series: [
      ["live", "var(--used)", [0, 3, 7, 12, 9, 4, 2]],
      ["parked", "var(--muted)", [0, 1, 1, 2, 3, 1, 0]],
      ["trunks", "var(--ok)", [1, 2, 3, 5, 5, 4, 3]],
    ],
    yMax: null,
  },
  {
    title: "Utilisation and news-cycle load over the capture",
    xs: [0.5, 10.25, 20.125, 33.3],
    series: [
      ["channel utilisation %", "var(--used)", [12.5, 40.04, 99.99, 150]],
      ["load ×10", "var(--bad)", [10, 12.25, 30.05, 8]],
    ],
    yMax: 100,
  },
  { title: NASTY, xs: [0, 1], series: [[NASTY, "#123456", [0.15, 2.45]]], yMax: null },
  { title: "short series and NaN", xs: [0, 10, 20, 30], series: [["a", "red", [1, NaN]], ["bb", "blue", [5, 6, 7, 8, 9]]], yMax: null },
  { title: "flat x", xs: [7, 7, 7], series: [["z", "green", [0, 0, 0]]], yMax: null },
  { title: "fixed 2.5", xs: [0, 1, 2], series: [["y", "var(--via)", [0.4, 2.5, 3.75]]], yMax: 2.5 },
];

export const barCases: BarCase[] = [
  { title: "no cats", cats: [], series: [["x", "red", []]] },
  { title: "no series", cats: ["a"], series: [] },
  { title: "Recent requests by outcome", cats: ["granted (live)", "denied", "released"], series: [["requests", "var(--used)", [7, 2, 11]]] },
  {
    title: "Calls by the caller's protocol",
    cats: ["Clear-Com Eclipse", "RTS ADAM", "Riedel Artist", "Telex"],
    series: [["live calls (from)", "var(--used)", [12, 3, 0, 1]], ["parked", "var(--muted)", [2, 0, 0]]],
  },
  { title: NASTY, cats: [NASTY, "ok"], series: [[NASTY, "var(--ok)", [0.25, -3]]] },
  { title: "Trunks by channels in use", cats: ["0 ch", "1 ch", "2 ch", "3 ch", "4 ch", "5 ch", "6 ch", "7 ch", "8 ch"], series: [["trunks", "var(--used)", [40, 13, 7, 3, 1, 0, 0, 0, 2]]] },
  { title: "fractions", cats: ["x", "y"], series: [["a", "red", [0.05, 0.35]], ["b ×", "blue", [1.25, 0.95]], ["c", "green", [NaN, 4.5]]] },
];

export const heatCases: HeatCase[] = [
  { title: "none", labels: [], matrix: [] },
  {
    title: "Calls between continents",
    labels: ["Africa", "Europe", "North America", "Oceania"],
    matrix: [
      [2, 5, 0, 1],
      [5, 14, 9, 0],
      [0, 9, 30, 2.5],
      [1, 0, 2.5, 0],
    ],
  },
  { title: NASTY, labels: [NASTY, "Middle East"], matrix: [[0, 0.5], [0.5, 0]] },
];

export const usersCases: UsersPageData[] = [
  { now: 1_792_600_000, records: [], state: { connections: [] } },
  {
    now: 1_792_600_000,
    state: {
      connections: [
        { id: "c-1", who: "alice", granted_unix: 1_792_599_000 },
        { id: "c-9", who: "zed", granted_unix: 1_792_590_000 },
        { id: "c-4", who: "bob", granted_unix: 1_792_600_100 },
      ],
      last_activity: { "EC-01": { unix: 1_792_599_905 }, "RTS-02": { unix: 1_792_599_000 } },
    },
    records: [
      { id: "c-1", who: "alice", whom: "RTS-02:U03", from: "EC-01:U01", when: "2026-10-21T10:00:00Z", why: "rehearsal", where: "Studio A", how: { kind: "direct", via: [] }, status: "granted", origin: "operator", gpio_sent: 1 },
      { id: "c-2", who: "bob", whom: "EC-03:U01", from: "RTS-02:U05", when: "2026-10-21T09:59:00Z", how: { kind: "via", via: ["EC-01", "RTS-04"] }, status: "released", origin: "simulator", connected_seconds: 3700 },
      { id: "c-3", who: "bob", whom: "EC-09:U02", from: "RTS-02:U06", when: "2026-10-21T09:58:00Z", status: "denied", reason: "no caster free", origin: "simulator" },
      { id: "c-4", who: "bob", whom: "EC-09:U02", from: "RTS-02:U06", when: "2026-10-21T09:57:00Z", how: { kind: "direct", via: [] }, status: "granted", origin: "simulator" },
      { id: "c-5", who: "carol", whom: "X", from: "Y", when: "2026-10-21T09:57:00Z", status: "denied", origin: "api" },
      { id: "c-6", who: "carol", whom: "X", from: "Y", when: "2026-10-21T08:00:00Z", status: "released", origin: "api" },
    ],
  },
  {
    now: 1_792_600_000,
    state: { connections: [{ id: "n-1", who: NASTY, granted_unix: 1_792_500_000 }] },
    records: [
      { id: "n-1", who: NASTY, whom: NASTY, from: NASTY, when: NASTY, why: NASTY, where: NASTY, how: { kind: "via", via: [NASTY] }, status: "granted", reason: null, origin: NASTY, gpio_sent: 3 },
      { id: "n-2", who: "\u{1F600}", whom: "w", from: "f", when: "2026-10-21T00:00:00Z", status: "denied", reason: NASTY, origin: "o" },
      { id: "n-3", who: "\u{FF5E}", whom: "w", from: "f", when: "2026-10-21T00:00:00Z", status: "denied", origin: "o" },
      { id: "n-4", who: "\u{FF5E}", whom: "w", from: "f", when: "2026-10-21T00:00:00Z", status: "denied", origin: "o" },
    ],
  },
];
