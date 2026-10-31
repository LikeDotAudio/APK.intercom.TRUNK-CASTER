/**
 * Read-only smoke test against a running runtime. GET routes ONLY; never POSTs.
 *
 *   node --experimental-strip-types api/smoke.ts [--base http://127.0.0.1:8080] [--pages] [--ws-seconds 8]
 *
 * Exits 0 when the server is unreachable (reports "not reachable") so it can
 * run in CI without a server; exits 1 when a reachable server returns a shape
 * that does not match routes.ts.
 */
import { createClient, TcHttpError } from './client.ts';
import { GET_META, type GetPath } from './routes.ts';
import { checkShape } from './validate.ts';
import { parseTelemetry, type GlobeDeltaMessage, type StatusMessage } from './telemetry.ts';

const STATUS_KEYS: readonly (keyof StatusMessage)[] = ['type', 'build', 'status', 'clock', 'hour', 'load', 'fader', 'productions', 'blackout', 'muted', 'log', 'wardbeck', 'continents', 'lines', 'run', 'dirty'];
const DELTA_KEYS: readonly (keyof GlobeDeltaMessage)[] = ['type', 'frames', 'clock', 'trunkList', 'history', 'today', 'callList', 'live', 'red', 'parked', 'blink', 'last', 'lights', 'clusters', 'sites', 'trunks', 'calls', 'sims'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Row {
  path: string;
  ok: boolean;
  ms: number;
  note: string;
}

async function main(): Promise<number> {
  const base = arg('--base') ?? 'http://127.0.0.1:8080';
  const pages = process.argv.includes('--pages');
  const wsSeconds = Number(arg('--ws-seconds') ?? '8');
  const tc = createClient({ baseUrl: base, timeoutMs: 60_000 });

  try {
    await createClient({ baseUrl: base, timeoutMs: 30_000 }).get('/api/status');
  } catch (e) {
    console.log(`server not reachable at ${base} (${e instanceof Error ? e.message : String(e)})`);
    return 0;
  }
  console.log(`server reachable at ${base}`);

  const rows: Row[] = [];
  const run = async (path: GetPath, label: string, call: () => Promise<unknown>) => {
    const t0 = performance.now();
    try {
      const v = await call();
      const c = GET_META[path].check;
      const problems = c ? checkShape(v, c) : [];
      const size = typeof v === 'string' ? `${v.length} chars` : Array.isArray(v) ? `${v.length} items` : 'object';
      rows.push({ path: label, ok: problems.length === 0, ms: performance.now() - t0, note: problems.length ? problems.join('; ') : size });
    } catch (e) {
      const note = e instanceof TcHttpError ? `HTTP ${e.status} ${e.error ?? ''}` : e instanceof Error ? e.message : String(e);
      rows.push({ path: label, ok: false, ms: performance.now() - t0, note });
    }
  };

  for (const p of Object.keys(GET_META) as GetPath[]) {
    if (p.includes(':')) continue;
    const isPage = GET_META[p].response.includes('text/html');
    if (isPage && !pages) continue;
    await run(p, p, () => tc.get(p as Exclude<GetPath, '/api/device/:id' | '/api/analyze/:id' | '/api/capture/:id' | '/api/taps/:frame' | '/api/voices/:frame' | '/voices/:file'>));
  }

  // Parameterised routes, with ids taken from the live server.
  const ads = await tc.get('/api/advertisements').catch(() => []);
  const frameId = ads[0]?.id;
  if (frameId) await run('/api/device/:id', `/api/device/${frameId}`, () => tc.get('/api/device/:id', { params: { id: frameId } }));
  if (frameId) await run('/api/taps/:frame', `/api/taps/${frameId}`, () => tc.get('/api/taps/:frame', { params: { frame: frameId } }));
  // A frame that has spoken, for its voice and its WAV.
  const voices = await tc.get('/api/voices').catch(() => null);
  const spoke = voices?.latest[0];
  if (spoke) {
    await run('/api/voices/:frame', `/api/voices/${spoke.frame}`, () => tc.get('/api/voices/:frame', { params: { frame: spoke.frame } }));
    const file = `${spoke.frame}-${spoke.kind}.wav`;
    await run('/voices/:file', `/voices/${file}`, async () => {
      const wav = await tc.get('/voices/:file', { params: { file } });
      if (String.fromCharCode(...wav.subarray(0, 4)) !== 'RIFF') throw new Error('not a WAV');
      return `${wav.length} bytes`;
    });
  }
  const caps = await tc.get('/api/captures').catch(() => null);
  const runs = await tc.get('/api/runs').catch(() => null);
  const capId = caps?.captures[0]?.id ?? runs?.previous[0]?.id;
  if (capId) {
    await run('/api/analyze/:id', `/api/analyze/${capId}`, () => tc.get('/api/analyze/:id', { params: { id: capId } }));
    await run('/api/capture/:id', `/api/capture/${capId}`, () => tc.get('/api/capture/:id', { params: { id: capId } }));
  }
  // Documented error shape: a 404 must be {"error": "..."}.
  await (async () => {
    const t0 = performance.now();
    try {
      await tc.get('/api/device/:id', { params: { id: 'no-such-frame-smoke' } });
      rows.push({ path: '/api/device/no-such-frame-smoke', ok: false, ms: performance.now() - t0, note: 'expected 404' });
    } catch (e) {
      const ok = e instanceof TcHttpError && e.status === 404 && e.error !== null;
      rows.push({ path: '/api/device/no-such-frame-smoke', ok, ms: performance.now() - t0, note: e instanceof TcHttpError ? `404 {error:${JSON.stringify(e.error)}}` : String(e) });
    }
  })();

  // The telemetry stream.
  const wsUrl = base.replace(/^http/, 'ws') + '/ws';
  const wsResult = await probeWs(wsUrl, wsSeconds * 1000);
  rows.push(...wsResult);

  const w = Math.max(...rows.map((r) => r.path.length));
  for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.path.padEnd(w)} ${r.ms.toFixed(0).padStart(6)} ms  ${r.note}`);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} matched`);
  return failed ? 1 : 0;
}

function probeWs(url: string, ms: number): Promise<Row[]> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const rows = new Map<string, Row>();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve([{ path: 'ws /ws', ok: false, ms: 0, note: String(e) }]);
      return;
    }
    const done = () => {
      clearTimeout(timer);
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      for (const t of ['status', 'globe-delta']) {
        if (!rows.has(t)) rows.set(t, { path: `ws ${t}`, ok: false, ms: performance.now() - t0, note: `no frame within ${ms} ms` });
      }
      resolve([...rows.values()]);
    };
    const timer = setTimeout(done, ms);
    ws.onclose = (ev) => {
      rows.set('close', { path: 'ws close', ok: false, ms: performance.now() - t0, note: `closed early, code ${ev.code}` });
      done();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      const m = parseTelemetry(ev.data);
      if (!m || rows.has(m.type)) return;
      const keys: readonly string[] = m.type === 'status' ? STATUS_KEYS : DELTA_KEYS;
      const problems = checkShape(m, { type: 'object', keys });
      rows.set(m.type, { path: `ws ${m.type}`, ok: problems.length === 0, ms: performance.now() - t0, note: problems.length ? problems.join('; ') : `${ev.data.length} bytes` });
      if (rows.has('status') && rows.has('globe-delta')) done();
    };
  });
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(2);
  },
);
