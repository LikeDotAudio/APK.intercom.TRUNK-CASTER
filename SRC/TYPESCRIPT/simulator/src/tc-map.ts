/**
 * tc-map.ts -- live map server for a Trunk-Caster estate (port of TRUNK-SIMULATOR/tc_map.py).
 *
 * A brand simulator (or launch-all.ts) hands this module a callback returning the
 * current estate state and, optionally, an action callback for the button API.
 * It serves:
 *     /            the map page (map-page.html, extracted verbatim from tc_map.HTML)
 *     /geojson     FeatureCollection: one Point per intercom, one LineString per trunk call
 *     /state       the raw state JSON the callback returned
 *     /api/...     the button / scenario API (API_HELP)
 *
 * Differences from Python (http.server):
 *   - node:http keeps connections alive (Python answers HTTP/1.0 and closes);
 *   - the action callback may be async (launch-all forwards with fetch);
 *   - a JSON body that is not an object is ignored (Python crashed the handler);
 *   - start() is async and rejects on EADDRINUSE (Python raised OSError synchronously).
 */
import { readFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { errStr, isoNow, localTzLabel, PyError, pyJson } from "./py.ts";

export { isoNow, localTzLabel };

export const API_HELP: Readonly<Record<string, string>> = {
  "/api/ports": "?matrix=LOND                                  list the ports of a matrix",
  "/api/port": "?matrix=LOND&port=1                           state of one port (talking_to, incoming, ...)",
  "/api/key": "?matrix=LOND&port=1&kind=talk|listen&target=25&state=1|0   press / release a key",
  "/api/call": "?matrix=LOND&port=3&icom=PARI&remote=5        trunk call to another intercom",
  "/api/hangup": "?matrix=LOND&port=3                           release that port's trunk call",
  "/api/claim": "?matrix=LOND&port=0&name=StreamDeck           reserve a port for a button panel (0 = next free panel)",
  "/api/release": "?matrix=LOND&port=7                           give it back",
  "/api/scenario": "?name=olympics&level=0.4&host=PARI            traffic scenario: quiet, normal, olympics, sports, evening, breaking",
  "/api/matrices": "                                              every matrix the API can reach",
};

// ----------------------------------------------------------------------------- state shapes (local; dedup with sdk)
export interface MapDevice {
  name: string;
  lat?: number | null;
  lon?: number | null;
  [k: string]: unknown;
}
export interface MapLink {
  from_device: string;
  from_port: string | number;
  to_device: string;
  to_port: string | number;
  since?: number;
  [k: string]: unknown;
}
export interface MapTotals {
  users: number;
  users_calling: number;
  ports: number;
  calls: number;
  devices: number;
}
export interface EstateState {
  time?: string;
  tz?: string;
  totals?: Partial<MapTotals>;
  scenario?: unknown;
  devices?: MapDevice[];
  links?: MapLink[];
  [k: string]: unknown;
}

export interface GeoFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] } | { type: "LineString"; coordinates: [number, number][] };
  properties: Record<string, unknown>;
}
export interface GeoCollection {
  type: "FeatureCollection";
  properties: { time: string | undefined; tz: string | undefined; totals: Partial<MapTotals>; scenario: unknown };
  features: GeoFeature[];
}

export function toGeojson(state: EstateState): GeoCollection {
  const features: GeoFeature[] = [];
  const pos = new Map<string, [number, number]>();
  for (const d of state.devices ?? []) {
    if (d.lat === null || d.lat === undefined || d.lon === null || d.lon === undefined) continue;
    pos.set(d.name, [d.lon, d.lat]);
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) if (k !== "lat" && k !== "lon") props[k] = v;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [d.lon, d.lat] }, properties: props });
  }
  for (const ln of state.links ?? []) {
    const a = pos.get(ln.from_device);
    const b = pos.get(ln.to_device);
    if (!a || !b) continue;
    features.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[...a], [...b]] }, properties: { ...ln, kind: "call" } });
  }
  return {
    type: "FeatureCollection",
    properties: { time: state.time, tz: state.tz, totals: state.totals ?? {}, scenario: state.scenario },
    features,
  };
}

/** The map page, byte-identical to tc_map.HTML. */
export const HTML: string = readFileSync(new URL("./map-page.html", import.meta.url), "utf-8");

export type Params = Record<string, string>;
export type StateCallback = () => EstateState;
/** Throw PyValueError / PyKeyError (any PyError) for a 400; anything else is a 500. */
export type ActionCallback = (name: string, params: Params) => unknown;
export type Logger = (msg: string) => void;

/** str(v) of a value json.loads produced. */
function pyStrOfJson(v: unknown): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return pyJson(v).replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False").replace(/\bnull\b/g, "None");
}

/** parse_qs(...) then {k: v[-1]}; blank values are dropped like parse_qs's default. */
function parseQs(qs: string): Params {
  const out: Params = {};
  for (const [k, v] of new URLSearchParams(qs)) if (v !== "") out[k] = v;
  return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export class MapServer {
  readonly stateCallback: StateCallback;
  readonly actionCallback: ActionCallback | null;
  readonly host: string;
  port: number;
  readonly log: Logger;
  private server: http.Server | null = null;

  constructor(stateCallback: StateCallback, host = "0.0.0.0", port = 8080, log: Logger | null = null, actionCallback: ActionCallback | null = null) {
    this.stateCallback = stateCallback;
    this.actionCallback = actionCallback;
    this.host = host;
    this.port = port;
    this.log = log ?? (() => undefined);
  }

  private send(res: http.ServerResponse, code: number, ctype: string, body: string | Buffer): void {
    const buf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
    res.writeHead(code, {
      "Content-Type": ctype,
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
  }

  private async params(req: http.IncomingMessage): Promise<[string, Params]> {
    const raw = req.url ?? "/";
    const q = raw.indexOf("?");
    const path = q < 0 ? raw : raw.slice(0, q);
    const params = parseQs(q < 0 ? "" : raw.slice(q + 1));
    const length = Number.parseInt(String(req.headers["content-length"] ?? "0"), 10) || 0;
    if (length) {
      const body = await readBody(req);
      if ((req.headers["content-type"] ?? "").includes("json")) {
        try {
          const obj: unknown = JSON.parse(body);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            for (const [k, v] of Object.entries(obj as Record<string, unknown>)) params[k] = pyStrOfJson(v);
          }
        } catch {
          // ValueError: ignored, like Python
        }
      } else {
        Object.assign(params, parseQs(body));
      }
    }
    return [path, params];
  }

  private async api(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const [path, params] = await this.params(req);
    const act = this.actionCallback;
    if (act === null) {
      this.send(res, 404, "application/json", '{"error":"no action handler"}');
      return;
    }
    const name = path.slice("/api/".length).replace(/^\/+|\/+$/g, "");
    if (!name || name === "help") {
      this.send(res, 200, "application/json", pyJson(API_HELP, { indent: 1 }));
      return;
    }
    try {
      const result: unknown = await act(name, params);
      this.send(res, 200, "application/json", pyJson({ ok: true, result }));
    } catch (exc) {
      if (exc instanceof PyError) {
        this.send(res, 400, "application/json", pyJson({ ok: false, error: exc.pyStr }));
      } else {
        this.log("api error: " + errStr(exc));
        this.send(res, 500, "application/json", pyJson({ ok: false, error: errStr(exc) }));
      }
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = req.url ?? "/";
    if (req.method === "POST") {
      if (raw.startsWith("/api/")) await this.api(req, res);
      else this.send(res, 404, "text/plain", "not found");
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      this.send(res, 501, "text/html;charset=utf-8", "Unsupported method (" + pyJson(req.method ?? "") + ")");
      return;
    }
    const path = raw.split("?", 1)[0] ?? "/";
    try {
      if (path === "/" || path === "/index.html") this.send(res, 200, "text/html; charset=utf-8", HTML);
      else if (path === "/geojson") this.send(res, 200, "application/geo+json", pyJson(toGeojson(this.stateCallback())));
      else if (path === "/state") this.send(res, 200, "application/json", pyJson(this.stateCallback()));
      else if (path.startsWith("/api/") || path === "/api") await this.api(req, res);
      else this.send(res, 404, "text/plain", "not found");
    } catch (exc) {
      this.log("map server error: " + errStr(exc));
      if (!res.headersSent) this.send(res, 500, "text/plain", errStr(exc));
    }
  }

  start(): Promise<void> {
    const srv = http.createServer((req, res) => {
      this.handle(req, res).catch((exc: unknown) => {
        this.log("map server error: " + errStr(exc));
        if (!res.headersSent) this.send(res, 500, "text/plain", errStr(exc));
      });
    });
    this.server = srv;
    return new Promise((resolve, reject) => {
      const onError = (e: Error): void => {
        this.server = null;
        reject(e);
      };
      srv.once("error", onError);
      srv.listen(this.port, this.host, () => {
        srv.off("error", onError);
        srv.on("error", (e) => this.log("map server error: " + e.message));
        this.port = (srv.address() as AddressInfo).port;
        this.log(`map: http://127.0.0.1:${this.port}/  (geojson at /geojson, raw at /state, api at /api/help)`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const srv = this.server;
    this.server = null;
    if (!srv) return Promise.resolve();
    return new Promise((resolve) => {
      srv.close(() => resolve());
      srv.closeAllConnections();
    });
  }
}
