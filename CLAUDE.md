# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository. It covers the host/workspace level only — module-specific guidance lives next to
each module (see `modules/inverter/CLAUDE.md`).

## About the project

`sweethome` is a modular monolith for local, cloud-free home control, running on a
Raspberry Pi (minimum Pi 3B). One Node process hosts independent subsystem modules behind a
single web UI, a shared authentication system and a single deploy.

Modules: `modules/inverter` — monitoring and control of an ISolar/EASUN SMG II hybrid
inverter over Modbus RTU (see `modules/inverter/CLAUDE.md` for its protocol, architecture
and write-safety model). `modules/cctv` — local, cloud-free recording, live view and
archive playback for two ONVIF/RTSP cameras, with all video going through an external
`ffmpeg` (see `modules/cctv/CLAUDE.md` for the camera hardware findings and review
lessons). Heating is designed but not yet implemented — see `docs/heating/SPEC.md`; the
implementation will land as its own module (`modules/heating`) in a later pass.

Unification design (why the repo looks the way it does): `docs/superpowers/specs/2026-08-01-sweethome-unification-design.md`.

## Commands (from the repository root)

```bash
npm install        # installs dependencies for all workspaces at once (this is a monorepo)
npm run dev        # server :3000 (forces INVERTER_TRANSPORT=mock) + web :3001 (Next.js HMR, proxies /api to :3000)
npm run build      # STRICTLY in the order packages/shared → packages/home-mcp → packages/inverter-shared → packages/inverter-mcp → modules/inverter → packages/cctv-shared → modules/cctv → server → web
npm run check      # jest: home-mcp + inverter-mcp + inverter (protocol/transport/stats/mqtt/store/router/mcp) + cctv (recorder/index/live/router/mcp) + server (auth/host/http/mcp) + typecheck (web)
npm test           # same as check, but with the web jest suite instead of typecheck: inverter-mcp → inverter → cctv → server → web
./deploy.sh        # local build → rsync to the Pi → npm ci → systemd restart (incl. enabling autostart) → health check
```

> ⚠️ Node in your shell must be **≥ 24** (`.nvmrc` = 24). With an older version active the
> tests fail not on assertions but on module load: `No such built-in module:
> node:sqlite`. Fix it with `nvm use` or by prefixing the command with
> `PATH="$HOME/.nvm/versions/node/v24.x.y/bin:$PATH"`.

- **`npm test -w @sweethome/inverter` runs jest** (14+ suites): the protocol
  (`src/protocol/modbus.test.ts`, `smg.test.ts`, `registers.test.ts` — consistency of the
  register map with the decoders), transport (`src/transport/detect.test.ts`,
  `mock.test.ts`, `serial.test.ts`), SQLite statistics (`src/stats/db.test.ts`,
  `solar.test.ts`, `recorder.test.ts`), MQTT (`src/mqtt.test.ts`), the baseline store
  (`src/store.test.ts`), the REST router (`src/router.test.ts`), the inverter core
  (`src/inverter.test.ts`), config (`src/config.test.ts`) and the MCP local gateway
  (`src/mcp/local-gateway.test.ts`). **After changing anything under
  `modules/inverter/src/protocol/*`, always run `npm test -w @sweethome/inverter`.**
- **`npm test -w @sweethome/cctv` runs jest** (17 suites): the index (`index/db.test.ts`,
  `scanner.test.ts`, `retention.test.ts`, `playlist-parse.test.ts`, `spans.test.ts`),
  playlist generation (`playlist.test.ts`), the recorder (`recorder/ffmpeg.test.ts`,
  `process.test.ts`, `manager.test.ts`), live view (`live/hub.test.ts`), ONVIF motion
  events (`events/onvif.test.ts`), the archive download route (`download.test.ts` for the
  file-name helper, `router.test.ts` for the route itself, which streams the segments),
  config (`config.test.ts`), the MCP tools (`mcp/tools.test.ts` — through a real MCP client
  over `InMemoryTransport` — and `mcp/snapshot.test.ts` for frame grabbing) and the
  assembled module (`module.test.ts`). No real cameras or disk needed — see `modules/cctv/CLAUDE.md` for the hardware findings behind
  the fixtures.
- **`npm test -w @sweethome/server` runs jest**: password hashes/roles/auth flows and
  tokens (`src/auth/hash.test.ts`, `db.test.ts`, `service.test.ts`, `tokens.test.ts`), the
  module host (`src/host.test.ts`), config (`src/config.test.ts`), authorization through
  the real `createServer` over HTTP (`src/server.http.test.ts`: gates, roles, forced
  password change, Bearer and scopes, legacy-page redirects), and the `/mcp`
  mounting/session plumbing (`src/mcp/http.test.ts` — the MCP tools themselves are covered
  by the `inverter-mcp` workspace's own tests). Its jest config also runs the pure
  `@sweethome/shared` and `@sweethome/inverter-shared` modules
  (`packages/shared/src/{auth,module}.test.ts`, `packages/inverter-shared/src/{settings,source}.test.ts`
  — see the `roots` list in `server/jest.config.cjs`). None of this is a typecheck.
- `npm run check` for `server`/`inverter`/`inverter-mcp`/`cctv` is jest, NOT a type check.
  Their types are only checked by the build (`tsc` in `npm run build`). The `web` workspace
  is checked separately (`tsc --noEmit`).
- Deploying to the Pi — `PI_HOST=pi@… SSH_KEY=~/.ssh/… ./deploy.sh`; note that the script
  rebuilds everything locally, uploads the artifacts and **restarts the live systemd
  service** on the Pi (see "Deploying to the Pi" below). The actual host/key are outside
  the repository (the owner's local environment).
- Node: `engines` is pinned to **≥ 24** in the root, `server` and `packages/inverter-mcp`
  package.json files (the built-in `node:sqlite`, used for the inverter's statistics, needs
  it). The Pi itself already runs **Node 24** (Raspberry Pi OS Trixie, arm64) — matching
  the declared minimum.

## Architecture

An npm-workspaces monorepo, strict build order: `packages/shared` → `packages/home-mcp` → `packages/inverter-shared`
→ `packages/inverter-mcp` → `modules/inverter` → `packages/cctv-shared` → `modules/cctv` →
`server` → `web`. Each package imports the previous ones from their **built `dist/`**, not
from source, so the order is not arbitrary.

### `server/` — the host
Express (REST under `/api` + serving the `web/out` static files) and WebSocket. The host
owns cross-cutting concerns and knows nothing about any module's internals:
- **`src/auth/`** — sessions, tokens and roles; shared by every module (see
  "Authorization" below).
- **`src/host.ts`** (`ModuleHost`) — starts/stops the module list with per-module error
  isolation, and aggregates `GET /api/health` into `{ ok, modules: { <id>: ModuleHealth } }`.
- **Mounting** (`src/server.ts`): for each module, its `apiRouter` goes under `/api/<id>`,
  an optional WebSocket goes under `/ws/<id>` (gated by the same cookie/Bearer check as
  `/api`), and an optional `attachHttp` hook wires routes outside the `/api/<id>` prefix.
- **`src/mcp/http.ts`** — the single `/mcp` endpoint (Streamable HTTP) for LLM agents,
  behind the same authorization as `/api`. It belongs to the host, not to a module: the
  address is one, and the tools come from whichever modules carry an `mcp` provider
  (`isMcpCapable` / `buildHomeMcpServer` from `@sweethome/home-mcp`). A server is built per
  session because the tool set depends on the presented token's rights. `MCP_ENABLED` /
  `MCP_MAX_SESSIONS` are host config now (they used to live in the inverter's).
- **Legacy redirects**: the old top-level `/stats`, `/settings`, `/diagnostics` page URLs
  301 to `/inverter/stats`, `/inverter/settings`, `/inverter/diagnostics` (old bookmarks
  and any external links keep working).
- The module contract is `HomeModule` from `@sweethome/shared/module`
  (`packages/shared/src/module.ts`): `id`, `apiRouter`, optional `ws`/`attachHttp`,
  `start()`/`stop()`/`health()`. `writeSource`/`denyWithoutWrite`/`requireAdmin` — the
  helpers a module's own router uses to enforce the write scope / admin role — also live
  there, so every module gets the same enforcement without the host knowing its routes.

### `modules/inverter`
The inverter module. See `modules/inverter/CLAUDE.md` for the protocol, the layered
architecture (`protocol/`, `transport/`, `inverter.ts`, `stats/`, `mqtt.ts`, MCP) and the
write-safety model.

### `packages/`
- **`shared`** (`@sweethome/shared`) — the system-level contract: `auth.ts` (`Role`,
  `canAccess`, `TokenScope`, `SessionUser`/`PublicUser`/`PublicApiToken`), `module.ts` (the
  `HomeModule` interface described above), `env.ts` (`envInt`/`envBool`).
- **`inverter-shared`** (`@sweethome/inverter-shared`) — re-exports `@sweethome/shared` and
  adds the inverter's own contract: types (`Snapshot`, …), the control whitelist
  (`api.ts`), the register map (`registers.ts`), the pure `diffSettings` (`settings.ts`),
  the derived power source (`source.ts`).
- **`home-mcp`** (`@sweethome/home-mcp`) — the MCP layer shared by every module: the
  `ModuleMcpProvider` contract a module implements to hand over its tools, `buildHomeMcpServer`
  (one server per session, instructions composed from the modules), and the time helpers
  (`parseTime`/`parseDay`/`localDay`/`localIso`) tools use to read and print times.
- **`inverter-mcp`** (`@sweethome/inverter-mcp`) — the inverter's own tools/resources/prompts
  plus its stdio binary; see `modules/inverter/CLAUDE.md`.

### `web/` — Next.js (App Router)
- **Production = static export** (`output: "export"` in `next.config.ts`) into `web/out/`,
  served by Express itself. **Dev** = `next dev -p 3001` + rewrites `/api/*` →
  `http://localhost:3000` (see `next.config.ts`). The same split drives
  `web/lib/api.ts::wsUrl(moduleId)`, which picks between dev (`ws://localhost:3000/ws/<id>`)
  and production.
- **Routes**: `/` — the home overview (compact per-module status cards linking into each
  module's section); `/inverter/*` — the inverter module's pages; `/cctv` — live view
  (one camera at a time, tabs to switch) and `/cctv/archive` — the archive with its
  timeline, time field and player; `/users` — user/token management (admin only).
  `app/login/` and `app/change-password/` are open. The shared app shell — top navigation,
  session, logout, toasts — lives in `app/(app)/layout.tsx` + `web/lib/session.tsx`
  (`GET /api/me`); it grows a nav entry per module ("Overview", "Inverter", "CCTV", plus
  "Users" for admins).
- **Video playback lives in `web/components/cctv/`** and does not use the browser's own
  player controls: what the device forced on those two components is written up in
  `modules/cctv/CLAUDE.md` ("Browser side"). Read it before touching them — the
  non-obvious parts are load-bearing, not stylistic.
- **Role-gated pages** — currently `/inverter/settings`, `/inverter/diagnostics` and
  `/users` — are enforced both on the server (`ADMIN_PAGES` in `src/server.ts`: redirects
  a `viewer` to `/`) and client-side (`ADMIN_PATH_PREFIXES` in
  `app/(app)/layout.tsx`, a defense-in-depth guard for SPA navigation). A `viewer` reaches
  `/`, `/inverter`, `/inverter/stats` and both camera pages — watching and rewinding is
  deliberately not an admin privilege (spec §13).
- **i18n** (`web/lib/i18n/`): a typed UA/RU/EN dictionary shared by the whole app. The
  initial language is hard-coded to `uk` to match the SSG prerender (otherwise hydration
  mismatches); the real choice is picked up from `localStorage` after mount.

### Authorization (`server/src/auth/`)
- `hash.ts` — scrypt password hashing (built-in `crypto`, no dependencies).
- `db.ts` — `AuthDb` on `node:sqlite` (`server/data/auth.db`): users + sessions, seeding
  admin/user when the database is empty.
- `service.ts` — the `Auth` class: login/sessions/password change, per-IP brute-force
  protection.
- The pure `canAccess(role, required)` lives in `packages/shared/src/auth.ts` (covered by
  `packages/shared/src/auth.test.ts`), not in `server/src/auth/` — it is a system-level
  primitive so module routers can reuse it via the `requireAdmin` helper.
- Two roles: `admin` (everything) / `viewer` (see "Role-gated pages" above for the current
  page split). The restrictions are enforced both on the server (403 middleware + page
  redirects) and in the UI (role-based navigation).
- Forced password change: `must_change_password=1` blocks all of `/api` except
  `me`/`change-password`/`logout` until the password is changed.
- **API tokens** (the `api_tokens` table in `auth.db`, `Authorization: Bearer inv_…`, sha256
  in the database, `read`/`write` scopes): the `/api` middleware tries the cookie first, then
  Bearer, and puts `kind`/`scopes`/`tokenName` into `req.auth`. Each module's own router
  decides which of its routes need the `write` scope (via `denyWithoutWrite`) or the
  `admin` role (via `requireAdmin`) — the host itself only gates `/api/users` and
  `/api/tokens` this way. Those two stay closed to tokens entirely
  (`code: session_required`) — access management happens only from a UI session. A token
  whose owner is under a forced password change is rejected. Issuing: the UI on `/users`,
  `POST /api/tokens`, or `server/scripts/issue-token.ts`. Every `/ws/<id>` accepts the same
  Bearer token.
- Tests — `hash.test.ts`, `db.test.ts`, `service.test.ts`, `tokens.test.ts` (jest, part of
  `npm test -w @sweethome/server`); the HTTP flows — `src/server.http.test.ts`; the module
  host — `src/host.test.ts`; the `/mcp` endpoint — `src/mcp/http.test.ts` (authorization,
  sessions, the session cap, the switch, and that one session serves every module's tools).

## Deploying to the Pi (important details)

- The build is **entirely local**; the Pi only runs
  `npm ci -w server -w modules/inverter -w packages/inverter-mcp -w modules/cctv
  -w packages/cctv-shared -w packages/home-mcp --omit=dev` + a systemd restart. The Pi
  compiles nothing. `rsync` uploads `packages/shared/dist`, `packages/home-mcp/dist`,
  `packages/inverter-shared/dist`, `packages/inverter-mcp/dist`, `modules/inverter/dist`,
  `packages/cctv-shared/dist`, `modules/cctv/dist`, `server/dist`, `web/out` and the
  workspace manifests.
- **`modules/cctv` needs two things on the Pi that nothing else in this project does**: an
  external **`ffmpeg`** binary (`sudo apt install ffmpeg` — Node alone cannot decode what
  these cameras send; see `modules/cctv/CLAUDE.md` for why) and a mounted **`/mnt/cctv`**, a
  dedicated mount point for video, separate from the existing `/mnt/rancho-backup` (both are
  prepared by hand once — spec §15). `deploy.sh` runs `command -v ffmpeg` on the Pi before
  restarting the service and fails with a clear message if it is missing; it does not check
  the mount itself — a missing `/mnt/cctv` shows up as "storage unavailable" in `health()`
  and the UI rather than as a failed deploy (spec §16).
- The Pi directory is `/home/pi/sweethome` (renamed from `/home/pi/inverter-monitor`);
  `deploy.sh` performs that one-time move itself the first time it runs against an
  unmigrated Pi (stops the old `inverter-monitor` unit, moves the directory, splits the
  data layout — see below — and removes the old unit file). Nothing to do by hand.
- **Data layout**: `server/data/auth.db` is system-level (shared by every module);
  module-owned data lives one directory per module id — the inverter module's is
  `server/data/inverter/{stats.db,baseline.json}`. `auth.db`/`stats.db` are created
  automatically on first start; `deploy.sh` does not touch the `data/` directory except
  for the one-time migration above.
- The systemd unit is `sweethome.service` (`server/systemd/sweethome.service`,
  `WorkingDirectory=…/server`).
- **`deploy.sh` enables autostart itself** (`systemctl enable`) as part of every deploy —
  this is not a separate manual step.

## Git workflow

- Repository: `git@github.com:apanamaryov/sweethome.git` (remote `origin`, default branch `main`).
- New changes go through feature branches and PRs — do not commit directly to `main`.
- Do not merge into `main` without explicit confirmation from the user.
- **Commit messages are written in English** (the repository is public, the README and the code are in English), in conventional-commits format: `feat(web): …`, `fix(mcp): …`, `docs: …`. Commits before 2026-07-28 are in Russian — that is legacy, no need to rewrite them. Conversation with the user still happens in Russian.
- Secrets (`server/.env`, real passwords/Pi data) never enter the repository — they live outside git and in `.gitignore`.
