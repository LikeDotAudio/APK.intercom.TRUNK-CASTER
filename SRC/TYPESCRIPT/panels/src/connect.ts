/**
 * connect.ts -- types and validator for PANELS/connect.json.
 *
 * connect.json has no schema of its own; this file IS its schema. Every
 * endpoint is a string "METHOD {base_url}/path?..." with {placeholders}.
 * expandEndpoint() turns one into a concrete URL so Companion recipes and the
 * emulator share one source of truth.
 */
import { Checker, type ValidationResult } from "./panel-schema.ts";

export interface ConnectConfig {
  _comment?: string;
  api: { base_url: string; help: string; content_type: string };
  discover: { list_matrices: string; list_ports: string; map_feed: string; whole_state: string };
  lifecycle: { claim_a_port: string; claim_specific_port: string; release: string };
  buttons: {
    talk_press: string;
    talk_release: string;
    listen_on: string;
    listen_off: string;
    trunk_call: string;
    hangup: string;
  };
  feedback: {
    poll: string;
    poll_interval_ms: number;
    fields: Record<string, string>;
  };
  bitfocus_companion: { connection: string; press_action: string; release_action: string; feedback: string; note: string };
  streamdeck_app_native: { action: string; limitation: string };
  audio_for_the_operator: { note: string; command: string };
}

const SHAPE: Record<string, readonly string[]> = {
  api: ["base_url", "help", "content_type"],
  discover: ["list_matrices", "list_ports", "map_feed", "whole_state"],
  lifecycle: ["claim_a_port", "claim_specific_port", "release"],
  buttons: ["talk_press", "talk_release", "listen_on", "listen_off", "trunk_call", "hangup"],
  feedback: ["poll"],
  bitfocus_companion: ["connection", "press_action", "release_action", "feedback", "note"],
  streamdeck_app_native: ["action", "limitation"],
  audio_for_the_operator: ["note", "command"],
};

/** Sections whose every value is an HTTP endpoint template. */
const ENDPOINT_SECTIONS = ["discover", "lifecycle", "buttons"] as const;
const ENDPOINT_RE = /^(GET|POST) \{base_url\}\/\S+$/;

export function validateConnect(v: unknown): ValidationResult<ConnectConfig> {
  const c = new Checker();
  if (c.object(v, "")) {
    c.required(v, Object.keys(SHAPE), "");
    c.string(v, "_comment", "");
    for (const [section, keys] of Object.entries(SHAPE)) {
      const s = v[section];
      if (s === undefined || !c.object(s, `/${section}`)) continue;
      c.required(s, keys, `/${section}`);
      for (const k of keys) c.string(s, k, `/${section}`);
      if ((ENDPOINT_SECTIONS as readonly string[]).includes(section)) {
        for (const [k, val] of Object.entries(s))
          if (typeof val === "string" && !ENDPOINT_RE.test(val)) c.fail(`/${section}/${k}`, `not an endpoint template: '${val}'`);
      }
    }
    const api = v["api"];
    if (c.isObject(api)) c.string(api, "base_url", "/api", { uri: true });
    const fb = v["feedback"];
    if (c.isObject(fb)) {
      c.required(fb, ["poll_interval_ms", "fields"], "/feedback");
      c.integer(fb, "poll_interval_ms", "/feedback", { min: 1 });
      const f = fb["fields"];
      if (f !== undefined && c.object(f, "/feedback/fields")) for (const k of Object.keys(f)) c.string(f, k, "/feedback/fields");
    }
  }
  return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, value: v as unknown as ConnectConfig };
}

/** "GET {base_url}/api/key?matrix={matrix}" + vars -> {method, url}. Unknown placeholders throw. */
export function expandEndpoint(template: string, vars: Record<string, string | number>): { method: "GET" | "POST"; url: string } {
  const m = /^(GET|POST)\s+(.*)$/.exec(template.trim());
  if (!m || (m[1] !== "GET" && m[1] !== "POST") || m[2] === undefined) throw new Error(`not an endpoint: ${template}`);
  const method = m[1];
  const url = m[2].replace(/\{(\w+)\}/g, (_all, name: string) => {
    const val = vars[name];
    if (val === undefined) throw new Error(`no value for {${name}} in ${template}`);
    return name === "base_url" ? String(val).replace(/\/+$/, "") : encodeURIComponent(String(val));
  });
  return { method, url };
}
