<div align="center">

# 🔋 Inverter Monitor — SK-5500P-48L

**Local monitoring and control of a hybrid inverter, talking to it directly — no SmartESS cloud.**

![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=next.js&logoColor=white)
![Modbus](https://img.shields.io/badge/Modbus-RTU%209600-orange)
![Cloud](https://img.shields.io/badge/cloud-none-success)
![License](https://img.shields.io/badge/license-MIT-blue)

A TypeScript / Node.js web application for monitoring and controlling the
**SK-5500P-48L** hybrid inverter (**ISolar / EASUN SMG II** family). It runs on a
Raspberry Pi, polls the inverter directly over RS232 using **Modbus RTU**, and serves
a mobile-friendly web UI plus a REST/WebSocket API to your local network. No data
ever leaves your LAN.

</div>

---

## ✨ Features

- 📡 **Direct inverter polling** over Modbus RTU (9600 baud, RS232), bypassing the cloud and the SmartESS app.
- 🔀 **Auto-detected transports** — serial (USB-RS232 adapter) and mock (demo data when no inverter is attached).
- 📱 **Mobile-friendly web UI** (Next.js) with live updates over WebSocket and automatic reconnection.
- 🌍 **Three interface languages** — Ukrainian, Russian, English; switching without a page reload.
- 🔒 **Safe control** — read-only by default; writes require an explicit unlock, a register whitelist, automatic re-locking, and an "as-found" settings baseline with drift highlighting.
- 🏠 **Home Assistant integration** over MQTT with auto-discovery — entities appear in HA by themselves, no YAML needed.
- 🔑 **Users & roles** — always-on login with two roles (admin / viewer), forced password change on first use, admin-managed accounts, scrypt-hashed passwords in SQLite, HttpOnly sessions and brute-force protection.
- 📊 **Statistics & history** — SQLite telemetry log with a per-metric power chart set, daily kWh totals, energy bars, a "Solar today" window (start/end of stable PV output), and an event log (mode changes, grid loss, faults).
- 🚀 **One-script deploy** — local build → rsync to the Pi → systemd restart → health check.

---

## 🗺️ How it works

```
Inverter ──(RS232 · Modbus RTU)── Raspberry Pi ──(WiFi/LAN)── phone / browser
                                       │
                       ┌───────────────┴───────────────┐
                       │  Node.js (this project)        │
                       │  ┌──────────┐  ┌────────────┐  │
                       │  │ transport│  │  protocol  │  │
                       │  │ serial   │  │ Modbus RTU │  │
                       │  │ mock     │  │ + SMG map  │  │
                       │  └──────────┘  └────────────┘  │
                       │        ┌────────────┐          │
                       │        │ HTTP + WS  │          │
                       │        └────────────┘          │
                       └────────────────────────────────┘
```

The inverter belongs to the **ISolar/EASUN SMG II** family and speaks **Modbus RTU**
(9600 baud, 8N1, slave id 1 — menu setting #25, "Modbus ID"). The SmartESS WiFi dongle
is merely a bridge that polls the same registers and relays the data to the cloud; this
application does the same thing locally. The register map has been verified against the
[syssi/esphome-smg-ii](https://github.com/syssi/esphome-smg-ii) project and a live
device: status — registers 201–234, faults/warnings — 100/108 (bit masks),
settings — 300–343.

**Layers** (an npm-workspaces monorepo):

| Layer | Where | Responsibility |
|---|---|---|
| `shared` | `shared/src` | Shared types (`Snapshot`, …) and the control contract (whitelist, value maps) — used by both server and web |
| `protocol` | `server/src/protocol` | `modbus.ts` — frames/CRC-16/response parsing; `smg.ts` — SMG II register map, decoders, setters |
| `transport` | `server/src/transport` | `serial` / `mock` behind a common interface + auto-detection |
| `inverter` | `server/src/inverter.ts` | Timer-driven polling, command queue (single port, 120 ms pacing), auto-reconnect, baseline, write lock |
| `server` | `server/src/server.ts` | Express (REST + static files) and WebSocket (live push) |
| `mqtt` | `server/src/mqtt.ts` | MQTT publishing with Home Assistant auto-discovery |
| `web` | `web/` | Mobile UI on Next.js; the static export is served by the same Express server |

Protocol correctness is pinned by reference frames captured from a live inverter
(`01 03 00 C9 00 01 54 34` → `01 03 02 00 03 F8 45`) — see
`server/src/protocol/modbus.test.ts` and `smg.test.ts`.

---

## 📑 Contents

- [Quick start (development)](#-quick-start-development)
- [Connecting the inverter to the Pi](#-connecting-the-inverter-to-the-pi-hardware)
- [Deploying to the Pi](#-deploying-to-the-pi)
- [Configuration (`.env`)](#️-configuration-env)
- [Web interface](#️-web-interface)
- [API](#-api)
- [Statistics](#-statistics)
- [Home Assistant (MQTT)](#-home-assistant-mqtt)
- [Control safety & write lock](#-control-safety--write-lock)
- [What's been verified](#-whats-been-verified)
- [Project structure](#️-project-structure)
- [Troubleshooting](#️-troubleshooting)
- [License](#-license)

---

## 🚀 Quick start (development)

An npm-workspaces monorepo: `shared/` (shared types and the API contract), `server/`
(Express + WebSocket, the Modbus protocol) and `web/` (Next.js UI). Development and
builds happen on a regular machine (not on the Pi); Node ≥ 24.

```bash
git clone https://github.com/apanamaryov/sweethome.git inverter-monitor
cd inverter-monitor
npm install    # installs dependencies for all workspaces at once
npm run dev    # server :3000 (mock data) + UI :3001 (Next.js, HMR)
```

Open `http://localhost:3001` — in dev mode the UI proxies `/api/*` to the server
on `:3000` (see `web/next.config.ts`).

Before committing, run the static checks (web typecheck + server jest suite):

```bash
npm run check
```

> `npm run check` runs the web typecheck plus the server's jest suite (`npm test -w
> server`, not a typecheck): protocol (`src/protocol/modbus.test.ts`, `smg.test.ts`
> — reference Modbus frames captured from a live inverter, CRC, register
> decoders/setters), stats (`src/stats/db.test.ts` — SQLite rollups/retention and
> event derivation), auth (`src/auth/hash.test.ts`, `policy.test.ts`, `db.test.ts`,
> `service.test.ts`) and the full auth flow over HTTP
> (`src/server.http.test.ts`). Tests live next to the sources they cover; run
> `npm test -w server` after changes under `server/src/*`. Requires Node ≥ 24.

---

## 🔌 Connecting the inverter to the Pi (hardware)

> While no inverter is physically attached, the application runs on demo data and
> will **pick the inverter up automatically** as soon as it appears (after a service
> restart or a reconnect cycle).

1. **Unplug the stock SmartESS WiFi dongle** from the inverter's RS232 port (the RJ45
   jack, the monitoring port). The dongle's DB9↔RJ45 cable is the standard one — it fits.
2. Connect: **inverter RS232 port → DB9↔RJ45 cable → USB-RS232 adapter → Pi USB**.
   - ⚠️ The adapter must have **true RS232 levels (±12 V)** — with a level shifter
     (MAX232/SP232) on board. Cheap "USB-RS232" dongles on CH340 often turn out to be
     USB-TTL (0/3.3 V) — they are physically incompatible with the inverter: the port
     opens, but the line stays silent. Multimeter check: the adapter's TX (DB9 pin 3)
     must idle at **minus 5…12 V**. A verified working option is an FTDI FT231X cable
     with a proper level shifter.
   - Stock cable pinout (verified by continuity testing): RJ45 pin 1 → DB9 pin 2
     (inverter TX), RJ45 pin 2 → DB9 pin 3 (inverter RX), RJ45 pin 8 → DB9 pin 5
     (GND). A null modem is NOT needed.
3. Check menu setting #25 "Modbus ID" on the inverter (default **001** — matches
   `MODBUS_SLAVE_ID=1`).
4. Restart the service: `sudo systemctl restart inverter-monitor`.
5. Confirm the header status changes from "Demo data" to "Connected · serial …".

If the Pi doesn't see the adapter: `lsusb`, `ls -l /dev/ttyUSB*`, and permissions
(user `pi` must be in the `dialout` group).

**Requirements:** Raspberry Pi (tested on a Pi 3B), **Node.js ≥ 24**; building the
native serialport module needs `git`, `gcc`, `make`, `python3`.

---

## 📦 Deploying to the Pi

The build is entirely **local**: the Pi compiles nothing — it only installs the
server's production dependencies and restarts the systemd service.

```bash
./deploy.sh
# with parameters:
PI_HOST=pi@<pi-address> SSH_KEY=~/.ssh/<key> ./deploy.sh
```

What the script does:

1. `npm run build` (shared → server → web) and `npm run check`.
2. `rsync` uploads the built artifacts to the Pi — `shared/dist`, `server/dist`, `server/systemd`, `server/.env.example`, the `web/out` static files — plus the workspace `package.json`/`package-lock.json`.
3. Over SSH on the Pi: `npm ci -w server --omit=dev`, updates the systemd unit and restarts `inverter-monitor`.
4. Checks `GET /api/health` (up to a minute for the restart); a `401` without a session (auth is always on) means the server is alive.

- `PI_HOST` — user and address of your Pi (defaults to `pi@raspberrypi.local`).
- `SSH_KEY` — path to a private key if the ssh agent doesn't pick one up.

On the Pi, config and data live in `server/.env` and `server/data/` (`baseline.json`,
`auth.db`); static files are served by the server itself from `web/out/`.
Enabling autostart after a Pi reboot (`systemctl enable`) is a one-time manual step:

```bash
ssh pi@<pi-address> sudo systemctl enable inverter-monitor
```

---

## ⚙️ Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP/WS server port |
| `HOST` | `0.0.0.0` | Listen interface |
| `INVERTER_TRANSPORT` | `auto` | `auto` / `serial` / `mock` |
| `INVERTER_SERIAL_DEVICE` | — | Serial device path (otherwise auto-picked) |
| `INVERTER_BAUD` | `9600` | Serial speed (SMG II uses 9600) |
| `MODBUS_SLAVE_ID` | `1` | Inverter's Modbus address (menu #25) |
| `POLL_INTERVAL_MS` | `5000` | Polling period |
| `COMMAND_TIMEOUT_MS` | `3000` | Command timeout |
| `ALLOW_MOCK` | `true` | Fall back to demo data when no inverter is found |
| `ALLOW_CONTROL` | `true` | Master write switch. `false` = permanently read-only (cannot be unlocked) |
| `STARTUP_LOCKED` | `true` | Start in read-only mode (writing requires an explicit unlock) |
| `AUTO_RELOCK` | `true` | Automatically re-engage the lock after every successful write |
| `DATA_DIR` | `data` | Where to persist the settings baseline (`baseline.json`) and the auth database (`auth.db`) |
| `AUTH_SESSION_TTL_DAYS` | `30` | Session cookie lifetime |
| `MQTT_URL` | — | MQTT broker address (`mqtt://user:pass@host:1883`). Empty = MQTT disabled |
| `MQTT_ENABLE_CONTROL` | `false` | Writable HA entities (bypass the UI lock) |
| `STATS_SOLAR_THRESHOLD_W` | `200` | PV power threshold (W) for the solar-day window (start/end of stable output) |
| `STATS_SOLAR_DWELL_MIN` | `15` | Minutes of sustained output/silence required before flagging the solar-day start/end |

The full list of MQTT variables is in [`server/.env.example`](server/.env.example).

### 🔑 Authentication

The app always requires login. Users and passwords are stored in `data/auth.db`.

- Two roles: **admin** (full access) and **viewer** (Overview and Statistics only).
- On first start, **admin/admin** and **user/user** are created — both must change
  their password on first login.
- The admin manages users on the **"Users"** page (create, change role, reset
  password, delete). The last remaining admin can't be deleted or demoted.
- Anti-brute-force: after 5 wrong passwords from one IP — a 10-minute lockout.
- Forgot your password? `cd server && DATA_DIR=data npx tsx scripts/reset-password.ts <username> <newpass>`.

**API tokens.** Machine clients (the MCP server, scripts) authenticate with
`Authorization: Bearer inv_…` instead of a session cookie. An admin issues them in the
**API tokens** section of the Users page, or from the Pi:

```bash
cd server && DATA_DIR=data npx tsx scripts/issue-token.ts "mcp laptop" --write --days 90
```

A token inherits its owner's role and carries scopes: `read` (everything that role may
read) and optionally `write` (control, lock, raw writes, baseline recapture). Without the
`write` scope those endpoints answer `403 scope_required`; `POST /api/control` with
`{"preview": true}` stays available, since it only reports what *would* be written.
Tokens are stored as sha256 — the value is shown exactly once — and they can never reach
`/api/users` or `/api/tokens`: managing access requires a UI session. A token belonging to
a user who still must change their password is rejected. `GET /api/me` reports
`auth: "session" | "token"` and the active scopes; `/ws` accepts the same Bearer header.

> **Before port-forwarding on your router**, put a TLS reverse proxy (Caddy/nginx +
> Let's Encrypt) in front, or use a VPN (WireGuard). Bare HTTP exposed to the internet
> leaks the session cookie in plain text. `AUTH_SESSION_TTL_DAYS` controls the session
> lifetime (days).

---

## 🖥️ Web interface

- **Header** — connection status (Connected / Demo data / No connection), current mode (Grid / Battery / Bypass / Charging / …), last update time.
- **Battery** — state of charge (SoC ring), voltage, charge/discharge current, state.
- **Solar (PV)** — power, voltage, current.
- **Solar today** — start/end of today's stable solar window (idle / active / ended), backed by `GET /api/stats/solar-window`.
- **Load** — active power, apparent power (VA), load %, voltage/frequency.
- **Grid** — consumed power, voltage, frequency, inverter temperature.
- **Current settings & baseline** — a "Current / Baseline" table with drift highlighting (including SOC thresholds for lithium batteries), function switches, a "Re-read baseline" button.
- **Control** — lock status and an Unlock/Lock button; output source priority, charging priority, max charging current, max AC charging current. Every change requires confirmation; the lock re-engages automatically after a write.
- **Diagnostics** — read/write arbitrary Modbus registers (`R 201 10`, `W 331 1`).
- **Statistics** (`/stats`) — charts, daily totals with solar start/end columns, and the event log (see [Statistics](#-statistics)).
- **Users** (`/users`, admin only) — create accounts, change roles, reset passwords, delete.

Navigation adapts to the role: an **admin** sees every page; a **viewer** sees only
Overview and Statistics (enforced server-side, not merely hidden in the UI). Everything
updates in real time over WebSocket with automatic reconnection.

---

## 🌐 API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/login` | `{username, password}` — log in, sets a session cookie |
| `POST` | `/api/logout` | Log out, revokes the session |
| `GET` | `/api/me` | Current user — `{username, role, mustChangePassword}` |
| `POST` | `/api/change-password` | `{currentPassword, newPassword}` — change your own password |
| `GET`·`POST`·`PATCH`·`DELETE` | `/api/users…` | User management (admin only) — list / create / change role / reset password / delete |
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/snapshot` | Current snapshot (status, mode, settings, warnings) |
| `GET` | `/api/meta` | Value maps for the controls |
| `POST` | `/api/control` | `{type, value}` — write a setting (whitelist; rejected while locked) |
| `POST` | `/api/lock` | `{locked}` — engage/release the write lock |
| `GET` | `/api/baseline` | The settings baseline captured on connect |
| `POST` | `/api/baseline/recapture` | Re-read the settings and overwrite the baseline |
| `POST` | `/api/raw` | `{command}` — raw Modbus: `"R <addr> [count]"` always reads, `"W <addr> <value>"` requires the lock to be released |
| `WS` | `/ws` | Real-time snapshot push |

`/api/control` types: `outputSourcePriority` (register 301), `chargerSourcePriority` (331),
`maxChargingCurrent` (332), `maxAcChargingCurrent` (333), `batteryRechargeVoltage` (327),
`batteryRedischargeVoltage` (326).

```bash
curl -X POST http://<pi-address>:3000/api/control \
  -H 'Content-Type: application/json' \
  -d '{"type":"chargerSourcePriority","value":3}'   # 3 = Only PV
```

---

## 📊 Statistics

The daemon keeps a telemetry history in SQLite (`server/data/stats.db`, the built-in
`node:sqlite` module, requires Node ≥ 24). Snapshots are buffered in memory and flushed
to disk once a minute (to spare the SD card). Tiered retention: raw 5-second snapshots
— 30 days (`STATS_RAW_DAYS`), per-minute aggregates — 2 years (`STATS_MINUTE_DAYS`),
daily summaries and the event log — kept indefinitely. Disable with `STATS_ENABLED=false`.

The **/stats** page in the web UI: a separate power chart per metric (PV, load, grid,
battery), battery and temperature charts, daily kWh totals with **solar start/end
columns**, energy bars (solar generated / taken from the grid), and an event log (mode
changes, grid loss/restore, faults, connectivity), plus CSV export.

The **solar day window** — when PV output stably starts and stops for the day — is
computed retrospectively from the per-minute PV series (threshold
`STATS_SOLAR_THRESHOLD_W`, dwell time `STATS_SOLAR_DWELL_MIN`) and stored per day
(`solar_start_ts`/`solar_end_ts`, part of `/api/stats/daily`). Today's live window —
including while it's still in progress — is served by `GET /api/stats/solar-window`
and shown as a "Solar today" panel on the dashboard.

API: `GET /api/stats/series|daily|energy|events|solar-window|export.csv`
(session-authenticated, same as the rest of the API). If the database is unavailable
— `503`; core monitoring keeps running regardless.

> On Node 24.11.0, the built-in `node:sqlite` module prints an `ExperimentalWarning`
> to stderr at server startup — harmless, safe to ignore.

---

## 🏠 Home Assistant (MQTT)

The application can publish data to **MQTT with Home Assistant auto-discovery** — HA
creates all entities by itself. The integration is **disabled** by default (empty `MQTT_URL`).

1. A running **MQTT broker** (usually the **Mosquitto** add-on in HA) and the **MQTT** integration enabled.
2. Point `server/.env` at the broker and restart the service:
   ```bash
   MQTT_URL=mqtt://ha-user:ha-pass@BROKER-IP:1883
   # optional — control the inverter from HA (bypasses the UI write lock):
   MQTT_ENABLE_CONTROL=true
   sudo systemctl restart inverter-monitor
   ```
3. In HA (**Settings → Devices & Services → MQTT**) a device named **"Inverter SK-5500P-48L"** appears with all its sensors.

**Published:** PV/battery/load/grid/temperature/mode/warning sensors; binary sensors
for "online", "problem", "write locked"; with `MQTT_ENABLE_CONTROL=true` — writable
`select` entities (source priorities, charging currents).

**Topics:** state — `inverter/<node>/state` (JSON), availability — `inverter/<node>/availability`,
commands — `inverter/<node>/set/<param>`, discovery — `homeassistant/<component>/<node>/<key>/config`.

> `MQTT_ENABLE_CONTROL=true` allows writes from HA bypassing the UI lock — the flag
> itself is the deliberate authorization. Commands still go through validation and
> the whitelist.
>
> Don't install Home Assistant itself on a Pi 3B (~1 GB RAM) — it's below HA's
> recommended requirements. Run HA on a beefier node; this application will connect
> to its broker over MQTT from anywhere on the network.

---

## 🔒 Control safety & write lock

The application is designed around the principle of **"read, but never overwrite until
you need to"**:

- **Nothing is ever written automatically.** Polling sends only register reads (fn 0x03). Writes happen exclusively on explicit action.
- **The write lock is engaged by default** (`STARTUP_LOCKED=true`). Until you press "Unlock" (or call `POST /api/lock`), all writes are rejected — via the UI and the API alike (including `W` commands in `/api/raw`).
- **Automatic re-locking** after every successful write (`AUTO_RELOCK=true`).
- **Settings baseline** — on first connect, all current settings (registers 300–343) are read once and persisted to disk. The UI **highlights drift** from the baseline. When a different device connects, the baseline is captured anew.
- **Reading is safe; writing is not.** Changing voltage thresholds, charging currents and priorities can harm the battery or the load. Change one parameter at a time.
- All writes go through a **register whitelist** with value validation; a write failure = a Modbus exception from the inverter.
- For a complete, irreversible write ban — `ALLOW_CONTROL=false` (cannot be unlocked).

---

## 🧪 What's been verified

**On a live inverter (2026-07-23):**

- RS232 transport (FTDI FT231X with true RS232 levels) + Modbus RTU 9600, slave 1.
- Register reads: mode (201), grid voltage (202 → 232.7 V), battery (215 → 52.2 V), SOC (229 → 72 %) — the values match reality.
- The request/response reference frames are pinned in the jest tests.

**Without hardware (mock, full cycle):**

- The server, every REST endpoint, WebSocket, the web UI, writes via fn 0x10 with auto-relock.
- TypeScript builds, installation on the Pi, systemd autostart.

**Still to be verified on the live inverter:**

- Full block reads (status 201–234 in one cycle) and the behaviour of registers absent from the esphome map.
- Actual setting writes (the whitelisted setters) — do the first write with the inverter's front panel in sight.

---

## 🗂️ Project structure

```
inverter-monitor/
├── package.json                  # root: workspaces + build/dev/check
├── deploy.sh                     # build → rsync → npm ci → restart → health
├── CLAUDE.md                     # guide for Claude Code
├── shared/
│   └── src/{types.ts, api.ts, auth.ts, index.ts}   # shared types + control contract + auth types
├── server/
│   ├── .env.example  systemd/inverter-monitor.service
│   ├── scripts/reset-password.ts             # CLI password reset
│   ├── src/{index,config,inverter,server,mqtt,store}.ts
│   ├── src/auth/{hash,db,policy,service}.ts  # scrypt, AuthDb (node:sqlite), roles, sessions
│   ├── src/stats/{db,recorder}.ts            # SQLite history, rollups, event derivation
│   ├── src/protocol/{modbus,smg}.ts          # Modbus RTU + SMG II register map
│   ├── src/transport/{types,serial,mock,detect}.ts
│   └── src/**/*.test.ts                      # jest — co-located with the sources they cover
└── web/
    ├── next.config.ts
    ├── app/{layout.tsx, login/, change-password/, (app)/{page,stats,settings,diagnostics,users}}
    ├── components/{Panel,ConfirmDialog,LangSwitch,BatteryRing,TimeChart}.tsx
    └── lib/{api,format,snapshot,meta,stats,toast}.ts + i18n/{dict,index}
```

---

## 🛠️ Troubleshooting

- **"Demo data" instead of real values** — the inverter wasn't found. Check the connection (`lsusb`, `/dev/ttyUSB*`), permissions (`dialout`), and above all that the adapter has **true RS232 levels** (minus 5…12 V idle on TX; USB-TTL does not work with this inverter). Set `INVERTER_SERIAL_DEVICE` / `INVERTER_TRANSPORT` explicitly.
- **Timeouts on every request** — check the Modbus ID in the inverter menu (#25, must match `MODBUS_SLAVE_ID`) and the speed (SMG II only answers at 9600).
- **CRC mismatch in the logs** — a bad cable/contacts or interference. Check the RJ45 crimp and the DB9 junction.
- **Modbus exception on write** — the register/value isn't supported by this firmware. Check the register map (esphome-smg-ii) via Diagnostics (`R <addr>`).
- **Port busy** — only one poller may be active; make sure the stock dongle is unplugged and no parallel instances are running.

---

## 📄 License

[MIT](LICENSE).
