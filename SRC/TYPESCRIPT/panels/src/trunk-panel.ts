/**
 * trunk-panel.ts -- your computer as an intercom port (Node port of TRUNK-SIMULATOR/trunk_panel.py).
 *
 * Joins a matrix simulator on its UDP audio series, claims a port, and serves
 * the keypanel as a local web page (Node has no tkinter):
 *   * 8 TX keys (my microphone -> the matrix), 8 RX keys (the matrix -> my speakers)
 *   * every key can "break away" into its own small window (window.open)
 *   * counter of users on the matrix and users making calls; incoming calls light up
 *
 * Audio (--audio):
 *   browser  (default with UI) the page captures the mic with getUserMedia + an AudioWorklet at
 *            48 kHz and streams Float32 blocks over a WebSocket; this process does the exact .py DSP
 *            (decimate to 8 kHz, 20 ms int16 frames) and answers each block with a speaker block.
 *   tone     1 kHz test tone as the mic (scripted tests, no hardware)
 *   none     keys and status only (the .py without sounddevice)
 *
 *   node --experimental-strip-types src/trunk-panel.ts --matrix 127.0.0.1:22304
 *   node --experimental-strip-types src/trunk-panel.ts --matrix 127.0.0.1:22304 --port 5 --name "Andrew's PC"
 *   node --experimental-strip-types src/trunk-panel.ts --test-seconds 4 --auto-talk 3 --audio tone
 */
import { createServer } from "node:http";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { AudioEngine, NullAudioDevice, ToneAudioDevice, type AudioDevice } from "./audio.ts";
import { MatrixLink, type LinkEvent } from "./matrix-link.ts";
import { PanelModel, parseChoice } from "./trunk-panel-core.ts";
import { SAMPLE_RATE } from "./tc-protocol.ts";

export type AudioMode = "browser" | "tone" | "none";

export interface TrunkPanelArgs {
  matrix: string;
  port: number;
  name: string;
  rate: number;
  audio: AudioMode;
  listDevices: boolean;
  testSeconds: number;
  autoTalk: number;
  uiPort: number;
  ui: boolean;
}

export function parseTrunkPanelArgs(argv: string[]): TrunkPanelArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      matrix: { type: "string", default: "127.0.0.1:20256" },
      port: { type: "string", default: "0" },
      name: { type: "string", default: hostname() },
      rate: { type: "string", default: "48000" },
      audio: { type: "string" },
      "input-device": { type: "string" },
      "output-device": { type: "string" },
      "list-devices": { type: "boolean", default: false },
      "test-seconds": { type: "string", default: "0" },
      "auto-talk": { type: "string", default: "0" },
      "ui-port": { type: "string", default: "0" },
      "no-ui": { type: "boolean", default: false },
    },
  });
  const rate = Number.parseInt(values.rate, 10);
  if (!Number.isInteger(rate) || rate <= 0 || rate % SAMPLE_RATE) throw new Error(`--rate must be a multiple of ${SAMPLE_RATE}`);
  const testSeconds = Number(values["test-seconds"]);
  const ui = !values["no-ui"] && !testSeconds;
  const audio = values.audio ?? (ui ? "browser" : "none");
  if (audio !== "browser" && audio !== "tone" && audio !== "none") throw new Error("--audio must be browser, tone or none");
  if (values["input-device"] || values["output-device"])
    console.warn("--input-device/--output-device: pick devices in the browser page (Node has no PortAudio)");
  return {
    matrix: values.matrix,
    port: Number.parseInt(values.port, 10) || 0,
    name: values.name,
    rate,
    audio,
    listDevices: values["list-devices"],
    testSeconds,
    autoTalk: Number.parseInt(values["auto-talk"], 10) || 0,
    uiPort: Number(values["ui-port"]),
    ui,
  };
}

/** "host:port" -> [host, port]; py rpartition(":") with the same defaults. */
export function splitMatrix(addr: string): [string, number] {
  const i = addr.lastIndexOf(":");
  const host = i < 0 ? "" : addr.slice(0, i);
  const port = i < 0 ? addr : addr.slice(i + 1);
  // py `int(port or 18100)`: 18100 predates the 20000 + 256*n series scheme; kept for fidelity (HANDOFF F5).
  return [host || "127.0.0.1", Number.parseInt(port, 10) || 18100];
}

// ---- browser audio device ------------------------------------------------------
/** The page that owns audio sends mic blocks; each is answered with one speaker block. */
export class BrowserAudioDevice implements AudioDevice {
  readonly name = "browser";
  private engine: AudioEngine | undefined;
  private owner: WebSocket | undefined;
  start(engine: AudioEngine): boolean {
    this.engine = engine;
    engine.error = "waiting for the browser: click 'start audio' in the panel page";
    return true;
  }
  stop(): void {
    this.owner = undefined;
  }
  attach(ws: WebSocket, rate: number): void {
    const e = this.engine;
    if (!e) return;
    if (rate !== e.rate) {
      e.error = `browser audio runs at ${rate} Hz, panel expects ${e.rate} Hz (use --rate ${rate - (rate % SAMPLE_RATE) || SAMPLE_RATE}?)`;
      return;
    }
    this.owner = ws;
    e.error = null;
  }
  detach(ws: WebSocket): void {
    if (this.owner === ws && this.engine) {
      this.owner = undefined;
      this.engine.error = "browser audio closed";
    }
  }
  onBlock(ws: WebSocket, data: Buffer): void {
    const e = this.engine;
    if (!e || ws !== this.owner || data.length % 4) return;
    const block = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    e.onInput(block);
    const out = e.onOutput(block.length);
    ws.send(Buffer.from(out.buffer, out.byteOffset, out.byteLength), { binary: true });
  }
}

// ---- the page ------------------------------------------------------------------
const WORKLET = `class TC extends AudioWorkletProcessor{constructor(o){super();this.n=o.processorOptions.block;this.buf=new Float32Array(this.n);this.f=0;this.q=[];this.cur=null;this.ci=0;
this.port.onmessage=e=>{this.q.push(e.data);if(this.q.length>6)this.q.shift();};}
process(ins,outs){const i=ins[0]&&ins[0][0],o=outs[0][0];if(i){for(let k=0;k<i.length;k++){this.buf[this.f++]=i[k];if(this.f===this.n){this.port.postMessage(this.buf.slice());this.f=0;}}}
for(let k=0;k<o.length;k++){if(!this.cur||this.ci>=this.cur.length){this.cur=this.q.shift()||null;this.ci=0;}o[k]=this.cur?this.cur[this.ci++]:0;}return true;}}
registerProcessor('tc',TC);`;

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TRUNK-SIMULATOR · My Computer as a matrix port</title>
<style>body{margin:0;font:13px "Segoe UI",system-ui,sans-serif;background:#f3f3f3;color:#111;display:flex;flex-direction:column;min-height:100vh}
header,.dev,footer{display:flex;gap:10px;align-items:center;padding:8px 12px;flex-wrap:wrap}header b{font-size:16px}#tz,#al,#st{color:#666}
.row{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:6px;padding:0 12px}h4{margin:10px 12px 4px}
.key{display:flex;flex-direction:column;gap:3px}.key button.k{min-height:64px;white-space:pre-line;font-weight:700;border:2px outset #ccc;border-radius:4px}
.key button.k.sunk{border-style:inset}.big button.k{min-height:150px;font-size:20px}footer{margin-top:auto}#inc{color:#a60}
#cnt{margin-left:auto;background:#1c1c22;color:#f3f3f3;font:700 15px "Segoe UI";padding:6px 12px;white-space:pre;text-align:right}progress{width:140px}</style>
<header><b id="hdr"></b><span id="tz" style="margin-left:auto"></span></header>
<div class="dev">mic <progress id="mm" max="1"></progress><label><input type="checkbox" id="mute"> mute mic</label>
speaker <progress id="sm" max="1"></progress><button id="go">start audio</button><span id="al"></span></div>
<div id="body"><h4>TX (my microphone → matrix)</h4><div class="row" id="tx"></div><h4>RX (matrix → my speakers)</h4><div class="row" id="rx"></div></div>
<footer><span id="inc"></span><span id="st"></span><span id="cnt"></span></footer>
<script>
const only=new URLSearchParams(location.search).get('key');const $=id=>document.getElementById(id);
const ws=new WebSocket('ws://'+location.host+'/ws');ws.binaryType='arraybuffer';let node=null;
const tell=o=>ws.send(JSON.stringify(o));
if(only!==null){$('body').className='big';document.querySelector('.dev').style.display='none';document.querySelectorAll('h4,footer,header').forEach(e=>e.style.display='none');}
$('mute').onchange=e=>tell({t:'mute',on:e.target.checked});
$('go').onclick=async()=>{const ctx=new AudioContext({sampleRate:${"${RATE}"}});
 await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([${JSON.stringify(WORKLET)}],{type:'text/javascript'})));
 const mic=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true}});
 node=new AudioWorkletNode(ctx,'tc',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],processorOptions:{block:${"${BLOCK}"}}});
 ctx.createMediaStreamSource(mic).connect(node);node.connect(ctx.destination);
 node.port.onmessage=e=>{if(ws.readyState===1)ws.send(e.data.buffer);};tell({t:'audio',rate:ctx.sampleRate});$('go').disabled=true;};
ws.onmessage=m=>{if(typeof m.data!=='string'){if(node)node.port.postMessage(new Float32Array(m.data));return;}
 const v=JSON.parse(m.data);$('hdr').textContent=v.hdr;$('tz').textContent=v.tz;$('st').textContent=v.status;$('inc').textContent=v.incoming;
 $('cnt').textContent=v.counter;$('mm').value=v.micMeter;$('sm').value=v.spkMeter;$('al').textContent=v.audio;
 for(const k of v.keys){if(only!==null&&String(k.index)!==only)continue;const host=$(k.kind==='talk'?'tx':'rx');let el=$('k'+k.index);
  if(!el){el=document.createElement('div');el.className='key';el.id='k'+k.index;el.innerHTML='<select></select><button class="k"></button>'+(only===null?'<button class="b">⇱ break away</button>':'');
   host.appendChild(el);el.querySelector('select').onchange=e=>tell({t:'target',i:k.index,choice:e.target.value});
   el.querySelector('.k').onclick=()=>tell({t:'toggle',i:k.index});
   const b=el.querySelector('.b');if(b)b.onclick=()=>window.open('?key='+k.index,'key'+k.index,'width=260,height=260');}
  const s=el.querySelector('select');const opts=['--',...k.choices].join('\\n');if(s.dataset.o!==opts){s.dataset.o=opts;s.innerHTML='';for(const c of ['--',...k.choices]){const o=document.createElement('option');o.textContent=c;s.appendChild(o);}}
  if(document.activeElement!==s)s.value=k.selected;const btn=el.querySelector('.k');btn.textContent=k.text;btn.style.background=k.bg;btn.style.color=k.fg;btn.classList.toggle('sunk',k.sunken);
  if(only!==null)document.title=k.text.split('\\n').slice(0,2).join('  ');}};
</script>`;

export interface ClientMsg {
  t: "toggle" | "target" | "mute" | "audio";
  i?: number;
  choice?: string;
  on?: boolean;
  rate?: number;
}

function parseClientMsg(raw: string): ClientMsg | undefined {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return undefined;
    const t = (v as { t?: unknown }).t;
    return t === "toggle" || t === "target" || t === "mute" || t === "audio" ? (v as ClientMsg) : undefined;
  } catch {
    return undefined;
  }
}

export function serveUi(panel: PanelModel, device: AudioDevice, port: number): Promise<{ url: string; close(): void }> {
  const page = PAGE.replace("${RATE}", String(panel.audio.rate)).replace("${BLOCK}", String(panel.audio.block));
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/") res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  const push = (): void => {
    const v = JSON.stringify(panel.view());
    for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(v);
  };
  const timer = setInterval(push, 100); // py Panel.poll() repaint cadence
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify(panel.view()));
    ws.on("message", (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (isBinary) {
        if (device instanceof BrowserAudioDevice) device.onBlock(ws, buf);
        return;
      }
      const m = parseClientMsg(buf.toString("utf-8"));
      if (!m) return;
      const key = m.i !== undefined ? panel.keys[m.i] : undefined;
      if (m.t === "toggle" && key) key.toggle();
      else if (m.t === "target" && key && typeof m.choice === "string") key.setTarget(parseChoice(m.choice));
      else if (m.t === "mute") panel.setMuted(m.on === true);
      else if (m.t === "audio" && typeof m.rate === "number" && device instanceof BrowserAudioDevice) device.attach(ws, m.rate);
      push();
    });
    ws.on("close", () => {
      if (device instanceof BrowserAudioDevice) device.detach(ws);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const a = server.address();
      resolve({
        url: `http://127.0.0.1:${typeof a === "object" && a ? a.port : port}/`,
        close: () => {
          clearInterval(timer);
          for (const c of wss.clients) c.terminate();
          wss.close();
          server.close();
        },
      });
    });
  });
}

// ---- main ----------------------------------------------------------------------
export async function main(argv: string[]): Promise<number> {
  const args = parseTrunkPanelArgs(argv);
  if (args.listDevices) {
    console.log("Node has no PortAudio: audio devices are chosen in the browser page (--audio browser).");
    return 0;
  }
  const [host, udp] = splitMatrix(args.matrix);
  let panel: PanelModel | undefined;
  const link = new MatrixLink(host, udp, args.port, args.name, (e: LinkEvent) => panel?.onLinkEvent(e));
  const engine = new AudioEngine(link, args.rate);
  panel = new PanelModel(link, engine, args.name, args.matrix);
  const device: AudioDevice =
    args.audio === "tone" ? new ToneAudioDevice() : args.audio === "browser" ? new BrowserAudioDevice() : new NullAudioDevice();
  await link.start();
  if (!device.start(engine)) panel.status(engine.error ?? "no audio");
  const ui = args.ui ? await serveUi(panel, device, args.uiPort) : undefined;
  if (ui) console.log(`TRUNK-SIMULATOR soft panel -> ${args.matrix}\nopen ${ui.url}`);
  const p = panel;
  const close = async (): Promise<void> => {
    device.stop();
    await p.close();
    ui?.close();
  };
  if (args.testSeconds) {
    if (args.autoTalk) {
      const latch = (): void => {
        const k = p.keys[0];
        if (link.connected && k) {
          k.setTarget(args.autoTalk);
          k.toggle();
        } else setTimeout(latch, 200);
      };
      setTimeout(latch, 300);
    }
    await new Promise((r) => setTimeout(r, args.testSeconds * 1000));
    console.log(`test: connected=${link.connected ? "True" : "False"} port=${link.myPort} alpha=${link.alpha} tx_frames=${link.txFrames} rx_frames=${link.rxCount} audio=${engine.error ?? `ok ${engine.rate} Hz`}`);
    console.log(`test: state=${JSON.stringify(p.state).slice(0, 400)}`);
    await close();
    return 0;
  }
  await new Promise<void>((resolve) => process.once("SIGINT", () => void close().then(resolve)));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  });
}
