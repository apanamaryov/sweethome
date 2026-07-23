<div align="center">

# 🔋 Inverter Monitor — SK-5500P-48L

**Local monitoring and control of a hybrid inverter, talking to it directly — no SmartESS cloud.**

![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)
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
- 🔑 **Authentication** (optional) — password login, HttpOnly sessions, brute-force protection.
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
(`01 03 00 C9 00 01 54 34` → `01 03 02 00 03 F8 45`) — see `server/scripts/selfcheck.ts`.

---

## 📑 Contents

- [Quick start (development)](#-quick-start-development)
- [Connecting the inverter to the Pi](#-connecting-the-inverter-to-the-pi-hardware)
- [Deploying to the Pi](#-deploying-to-the-pi)
- [Configuration (`.env`)](#️-configuration-env)
- [Web interface](#️-web-interface)
- [API](#-api)
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
builds happen on a regular machine (not on the Pi); Node ≥ 20.

```bash
git clone https://github.com/apanamaryov/sweethome.git inverter-monitor
cd inverter-monitor
npm install    # installs dependencies for all workspaces at once
npm run dev    # server :3000 (mock data) + UI :3001 (Next.js, HMR)
```

Open `http://localhost:3001` — in dev mode the UI proxies `/api/*` to the server
on `:3000` (see `web/next.config.ts`).

Before committing, run the static checks (web typecheck + protocol selfcheck):

```bash
npm run check
```

> For the server, `npm run check` runs **`server/scripts/selfcheck.ts`** — not a
> typecheck but a verification of reference Modbus frames (captured from a live
> inverter), CRC, register decoders and setters. Run it after any change under
> `server/src/protocol/*`.

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

**Requirements:** Raspberry Pi (tested on a Pi 3B), **Node.js ≥ 18**; building the
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
4. Checks `GET /api/health` (up to a minute for the restart); `200` without auth or `401` with auth — both mean "the server is alive".

- `PI_HOST` — user and address of your Pi (defaults to `pi@raspberrypi.local`).
- `SSH_KEY` — path to a private key if the ssh agent doesn't pick one up.

On the Pi, config and data live in `server/.env` and `server/data/` (`baseline.json`,
`sessions.json`); static files are served by the server itself from `web/out/`.
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
| `DATA_DIR` | `data` | Where to persist the settings baseline (`baseline.json`) |
| `AUTH_PASSWORD` | — | UI/API login password. Empty = no auth (trusted LAN) |
| `AUTH_SESSION_TTL_DAYS` | `30` | Session cookie lifetime |
| `MQTT_URL` | — | MQTT broker address (`mqtt://user:pass@host:1883`). Empty = MQTT disabled |
| `MQTT_ENABLE_CONTROL` | `false` | Writable HA entities (bypass the UI lock) |

The full list of MQTT variables is in [`server/.env.example`](server/.env.example).

### 🔑 Authentication

With `AUTH_PASSWORD` set, the entire UI, API and WebSocket require login (a `/login`
page, HttpOnly cookie; sessions survive restarts — `server/data/sessions.json` stores
only SHA-256 token hashes). After 5 wrong passwords from one IP — a 10-minute lockout.

> **Before port-forwarding on your router**, make sure to set `AUTH_PASSWORD`. Bare
> HTTP exposed to the internet leaks the password and cookies in plain text — from
> outside, prefer a VPN (WireGuard) or a TLS reverse proxy (caddy/nginx + Let's Encrypt).

---

## 🖥️ Web interface

- **Header** — connection status (Connected / Demo data / No connection), current mode (Grid / Battery / Bypass / Charging / …), last update time.
- **Battery** — state of charge (SoC ring), voltage, charge/discharge current, state.
- **Solar (PV)** — power, voltage, current.
- **Load** — active power, apparent power (VA), load %, voltage/frequency.
- **Grid** — consumed power, voltage, frequency, inverter temperature.
- **Current settings & baseline** — a "Current / Baseline" table with drift highlighting (including SOC thresholds for lithium batteries), function switches, a "Re-read baseline" button.
- **Control** — lock status and an Unlock/Lock button; output source priority, charging priority, max charging current, max AC charging current. Every change requires confirmation; the lock re-engages automatically after a write.
- **Diagnostics** — read/write arbitrary Modbus registers (`R 201 10`, `W 331 1`).

Everything updates in real time over WebSocket with automatic reconnection.

---

## 🌐 API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/login` | `{password}` — log in, sets a session cookie |
| `POST` | `/api/logout` | Log out, revokes the session |
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
- The request/response reference frames are pinned in the selfcheck.

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
│   └── src/{types.ts, api.ts, index.ts}   # shared types + control contract
├── server/
│   ├── .env.example  systemd/inverter-monitor.service
│   ├── scripts/selfcheck.ts      # reference Modbus frames, CRC, decoders, setters
│   ├── src/{index,config,inverter,server,auth,mqtt,store}.ts
│   ├── src/protocol/{modbus,smg}.ts       # Modbus RTU + SMG II register map
│   └── src/transport/{types,serial,mock,detect}.ts
└── web/
    ├── next.config.ts
    ├── app/{layout.tsx, login/, (app)/{page,settings,diagnostics}}
    ├── components/{Panel,ConfirmDialog,LangSwitch,BatteryRing}.tsx
    └── lib/{api,format,snapshot,meta,toast}.ts + i18n/{dict,index}
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
