# PANELS

Button panels for Trunk-Caster: Stream Deck and the things like it (Loupedeck,
Razer Stream Controller, X-keys, a phone running Bitfocus Companion, a browser
page). A panel is a grid of buttons; every button is a key on a port of a matrix.

| file | what it is |
|------|------------|
| `panel.schema.json` | JSON Schema for a panel definition |
| `streamdeck-mini.json`, `streamdeck-mk2.json`, `streamdeck-xl.json`, `streamdeck-plus.json` | ready-made panel definitions for the Stream Deck models |
| `connect.json` | the endpoints a Stream Deck (or Companion, or anything with HTTP) uses to reach the buttons |
| `streamdeck_emulator.py` | a window that looks like a Stream Deck, loads a panel definition and presses the real keys over HTTP |

## The model

```
panel  = { device, matrix, port, buttons[] }
button = { row, col, label, action, target, color, ... }
```

- **matrix**: which intercom the panel belongs to, by alpha (LOND, PARI, WASH ...).
- **port**: which port on that matrix *is* this panel. `0` means claim the next
  free keypanel port when the panel connects.
- **action** per button:
  - `talk`      press-and-hold or latch talk to `target`
  - `listen`    monitor `target` (an IFB, a party line, a wireless receiver)
  - `call`      trunk call to another intercom: `target` is `ICOM:port`, e.g. `PARI:5`
  - `hangup`    release this port's trunk call
  - `reply`     talk back to whoever is calling this port right now
  - `page`      switch the panel to another page of buttons
  - `none`      blank spacer
- **mode**: `momentary` (down = on, up = off) or `latch` (toggle).
- **colors**: `idle`, `active`, `incoming` so the key can light up when the
  target is calling you.

## How a Stream Deck connects

Every matrix simulator serves a small HTTP API next to its map. A Stream Deck
cannot speak it natively, so one of these sits in between:

1. **Bitfocus Companion** (free, most common). Add a *Generic HTTP* connection
   pointing at the API host. Each button runs an HTTP GET on press and another
   on release. `connect.json` lists the exact URLs, so you can paste them.
2. **The Stream Deck app's own "Website" / "Open" action** can hit a GET URL on
   press only. Fine for latch buttons.
3. **`streamdeck_emulator.py`** does the same thing from a window on screen, so
   you can design and test panels with no hardware.

The API is plain GET or POST, no auth, meant for a lab network:

```
GET /api/help
GET /api/matrices
GET /api/ports?matrix=LOND
GET /api/claim?matrix=LOND&port=0&name=StreamDeck%20XL
GET /api/key?matrix=LOND&port=7&kind=talk&target=25&state=1     press
GET /api/key?matrix=LOND&port=7&kind=talk&target=25&state=0     release
GET /api/key?matrix=LOND&port=7&kind=listen&target=63&state=1
GET /api/call?matrix=LOND&port=7&icom=PARI&remote=5
GET /api/hangup?matrix=LOND&port=7
GET /api/port?matrix=LOND&port=7            who is calling me, what I am talking to
```

Feedback (lighting a key when someone calls) comes from polling `/api/port`
every second or so; the emulator does this, and Companion can with its
*HTTP feedback* / variables.

## Try it

```
python "..\KNOWN PROTOCOLS\VENDOR\RTS\SIMULATOR\rts_intercom_sim.py"                        (56 capitals, map and API on :8080)
python streamdeck_emulator.py streamdeck-xl.json --api http://127.0.0.1:8180 --matrix LOND
```
