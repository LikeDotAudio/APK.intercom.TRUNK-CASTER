/**
 * streamdeck-emulator.ts -- a Stream Deck on screen (Node port of PANELS/streamdeck_emulator.py).
 *
 * Node has no tkinter, so the "window" is a tiny page this process serves on
 * --ui-port (default 0 = any free port; the URL is printed). Mouse down / up on
 * a key POSTs to this process, which presses the real key on the matrix API
 * exactly like the Python version. Feedback is pushed to the page over SSE.
 *
 *   node --experimental-strip-types src/streamdeck-emulator.ts ../../PANELS/streamdeck-xl.json
 *   node --experimental-strip-types src/streamdeck-emulator.ts ../../PANELS/streamdeck-mk2.json --api http://127.0.0.1:8080 --matrix PARI --port 0
 *   ... --test-seconds 4 --auto-press 0,0      (headless scripted test, prints like the .py)
 *
 * No dependencies beyond Node 22+ (fetch, node:http, node:util parseArgs).
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EmulatorCore, type EmulatorEvent } from "./emulator-core.ts";
import { MatrixApi } from "./matrix-api.ts";
import { lintPanel, validatePanel, type Panel } from "./panel-schema.ts";

export interface EmulatorArgs {
  panel: string;
  api?: string | undefined;
  matrix?: string | undefined;
  port?: number | undefined;
  testSeconds: number;
  autoPress?: string | undefined;
  uiPort: number;
  ui: boolean;
}

const PANELS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "PANELS");

export function parseEmulatorArgs(argv: string[]): EmulatorArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      api: { type: "string" },
      matrix: { type: "string" },
      port: { type: "string" },
      "test-seconds": { type: "string", default: "0" },
      "auto-press": { type: "string" },
      "ui-port": { type: "string", default: "0" },
      "no-ui": { type: "boolean", default: false },
    },
  });
  const port = values.port !== undefined ? Number.parseInt(values.port, 10) : undefined;
  if (port !== undefined && Number.isNaN(port)) throw new Error("--port must be an integer");
  return {
    panel: positionals[0] ?? join(PANELS_DIR, "streamdeck-xl.json"),
    api: values.api,
    matrix: values.matrix,
    port,
    testSeconds: Number(values["test-seconds"]),
    autoPress: values["auto-press"],
    uiPort: Number(values["ui-port"]),
    ui: !values["no-ui"],
  };
}

export function loadPanel(path: string): Panel {
  const res = validatePanel(JSON.parse(readFileSync(path, "utf-8")));
  if (!res.ok) throw new Error(`${path} is not a valid panel:\n` + res.errors.map((e) => `  ${e.path || "/"}: ${e.message}`).join("\n"));
  for (const w of lintPanel(res.value)) console.warn(`warning ${path}${w.path}: ${w.message}`);
  return res.value;
}

// ---- the page -----------------------------------------------------------------
function snapshot(emu: EmulatorCore): string {
  return JSON.stringify({ title: emu.title, hdr: emu.hdr, foot: emu.foot, counter: emu.counter, cols: emu.cols, px: emu.px,
    faces: emu.faces(), encoders: (emu.panel.device.encoders ?? 0) ? (emu.panel.encoders ?? []).map((e) => e.label ?? e.action) : [] });
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stream Deck</title>
<style>body{margin:0;background:#111;color:#aaa;font:13px "Segoe UI",system-ui,sans-serif;padding:8px 10px}
#g{display:grid;gap:8px;margin:8px 0}#g button{border:0;border-radius:8px;font-weight:700;white-space:pre-line;cursor:pointer;user-select:none}
#f{color:#f0b429;font-weight:700}#c{color:#ddd;float:right}#e span{display:inline-block;width:110px;color:#888}</style>
<div id="h">connecting…</div><div id="g"></div><div><span id="c"></span><span id="f"></span></div><div id="e"></div>
<script>
const g=document.getElementById('g');let down=null;
function press(r,c,d){fetch('/press?row='+r+'&col='+c+'&down='+(d?1:0),{method:'POST'});}
addEventListener('mouseup',()=>{if(down){press(down[0],down[1],false);down=null;}});
new EventSource('/events').onmessage=m=>{const s=JSON.parse(m.data);document.title=s.title;
 h.textContent=s.hdr;f.textContent=s.foot;c.textContent=s.counter;
 g.style.gridTemplateColumns='repeat('+s.cols+','+s.px+'px)';g.innerHTML='';
 for(const k of s.faces){const b=document.createElement('button');b.textContent=k.label;b.style.cssText='width:'+s.px+'px;height:'+s.px+'px;background:'+k.bg+';color:'+k.fg+';font-size:'+(s.px<90?12:14)+'px';
  b.onmousedown=()=>{down=[k.row,k.col];press(k.row,k.col,true);};g.appendChild(b);}
 e.innerHTML=s.encoders.map(x=>'<span>◉ '+x.replace(/</g,'&lt;')+'</span>').join('');};
</script>`;

export function serveUi(emu: EmulatorCore, port: number): Promise<{ url: string; close(): void; push(): void }> {
  const clients = new Set<ServerResponse>();
  const push = (): void => {
    const data = `data: ${snapshot(emu)}\n\n`;
    for (const c of clients) c.write(data);
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      clients.add(res);
      res.write(`data: ${snapshot(emu)}\n\n`);
      req.on("close", () => clients.delete(res));
    } else if (u.pathname === "/press" && req.method === "POST") {
      const sent = emu.pressAt(Number(u.searchParams.get("row")), Number(u.searchParams.get("col")), u.searchParams.get("down") === "1");
      push(); // page switches and latches show at once
      void sent?.then(push);
      res.writeHead(204).end();
    } else if (u.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    } else res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const a = server.address();
      const p = typeof a === "object" && a ? a.port : port;
      resolve({
        url: `http://127.0.0.1:${p}/`,
        push,
        close: () => {
          for (const c of clients) c.end();
          server.close();
        },
      });
    });
  });
}

// ---- main ---------------------------------------------------------------------
export async function main(argv: string[]): Promise<number> {
  const args = parseEmulatorArgs(argv);
  const panel = loadPanel(args.panel);
  let ui: Awaited<ReturnType<typeof serveUi>> | undefined;
  const emu = new EmulatorCore(panel, {
    api: new MatrixApi(args.api || panel.api || "http://127.0.0.1:8180"),
    matrix: args.matrix,
    port: args.port,
    onEvent: (_e: EmulatorEvent) => ui?.push(),
  });
  if (args.ui && !args.testSeconds) {
    ui = await serveUi(emu, args.uiPort);
    console.log(`${emu.title}\nopen ${ui.url}`);
  }
  const running = emu.run();
  const shutdown = async (): Promise<void> => {
    await emu.close();
    ui?.close();
  };
  if (args.testSeconds) {
    if (args.autoPress) {
      const [r, c] = args.autoPress.split(",").map((x) => Number.parseInt(x, 10));
      const tryPress = (): void => {
        if (emu.alpha) void emu.pressAt(r ?? 0, c ?? 0, true); // held until the test ends
        else setTimeout(tryPress, 200);
      };
      setTimeout(tryPress, 300);
    }
    await new Promise((r) => setTimeout(r, args.testSeconds * 1000));
    console.log(`test: port=${emu.port} alpha=${emu.alpha} matrix=${emu.matrix} state=${JSON.stringify(emu.state).slice(0, 300)}`);
    console.log(`test: header=${emu.hdr}  foot=${emu.foot}`);
    await shutdown();
    return 0;
  }
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  await running;
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  });
}
