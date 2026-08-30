# dryer — food dehydrator control

Runs and monitors a food dehydrator (fruit, vegetables, mushrooms, herbs): presets per
product, humidity-driven exhaust and autostop, run history with charts, and control from
the shared web UI or MCP. The heater, fan control and safety cutoffs live in the node
itself (an ESP32 running ESPHome) — the Pi adds meaning, not physics.

## What it does

- **Presets** — product name, temperature, max duration, autostop on/off — grouped as
  fruit / vegetable / other, editable from the settings page.
- **Humidity excess** — the key number: how much wetter the chamber air is than merely
  heated room air would be. It falls toward zero as the food dries.
- **Autostop** — stops the run on its own once the excess has stayed below a threshold
  for long enough, so nobody has to guess when a batch is done.
- **Run history** — every run recorded with start/end, how it ended, restarts, and a full
  time series for the chart.
- **Notifications** — an event log (run finished, timed out, faulted, node lost/back) shown
  in the web UI; nothing external yet.
- **Works without the Pi** — see Caveats.

## How it works

```
┌─ ESP32 node ─────────┐        ┌───────────┐        ┌─ modules/dryer ──────┐
│ SHT41 × 2, NTC, SSR,  │──MQTT─▶│ mosquitto │◀──MQTT─│ NodeLink (mqtt/mock) │
│ fans, button, LED     │        │  on the Pi │        │ runs · autostop ·    │
│ (ESPHome, standalone) │◀───────┤            │───────▶│ store (SQLite)       │
└───────────────────────┘        └───────────┘        └──────────┬────────────┘
                                                                   │
                                                     /api/dryer, /ws/dryer, MCP
                                                                   │
                                                          web (/dryer/*) · agents
```

The node publishes every sensor and state every 10 s, retained where it matters
(`cfg/*`); the module (`node/mqtt.ts`) tracks freshness per value and turns the raw
topics into one `NodeSnapshot`. `node/mock.ts` is a drop-in stand-in with the same
`NodeLink` interface, used by `npm run dev` and by every test — no broker or hardware
needed to work on the module or the web UI.

## Configuration (`server/.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DRYER_ENABLED` | `true` | master switch |
| `DRYER_TRANSPORT` | `mqtt` | `mqtt` (real node) or `mock` (simulator); `npm run dev` forces `mock` |
| `DRYER_MQTT_URL` | `mqtt://127.0.0.1:1883` | broker address |
| `DRYER_MQTT_USER` | — | broker username |
| `DRYER_MQTT_PASS` | — | broker password |
| `DRYER_MQTT_PREFIX` | `dryer` | MQTT topic prefix |
| `DRYER_TICK_MS` | `10000` | module tick period (10 s in production) |

Own `DRYER_MQTT_*` keys rather than the inverter's shared `MQTT_URL`: that one is
already taken by the Home Assistant integration. Data lives in
`server/data/dryer/dryer.db` (SQLite via `node:sqlite`).

**Health**: `ok` only if the broker is connected *and* the node has been heard from
within `staleAfterSeconds`; otherwise `ok: false` with `{ broker, nodeOnline, lastSeen,
state }`.

## API (`/api/dryer`)

All responses are JSON; times are unix ms; `null` means "no data" and is never replaced
by zero.

| Method | Path | What | Who |
|---|---|---|---|
| GET | `/state` | full snapshot | any role |
| WS | `/ws/dryer` | same snapshot every tick, first frame immediately | any |
| GET | `/presets` | presets by group | any |
| POST | `/presets` | create a preset | admin |
| PUT | `/presets/:id` | edit a preset (partial) | admin |
| DELETE | `/presets/:id` | delete a preset | admin |
| POST | `/runs` | start: `{ presetId }` or `{ setpoint, maxMinutes, autostop? }` | admin + `write` scope |
| POST | `/runs/current/stop` | stop the run / clear a fault | admin + `write` |
| GET | `/runs?from&to` | run history | any |
| GET | `/runs/:id/samples` | one run's time series, for the chart | any |
| GET | `/settings` | global settings (autostop thresholds, exhaust curve) | any |
| PUT | `/settings` | update settings (partial) | admin |
| POST | `/events/:id/seen` | mark a notification read | any |

## MCP tools

Registered on the shared `/mcp` endpoint (`McpCapable`, like every other module). Read
tools are always visible; all three write tools appear only in a session that has both the
`admin` role and the `write` scope (`mcp/tools.ts` — one `canWrite` check for the lot).

| Tool | What it does | Rights |
|---|---|---|
| `dryer_get_state` | current snapshot: node state, chamber/room readings, excess, duty, running batch, unread events | read |
| `dryer_list_presets` | presets by group | read |
| `dryer_get_runs` | runs in a time range: when, preset, duration, how it ended, restarts | read |
| `dryer_get_run_chart` | one run's time series, thinned to ≤ 200 points | read |
| `dryer_start` | start by preset name, or explicit `{ setpoint, maxHours, autostop? }` | admin + write |
| `dryer_stop` | stop the run / clear a fault | admin + write |
| `dryer_upsert_preset` | create or update a preset | admin + write |

Resources: `dryer://state`, `dryer://runs/recent` (last 20). Prompt: `dryer-report`
("how did the last run go"). The server's `instructions` tell an agent to confirm with a
person before starting a run — it switches on a 220 V heater for hours — and never to
start while the node is in `fault` without finding out why first.

## Caveats

- **The node is autonomous.** Once a run is going, the ESP32 needs nothing from the Pi:
  it keeps the PID loop, the exhaust curve and the safety cutoffs running on its own and
  switches itself off at `max_minutes`. If the Pi is down or Wi-Fi drops, drying continues
  and the run record is not closed — the module marks it "node lost" only if the node
  stays unreachable past its own timeout plus a 15-minute grace period.
- **`cmd/run` (the START/STOP command) is not retained on the broker, on purpose.** A
  stale `START` left over from a dead Pi must not restart the heater the moment the node
  reboots. This means a reboot mid-run needs an explicit re-send, which is exactly what
  the module does (up to 3 restarts per run before giving up).
- **Autostop refuses to stop on a data gap.** It only fires when the humidity-excess
  series for the whole hold window is unbroken; any gap (a dropped MQTT message, a
  restart) postpones the decision rather than risking an early stop on a wet batch.
  Better to over-dry for half an hour than to stop while it's still wet.
- **A `fault` sticks until someone clears it** — a `STOP` command or the physical button —
  even after the underlying problem goes away. Nobody should be able to restart a
  dehydrator with an unresolved problem without noticing it first.
- **Exhaust yields to temperature.** While the heater is pinned at 100% and the chamber
  is still meaningfully below setpoint, the node throttles the exhaust fan down toward
  its minimum instead of venting away the heat it's trying to build up; it lets go once
  the chamber is close to setpoint again.
- **Cooldown is capped at 10 minutes**, unconditionally — including when the plate
  temperature can't be read (a common `fault:sensor` cause). Without that cap, a dead
  sensor would leave the fans running forever waiting for a reading that never comes.
- **The heater-fault rule is physical, not a fixed temperature.** It fires when the
  heater has been driven ≥ 60% for five minutes straight without the plate ever getting
  at least 5 °C hotter than the chamber — the signature of a dead SSR, a burnt-out mat or
  a detached thermistor, not of a normal steady state with a wet load.

## Structure

```
src/
  config.ts          env → DryerConfig
  node/link.ts        NodeLink — the boundary to the node (two implementations below)
  node/mqtt.ts        real node over MQTT (mqtt.js), freshness tracking per topic
  node/mock.ts        simulator: first-order thermal model, used by `npm run dev` and tests
  humidity.ts         excessHumidity() — Magnus formula, duplicated in the firmware
  autostop.ts         decideAutostop() — pure decision, no side effects
  runs.ts             RunManager — start/stop/button/reboot/node-lost lifecycle
  store.ts            SQLite: presets, runs, samples, events, settings
  dryer.ts            Dryer — the tick: snapshot → runs → autostop → prune → broadcast
  router.ts           REST API
  mcp/                MCP tools, resources, prompt
  module.ts           assembly into the host's module contract
```

Design: [`docs/superpowers/specs/2026-08-30-dryer-design.md`](../../docs/superpowers/specs/2026-08-30-dryer-design.md).
Firmware: [`firmware/dryer/README.md`](../../firmware/dryer/README.md).
Operating the broker on the Pi: [`docs/dryer/README.md`](../../docs/dryer/README.md).
Layers and lessons for future work: [CLAUDE.md](CLAUDE.md).
