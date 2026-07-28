# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About the project

`inverter-monitor` — local monitoring and control of a hybrid **SK-5500P-48L** inverter
(the **ISolar/EASUN SMG II** family) over **Modbus RTU via RS232**, with no SmartESS cloud.
Runs on a Raspberry Pi.

The full feature description, API, configuration and troubleshooting live in `README.md`
(detailed, in English — keep it up to date when features change). This file covers only
architecture and workflow.

## Commands (from the repository root)

```bash
npm install        # installs dependencies for all workspaces at once (this is a monorepo)
npm run dev        # server :3000 (forces INVERTER_TRANSPORT=mock) + web :3001 (Next.js HMR, proxies /api to :3000)
npm run build      # STRICTLY in the order shared → mcp → server → web
npm run check      # jest: mcp + protocol/stats/auth/auth-http (server) + typecheck (web)
npm test           # same as check, but with the web jest suite instead of typecheck: mcp → server → web
./deploy.sh        # local build → rsync to the Pi → npm ci → systemd restart → health check
```

> ⚠️ Node in your shell must be **≥ 24** (`.nvmrc` = 24). With an older version active the
> tests fail not on assertions but on module load: `No such built-in module:
> node:sqlite`. Fix it with `nvm use` or by prefixing the command with
> `PATH="$HOME/.nvm/versions/node/v24.x.y/bin:$PATH"`.

- **`npm run check -w server` (= `npm test -w server`) runs jest**: the protocol (`src/protocol/modbus.test.ts`, `smg.test.ts`, `registers.test.ts` — consistency of the register map with the decoders), SQLite statistics (`src/stats/db.test.ts`, `solar.test.ts`, `recorder.test.ts`), password hashes/roles/auth flows and tokens (`src/auth/hash.test.ts`, `policy.test.ts`, `db.test.ts`, `service.test.ts`, `tokens.test.ts`), authorization through the real `createServer` over HTTP (`src/server.http.test.ts`: gates, roles, forced password change, Bearer and scopes), the MCP endpoint and the local gateway (`src/mcp/http.test.ts`, `local-gateway.test.ts`), plus the pure `shared` modules (`shared/src/settings.test.ts` — the server's jest config includes `shared/src` in `roots`). None of these is a typecheck.
- **Tests live next to the sources** (`*.test.ts`) — the migration from the four hand-written `assert` scripts `scripts/selfcheck*.ts` to jest is complete. The protocol tests verify against **reference Modbus frames captured from a live inverter** (request `01 03 00 C9 00 01 54 34` → response `01 03 02 00 03 F8 45`, and others), CRC-16/Modbus, the register decoders and the setter builders. **After changing anything under `server/src/protocol/*`, always run `npm test -w server`.**
- **`src/stats/db.test.ts`** likewise checks the schema/rollups/retention of the SQLite statistics (`src/stats/db.ts`, `recorder.ts`). **After changing anything under `server/src/stats/*`, always run the tests.**
- `npm run check` for the server is jest, NOT a type check. Server types are only checked by the build (`tsc` in `npm run build`). The web workspace is checked separately (`tsc --noEmit`).
- Deploying to the Pi — `PI_HOST=pi@… SSH_KEY=~/.ssh/… ./deploy.sh`; note that the script rebuilds everything locally, uploads the artifacts and **restarts the live systemd service** on the Pi. The actual host/key are outside the repository (the owner's local environment).
- Node: both the root `engines` and the `server` `engines` are **≥ 24** (the built-in `node:sqlite` is required for statistics). The Pi itself already runs **Node 24** (Raspberry Pi OS Trixie, arm64) — matching the declared minimum.

## Protocol (important: Modbus, NOT PI30)

The inverter speaks **Modbus RTU: 9600 baud 8N1, slave id 1** (menu setting #25, "Modbus ID").
Historical note: the project was originally written for Voltronic PI30 (QPIGS/CRC-XMODEM) —
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

An npm-workspaces monorepo: `shared/`, `mcp/`, `server/`, `web/`. The build order is not arbitrary — `mcp`, `server` and `web` import `@inverter/shared` from its **built `dist/`**, and `server` additionally imports `@inverter/mcp` from `mcp/dist`, hence the strict order `shared → mcp → server → web`.

### `shared/` — the contract between server and web
`@inverter/shared` is the single source of truth both for the data types (`Snapshot`, `InverterStatus`, `InverterRatedInfo`, `Baseline` etc. in `types.ts`) and for the **control whitelist contract** (`api.ts`: the `ControlType` type, the `OUTPUT_SOURCE_PRIORITY`/`CHARGER_SOURCE_PRIORITY` maps, the arrays of allowed currents, `ApiMeta`). Both server and web pull their values from here — do not duplicate enums on either side.

**Adding a new control command** touches several files in lockstep: `shared/src/api.ts` (in `ControlType`, and in `ApiMeta` if needed) → `server/src/protocol/smg.ts` (a branch in `buildControlWrite`: register + scale + validation) → `server/src/server.ts` (`CONTROL_TYPES`) → `web/` (UI) → `mcp/src/tools/control.ts` (`CONTROL_TYPES` + description) and `mcp/src/prompts.ts` (the completion list) → `shared/src/registers.ts` (the register row, otherwise `server/src/protocol/registers.test.ts` fails). Miss one and things fall out of sync.

`shared` additionally holds the **register map** (`registers.ts`: `REGISTER_DOCS` + `registerDocsMarkdown()`) and the **pure `diffSettings`** (`settings.ts`) — both consumed by MCP; consistency between the map and the decoders is checked by `server/src/protocol/registers.test.ts`.

### `mcp/` — the MCP server for agents
`@inverter/mcp` is the transport-agnostic core of tools/resources/prompts: all communication
with the service goes through the `InverterGateway` interface (`mcp/src/gateway/types.ts`).
There are two implementations: `HttpGateway` (`gateway/http.ts` — REST + WS behind a Bearer
token, used by the stdio binary `mcp/dist/bin/stdio.js`) and `LocalGateway`
(`server/src/mcp/local-gateway.ts` — direct `Inverter`/`StatsDb` calls for the `/mcp`
endpoint, no HTTP hop). Tools: `tools/read.ts` (snapshot, settings diff, alarms, meta,
health, register reads), `tools/stats.ts` (series, days, energy, events, solar window,
summary, CSV link), `tools/control.ts` (writes).

- **The tool set depends on permissions**: write tools are not registered at all if the
  role is not `admin`, the token lacks the `write` scope, `ALLOW_CONTROL` is off, or
  `INVERTER_MCP_READ_ONLY` is set (see `canWrite` in `mcp/src/server.ts`). The statistics
  tools and resources disappear when `STATS_ENABLED=false`.
- **Subscriptions** (`resources.ts`): the SDK's `McpServer` does not handle `subscribe`/
  `unsubscribe` itself — they are registered manually on the low-level `server.server`, and
  notifications are throttled to one per 5 s.
- **The workspace tsconfig** uses `module/moduleResolution: node16` + `isolatedModules`
  (otherwise the SDK's subpath exports do not resolve and ts-jest complains); the emit stays
  CommonJS: `server` pulls the package in with a plain `require`. Build order:
  `shared → mcp → server → web`.
- **The stdio entry point** (`bin/stdio.ts`) is configured through env only:
  `INVERTER_MCP_URL`, `INVERTER_MCP_TOKEN` (required), `INVERTER_MCP_TIMEOUT_MS`,
  `INVERTER_MCP_READ_ONLY`. Diagnostics go to **stderr** — stdout belongs to the protocol.
- Tests — `mcp/src/**/*.test.ts` (jest, part of `npm run check`), including a run of a real
  MCP client over `InMemoryTransport`.
- ⚠️ **The fake-gateway fixtures (`src/testing/fake-gateway.ts`) must mirror the server's real
  schemas.** This has already burned us: the summary read `batteryCapacity_min/max` even though
  the `daily` table names those columns `soc_min`/`soc_max` (the former come from
  `samples_minute`), and the fixture repeated the same mistake — so the tests were green while
  SOC came back empty on live data. The statistics contract is guarded by
  `server/src/mcp/local-gateway.test.ts`, which runs the gateway against a real `StatsDb`.

### `server/` — layers bottom-up
1. **`src/protocol/`** — Modbus RTU + the SMG II map.
   - `modbus.ts` — CRC-16/Modbus (poly 0xA001, init 0xFFFF, LE inside the frame), `buildReadRequest`/`buildWriteRequest` (fn 0x03/0x10), `parseReadResponse`/`parseWriteResponse`, `expectedResponseLength`, `ModbusError` carrying the exception code, `toSigned` (S_WORD).
   - `smg.ts` — read blocks (`STATUS_BLOCKS`/`ALARM_BLOCKS`/`SETTINGS_BLOCKS` — documented ranges only, no "holes"), decoders (`decodeStatus`/`decodeSettings`/`decodeFlags`/`decodeAlarms`/`decodeMode`), setters (`buildControlWrite`). **Scaling is done by division** (`/10`, `/100`), not by multiplying by 0.1 — otherwise float tails (232.70000000000002) break the jest tests and the UI.
2. **`src/transport/`** — a common `Transport` interface plus two implementations: `serial` (`serialport`, an optionalDependency behind an `isAvailable()` check) and `mock` (**a full Modbus-slave emulator**: answers fn 0x03 from an internal register map with plausible dynamics, accepts fn 0x10 writes). `transact(frame, timeout, expectedLen)` — the read completes once `expectedLen` bytes have accumulated OR on an exception frame (5 bytes, function bit 0x80). `detect.ts`: mock always last; the Pi's onboard UARTs are filtered out — USB serial only, unless `INVERTER_SERIAL_DEVICE` is set explicitly.
3. **`src/inverter.ts`** — the core. **All transport work is serialized through a single promise queue (`enqueue`) with 120 ms pacing** between commands. Polling: status+alarms every cycle (7 block reads), settings roughly every 6th cycle and always on the first cycle after connecting; a probe on connect — reading register 201 and validating the mode; automatic reconnect after 3 consecutive errors; **baseline capture** (once per device, persisted to disk); write lock. `rawQuery` understands the text commands `"R <address> [count]"` (always) and `"W <address> <value>"` (behind the same gates as `control()`).
3½. **`src/stats/`** — statistics in SQLite through the built-in `node:sqlite` (Node ≥ 24, no
   native dependencies). `db.ts` — the schema (samples 30 days / samples_minute 2 years /
   daily+events kept forever), watermark-based rollups, retention; `recorder.ts` — subscribes
   to `"snapshot"` and `"write"`, buffers with a flush every 60 s (easy on the SD card),
   derives events from snapshot diffs (mode change, grid loss/return, faults, link,
   device-changed) plus explicit records (`control`). **The solar day window** (start/end of
   sustained PV output) is computed separately — retrospectively from the per-minute
   `samples_minute` series in `db.ts` (`computeSolarWindow` in `solar.ts` +
   `querySolarWindow`), stored in `daily` (`solar_start_ts`/`solar_end_ts`) and served by the
   `/api/stats/solar-window` endpoint. It never writes to the inverter. Tests —
   `src/stats/db.test.ts`, `src/stats/solar.test.ts` (jest, part of `npm run check -w server`).
4. **`src/server.ts`** — Express (REST under `/api` + serving the `web/out` static files) and WebSocket (`/ws`, pushes every `Snapshot`). `Inverter` is an `EventEmitter`; the server and MQTT both subscribe to the `"snapshot"` event. This is also where `/mcp` is mounted (`src/mcp/http.ts`, Streamable HTTP, one `McpServer` per session, `MCP_MAX_SESSIONS` limit, `MCP_ENABLED` kill switch) — behind the same authorization middleware as `/api`.
4½. **Write auditing**: after a successful write `Inverter` emits a `"write"` event
   (`WriteEvent`: source, register, value), and `StatsRecorder` turns it into an event row of
   type `control`. The source is supplied by the callers: `ui:<user>` / `token:<name>` in
   `server.ts`, `mqtt` in `mqtt.ts`, and `local-gateway.ts` for `/mcp`.
5. **`src/mqtt.ts`** — publishing to MQTT with Home Assistant auto-discovery (off by default, `MQTT_URL` empty).
6. **`src/config.ts`** — all configuration comes from env only (see `.env.example`): `INVERTER_BAUD` defaults to **9600**, `MODBUS_SLAVE_ID` defaults to 1, transport `auto|serial|mock`.

### The write-safety model (the key design intent — do not break it)
The principle is "read, but never overwrite until asked". When changing the control paths, preserve every gate:
- Polling/connecting send **reads only (fn 0x03)**. Nothing is written automatically.
- `ALLOW_CONTROL=false` is an irreversible read-only mode (it cannot be unlocked). `STARTUP_LOCKED` starts locked. `AUTO_RELOCK` re-arms the lock after every successful write.
- `/api/raw`: `R` commands always work, `W` commands are gated by the same checks as `control()` — otherwise it would be a hole around the lock.
- MQTT control (`MQTT_ENABLE_CONTROL=true`) deliberately bypasses the UI lock via `opts.bypassLock` — enabling that flag *is* the deliberate authorization; it does not touch the UI lock.
- Every setter goes through the register whitelist plus value validation; a failed write means a Modbus exception from the inverter.
- **Tokens and MCP add no bypasses**: a `Bearer` token needs the `write` scope on top of the `admin` role, and MCP write tools are not registered at all without permissions (`canWrite`). Beyond that, the same `ALLOW_CONTROL`/lock/whitelist apply. `preview` (`POST /api/control` with `preview: true`, `set_control` with `preview`) writes nothing and is therefore available without the scope and while locked.
- **Every write lands in the log** as a `control` event with its source — see "Write auditing". Do not drop `opts.source` from `control()`/`rawQuery()` calls: without it the write is anonymous (`unknown`).

### Authorization (`server/src/auth/`)
- `hash.ts` — scrypt password hashing (built-in `crypto`, no dependencies).
- `db.ts` — `AuthDb` on `node:sqlite` (`data/auth.db`): users + sessions, seeding
  admin/user when the database is empty.
- `policy.ts` — the pure `canAccess(role, required)` (covered by `policy.test.ts`).
- `service.ts` — the `Auth` class: login/sessions/password change, per-IP brute-force protection.
- Two roles: `admin` (everything) / `viewer` (only `/` and `/stats`). The restrictions are
  enforced both on the server (403 middleware + page redirects) and in the UI (role-based navigation).
- Forced password change: `must_change_password=1` blocks all of `/api` except
  `me`/`change-password`/`logout` until the password is changed.
- **API tokens** (the `api_tokens` table in `auth.db`, `Authorization: Bearer inv_…`, sha256
  in the database, `read`/`write` scopes): the `/api` middleware tries the cookie first, then
  Bearer, and puts `kind`/`scopes`/`tokenName` into `req.auth`. Mutating routes (`control`,
  `lock`, `raw` with `W`, `baseline/recapture`) require the `write` scope — except
  `POST /api/control` with `preview: true`, which is a read (`Inverter.previewControl`).
  `/api/users` and `/api/tokens` are closed to tokens (`code: session_required`) — access
  management happens only from a UI session. A token whose owner is under a forced password
  change is rejected. Issuing: the UI on `/users`, `POST /api/tokens`, or
  `scripts/issue-token.ts`. `/ws` accepts the same Bearer token.
- Tests — `hash.test.ts`, `policy.test.ts`, `db.test.ts`, `service.test.ts`, `tokens.test.ts` (jest, part of `npm run check -w server`); the HTTP flows — `src/server.http.test.ts`.

### `web/` — Next.js (App Router)
- **Production = static export** (`output: "export"` in `next.config.ts`) into `web/out/`, served by Express itself. **Dev** = `next dev -p 3001` + rewrites `/api/*` → `http://localhost:3000` (see `next.config.ts`). The same split drives `web/lib/api.ts::wsUrl()`, which picks between dev (`ws://localhost:3000`) and production.
- The `app/(app)/` route group is the authenticated shell (dashboard, `stats`, `settings`, `diagnostics`, `users`); `app/login/` and `app/change-password/` are open. Navigation and access depend on the role (see "Authorization"): a viewer only sees the dashboard and `stats`. The server redirects page routes (`/login` without a session; `/change-password` under a forced password change; `/` for a viewer on admin pages), but serves static assets (css/js/pages) freely — the data is protected at the `/api` level.
- UI data plumbing — `web/lib/snapshot.tsx` (WS subscription with reconnect and stale marking), `meta.tsx` (control reference data with retry; carries the current user/role in `ApiMeta.session`), `stats.ts` (the `/api/stats/*` client), `format.ts`, `toast.tsx`.
- **The `/users` page** has two sections: users (`app/(app)/users/page.tsx`) and API tokens (`components/TokensPanel.tsx` — creation, one-time display of the value, revocation). The panel is mocked in the page tests: it calls `/api/tokens` and would otherwise throw off the sequential fetch mocks; it has its own tests in `components/TokensPanel.test.tsx`.
- **The event log on `/stats`** knows the `control` event type (a write to the inverter): label `stEvControl`, text — "what changed · source".
- **The solar-window panel on `/stats`** (`components/SolarWindowPanel.tsx`) follows the period selector: for a day it calls `/api/stats/solar-window?day=…` (today's window arrives still open), for a week/month it computes the summary from the already-loaded `daily` rows — it issues no extra requests. The pure part (earliest start, latest end, average duration) is `lib/solar.ts`, and the time of day is measured from each day's **local** midnight, otherwise days are not comparable. The dashboard panel (`components/SolarToday.tsx`) stayed separate: it is about "right now" and polls the API once a minute.
- **i18n** (`web/lib/i18n/`): a typed UA/RU/EN dictionary. The initial language is hard-coded to `uk` to match the SSG prerender (otherwise hydration mismatches); the real choice is picked up from `localStorage` after mount. The dictionary also localizes the **fault/warning bit names** (the English strings from `smg.ts` are the keys of `dict.warnings`) and the **flag toggles** (the `lcdHome`/`ecoMode`/… keys from `FLAG_DEFS`) — when changing strings in `smg.ts`, keep `dict.ts` in sync.

## Hardware (context for debugging the link)
- The chain: the inverter's RS232 port (RJ45) → the stock dongle cable DB9↔RJ45 (RJ45 1→DB9 2 = the inverter's TX, 2→3 = RX, 8→5 = GND; a null-modem is NOT needed) → a USB-RS232 adapter (FTDI FT231X, **true RS232 levels ±12 V**) → the Pi's USB.
- ⚠️ USB-TTL dongles (often sold as "USB-RS232" on a CH340) are physically incompatible with the inverter — the port opens but the exchange stays silent. The check: the adapter's TX at idle must sit at **−5…−12 V**.
- In a typical installation the inverter's USB-B port is taken by the battery BMS — hence the RS232 path.

## Deploying to the Pi (important details)
- The build is **entirely local**; the Pi only runs `npm ci -w server -w mcp --omit=dev` + a systemd restart. The Pi compiles nothing. `rsync` uploads `shared/dist`, `mcp/dist`, `server/dist`, `web/out` and the workspace manifests.
- On the Pi the config and data live under `server/` (`server/.env`, `server/data/{baseline.json, auth.db, stats.db}`); the systemd unit has `WorkingDirectory=…/server`. `auth.db`/`stats.db` are created automatically on first start; `deploy.sh` does not touch the `data/` directory.
- `systemctl enable` (autostart after a Pi reboot) is a one-off manual operation — `deploy.sh` does not do it.

## Git workflow
- Repository: `git@github.com:apanamaryov/sweethome.git` (remote `origin`, default branch `main`).
- New changes go through feature branches and PRs — do not commit directly to `main`.
- Do not merge into `main` without explicit confirmation from the user.
- **Commit messages are written in English** (the repository is public, the README and the code are in English), in conventional-commits format: `feat(web): …`, `fix(mcp): …`, `docs: …`. Commits before 2026-07-28 are in Russian — that is legacy, no need to rewrite them. Conversation with the user still happens in Russian.
- Secrets (`server/.env`, real passwords/Pi data) never enter the repository — they live outside git and in `.gitignore`.
