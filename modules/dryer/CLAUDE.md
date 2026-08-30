# modules/dryer — CLAUDE.md

This file covers only what is expensive to re-derive for the `@sweethome/dryer` module.
Root-level workflow (commands, deploy, git) lives in the repository's top-level `CLAUDE.md`.
The full design — decisions, MQTT contract, firmware behaviour, API, acceptance criteria —
is `docs/superpowers/specs/2026-08-30-dryer-design.md`; this is its condensed form for
day-to-day work on the module.

## Layers

```
router.ts / mcp/          REST + MCP — thin, delegate everything to Dryer
dryer.ts (Dryer)          the tick: snapshot → RunManager.tick() → autostop → prune → broadcast
runs.ts (RunManager)      run lifecycle: start/stop, button, reboot, node-lost
autostop.ts               decideAutostop() — pure, no side effects
humidity.ts               excessHumidity() — pure, the Magnus formula
node/link.ts (NodeLink)   the boundary to the node
node/mqtt.ts, node/mock.ts   the two NodeLink implementations
store.ts                  SQLite: presets, runs, samples, events, settings
```

**`NodeLink` is the one boundary that matters here.** Everything above it (`Dryer`,
`RunManager`, `autostop`, the router, MCP) talks only to `NodeLink.view()` /
`.publishCfg()` / `.sendRun()` / `.uptime()` / `.connected()` and never to MQTT or the
simulator directly. `MqttNodeLink` (real node, `node/mqtt.ts`) and `MockNodeLink`
(`node/mock.ts`, a first-order thermal simulator) are the only two things that know the
difference between a real node and a fake one. This is why `npm test -w @sweethome/dryer`
needs no broker and no hardware — every other test drives the mock or a fake `NodeLink`.

## The Magnus formula lives in two places — change as a pair

`humidity.ts::excessHumidity` (via `humidityAtTemperature`/`saturationVaporPressure`) is
the *exact same math* as `firmware/dryer/dryer.yaml`'s `humidity_excess` sensor. The node
computes its own excess to drive the exhaust fan; the module recomputes it independently
for the chart and for `autostop.ts`'s input series (it does not trust the node's own
`humidity_excess` reading as the sole source — the module derives it from
`chamber`/`ambient` temperature and humidity so the two are exercised by the same test
suite). If you ever touch the coefficients (Alduchov–Eskridge, 1996) or the formula shape,
change both files in the same commit and re-verify `humidity.test.ts`'s table against the
firmware's own behaviour — a mismatch here means the web chart and the physical fan
disagree about how wet the batch still is.

## Why `cmd/run` is not retained

`MqttNodeLink.sendRun()` publishes `cmd/run` with `retain: false` (spec §5). If it were
retained, a Pi that sent `START` and then died would leave that `START` sitting on the
broker — and the moment the node reboots (power blip, OTA, whatever) and resubscribes, it
would replay straight into the heater turning back on unattended. Everything else the
module publishes to the node (`cfg/setpoint`, `cfg/max_minutes`, `cfg/exhaust_min`,
`cfg/exhaust_gain`) *is* retained, because those are safe to replay — worst case the node
just remembers its last configured setpoint, which is also what lets the physical button
start a run with sane parameters even with the Pi off.

Consequence: `RunManager` cannot rely on the broker to resume a run after a node reboot —
it has to notice the reboot itself (`uptime` going backwards, see `runs.ts::tick`) and
actively re-send `cfg/*` + `START` (`afterReboot()`), bumping `restarts` and giving up
after `maxRestarts` (3) with `fault:node_reboot_loop`.

## Why a run is not closed when the node disappears

The node is designed to keep drying with zero input from the Pi (§4 of the spec — "the
node doesn't need a heartbeat"). So when `NodeLink.view().online` goes false mid-run, the
right assumption is "still drying, just not talking to us" — closing the run the moment
we lose the MQTT connection would be wrong almost every time (a Wi-Fi blip, a broker
restart). `RunManager.tick()` only closes it as `node_lost` once we're well past the point
the node's own `max_minutes` timer must have fired (`run.maxMinutes` elapsed **plus** a
15-minute grace period, `LOST_GRACE_MS`) — see the "--- связь ---" block at the top of
`tick()`. Anything less patient would flap open/closed runs on every reconnect.

## The `pendingStart` race and its guard

`RunManager.start()` publishes `cfg/*` + `START` and then polls `view()` every 200 ms
waiting for the state to become `heating`/`drying`, up to a 5 s timeout — all *before* it
calls `store.openRun()`. Meanwhile `Dryer`'s own tick (`RunManager.tick()`) runs on its own
10 s interval and can observe that same transition to `heating` in the gap between "the
node changed state" and "our `start()` call got around to writing the run row". Without a
guard, `tick()` would read "no current run, but the node is drying" and conclude *the
button was pressed* — opening a spurious `started_by: 'button'` run right under the one
`start()` is about to create.

The guard is `pendingStart` (a timestamp set the instant `sendRun("START")` goes out,
cleared once the state actually reaches active or after a 10 s safety cutoff) plus a
same-tick snapshot of it (`wasPending`, read before anything in `tick()` can clear it).
`tick()`'s button/recovery branch requires **both** `pendingStart === null` *and*
`!wasPending` — so a tick that lands squarely inside our own pending START never opens a
second run for it. See the comment above `wasPending` in `runs.ts` for the exact race
being closed.

The same "no current run + node active" branch is also how a service restart picks up a
run that was already going (`startedBy: 'recovered'`, `startedAt` reconstructed from
`run_elapsed`) and how the physical button is detected (`startedBy: 'button'`, previous
state was idle/cooldown) — the `fromButton` check just distinguishes which of the two it
is.

## Running the tests

```bash
npm test -w @sweethome/dryer   # jest, 14 suites, no broker or hardware needed
```

Every suite drives either a pure function (`autostop`, `humidity`, `texts`, `validate`),
`MockNodeLink` (`node/mock.test.ts`, `dryer.test.ts`, `runs.test.ts`), a fake `MqttClientLike`
(`node/mqtt.test.ts` — topic parsing, freshness, that `cfg/*` goes out before `START`, that
`cmd` is never retained, LWT), an in-memory `DryerStore` on a temp file (`store.test.ts`), a
real MCP client over `InMemoryTransport` (`mcp/tools.test.ts`, `mcp/provider.test.ts`), or
`supertest` against the router (`router.test.ts`). If you change `node/mqtt.ts`'s topic
parsing or `humidity.ts`, run this workspace's tests specifically — nothing elsewhere
exercises them.

## Watching the live contract

With a real node and broker, `mosquitto_sub` is the fastest way to see whether the module
and the firmware agree with each other:

```bash
mosquitto_sub -h <pi> -u dryer-service -P '<password>' -t 'dryer/#' -v
```

Every sensor and both text sensors should appear every 10 s regardless of state. To watch
just the commands the module sends: filter to `dryer/cmd/#` and `dryer/cfg/#` — `cfg/*`
should always precede a `cmd/run START`, and `cmd/run` should never show up with a retain
flag replay on resubscribe (kill and restart `mosquitto_sub` — it should print nothing
until the module sends the next command).

## Pointers

- Firmware (ESPHome config, pinout, build/flash instructions, PID autotune):
  [`firmware/dryer/README.md`](../../firmware/dryer/README.md).
- Broker setup, ACLs, `.env` on the Pi, diagnostics:
  [`docs/dryer/README.md`](../../docs/dryer/README.md).
- Module overview, config table, API, MCP tools, caveats: [README.md](README.md).
