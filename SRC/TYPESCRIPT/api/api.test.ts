import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPath, buildQuery, createClient, TcHttpError, type FetchLike } from './client.ts';
import { GET_META, POST_META } from './routes.ts';
import { checkShape } from './validate.ts';
import { connectTelemetry, mergeGlobe, parseTelemetry, type GlobeDeltaMessage, type WebSocketLike } from './telemetry.ts';
import type { GlobeData, GlobeNode, Status } from './types.ts';
import { buildOpenApi } from './openapi.ts';

// --- client ---------------------------------------------------------------

function fakeFetch(handler: (url: string, init: RequestInit | undefined) => { status: number; body: string }): { fetch: FetchLike; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = handler(url, init);
      return new Response(r.body, { status: r.status });
    },
  };
}

test('buildPath fills params and refuses empty or escaped ids', () => {
  assert.equal(buildPath('/api/device/:id', { id: 'lon-01' }), '/api/device/lon-01');
  assert.throws(() => buildPath('/api/device/:id', { id: '' }), /missing/);
  assert.throws(() => buildPath('/api/device/:id', {}), /missing/);
  assert.throws(() => buildPath('/api/device/:id', { id: 'a b' }), /escaping/);
});

test('buildQuery encodes and skips undefined', () => {
  assert.equal(buildQuery({ frame: 'a b', port: 3, x: undefined }), '?frame=a%20b&port=3');
  assert.equal(buildQuery(), '');
});

test('get parses JSON and infers path params', async () => {
  const f = fakeFetch((url) => ({ status: 200, body: url.endsWith('/api/device/x-01') ? '{"frame":{"id":"x-01"}}' : '{}' }));
  const tc = createClient({ baseUrl: 'http://h:1/', fetch: f.fetch, timeoutMs: 0 });
  const d = await tc.get('/api/device/:id', { params: { id: 'x-01' } });
  assert.equal(d.frame.id, 'x-01');
  assert.equal(f.calls[0]?.url, 'http://h:1/api/device/x-01');
  assert.equal(f.calls[0]?.init?.method, 'GET');
});

test('text routes return the raw string', async () => {
  const f = fakeFetch(() => ({ status: 200, body: '# Report' }));
  const tc = createClient({ fetch: f.fetch, timeoutMs: 0 });
  const md: string = await tc.get('/api/report');
  assert.equal(md, '# Report');
  const wb: string = await tc.get('/api/wardbeck');
  assert.equal(wb, '# Report');
});

test('voice WAVs come back as bytes, JSON voice routes as objects', async () => {
  const f = fakeFetch((url) => (url.endsWith('.wav') ? { status: 200, body: 'RIFF....WAVE' } : { status: 200, body: '{"frame":"paris-01","accent":"fr-fr+f2"}' }));
  const tc = createClient({ fetch: f.fetch, timeoutMs: 0 });
  const wav: Uint8Array = await tc.get('/voices/:file', { params: { file: 'paris-01-call.wav' } });
  assert.ok(wav instanceof Uint8Array);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  const v = await tc.get('/api/voices/:frame', { params: { frame: 'paris-01' } });
  assert.equal(v.accent, 'fr-fr+f2');
  assert.equal(f.calls[1]?.url, 'http://127.0.0.1:8080/api/voices/paris-01');
});

test('a TAPS fader is a GainSet with frame, input and output', async () => {
  const f = fakeFetch(() => ({ status: 200, body: '{"seq":1,"at":"t","set":{"frame":"a-01","input":"C0","output":"U00","db":-6},"was_db":0,"path_gain_db":{}}' }));
  const tc = createClient({ fetch: f.fetch, timeoutMs: 0 });
  const ev = await tc.post('/api/gain', { frame: 'a-01', input: 'C0', output: 'U00', db: -6 });
  assert.equal(ev.set.frame, 'a-01');
  const u = await tc.post('/api/taps/unity', {});
  assert.ok(u);
});

test('post sends JSON body as text/plain (no CORS preflight)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: '{"wire_version":1,"id":"r1","status":"denied","replied_at":"t"}' }));
  const tc = createClient({ fetch: f.fetch, timeoutMs: 0 });
  const r = await tc.post('/api/request', { who: 'Sam', from: 'a', to: 'b' });
  assert.equal(r.status, 'denied');
  assert.equal(f.calls[0]?.init?.body, '{"who":"Sam","from":"a","to":"b"}');
  assert.deepEqual(f.calls[0]?.init?.headers, { 'Content-Type': 'text/plain;charset=UTF-8' });
  await tc.post('/api/capture/stop');
  assert.equal(f.calls[1]?.init?.body, '');
});

test('non-2xx throws TcHttpError carrying the {error} message', async () => {
  const f = fakeFetch(() => ({ status: 404, body: '{\n  "error": "no frame zz"\n}' }));
  const tc = createClient({ fetch: f.fetch, timeoutMs: 0 });
  await assert.rejects(tc.get('/api/device/:id', { params: { id: 'zz' } }), (e: unknown) => e instanceof TcHttpError && e.status === 404 && e.error === 'no frame zz');
});

// Compile-time contract checks (fail tsc, not the test run, if they drift).
type Assert<T extends true> = T;
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _status = Assert<Eq<Awaited<ReturnType<typeof statusCall>>, Status>>;
const statusCall = () => createClient().get('/api/status');
// @ts-expect-error a param route needs its params
const _bad = () => createClient().get('/api/device/:id');
// @ts-expect-error POST /api/request needs a Request body
const _bad2 = () => createClient().post('/api/request');
void _bad;
void _bad2;
export type { _status };

// --- catalogue ------------------------------------------------------------

test('catalogue counts: 70 /api endpoints + 19 pages + /report.md + /voices/:file', () => {
  const gets = Object.keys(GET_META);
  const posts = Object.keys(POST_META);
  const apiGets = gets.filter((p) => p.startsWith('/api/'));
  assert.equal(apiGets.length, 49);
  assert.equal(posts.length, 21);
  assert.equal(gets.filter((p) => GET_META[p as keyof typeof GET_META].response.includes('text/html')).length, 19);
});

test('openapi has every path', () => {
  const doc = buildOpenApi() as { paths: Record<string, unknown> };
  assert.ok('/api/device/{id}' in doc.paths);
  assert.ok('/ws' in doc.paths);
  const unique = new Set([...Object.keys(GET_META), ...Object.keys(POST_META)]);
  assert.equal(Object.keys(doc.paths).length, unique.size + 1);
  assert.equal(unique.size, 87);
});

test('checkShape', () => {
  assert.deepEqual(checkShape({ a: 1 }, { type: 'object', keys: ['a'] }), []);
  assert.deepEqual(checkShape({}, { type: 'object', keys: ['a'] }), ['missing key a']);
  assert.deepEqual(checkShape([], { type: 'array', itemKeys: ['a'] }), []);
  assert.deepEqual(checkShape('x', { type: 'string' }), []);
});

// --- telemetry ------------------------------------------------------------

function node(id: string, live: number): GlobeNode {
  return { id, proto: 'p', protoName: 'P', site: 's', fam: 'other', badge: null, lat: 0, lon: 0, live, cont: null, free: 0, cas: 8, ports: 56, since: null, sim: null, load: null, who: [] };
}
function seed(): GlobeData {
  return {
    site: 's', clock: '00:00', load: 1, sim_time: 0, frames: 2, sites: 1, trunks: 0, calls: 0, sims: 0,
    config: { rotate_deg_per_s: 1, tilt_deg: 0, show_capitals: true, show_provinces: true, show_cities: true, graticule_deg: 30, projection: 'both', zoom: 1, zones: [] },
    nodes: [node('a', 3), node('b', 0)], clusters: [], trunkList: [], callList: [], history: [], today: 0, lockHours: 1, daysShown: 14,
  };
}
function delta(over: Partial<GlobeDeltaMessage> = {}): GlobeDeltaMessage {
  return {
    type: 'globe-delta', frames: 2, clock: '01:00', trunkList: [], history: [], today: 1, callList: [], live: { b: 2 }, red: [], parked: {}, blink: [], last: {},
    lights: { now: 0, lease: 60, hot: [], stale: [], parked: [], live: {}, conn: {}, casters: {} }, clusters: [], sites: 1, trunks: 4, calls: 1, sims: 0, ...over,
  };
}

test('mergeGlobe: absent live means 0 (replace, not merge)', () => {
  const r = mergeGlobe(seed(), delta());
  assert.equal(r.globe.nodes[0]?.live, 0);
  assert.equal(r.globe.nodes[1]?.live, 2);
  assert.equal(r.globe.clock, '01:00');
  assert.equal(r.globe.trunks, 4);
  assert.equal(r.fleetChanged, false);
  assert.equal(mergeGlobe(seed(), delta({ frames: 3 })).fleetChanged, true);
});

test('parseTelemetry ignores junk and unknown types', () => {
  assert.equal(parseTelemetry('nope'), null);
  assert.equal(parseTelemetry('{"type":"other"}'), null);
  assert.equal(parseTelemetry('{"type":"status","build":"b"}')?.type, 'status');
});

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.all.push(this);
  }
  close(): void {
    this.closed = true;
  }
  emit(obj: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(obj) }));
  }
  drop(): void {
    this.onclose?.(new Event('close') as CloseEvent);
  }
}

test('connectTelemetry: status, build change, seed+delta merge, reconnect with backoff', async () => {
  FakeWs.all = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const builds: string[] = [];
  const globes: GlobeData[] = [];
  const t = connectTelemetry({
    url: 'ws://x/ws',
    WebSocket: FakeWs,
    seed: async () => seed(),
    onBuildChange: (a, b) => builds.push(`${a}->${b}`),
    onGlobe: (g) => globes.push(g),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
  });
  await new Promise((r) => setTimeout(r, 0));
  const ws = FakeWs.all[0]!;
  ws.onopen?.(new Event('open'));
  assert.equal(t.state, 'open');
  ws.emit({ type: 'status', build: 'b1' });
  ws.emit({ type: 'status', build: 'b2' });
  assert.deepEqual(builds, ['b1->b2']);
  ws.emit(delta());
  assert.equal(t.globe?.nodes[1]?.live, 2);
  ws.drop();
  assert.equal(t.state, 'closed');
  assert.equal(timers[0]?.ms, 2000);
  timers[0]!.fn();
  FakeWs.all[1]!.drop();
  assert.equal(timers[1]?.ms, 4000);
  t.stop();
  assert.equal(t.state, 'stopped');
  assert.ok(globes.length >= 1);
});
