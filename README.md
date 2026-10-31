# INTERCOM.Caster — Trunk-Caster on APK.audio

**Being rewritten.** `SRC/` holds the Trunk-Caster source **verbatim**, as imported on 2026-10-31.
It is the reference the rewrite reads, not the thing that runs. Nothing here is built or started by
APK.audio yet: there is no `Docker/` stack and no service in any pod.

Trunk-Caster is an intercom trunking system. It reads the manuals for 28 intercom protocols,
advertises virtual frames (56 user ports plus 8 casters per frame), trunks them together 8 channels
at a time, and routes any port to any other over the trunks. Every switch on every frame is spoken
as one Ward-Beck crosspoint line:

```text
SITE,FRAME,INPUT,INPUT_NAME,CLOSE/OPEN,OUTPUT_NAME,OUTPUT,FRAME,SITE
```

The rewrite moves it onto the APK.audio plugin SDK (`LikeDotAudio/APK.plugin.SDK`,
`apk-plugin-runner` + `apkaudio-contracts`, tag `sdk-v0.9`). Its HTTP server, WebSocket server and
own MQTT client are replaced by the APK bus and the OS shell. Its 28 per-protocol frame simulators
become plugin-shaped agents, and its pages become soft apps. What exists today, module by module, is
mapped in [ARCHITECTURE](Documentation/%F0%9F%A7%A9Manual%20and%20Artifacts/ARCHITECTURE.md).

**Wiki:** [Documentation/README.md](Documentation/README.md) — principles, architecture, delivery.

| | |
|---|---|
| **Recipe** | none yet — the source's own `SRC/Dockerfile` and `SRC/docker-compose.yml` are kept as reference and are **not** used by APK.audio (they claim 8080 and 1883, which are Storage-Portal's and Broker-Mosquitto's on the bench) |
| **Source** | `SRC/` — the Trunk-Caster tree: `RUST-RUNTIME/` (the caster, 13.5k lines of Rust), `TRUNK-SIMULATOR/frame-sim/` (one protocol's frames, 0.8k), `TRUNK-CASTER-SDK/` (its own SDK crate, 4.5k), `TYPESCRIPT/` (pages and panels being ported), `KNOWN PROTOCOLS/` (the manuals), `PANELS/`, the `TRUNK-*` data folders |
| **Repository** | https://github.com/LikeDotAudio/APK.intercom.TRUNK-CASTER (public), a submodule at `PODS/POD.THICK/INTERCOM.Caster` |
| **Related** | the soft app `PODS/POD.THIN/Softapps/HARDWARE_AND_NETWORK/INTERCOM.TRUNK-CASTER` (the globe snapshot, MicroCOM, the machines view) |

## Run the reference on its own (outside APK.audio)

```sh
cd SRC/RUST-RUNTIME
cargo test
cargo run -- serve --site HQ --port 7878     # http://127.0.0.1:7878 — keep it off 8080
```

---

*© 2026 — Written & Maintained by Anthony P. Kuzub. MIT Licence.*

<!-- wiki:smoke -->
**Smoke test** — ✅ PASS 1/1 since 2026-10-31 13:12 EDT — [results](Documentation/%F0%9F%A7%A9Manual%20and%20Artifacts/SMOKE.md)
<!-- /wiki:smoke -->
