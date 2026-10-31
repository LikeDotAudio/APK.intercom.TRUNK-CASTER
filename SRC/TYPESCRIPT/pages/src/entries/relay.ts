// Relay page (html.rs relay_page): port of RELAY_JS — the local sound card
// relay. The browser enumerates this computer's audio devices, meters every
// input live (Web Audio), binds devices to relay ports, offers mic+speaker
// pairs, and reports peaks over the threshold as events.
//
// Server values (window.RELAY_THRESHOLD / RELAY_MATRICES / RELAY_BOUND) are
// read from JSON data islands first, the legacy globals second.

import { ISLANDS, island } from '../lib/island.ts';
import type { RelayBinding, RelayMatrixLite } from '../wire.ts';

interface Meter {
  an: AnalyserNode;
  buf: Float32Array;
  peakHold: number;
  over: boolean;
  lastOver: number;
  row: HTMLElement | null;
  label: string;
}

interface Pair {
  mic: MediaDeviceInfo | undefined;
  spk: MediaDeviceInfo | undefined;
}

interface Slot {
  matrix: string;
  label: string;
  mic: number;
  spk: number;
}

(function () {
  if (!LIVE) return;
  // LATENT (preserved): `list` (and each meter's `row`, and the Start
  // button's listener) are bound once. The Relay page refreshes <main> every
  // 4 s without re-running this script: after the first refresh the Start
  // button is a fresh element with no listener, and once started the meters
  // paint detached rows while the visible table says "press Start".
  // Fix: mark #devices, #pair-offer and #relay-start `data-keep` — HANDOFF.md.
  const list = document.getElementById('devices');
  if (!list) return;
  // The original read these as plain globals, undefined if missing; the same
  // holds here (the `!` keeps their declared types, as the JS assumed).
  const THRESH = island<number>(ISLANDS.relayThreshold, window.RELAY_THRESHOLD)!;
  const MATRICES = island<RelayMatrixLite[]>(ISLANDS.relayMatrices, window.RELAY_MATRICES)!;
  const BOUND = island<Record<string, RelayBinding>>(ISLANDS.relayBound, window.RELAY_BOUND)!;
  const meters: Record<string, Meter> = {};
  let ctx: AudioContext;
  const dbfs = (v: number): number => (v <= 0 ? -90 : Math.max(-90, 20 * Math.log10(v)));

  // RELAY_JS shadows the core esc() with its own (no null handling). Every
  // call site passes a string, so the two agree; kept local for fidelity.
  const relayEsc = (s: unknown): string =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c as '&' | '<' | '>' | '"']);
  const cssId = (s: string): string => s.replace(/[^a-zA-Z0-9]/g, '_');

  function row(d: MediaDeviceInfo): string {
    // LATENT (preserved): an empty device label (no permission yet) matches
    // any binding whose device_label is also empty.
    const bound = Object.entries(BOUND).find(([, b]) => b.device_id === d.deviceId || b.device_label === d.label);
    // LATENT (preserved): m.id and m.label are not escaped into the <option>.
    const sel = MATRICES.map((m) =>
      Array.from(
        { length: m.io },
        (_, i) => `<option value="${m.id}:${i}" ${bound && bound[0] === m.id + ':' + i ? 'selected' : ''}>${m.label} U${String(i).padStart(2, '0')}</option>`,
      ).join(''),
    ).join('');
    return `<tr id="dev-${cssId(d.deviceId)}"><td>${d.kind === 'audioinput' ? '🎙️ in' : '🔈 out'}</td><td><b>${relayEsc(d.label || d.deviceId.slice(0, 8))}</b></td>
      <td class="vu"><div class="vubar"><i class="rms"></i><i class="peak"></i><span class="hold"></span></div><div class="vunum"><span class="db">—</span></div></td>
      <td><select class="bind"><option value="">— not bound —</option>${sel}</select></td><td class="muted ev"></td></tr>`;
  }

  async function start(): Promise<void> {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      document.getElementById('relay-note')!.textContent = 'Microphone permission is needed to meter the local devices: ' + (e as Error).message;
    }
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput');
    list!.innerHTML = devs.map(row).join('') || '<tr><td colspan=5 class="muted">no audio devices found</td></tr>';
    devs.forEach((d) => {
      void api('/api/relay/event', { kind: 'device', device_label: d.label || d.deviceId.slice(0, 8), note: d.kind });
    });
    document.querySelectorAll<HTMLSelectElement>('select.bind').forEach((s, i) => {
      s.addEventListener('change', () => {
        const d = devs[i]!;
        const v = s.value;
        if (!v) {
          const b = Object.entries(BOUND).find(([, b]) => b.device_id === d.deviceId);
          if (b) {
            const [m, p] = b[0].split(':');
            void api('/api/relay/unbind', { matrix: m, port: Number(p) }).then(() => reload());
          }
          return;
        }
        const [m, p] = v.split(':');
        void api('/api/relay/bind', {
          matrix: m,
          port: Number(p),
          device_id: d.deviceId,
          device_label: d.label || d.deviceId.slice(0, 8),
          kind: d.kind === 'audioinput' ? 'input' : 'output',
        }).then(() => reload());
      });
    });
    // Offer to connect microphone + speaker pairs: the first pair lands on
    // the 2x2 that carries your user name, the rest overflow onto the 8x8s.
    const mics = devs.filter((d) => d.kind === 'audioinput' && !/communications|default/i.test(d.deviceId)),
      outs = devs.filter((d) => d.kind === 'audiooutput' && !/communications|default/i.test(d.deviceId));
    const pairs: Pair[] = [];
    for (let i = 0; i < Math.max(mics.length, outs.length); i++) pairs.push({ mic: mics[i] || mics[0], spk: outs[i] || outs[0] });
    const order = MATRICES.slice().sort((a, b) => (a.io === 2 ? -1 : 0) - (b.io === 2 ? -1 : 0)); // the 2x2 first
    const slots: Slot[] = [];
    for (const m of order) for (let p = 0; p + 1 < m.io; p += 2) slots.push({ matrix: m.id, label: m.label, mic: p, spk: p + 1 });
    const offer = document.getElementById('pair-offer');
    if (offer && pairs.length) {
      offer.innerHTML =
        '<h3>Connect your microphone and speakers</h3><p class="note">' + pairs.length + ' pair' + (pairs.length > 1 ? 's' : '') +
        ' found. Each pair takes two ports: microphone in, speakers out.' + (pairs.length > 1 ? ' Connect them all at once or one by one.' : '') + '</p>' +
        pairs
          .map((p, i) => {
            const s = slots[i];
            return (
              '<div class="row" style="margin:4px 0"><span>🎙️ ' + relayEsc(p.mic ? p.mic.label : '—') + ' + 🔈 ' + relayEsc(p.spk ? p.spk.label : '—') + ' → <b>' +
              relayEsc(s ? s.label + ' U' + String(s.mic).padStart(2, '0') + '/U' + String(s.spk).padStart(2, '0') : 'no free pair') +
              '</b></span> <button class="small" data-pair="' + i + '" ' + (s ? '' : 'disabled') + '>Connect</button></div>'
            );
          })
          .join('') +
        (pairs.length > 1 ? '<button id="pair-all" style="margin-top:6px">Connect all ' + Math.min(pairs.length, slots.length) + ' pairs</button>' : '');
      const bind = async (i: number): Promise<void> => {
        const p = pairs[i],
          s = slots[i];
        if (!p || !s) return;
        if (p.mic) await api('/api/relay/bind', { matrix: s.matrix, port: s.mic, device_id: p.mic.deviceId, device_label: p.mic.label || 'microphone', kind: 'input' });
        if (p.spk) await api('/api/relay/bind', { matrix: s.matrix, port: s.spk, device_id: p.spk.deviceId, device_label: p.spk.label || 'speakers', kind: 'output' });
      };
      offer.querySelectorAll<HTMLButtonElement>('button[data-pair]').forEach((b) =>
        b.addEventListener('click', async () => {
          await bind(Number(b.dataset.pair));
          reload();
        }),
      );
      const all = document.getElementById('pair-all');
      if (all)
        all.addEventListener('click', async () => {
          for (let i = 0; i < Math.min(pairs.length, slots.length); i++) await bind(i);
          reload();
        });
    }
    const AC = (window.AudioContext || window.webkitAudioContext)!;
    ctx = new AC();
    for (const d of devs.filter((d) => d.kind === 'audioinput')) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: d.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        src.connect(an);
        meters[d.deviceId] = {
          an,
          buf: new Float32Array(an.fftSize),
          peakHold: -90,
          over: false,
          lastOver: 0,
          row: document.getElementById('dev-' + cssId(d.deviceId)),
          label: d.label || d.deviceId.slice(0, 8),
        };
      } catch (e) {
        const r = document.getElementById('dev-' + cssId(d.deviceId));
        if (r) r.querySelector('.ev')!.textContent = 'cannot open: ' + (e as Error).message;
      }
    }
    tick();
  }

  function tick(): void {
    for (const id in meters) {
      const m = meters[id]!;
      m.an.getFloatTimeDomainData(m.buf);
      let sum = 0,
        pk = 0;
      for (let i = 0; i < m.buf.length; i++) {
        const v = Math.abs(m.buf[i]!);
        sum += v * v;
        if (v > pk) pk = v;
      }
      const rms = dbfs(Math.sqrt(sum / m.buf.length)),
        peak = dbfs(pk);
      m.peakHold = Math.max(peak, m.peakHold - 0.4);
      const pct = (db: number): number => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
      const r = m.row;
      if (r) {
        r.querySelector<HTMLElement>('.rms')!.style.width = pct(rms) + '%';
        r.querySelector<HTMLElement>('.peak')!.style.width = pct(peak) + '%';
        r.querySelector<HTMLElement>('.hold')!.style.left = pct(m.peakHold) + '%';
        r.querySelector('.db')!.textContent = (peak > -89 ? peak.toFixed(1) : '-∞') + ' dBFS';
        r.querySelector('.vubar')!.classList.toggle('hot', peak > THRESH);
      }
      const now = Date.now();
      if (peak > THRESH && !m.over && now - m.lastOver > 2000) {
        m.over = true;
        m.lastOver = now;
        const b = Object.entries(BOUND).find(([, b]) => b.device_id === id);
        const [mx, pt]: (string | null | undefined)[] = b ? b[0].split(':') : [null, null];
        void api('/api/relay/event', {
          kind: 'over',
          device_label: m.label,
          matrix: mx,
          port: pt !== null ? Number(pt) : null,
          peak_dbfs: Math.round(peak * 10) / 10,
          threshold_dbfs: THRESH,
        });
        if (r) r.querySelector('.ev')!.textContent = 'over ' + THRESH + ' dBFS at ' + new Date().toLocaleTimeString();
      }
      if (peak < THRESH - 3) m.over = false;
    }
    requestAnimationFrame(tick);
  }

  document.getElementById('relay-start')!.addEventListener('click', () => void start());
})();
