/**
 * matrix-api.ts -- the button API every matrix simulator serves (/api/<action>).
 *
 * Port of streamdeck_emulator.py:28-38 (class Api) with typed results. Shapes
 * come from rts_intercom_sim.py Estate.action() / MatrixDevice.port_state().
 * DEDUP NOTE: these wire types belong in TYPESCRIPT/sdk (agent 04). They are
 * defined locally here and should be replaced by sdk imports once it lands.
 */

/** GET /api/ports?matrix=X -> one entry per port. */
export interface ApiPort {
  n: number;
  alpha: string;
  type: string;
  user: boolean;
  talk?: boolean;
  listen?: boolean;
  live?: boolean;
  keys?: number;
}

export interface IncomingCall {
  port: number;
  alpha: string;
  /** epoch seconds on the matrix's clock */
  since: number;
}

/** GET /api/port (also returned by /api/key) -- also the TC STATE payload. */
export interface PortState {
  port?: number;
  alpha?: string;
  matrix?: string;
  talking_to?: number[];
  /** "ICOM:port" strings for trunk calls in progress */
  remote?: string[];
  listening?: number[];
  incoming?: IncomingCall[];
  users?: number;
  users_calling?: number;
  time?: string;
}

export interface ClaimResult {
  port: number;
  alpha: string;
  matrix: string;
}

export type ApiParam = string | number | undefined | null;

export class ApiError extends Error {}

/** Minimal fetch signature so tests can inject a fake. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ json(): Promise<unknown> }>;

export class MatrixApi {
  readonly base: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(base: string, opts: { timeoutMs?: number; fetch?: FetchLike } = {}) {
    this.base = base.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  url(action: string, params: Record<string, ApiParam>): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
    return `${this.base}/api/${action}?${q.toString()}`;
  }

  /** Untyped call; prefer the typed helpers below. */
  async call(action: string, params: Record<string, ApiParam>): Promise<unknown> {
    const r = await this.fetchImpl(this.url(action, params), { signal: AbortSignal.timeout(this.timeoutMs) });
    const data = await r.json();
    if (typeof data !== "object" || data === null) throw new ApiError("api error: not an object");
    const d = data as { ok?: unknown; error?: unknown; result?: unknown };
    if (!d.ok) throw new ApiError(typeof d.error === "string" ? d.error : "api error");
    return d.result;
  }

  ports(matrix: string): Promise<ApiPort[]> {
    return this.call("ports", { matrix }) as Promise<ApiPort[]>;
  }
  claim(matrix: string, port: number, name: string): Promise<ClaimResult> {
    return this.call("claim", { matrix, port, name }) as Promise<ClaimResult>;
  }
  release(matrix: string, port: number): Promise<unknown> {
    return this.call("release", { matrix, port });
  }
  port(matrix: string, port: number): Promise<PortState> {
    return this.call("port", { matrix, port }) as Promise<PortState>;
  }
  key(matrix: string, port: number, kind: "talk" | "listen", target: string | number | undefined, state: boolean): Promise<PortState> {
    return this.call("key", { matrix, port, kind, target, state: state ? 1 : 0 }) as Promise<PortState>;
  }
  trunkCall(matrix: string, port: number, icom: string, remote: string): Promise<unknown> {
    return this.call("call", { matrix, port, icom, remote });
  }
  hangup(matrix: string, port: number): Promise<unknown> {
    return this.call("hangup", { matrix, port });
  }
}
