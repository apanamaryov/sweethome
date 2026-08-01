# modules/inverter — CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) for the `@sweethome/inverter`
module. Root-level workflow (commands, deploy, git) lives in the repository's top-level
`CLAUDE.md`; this file covers only the inverter module's protocol, architecture and
write-safety model.

The full feature description, API, configuration and troubleshooting live in
`modules/inverter/README.md` (detailed, in English — keep it up to date when features
change). This file covers only architecture and workflow.

## Protocol (important: Modbus, NOT PI30)

The inverter speaks **Modbus RTU: 9600 baud 8N1, slave id 1** (menu setting #25, "Modbus
ID"). Historical note: the project was originally written for Voltronic PI30 (QPIGS/CRC-XMODEM) —
that turned out to be wrong, the inverter does not answer PI30 at all; on 2026-07-23 the
protocol layer was rewritten for Modbus. The register map comes from **syssi/esphome-smg-ii**
(verified against a live device):

- **Status**: 201 mode (0..6), 202 grid V ×0.1, 203 Hz ×0.01, 210/212/213/214 output,
  215 battery V ×0.1, 217 battery power (±), 219/220/223/224 PV, 225 load %,
  226/227 temperatures, 229 SOC, 232 battery current ×0.1 (+charge/−discharge).
- **Alarms**: 100–101 fault (32 bits), 108–109 warning (32 bits) — the bit lists are in `smg.ts`.
- **Settings**: 300–343 (301 output priority, 331 charger priority, 332/333 currents ×0.1,
  324/325/326/327/329 voltage thresholds ×0.1, 341–343 SOC thresholds), 643 rated W.
- **Writes — function 0x10 ONLY** (Write Multiple Registers) — the device does not understand 0x06.
- **Pacing**: commands need a gap between them (~120 ms, esphome uses 200 ms) — implemented
  in the `Inverter.enqueue` queue.
- The inverter only answers **at 9600** (stays silent at 2400/4800/19200).

## Architecture

### `modules/inverter/src/protocol/` — Modbus RTU + the SMG II map
- `modbus.ts` — CRC-16/Modbus (poly 0xA001, init 0xFFFF, LE inside the frame), `buildReadRequest`/`buildWriteRequest` (fn 0x03/0x10), `parseReadResponse`/`parseWriteResponse`, `expectedResponseLength`, `ModbusError` carrying the exception code, `toSigned` (S_WORD).
- `smg.ts` — read blocks (`STATUS_BLOCKS`/`ALARM_BLOCKS`/`SETTINGS_BLOCKS` — documented ranges only, no "holes"), decoders (`decodeStatus`/`decodeSettings`/`decodeFlags`/`decodeAlarms`/`decodeMode`), setters (`buildControlWrite`). **Scaling is done by division** (`/10`, `/100`), not by multiplying by 0.1 — otherwise float tails (232.70000000000002) break the jest tests and the UI.

**Adding a new control command** touches several files in lockstep: `packages/inverter-shared/src/api.ts` (in `ControlType`, and in `ApiMeta` if needed) → `modules/inverter/src/protocol/smg.ts` (a branch in `buildControlWrite`: register + scale + validation) → `modules/inverter/src/router.ts` (`CONTROL_TYPES`) → `web/` (UI) → `packages/inverter-mcp/src/tools/control.ts` (`CONTROL_TYPES` + description) and `packages/inverter-mcp/src/prompts.ts` (the completion list) → `packages/inverter-shared/src/registers.ts` (the register row, otherwise `modules/inverter/src/protocol/registers.test.ts` fails). Miss one and things fall out of sync.

`packages/inverter-shared` holds the data types (`Snapshot`, `InverterStatus`, `InverterRatedInfo`, `Baseline`, etc. in `types.ts`), the **control whitelist contract** (`api.ts`: the `ControlType` type, the `OUTPUT_SOURCE_PRIORITY`/`CHARGER_SOURCE_PRIORITY` maps, the arrays of allowed currents, `ApiMeta`), the **register map** (`registers.ts`: `REGISTER_DOCS` + `registerDocsMarkdown()`) and the **pure `diffSettings`** (`settings.ts`) — both consumed by MCP; consistency between the map and the decoders is checked by `modules/inverter/src/protocol/registers.test.ts`.

`packages/inverter-shared` also holds the **pure derivation of the power source** (`source.ts`: `instantSource` — an unsmoothed per-sample candidate — plus `stepSource`, a 2-in-a-row hysteresis over it). The inverter has no "solar" mode of its own (register 201 only knows PowerOn/Standby/Line/Battery/Bypass/Charging/Fault); `source.ts` is where `"Solar"` gets synthesized from telemetry. `modules/inverter/src/inverter.ts` is the only one that runs this logic, once per poll cycle, and owns the `SourceState`; web, MQTT and MCP never compute it themselves — they only ever read the resulting `Snapshot.powerSource`.

### `modules/inverter/src/transport/`
A common `Transport` interface plus two implementations: `serial` (`serialport`, an optionalDependency behind an `isAvailable()` check) and `mock` (**a full Modbus-slave emulator**: answers fn 0x03 from an internal register map with plausible dynamics, accepts fn 0x10 writes). `transact(frame, timeout, expectedLen)` — the read completes once `expectedLen` bytes have accumulated OR on an exception frame (5 bytes, function bit 0x80). `detect.ts`: mock always last; the Pi's onboard UARTs are filtered out — USB serial only, unless `INVERTER_SERIAL_DEVICE` is set explicitly.

### `modules/inverter/src/inverter.ts` — the core
**All transport work is serialized through a single promise queue (`enqueue`) with 120 ms pacing** between commands. Polling: status+alarms every cycle (7 block reads), settings roughly every 6th cycle and always on the first cycle after connecting; a probe on connect — reading register 201 and validating the mode; automatic reconnect after 3 consecutive errors; **baseline capture** (once per device, persisted to disk). `rawQuery` understands the text commands `"R <address> [count]"` (always) and `"W <address> <value>"` (behind the same gates as `control()`). It also holds the `SourceState` (`packages/inverter-shared/src/source.ts`) for the derived `powerSource`: `instantSource`+`stepSource` run every poll cycle. **The raw mode stays authoritative** — whenever register 201 reads a different mode than the previous sample, the state is re-seeded with that mode (`lastMode`), so grid loss/return and `Fault` reach the badge and the HA sensor in the same cycle and the hysteresis only ever smooths the `Battery ↔ Solar` pair. That re-seed also covers the first sample after a (re)connect, since `lastMode` is reset together with the state. The state is reset back to `"Unknown"` on disconnect (both in `closeTransport()` and in `setConnection(false, …)` — a single failed read takes only the latter path), so a stale `"Solar"` never survives a reconnect (a device change goes through the same disconnect path, since `deviceId` is only reassigned by a fresh `connect()`).

### `modules/inverter/src/stats/`
Statistics in SQLite through the built-in `node:sqlite` (Node ≥ 24, no
native dependencies). `db.ts` — the schema (samples 30 days / samples_minute 2 years /
daily+events kept forever), watermark-based rollups, retention; `recorder.ts` — subscribes
to `"snapshot"` and `"write"`, buffers with a flush every 60 s (easy on the SD card),
derives events from snapshot diffs (mode change, grid loss/return, faults, link,
device-changed) plus explicit records (`control`). **The solar day window** (start/end of
sustained PV output) is computed separately — retrospectively from the per-minute
`samples_minute` series in `db.ts` (`computeSolarWindow` in `solar.ts` +
`querySolarWindow`), stored in `daily` (`solar_start_ts`/`solar_end_ts`) and served by the
`/api/inverter/stats/solar-window` endpoint. It never writes to the inverter. Tests —
`src/stats/db.test.ts`, `src/stats/solar.test.ts` (jest, part of `npm test -w @sweethome/inverter`).

### `modules/inverter/src/mqtt.ts`
Publishing to MQTT with Home Assistant auto-discovery (off by default, `MQTT_URL` empty).

### MCP
`@sweethome/inverter-mcp` is the transport-agnostic core of tools/resources/prompts: all communication
with the service goes through the `InverterGateway` interface (`packages/inverter-mcp/src/gateway/types.ts`).
There are two implementations: `HttpGateway` (`gateway/http.ts` — REST + WS behind a Bearer
token, used by the stdio binary `packages/inverter-mcp/dist/bin/stdio.js`) and `LocalGateway`
(`modules/inverter/src/mcp/local-gateway.ts` — direct `Inverter`/`StatsDb` calls for the `/mcp`
endpoint, no HTTP hop). Tools: `tools/read.ts` (snapshot, settings diff, alarms, meta,
health, register reads), `tools/stats.ts` (series, days, energy, events, solar window,
summary, CSV link), `tools/control.ts` (writes).

- **The tool set depends on permissions**: write tools are not registered at all if the
  role is not `admin`, the token lacks the `write` scope, `ALLOW_CONTROL` is off, or
  `INVERTER_MCP_READ_ONLY` is set (see `canWrite` in `packages/inverter-mcp/src/server.ts`). The statistics
  tools and resources disappear when `STATS_ENABLED=false`.
- **Subscriptions** (`resources.ts`): the SDK's `McpServer` does not handle `subscribe`/
  `unsubscribe` itself — they are registered manually on the low-level `server.server`, and
  notifications are throttled to one per 5 s.
- **The workspace tsconfig** uses `module/moduleResolution: node16` + `isolatedModules`
  (otherwise the SDK's subpath exports do not resolve and ts-jest complains); the emit stays
  CommonJS: `modules/inverter` pulls the package in with a plain `require`.
- **The stdio entry point** (`bin/stdio.ts`) is configured through env only:
  `INVERTER_MCP_URL`, `INVERTER_MCP_TOKEN` (required), `INVERTER_MCP_TIMEOUT_MS`,
  `INVERTER_MCP_READ_ONLY`. Diagnostics go to **stderr** — stdout belongs to the protocol.
- Tests — `packages/inverter-mcp/src/**/*.test.ts` (jest, part of `npm test -w @sweethome/inverter-mcp`), including a run of a real
  MCP client over `InMemoryTransport`.
- ⚠️ **The fake-gateway fixtures (`src/testing/fake-gateway.ts`) must mirror the server's real
  schemas.** This has already burned us: the summary read `batteryCapacity_min/max` even though
  the `daily` table names those columns `soc_min`/`soc_max` (the former come from
  `samples_minute`), and the fixture repeated the same mistake — so the tests were green while
  SOC came back empty on live data. The statistics contract is guarded by
  `modules/inverter/src/mcp/local-gateway.test.ts`, which runs the gateway against a real `StatsDb`.

## The write-safety model (the key design intent — do not break it)
The principle is "read, but never overwrite until asked". When changing the control paths, preserve every gate:
- Polling/connecting send **reads only (fn 0x03)**. Nothing is written automatically.
- `ALLOW_CONTROL=false` is an irreversible read-only mode (it cannot be unlocked). `STARTUP_LOCKED` starts locked. `AUTO_RELOCK` re-arms the lock after every successful write.
- `/api/inverter/raw`: `R` commands always work, `W` commands are gated by the same checks as `control()` — otherwise it would be a hole around the lock.
- MQTT control (`MQTT_ENABLE_CONTROL=true`) deliberately bypasses the UI lock via `opts.bypassLock` — enabling that flag *is* the deliberate authorization; it does not touch the UI lock.
- Every setter goes through the register whitelist plus value validation; a failed write means a Modbus exception from the inverter.
- **Tokens and MCP add no bypasses**: a `Bearer` token needs the `write` scope on top of the `admin` role, and MCP write tools are not registered at all without permissions (`canWrite`). Beyond that, the same `ALLOW_CONTROL`/lock/whitelist apply. `preview` (`POST /api/inverter/control` with `preview: true`, `set_control` with `preview`) writes nothing and is therefore available without the scope and while locked.
- **Every write lands in the log** as a `control` event with its source — see "Write auditing". Do not drop `opts.source` from `control()`/`rawQuery()` calls: without it the write is anonymous (`unknown`).

## Hardware (context for debugging the link)
- The chain: the inverter's RS232 port (RJ45) → the stock dongle cable DB9↔RJ45 (RJ45 1→DB9 2 = the inverter's TX, 2→3 = RX, 8→5 = GND; a null-modem is NOT needed) → a USB-RS232 adapter (FTDI FT231X, **true RS232 levels ±12 V**) → the Pi's USB.
- ⚠️ USB-TTL dongles (often sold as "USB-RS232" on a CH340) are physically incompatible with the inverter — the port opens but the exchange stays silent. The check: the adapter's TX at idle must sit at **−5…−12 V**.
- In a typical installation the inverter's USB-B port is taken by the battery BMS — hence the RS232 path.
