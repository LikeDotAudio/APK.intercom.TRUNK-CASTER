/**
 * panel-schema.ts -- hand-written TypeScript mirror of PANELS/panel.schema.json
 * plus a dependency-free runtime validator.
 *
 * The types are exact to the schema: required keys are required, everything
 * else is optional, enums are string-literal unions. Defaults that the schema
 * declares live in PANEL_DEFAULTS / BUTTON_COLOR_DEFAULTS so callers do not
 * scatter magic numbers (the Python emulator did: 72, 1000, "momentary", ...).
 *
 * The schema does not set additionalProperties:false anywhere except `pages`
 * (whose values must be button arrays), so unknown keys are accepted, exactly
 * as a JSON Schema validator would.
 */

export const DEVICE_MODELS = [
  "streamdeck-mini", "streamdeck-mk2", "streamdeck-xl", "streamdeck-plus", "streamdeck-neo",
  "loupedeck-live", "razer-stream-controller", "xkeys", "companion", "browser", "generic",
] as const;
export type DeviceModel = (typeof DEVICE_MODELS)[number];

export const BUTTON_ACTIONS = ["talk", "listen", "call", "hangup", "reply", "page", "none"] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

export const BUTTON_MODES = ["momentary", "latch"] as const;
export type ButtonMode = (typeof BUTTON_MODES)[number];

export const ENCODER_ACTIONS = ["listen_level", "mic_level", "scroll_targets", "none"] as const;
export type EncoderAction = (typeof ENCODER_ACTIONS)[number];

export interface PanelDevice {
  model: DeviceModel;
  /** 1..16 */
  rows: number;
  /** 1..16 */
  cols: number;
  /** default 72 */
  key_px?: number;
  /** default 0 */
  encoders?: number;
  serial?: string;
}

export interface ButtonColors {
  idle?: string;
  active?: string;
  incoming?: string;
  text?: string;
}

export interface PanelButton {
  row: number;
  col: number;
  label?: string;
  action: ButtonAction;
  /** port number or alpha (talk/listen), "ICOM:port" (call), page name (page) */
  target?: string;
  mode?: ButtonMode;
  colors?: ButtonColors;
  icon?: string;
  hold_to_latch_ms?: number;
}

export interface PanelEncoder {
  index: number;
  label?: string;
  action: EncoderAction;
  target?: string;
}

export interface Panel {
  name: string;
  device: PanelDevice;
  matrix: string;
  /** 0 = claim the next free keypanel port */
  port: number;
  api?: string;
  name_on_matrix?: string;
  /** default 1000 */
  poll_ms?: number;
  pages?: Record<string, PanelButton[]>;
  buttons: PanelButton[];
  encoders?: PanelEncoder[];
}

export const PANEL_DEFAULTS = {
  key_px: 72,
  encoders: 0,
  poll_ms: 1000,
  mode: "momentary" as ButtonMode,
  hold_to_latch_ms: 0,
} as const;

export const BUTTON_COLOR_DEFAULTS: Required<ButtonColors> = {
  idle: "#2b2b2b",
  active: "#d9342b",
  incoming: "#f0b429",
  text: "#ffffff",
};

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export interface ValidationError {
  /** JSON-pointer-ish path, e.g. /buttons/3/action */
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

/** Shared tiny checker used by both validators in this folder. */
export class Checker {
  readonly errors: ValidationError[] = [];

  fail(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  isObject(v: unknown): v is JsonObject {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  object(v: unknown, path: string): v is JsonObject {
    if (this.isObject(v)) return true;
    this.fail(path, "must be an object");
    return false;
  }

  required(o: JsonObject, keys: readonly string[], path: string): void {
    for (const k of keys) if (!(k in o)) this.fail(path, `missing required property '${k}'`);
  }

  string(o: JsonObject, key: string, path: string, opt: { enum?: readonly string[]; uri?: boolean } = {}): void {
    if (!(key in o)) return;
    const v = o[key];
    const p = `${path}/${key}`;
    if (typeof v !== "string") {
      this.fail(p, "must be a string");
      return;
    }
    if (opt.enum && !opt.enum.includes(v)) this.fail(p, `must be one of ${opt.enum.join(", ")} (got '${v}')`);
    if (opt.uri && !URL.canParse(v)) this.fail(p, `must be a URI (got '${v}')`);
  }

  integer(o: JsonObject, key: string, path: string, opt: { min?: number; max?: number } = {}): void {
    if (!(key in o)) return;
    const v = o[key];
    const p = `${path}/${key}`;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      this.fail(p, "must be an integer");
      return;
    }
    if (opt.min !== undefined && v < opt.min) this.fail(p, `must be >= ${opt.min}`);
    if (opt.max !== undefined && v > opt.max) this.fail(p, `must be <= ${opt.max}`);
  }
}

function checkButton(c: Checker, b: unknown, path: string): void {
  if (!c.object(b, path)) return;
  c.required(b, ["row", "col", "action"], path);
  c.integer(b, "row", path, { min: 0 });
  c.integer(b, "col", path, { min: 0 });
  c.string(b, "label", path);
  c.string(b, "action", path, { enum: BUTTON_ACTIONS });
  c.string(b, "target", path);
  c.string(b, "mode", path, { enum: BUTTON_MODES });
  if ("colors" in b && c.object(b["colors"], `${path}/colors`)) {
    const col = b["colors"] as JsonObject;
    for (const k of ["idle", "active", "incoming", "text"]) c.string(col, k, `${path}/colors`);
  }
  c.string(b, "icon", path);
  c.integer(b, "hold_to_latch_ms", path);
}

function checkButtons(c: Checker, v: unknown, path: string): void {
  if (!Array.isArray(v)) {
    c.fail(path, "must be an array");
    return;
  }
  v.forEach((b, i) => checkButton(c, b, `${path}/${i}`));
}

/** Validate a parsed JSON value against panel.schema.json. */
export function validatePanel(v: unknown): ValidationResult<Panel> {
  const c = new Checker();
  if (c.object(v, "")) {
    c.required(v, ["name", "device", "matrix", "port", "buttons"], "");
    c.string(v, "name", "");
    if ("device" in v && c.object(v["device"], "/device")) {
      const d = v["device"] as JsonObject;
      c.required(d, ["model", "rows", "cols"], "/device");
      c.string(d, "model", "/device", { enum: DEVICE_MODELS });
      c.integer(d, "rows", "/device", { min: 1, max: 16 });
      c.integer(d, "cols", "/device", { min: 1, max: 16 });
      c.integer(d, "key_px", "/device");
      c.integer(d, "encoders", "/device");
      c.string(d, "serial", "/device");
    }
    c.string(v, "matrix", "");
    c.integer(v, "port", "", { min: 0 });
    c.string(v, "api", "", { uri: true });
    c.string(v, "name_on_matrix", "");
    c.integer(v, "poll_ms", "");
    if ("pages" in v && c.object(v["pages"], "/pages")) {
      for (const [name, arr] of Object.entries(v["pages"] as JsonObject)) checkButtons(c, arr, `/pages/${name}`);
    }
    if ("buttons" in v) checkButtons(c, v["buttons"], "/buttons");
    if ("encoders" in v) {
      const enc = v["encoders"];
      if (!Array.isArray(enc)) c.fail("/encoders", "must be an array");
      else
        enc.forEach((e, i) => {
          const p = `/encoders/${i}`;
          if (!c.object(e, p)) return;
          c.required(e, ["index", "action"], p);
          c.integer(e, "index", p, { min: 0 });
          c.string(e, "label", p);
          c.string(e, "action", p, { enum: ENCODER_ACTIONS });
          c.string(e, "target", p);
        });
    }
  }
  // The checks above prove the shape; the cast is the single narrowing point.
  return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, value: v as Panel };
}

// ---------------------------------------------------------------------------
// Lint: rules the schema cannot express but the emulator silently relies on.
// ---------------------------------------------------------------------------

export interface LintWarning {
  path: string;
  message: string;
}

export function lintPanel(p: Panel): LintWarning[] {
  const out: LintWarning[] = [];
  const pages: [string, PanelButton[]][] = [["main", p.buttons], ...Object.entries(p.pages ?? {})];
  const pageNames = new Set(pages.map(([n]) => n));
  for (const [page, buttons] of pages) {
    const base = page === "main" ? "/buttons" : `/pages/${page}`;
    const seen = new Map<string, number>();
    buttons.forEach((b, i) => {
      const path = `${base}/${i}`;
      if (b.row >= p.device.rows || b.col >= p.device.cols)
        out.push({ path, message: `key ${b.row},${b.col} is outside the ${p.device.rows}x${p.device.cols} grid (never drawn)` });
      const rc = `${b.row},${b.col}`;
      const prev = seen.get(rc);
      if (prev !== undefined) out.push({ path, message: `duplicate key ${rc} (also ${base}/${prev}); last one wins` });
      seen.set(rc, i);
      if ((b.action === "talk" || b.action === "listen" || b.action === "call" || b.action === "page") && !b.target)
        out.push({ path, message: `action '${b.action}' needs a target` });
      if (b.action === "call" && b.target && !/^[A-Za-z0-9]+:\d+$/.test(b.target))
        out.push({ path, message: `call target '${b.target}' is not ICOM:port` });
      if (b.action === "page" && b.target && !pageNames.has(b.target))
        out.push({ path, message: `page '${b.target}' does not exist` });
      if (b.hold_to_latch_ms) out.push({ path, message: "hold_to_latch_ms is in the schema but not implemented by the emulator" });
    });
  }
  const encCount = p.device.encoders ?? PANEL_DEFAULTS.encoders;
  for (const [i, e] of (p.encoders ?? []).entries()) {
    if (e.index >= encCount) out.push({ path: `/encoders/${i}`, message: `encoder index ${e.index} but device has ${encCount} encoders` });
  }
  if ((p.encoders?.length ?? 0) > 0 && encCount === 0)
    out.push({ path: "/encoders", message: "encoders listed but device.encoders is 0, so they are never shown" });
  return out;
}
