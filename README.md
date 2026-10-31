# INTERCOM.Caster — Trunk-Caster on APK.audio

**Retired as a runtime (ROAD-3453).** Trunk-Caster now runs on the APK.audio plugin SDK:
`PLUGIN.TRUNK_CASTER` (the caster), `PLUGIN.TRUNK_SIM` (every protocol's frame simulator) and the
Intercom soft apps (`PODS/POD.THIN/Softapps/HARDWARE_AND_NETWORK/INTERCOM.TRUNK-CASTER`), all on the
`trunk` contract (`contracts/TRUNK.md`). What stays here is what is still read: the protocol manuals,
Trunk-Caster's own documentation, and the Python matrix simulator with its Stream Deck emulator.
Where each piece of the imported source went is in
[ARCHITECTURE](Documentation/%F0%9F%A7%A9Manual%20and%20Artifacts/ARCHITECTURE.md).

Trunk-Caster is an intercom trunking system. It reads the manuals for its intercom protocols,
advertises virtual frames (56 user ports plus 8 casters per frame), trunks them together 8 channels
at a time, and routes any port to any other over the trunks. Every switch on every frame is spoken
as one Ward-Beck crosspoint line:

```text
SITE,FRAME,INPUT,INPUT_NAME,CLOSE/OPEN,OUTPUT_NAME,OUTPUT,FRAME,SITE
```

**Wiki:** [Documentation/README.md](Documentation/README.md) — principles, architecture, delivery.

| | |
|---|---|
| **Recipe** | none — nothing here is a container. The caster and the simulators are `PODS/POD.THICK/PLUGINS/PLUGIN.TRUNK_CASTER` and `PLUGIN.TRUNK_SIM`, started with the Discovery Engine's plugins under the profile `intercom` |
| **Source** | `SRC/KNOWN PROTOCOLS/` (the manuals, and the vendor simulators some of them carry), `SRC/TRUNK-CASTER-SDK/README.md` + `plans/` (Trunk-Caster's vocabulary and plans), `SRC/TRUNK-SIMULATOR/` (the Python matrix simulator: `trunk_panel.py`, `tc_protocol.py`, `tc_map.py`, `launch_all.py`), `SRC/PANELS/` (the panel model, `connect.json` and `streamdeck_emulator.py`, which speak to that Python simulator) |
| **Repository** | https://github.com/LikeDotAudio/APK.intercom.TRUNK-CASTER (public), a submodule at `PODS/POD.THICK/INTERCOM.Caster` |
| **Related** | `PLUGIN.TRUNK_CASTER` (its `data/seed/` carries the caster's copy of the manuals and starting configuration), `PLUGIN.TRUNK_SIM`, the soft app `INTERCOM.TRUNK-CASTER` (35 Intercom windows; the Stream Deck definitions and the land outline are its own `data/`), the SDK wiki page `DISCOVERY.Engine/SDK/Documentation/🧩Manual and Artifacts/TRUNK-CASTER.md` |

## Run the Python matrix simulator (outside APK.audio)

```sh
cd SRC/TRUNK-SIMULATOR
python3 launch_all.py          # the matrices; PANELS/streamdeck_emulator.py presses their keys
```

---

*© 2026 — Written & Maintained by Anthony P. Kuzub. MIT Licence.*

<!-- wiki:smoke -->
**Smoke test** — ✅ PASS 1/1 since 2026-10-31 13:12 EDT — [results](Documentation/%F0%9F%A7%A9Manual%20and%20Artifacts/SMOKE.md)
<!-- /wiki:smoke -->
