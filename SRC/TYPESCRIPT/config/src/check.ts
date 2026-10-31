// Dependency-free runtime validators that mirror serde's behaviour.
//
// A Check<T> walks an unknown JSON value, records issues with a JSON path,
// and returns true when the value has the shape of T. The phantom `__t`
// carries T so `obj<T>()` can insist that every key of T has a check.
//
// serde semantics reproduced here:
//   - a missing required field fails the whole parse      -> error
//   - `#[serde(default)]` fields may be absent              -> opt()/dflt()
//   - unknown fields are silently ignored by serde          -> warn (typo finder)
//   - integer fields (u64/usize/u16) reject 1.5 and -1      -> int()

export type Level = "error" | "warn";

export interface Issue {
  readonly level: Level;
  readonly path: string;
  readonly message: string;
}

export interface Ctx {
  readonly issues: Issue[];
}

export interface Check<T> {
  (v: unknown, path: string, ctx: Ctx): boolean;
  /** Phantom: never set at run time. */
  readonly __t?: T;
  /** Field may be absent (serde `default` / `Option`). */
  readonly optional?: boolean;
  /** Human description used in messages and docs. */
  readonly label: string;
}

export function newCtx(): Ctx {
  return { issues: [] };
}

export function err(ctx: Ctx, path: string, message: string): false {
  ctx.issues.push({ level: "error", path, message });
  return false;
}

export function warn(ctx: Ctx, path: string, message: string): void {
  ctx.issues.push({ level: "warn", path, message });
}

function make<T>(label: string, fn: (v: unknown, path: string, ctx: Ctx) => boolean, optional = false): Check<T> {
  return Object.assign(fn, { label, optional });
}

export function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export const str = (): Check<string> =>
  make<string>("string", (v, p, c) => (typeof v === "string" ? true : err(c, p, `expected string, got ${describe(v)}`)));

export const bool = (): Check<boolean> =>
  make<boolean>("boolean", (v, p, c) => (typeof v === "boolean" ? true : err(c, p, `expected boolean, got ${describe(v)}`)));

export interface NumOpts {
  readonly min?: number;
  readonly max?: number;
  /** Values outside [softMin, softMax] are legal for serde but suspicious. */
  readonly softMin?: number;
  readonly softMax?: number;
}

/** f64. JSON has no NaN/Infinity so any finite number parses. */
export const num = (o: NumOpts = {}): Check<number> =>
  make<number>("number", (v, p, c) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return err(c, p, `expected number, got ${describe(v)}`);
    return range(v, o, p, c);
  });

/** u64 / usize / u32 / u16: serde rejects fractions and negatives. */
export const int = (o: NumOpts = {}): Check<number> =>
  make<number>("integer", (v, p, c) => {
    if (typeof v !== "number" || !Number.isInteger(v)) return err(c, p, `expected integer, got ${typeof v === "number" ? v : describe(v)}`);
    if (v < 0) return err(c, p, `expected unsigned integer, got ${v}`);
    return range(v, o, p, c);
  });

function range(v: number, o: NumOpts, p: string, c: Ctx): boolean {
  if (o.min !== undefined && v < o.min) return err(c, p, `${v} is below ${o.min}`);
  if (o.max !== undefined && v > o.max) return err(c, p, `${v} is above ${o.max}`);
  if (o.softMin !== undefined && v < o.softMin) warn(c, p, `${v} is below the expected ${o.softMin}`);
  if (o.softMax !== undefined && v > o.softMax) warn(c, p, `${v} is above the expected ${o.softMax}`);
  return true;
}

export const oneOf = <const L extends readonly string[]>(values: L, level: Level = "error"): Check<L[number]> =>
  make<L[number]>(values.map((x) => JSON.stringify(x)).join(" | "), (v, p, c) => {
    if (typeof v !== "string") return err(c, p, `expected one of ${values.join(", ")}, got ${describe(v)}`);
    if (values.includes(v)) return true;
    if (level === "warn") {
      warn(c, p, `"${v}" is not one of ${values.join(", ")}`);
      return true;
    }
    return err(c, p, `"${v}" is not one of ${values.join(", ")}`);
  });

export const pattern = (re: RegExp, what: string, level: Level = "error"): Check<string> =>
  make<string>(`string /${re.source}/`, (v, p, c) => {
    if (typeof v !== "string") return err(c, p, `expected ${what}, got ${describe(v)}`);
    if (re.test(v)) return true;
    if (level === "warn") {
      warn(c, p, `"${v}" is not ${what}`);
      return true;
    }
    return err(c, p, `"${v}" is not ${what}`);
  });

/** Any JSON value (serde_json::Value). */
export const json = (): Check<JsonValue> => make<JsonValue>("json", () => true);

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export const arr = <T>(item: Check<T>): Check<T[]> =>
  make<T[]>(`${item.label}[]`, (v, p, c) => {
    if (!Array.isArray(v)) return err(c, p, `expected array, got ${describe(v)}`);
    let ok = true;
    v.forEach((x, i) => {
      if (!item(x, `${p}[${i}]`, c)) ok = false;
    });
    return ok;
  });

/** BTreeMap<String, T>. */
export const record = <T>(value: Check<T>, key?: Check<string>): Check<Record<string, T>> =>
  make<Record<string, T>>(`{[k]: ${value.label}}`, (v, p, c) => {
    if (!isPlainObject(v)) return err(c, p, `expected object, got ${describe(v)}`);
    let ok = true;
    for (const [k, x] of Object.entries(v)) {
      if (key && !key(k, `${p}.${k} (key)`, c)) ok = false;
      if (!value(x, `${p}.${k}`, c)) ok = false;
    }
    return ok;
  });

/** Option<T> / #[serde(default)]: may be absent. `null` is accepted for Option. */
export const opt = <T>(inner: Check<T>, allowNull = true): Check<T | undefined> =>
  make<T | undefined>(
    `${inner.label}?`,
    (v, p, c) => (v === undefined || (allowNull && v === null) ? true : inner(v, p, c)),
    true,
  );

export type Shape<T> = { readonly [K in keyof T]-?: Check<T[K]> };

export interface ObjOpts {
  /** Keys that are allowed but not modelled (e.g. `_comment`). */
  readonly extra?: readonly string[];
  /** Unknown keys: "warn" (serde ignores them; default) or "ignore". */
  readonly unknown?: "warn" | "ignore";
}

export const obj = <T>(shape: Shape<T>, o: ObjOpts = {}): Check<T> =>
  make<T>("object", (v, p, c) => {
    if (!isPlainObject(v)) return err(c, p, `expected object, got ${describe(v)}`);
    let ok = true;
    const known = new Set<string>([...Object.keys(shape), ...(o.extra ?? [])]);
    for (const [k, check] of Object.entries(shape) as [string, Check<unknown>][]) {
      const x = v[k];
      const at = p ? `${p}.${k}` : k;
      if (x === undefined && !check.optional) {
        err(c, at, "missing required field (serde would refuse the whole file)");
        ok = false;
        continue;
      }
      if (!check(x, at, c)) ok = false;
    }
    if (o.unknown !== "ignore") {
      for (const k of Object.keys(v)) {
        if (!known.has(k)) warn(c, p ? `${p}.${k}` : k, "unknown field: serde ignores it (typo?)");
      }
    }
    return ok;
  });

/** Add semantic checks that run only when the shape is right. */
export const refine = <T>(base: Check<T>, extra: (v: T, path: string, ctx: Ctx) => void): Check<T> =>
  make<T>(
    base.label,
    (v, p, c) => {
      if (!base(v, p, c)) return false;
      const before = c.issues.filter((i) => i.level === "error").length;
      extra(v as T, p, c);
      return c.issues.filter((i) => i.level === "error").length === before;
    },
    base.optional ?? false,
  );

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface Parsed<T> {
  readonly ok: boolean;
  readonly value: T | undefined;
  readonly issues: Issue[];
}

export function validate<T>(check: Check<T>, v: unknown, path = ""): Parsed<T> {
  const ctx = newCtx();
  const ok = check(v, path, ctx);
  // The only cast in the module: the check has just proved the shape.
  return { ok, value: ok ? (v as T) : undefined, issues: ctx.issues };
}

/** Parse JSON text and validate it; a syntax error is one issue at the root. */
export function validateText<T>(check: Check<T>, text: string): Parsed<T> {
  let v: unknown;
  try {
    v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, value: undefined, issues: [{ level: "error", path: "", message: `JSON syntax: ${m}` }] };
  }
  return validate(check, v);
}

/** Duplicates in a list, by key. */
export function duplicates<T>(items: readonly T[], key: (x: T) => string): string[] {
  const seen = new Map<string, number>();
  for (const x of items) seen.set(key(x), (seen.get(key(x)) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}
