/**
 * A typed fetch client over the endpoint map in routes.ts.
 *
 *   const tc = createClient();                       // http://127.0.0.1:8080
 *   const st = await tc.get('/api/status');          // Status
 *   const d  = await tc.get('/api/device/:id', { params: { id: 'lon-01' } });
 *   const r  = await tc.post('/api/request', { who: 'Sam', from: 'a', to: 'b' });
 *   const md = await tc.get('/api/report');          // string (text/markdown)
 *
 * Works in the browser (same-origin; pass baseUrl '') and in Node >= 18.
 * Non-2xx replies throw `TcHttpError`; its `error` field is the server's
 * `{error}` message when the body parsed as one.
 */
import type { GetPath, GetRoutes, PathParams, PostPath, PostRoutes, Kind } from './routes.ts';
import { GET_META } from './routes.ts';
import type { ApiErrorBody } from './types.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Default `http://127.0.0.1:8080`. Use `''` for same-origin in a page. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Per-request timeout in ms (default 10 000, the Rust HttpClient's). 0 disables. */
  timeoutMs?: number;
}

type ParamOpt<P extends string> = keyof PathParams<P> extends never ? { params?: undefined } : { params: PathParams<P> };
export type GetOptions<P extends GetPath> = ParamOpt<P> & {
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
};
type GetArgs<P extends GetPath> = keyof PathParams<P> extends never ? [opts?: GetOptions<P>] : [opts: GetOptions<P>];
type PostArgs<P extends PostPath> = PostRoutes[P]['body'] extends undefined
  ? [body?: undefined, opts?: { signal?: AbortSignal }]
  : [body: PostRoutes[P]['body'], opts?: { signal?: AbortSignal }];

export class TcHttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  /** Raw body text. */
  readonly body: string;
  /** `error` from a `{"error": "..."}` body, else null. */
  readonly error: string | null;
  constructor(method: string, path: string, status: number, body: string) {
    const msg = parseApiError(body);
    super(`${method} ${path} -> ${status}${msg ? `: ${msg}` : ''}`);
    this.name = 'TcHttpError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
    this.error = msg;
  }
}

export function parseApiError(body: string): string | null {
  try {
    const v: unknown = JSON.parse(body);
    if (isApiError(v)) return v.error;
  } catch {
    /* not JSON */
  }
  return null;
}
export function isApiError(v: unknown): v is ApiErrorBody {
  return typeof v === 'object' && v !== null && 'error' in v && typeof (v as { error: unknown }).error === 'string';
}

/**
 * Fill `:name` segments. Throws on an empty value: the server trims the
 * trailing slash, so `/api/device/` would become `/api/device` and 404 as
 * "not found" rather than "no frame".
 */
export function buildPath(template: string, params?: Readonly<Record<string, string>>): string {
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === '') throw new Error(`missing path parameter :${name} for ${template}`);
    // The server does NOT percent-decode path ids (http.rs:242,253,277), so
    // only ids that survive encodeURIComponent unchanged are reachable.
    const enc = encodeURIComponent(v);
    if (enc !== v) throw new Error(`path parameter :${name}=${JSON.stringify(v)} needs escaping; the server would look up ${JSON.stringify(enc)} literally`);
    return enc;
  });
}

export function buildQuery(query?: Readonly<Record<string, string | number | undefined>>): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function kindOf(path: GetPath): Kind {
  const m = GET_META[path];
  if (m.response.startsWith('string (text/html)')) return 'html';
  if (m.response.startsWith('string (text/markdown)')) return 'markdown';
  if (m.response.startsWith('string (text/plain)')) return 'text';
  if (m.response.startsWith('binary (audio/')) return 'audio';
  return 'json';
}

export interface TcClient {
  get<P extends GetPath>(path: P, ...args: GetArgs<P>): Promise<GetRoutes[P]['res']>;
  post<P extends PostPath>(path: P, ...args: PostArgs<P>): Promise<PostRoutes[P]['res']>;
  readonly baseUrl: string;
}

export function createClient(opts: ClientOptions = {}): TcClient {
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const doFetch: FetchLike = opts.fetch ?? ((i, init) => fetch(i, init));
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function send(method: 'GET' | 'POST', url: string, path: string, body: string | undefined, signal: AbortSignal | undefined, kind: Kind): Promise<unknown> {
    const signals: AbortSignal[] = [];
    if (signal) signals.push(signal);
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    const init: RequestInit = { method };
    if (signals.length === 1) init.signal = signals[0] ?? null;
    else if (signals.length > 1) init.signal = AbortSignal.any(signals);
    if (body !== undefined) {
      init.body = body;
      // text/plain keeps a cross-origin browser POST "simple" (no preflight):
      // the server answers OPTIONS with 405 and ignores Content-Type anyway.
      init.headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
    }
    const res = await doFetch(url, init);
    if (kind === 'audio' && res.ok) return new Uint8Array(await res.arrayBuffer());
    const text = await res.text();
    if (!res.ok) throw new TcHttpError(method, path, res.status, text);
    if (kind !== 'json') return text;
    return JSON.parse(text) as unknown;
  }

  return {
    baseUrl,
    async get<P extends GetPath>(path: P, ...args: GetArgs<P>): Promise<GetRoutes[P]['res']> {
      const o: GetOptions<P> | undefined = args[0];
      const params = o?.params as Readonly<Record<string, string>> | undefined;
      const concrete = buildPath(path, params);
      const url = baseUrl + concrete + buildQuery(o?.query);
      // The route map is the contract; the cast is the one unchecked step.
      return (await send('GET', url, concrete, undefined, o?.signal, kindOf(path))) as GetRoutes[P]['res'];
    },
    async post<P extends PostPath>(path: P, ...args: PostArgs<P>): Promise<PostRoutes[P]['res']> {
      const [body, o] = args;
      const text = body === undefined ? '' : JSON.stringify(body);
      return (await send('POST', baseUrl + path, path, text, o?.signal, 'json')) as PostRoutes[P]['res'];
    },
  };
}

/** Shorthand used in docs: `tc.get('/api/status')`. */
export const tc: TcClient = createClient();
