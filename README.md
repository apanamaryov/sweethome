# sweethome

Local, cloud-free home control running on a Raspberry Pi (3B or better).
A modular monolith: one Node process hosts independent subsystem modules
behind a single web UI, shared authentication and a single deploy.

## Modules

- **inverter** — monitoring and control of an ISolar SMG II hybrid inverter
  over Modbus RTU. See [modules/inverter/README.md](modules/inverter/README.md).
- **cctv** — round-the-clock recording, live view and seekable archive for IP
  cameras, with no vendor cloud. See [modules/cctv/README.md](modules/cctv/README.md).
- **heating** — designed, not yet implemented. See [docs/heating/SPEC.md](docs/heating/SPEC.md).

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
