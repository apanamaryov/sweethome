# sweethome

Local, cloud-free home control running on a Raspberry Pi (3B or better).
A modular monolith: one Node process hosts independent subsystem modules
behind a single web UI, shared authentication and a single deploy.

## Modules

- **inverter** — monitoring and control of an ISolar SMG II hybrid inverter
  over Modbus RTU. See [modules/inverter/README.md](modules/inverter/README.md).
- **cctv** — round-the-clock recording, live view and seekable archive for IP
  cameras, with no vendor cloud. See [modules/cctv/README.md](modules/cctv/README.md).
- **dryer** — a food dehydrator with presets, humidity-driven autostop and run
  history, controlled through an ESP32/ESPHome node over MQTT. See
  [modules/dryer/README.md](modules/dryer/README.md).
- **heating** — designed, not yet implemented. See [docs/heating/SPEC.md](docs/heating/SPEC.md).

## For LLM agents (MCP)

One endpoint — `POST/GET/DELETE /mcp` (Streamable HTTP, same auth as the API) —
serves the whole home: every module contributes its own tools to it, so an agent
connects once and sees all of them. The inverter brings readings, statistics and
(behind a scoped token) control; the cameras bring recording state, storage,
what was recorded when, and actual frames — live or from the archive. Details:
[modules/inverter/README.md](modules/inverter/README.md#-mcp-llm-agents) and
[modules/cctv/README.md](modules/cctv/README.md).

## Stack

Node ≥ 24, TypeScript, npm workspaces, Express + WebSocket, Next.js (static
export), SQLite via node:sqlite, jest. Deploys to a Pi with rsync + systemd
(`./deploy.sh`).

The `cctv` module additionally needs an external `ffmpeg` on the Pi and a mount
point for the recordings — see its README.

## Development

```bash
npm install && npm run dev   # server :3000 (mock transport) + web :3001
npm test                     # all workspaces
```
