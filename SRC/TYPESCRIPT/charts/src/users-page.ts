// Proof port: the Users page body (html.rs 3308-3418 `users_page`), rendered
// client-side from the JSON the runtime already serves:
//   GET /api/users  -> UserRecord[]          (rt.recent_records)
//   GET /api/state  -> { connections, last_activity, ... }
// The page chrome (`page()` header/nav/footer/day strip) stays with web-core
// (agent 01); this module renders only what goes inside <main>.
//
// Wire types are declared locally; dedup with agent 04's TYPESCRIPT/sdk/.

import { barChart } from "./charts.ts";
import { html, htmlCompat, raw, type HtmlTag, type SafeHtml } from "./html.ts";
import { cmpRustStr } from "./rustfmt.ts";
import { dur } from "./text.ts";

export type RouteKind = "direct" | "via";
export type ReplyStatus = "granted" | "denied" | "released";

/** TRUNK-CASTER-SDK types.rs:777 `How` (hops omitted: unused here). */
export interface How {
  kind: RouteKind;
  via: string[];
}

/** TRUNK-CASTER-SDK types.rs:784 `UserRecord` (fields this page reads). */
export interface UserRecord {
  id: string;
  who: string;
  whom: string;
  from: string;
  when: string;
  why?: string | null;
  where?: string | null;
  how?: How | null;
  status: ReplyStatus;
  reason?: string | null;
  origin: string;
  connected_seconds?: number | null;
  gpio_sent?: number;
}

/** The slice of `Connection` this page reads. */
export interface ConnectionLite {
  id: string;
  who: string;
  granted_unix?: number;
}

/** The slice of routing `State` this page reads (GET /api/state). */
export interface StateLite {
  connections: ConnectionLite[];
  last_activity?: Record<string, { unix: number }>;
}

export interface UsersPageData {
  /** Wall clock, unix seconds (server `util::now_unix()`; client Date.now()/1000). */
  now: number;
  records: UserRecord[];
  state: StateLite;
}

export interface RenderOptions {
  /** true: escape exactly like Rust `esc` (no `'`) for byte-parity tests. */
  compat?: boolean;
}

const connectedFor = (c: ConnectionLite, now: number): number => Math.max(0, now - (c.granted_unix ?? 0));

function lastConnectionOverall(state: StateLite, now: number): string {
  const unixes = Object.values(state.last_activity ?? {}).map((a) => a.unix);
  if (unixes.length === 0) return "never";
  return `${dur(Math.max(0, now - Math.max(...unixes)))} ago`;
}

function tile(h: HtmlTag, label: string, value: string | number): SafeHtml {
  return h`<div class="tile"><b>${value}</b><span>${label}</span></div>`;
}

interface Person {
  asked: number;
  live: number;
  last: string;
  total: number;
}

/** The body of the Users page: tiles, graphs, people, requests. */
export function renderUsersBody(data: UsersPageData, opts: RenderOptions = {}): SafeHtml {
  const h = opts.compat ? htmlCompat : html;
  const { now, records: recs, state } = data;
  const granted = recs.filter((r) => r.status === "granted").length;
  const denied = recs.filter((r) => r.status === "denied").length;
  const released = recs.filter((r) => r.status === "released").length;

  const intro = h`<section><h2>Who asked whom</h2><div class="tiles">${[
    tile(h, "records shown", recs.length),
    tile(h, "live (granted)", granted),
    tile(h, "denied", denied),
    tile(h, "released", released),
    tile(h, "last connection", lastConnectionOverall(state, now)),
  ]}</div>
<p class="note">One JSON per request lives in <code>TRUNK-USERS</code>: who, whom, when, why, where and how (direct or via which frames), plus how long it lasted. Showing the most recent ${recs.length} records.</p></section>`;

  // Graphs. Chart output is already escaped SVG, so it goes in via raw().
  const outcomeChart = barChart("Recent requests by outcome", ["granted (live)", "denied", "released"], [["requests", "var(--used)", [granted, denied, released]]]);
  const byWho = new Map<string, number>();
  for (const r of recs) byWho.set(r.who, (byWho.get(r.who) ?? 0) + 1);
  const top = [...byWho].sort((a, b) => b[1] - a[1] || cmpRustStr(a[0], b[0])).slice(0, 12);
  const whoChart = barChart("Busiest callers (recent records)", top.map((t) => t[0]), [["requests", "var(--ok)", top.map((t) => t[1])]]);
  const graphs = h`<section><h2>Graphs</h2>${raw(outcomeChart)}${raw(whoChart)}</section>`;

  // People: BTreeMap order (byte order of `who`), then stable sort by last asked, newest first.
  const people = new Map<string, Person>();
  for (const r of recs) {
    let p = people.get(r.who);
    if (!p) {
      p = { asked: 0, live: 0, last: "", total: 0 };
      people.set(r.who, p);
    }
    p.asked += 1;
    if (r.status === "granted") p.live += 1;
    if (cmpRustStr(r.when, p.last) > 0) p.last = r.when;
    p.total += r.connected_seconds ?? 0;
  }
  for (const c of state.connections) {
    const p = people.get(c.who);
    if (p) p.total += connectedFor(c, now);
  }
  const rows = [...people].sort((a, b) => cmpRustStr(a[0], b[0])).sort((a, b) => cmpRustStr(b[1].last, a[1].last));
  const peopleRows = rows
    .slice(0, 100)
    .map(([who, p]) => h`<tr><td><b>${who}</b></td><td>${p.asked}</td><td>${p.live}</td><td>${dur(p.total)}</td><td class="muted">${p.last}</td></tr>`);
  const peopleSection = h`<section><h2>People</h2><div class="scroll"><table><tr><th>Who</th><th>Requests</th><th>Live now</th><th>Connected in total</th><th>Last asked</th></tr>${peopleRows}</table></div></section>`;

  const reqRows = recs.map((r) => {
    const how = r.how
      ? r.how.kind === "via"
        ? h`<span class="kind-via">via ${r.how.via.join(" → ")}</span>`
        : h`<span class="kind-direct">direct</span>`
      : h`<span class="bad">${r.reason ?? "denied"}</span>`;
    let lasted = "";
    if (r.status === "released" && r.connected_seconds != null) lasted = dur(r.connected_seconds);
    else if (r.status === "granted") {
      const c = state.connections.find((x) => x.id === r.id);
      if (c) lasted = `${dur(connectedFor(c, now))} so far`;
    }
    return h`<tr><td class="muted">${r.when}</td><td>${r.who}</td><td>${r.from}</td><td>${r.whom}</td><td>${r.why ?? ""}</td><td>${r.where ?? ""}</td><td>${how}</td><td>${lasted}</td><td>${r.gpio_sent ?? 0}</td><td class="status-${r.status}">${r.status}</td><td class="muted">${r.origin}</td></tr>`;
  });
  const empty = recs.length === 0 ? h`<tr><td colspan="11" class="muted">No requests yet.</td></tr>` : null;
  const requests = h`<section><h2>Requests</h2><div class="scroll" style="max-height:70vh"><table><tr><th>When</th><th>Who</th><th>From</th><th>Whom</th><th>Why</th><th>Where</th><th>How</th><th>Lasted</th><th>GPIO</th><th>Status</th><th>Origin</th></tr>${reqRows}${empty}</table></div></section>`;

  return h`${intro}${graphs}${peopleSection}${requests}`;
}

export interface MountOptions {
  /** Base URL of the runtime; "" when served by it. */
  base?: string;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  /** Clock in unix seconds; defaults to Date.now()/1000. */
  clock?: () => number;
}

function isStateLite(v: unknown): v is StateLite {
  return typeof v === "object" && v !== null && Array.isArray((v as { connections?: unknown }).connections);
}

/** Render the Users body into `root` and return a refresh() for the
 * telemetry loop (web-core's WebSocket push calls it; no full reload). */
export function mountUsersPage(root: Element, opts: MountOptions = {}): { refresh(): Promise<void> } {
  const base = opts.base ?? "";
  const get = opts.fetchImpl ?? ((url: string) => fetch(url));
  const clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
  async function getJson(path: string): Promise<unknown> {
    const res = await get(base + path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }
  async function refresh(): Promise<void> {
    const [records, state] = await Promise.all([getJson("/api/users"), getJson("/api/state")]);
    if (!Array.isArray(records) || !isStateLite(state)) throw new Error("users page: unexpected JSON shape");
    root.innerHTML = renderUsersBody({ now: clock(), records: records as UserRecord[], state }).value;
  }
  return { refresh };
}
