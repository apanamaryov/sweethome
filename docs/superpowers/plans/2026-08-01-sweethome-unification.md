# Sweethome Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перестроить репозиторий `sweethome` из «приложения инвертора» в модульный монолит умного дома: хост-сервер + модуль инвертора + единый веб с обзором дома, по спеке `docs/superpowers/specs/2026-08-01-sweethome-unification-design.md`.

**Architecture:** Один Node-процесс: `server/` — хост (Express, auth, WS, статика, монтаж модулей), `modules/inverter/` — весь инверторный код за контрактом `HomeModule`, `packages/*` — shared-пакеты, `web/` — единый Next.js (static export). Реализация отопления — вне скоупа, только каркас.

**Tech Stack:** Node ≥ 24 (`node:sqlite`), TypeScript, npm workspaces, Express 4, ws, Next 15 (App Router, `output: "export"`), jest + ts-jest, MCP SDK.

## Global Constraints

- Node ≥ 24 обязателен и в shell (`nvm use`), иначе тесты падают на `No such built-in module: node:sqlite`.
- Порядок сборки строго: `packages/shared → packages/inverter-shared → packages/inverter-mcp → modules/inverter → server → web` (каждый следующий импортирует **из dist** предыдущих).
- Имена env-переменных (`INVERTER_*`, `MQTT_*`, `STATS_*`, `MCP_*`, `AUTH_*`, `PORT`, `HOST`, `DATA_DIR`) **не переименовывать**.
- Ветка: `feat/sweethome-unification` (уже создана). Коммиты — на английском, conventional commits (`refactor(...)`, `feat(web): ...`). Без `Co-Authored-By`. В `main` не мержить без явного подтверждения пользователя.
- После каждого таска: `npm run build && npm run check` зелёные (плюс `npm test` там, где указано).
- В инверторном коде скейлинг регистров — **делением** (`/10`), не умножением на 0.1.
- Тесты лежат рядом с кодом (`*.test.ts`) и переезжают вместе с ним.
- Playwright не запускать; деплой на Pi — только по явной просьбе пользователя.
- Линтить только изменённые файлы: `npx eslint <file1> <file2>`, после — проверить `git status`.
- `node_modules`, `dist`, `web/out`, `web/.next`, `coverage` не трогать руками — их пересоздают `npm install` / build.

---

### Task 1: Переезд workspace-каталогов и переименование пакетов

Каталоги `shared/` и `mcp/` переезжают в `packages/`, все пакеты получают scope `@sweethome/*`. Функциональность не меняется — только пути и имена.

**Files:**
- Move: `shared/` → `packages/inverter-shared/`, `mcp/` → `packages/inverter-mcp/`
- Modify: `package.json` (корень), `packages/inverter-shared/package.json`, `packages/inverter-mcp/package.json`, `server/package.json`, `web/package.json`
- Modify: `server/jest.config.cjs`, `packages/inverter-mcp/jest.config.cjs`, `web/jest.config.mjs`, `server/tsconfig.test.json`, `packages/inverter-mcp/tsconfig.test.json`
- Modify: все `*.ts`/`*.tsx` с импортами `@inverter/*` (список даёт grep, см. шаг 3)

**Interfaces:**
- Consumes: текущие пакеты `@inverter/shared`, `@inverter/mcp`, `@inverter/server`, `@inverter/web`.
- Produces: пакеты `@sweethome/inverter-shared`, `@sweethome/inverter-mcp`, `@sweethome/server`, `@sweethome/web`; корневой пакет `sweethome` с workspaces `["packages/*", "modules/*", "server", "web"]`. Импорт-пути `@sweethome/inverter-shared` и `@sweethome/inverter-mcp` — на них полагаются все последующие таски.

- [ ] **Step 1: Переместить каталоги через git mv**

```bash
cd ~/work/rancho/inverter-monitor
mkdir packages
git mv shared packages/inverter-shared
git mv mcp packages/inverter-mcp
```

- [ ] **Step 2: Переименовать пакеты в манифестах**

В `packages/inverter-shared/package.json`: `"name": "@inverter/shared"` → `"@sweethome/inverter-shared"`.
В `packages/inverter-mcp/package.json`: `"name"` → `"@sweethome/inverter-mcp"`; в `dependencies`: `"@inverter/shared"` → `"@sweethome/inverter-shared"` (версия та же).
В `server/package.json`: `"name"` → `"@sweethome/server"`; в `dependencies` заменить оба: `"@sweethome/inverter-shared": "1.0.0"`, `"@sweethome/inverter-mcp": "1.0.0"`.
В `web/package.json`: `"name"` → `"@sweethome/web"`; `"@inverter/shared"` → `"@sweethome/inverter-shared"`.

Корневой `package.json`:

```json
{
  "name": "sweethome",
  "private": true,
  "workspaces": ["packages/*", "modules/*", "server", "web"],
  "scripts": {
    "build": "npm run build -w @sweethome/inverter-shared && npm run build -w @sweethome/inverter-mcp && npm run build -w @sweethome/server && npm run build -w @sweethome/web",
    "check": "npm run check -w @sweethome/inverter-mcp && npm run check -w @sweethome/server && npm run typecheck -w @sweethome/web",
    "dev": "concurrently -k -n server,web -c blue,magenta \"npm run dev -w @sweethome/server\" \"npm run dev -w @sweethome/web\"",
    "test": "npm test -w @sweethome/inverter-mcp && npm test -w @sweethome/server && npm test -w @sweethome/web",
    "test:coverage": "npm run test:coverage -w @sweethome/inverter-mcp && npm run test:coverage -w @sweethome/server && npm run test:coverage -w @sweethome/web"
  },
  "devDependencies": { "concurrently": "^9.1.0" },
  "engines": { "node": ">=24" }
}
```

- [ ] **Step 3: Заменить импорты по всему коду**

```bash
grep -rl --include='*.ts' --include='*.tsx' '@inverter/' server packages web \
  | xargs sed -i 's|@inverter/shared|@sweethome/inverter-shared|g; s|@inverter/mcp|@sweethome/inverter-mcp|g'
grep -rn '@inverter/' server packages web --include='*.ts' --include='*.tsx'   # должно быть пусто
```

- [ ] **Step 4: Поправить jest- и tsconfig-конфиги**

`server/jest.config.cjs`: `roots: ["<rootDir>/server/src", "<rootDir>/packages/inverter-shared/src"]`; `moduleNameMapper`: `"^@sweethome/inverter-shared$": "<rootDir>/packages/inverter-shared/src/index.ts"`; в `collectCoverageFrom` заменить `shared/src/...` на `packages/inverter-shared/src/...` (три строки).

`packages/inverter-mcp/jest.config.cjs`: `rootDir: path.resolve(__dirname, "../..")` (каталог стал глубже!); `roots: ["<rootDir>/packages/inverter-mcp/src"]`; mapper → `"<rootDir>/packages/inverter-shared/src/index.ts"`; `transform` tsconfig → `"<rootDir>/packages/inverter-mcp/tsconfig.test.json"`; `collectCoverageFrom`/`coverageDirectory` → `packages/inverter-mcp/...`.

`web/jest.config.mjs`: mapper → `"^@sweethome/inverter-shared$": "<rootDir>/../packages/inverter-shared/src/index.ts"`.

Проверить оба `tsconfig.test.json` (server, inverter-mcp) на пути вида `../shared`: `grep -n shared server/tsconfig.test.json packages/inverter-mcp/tsconfig.test.json` — все вхождения заменить на новые пути (`../packages/inverter-shared`).

- [ ] **Step 5: Переустановить, собрать, прогнать тесты**

```bash
rm -rf node_modules server/node_modules web/node_modules packages/*/node_modules package-lock.json
npm install
npm run build && npm run check && npm test
```

Expected: всё зелёное. Типовые причины падений: не заменённый импорт (шаг 3), забытый путь в jest-конфиге (шаг 4).

⚠️ `deploy.sh` с этого момента и до Task 7 намеренно неактуален — деплоя в середине ветки не будет.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move workspaces under packages/ and rename to @sweethome scope"
```

---

### Task 2: Пакет @sweethome/shared — системные типы, canAccess, env-хелперы, контракт HomeModule

Новый пакет для того, что принадлежит системе, а не инвертору: auth-типы и `canAccess`, env-хелперы, контракт модуля с augmentation `express.Request` и хелперами `writeSource`/`denyWithoutWrite`/`requireAdmin`.

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/env.ts`, `packages/shared/src/module.ts`, `packages/shared/src/module.test.ts`
- Move: `packages/inverter-shared/src/auth.ts` → `packages/shared/src/auth.ts`; `server/src/auth/policy.ts` → влить в `packages/shared/src/auth.ts`; `server/src/auth/policy.test.ts` → `packages/shared/src/auth.test.ts`
- Modify: `packages/inverter-shared/src/index.ts`, `packages/inverter-shared/src/api.ts`, `packages/inverter-shared/package.json`, `server/package.json`, `web/package.json`, `packages/inverter-mcp/package.json`, `package.json` (корень), `server/jest.config.cjs`, `web/jest.config.mjs`, `packages/inverter-mcp/jest.config.cjs`, `server/src/config.ts` + все файлы, импортировавшие auth-типы или `canAccess` (grep в шаге 4)

**Interfaces:**
- Consumes: типы `Role`, `SessionUser`, `PublicUser`, `TokenScope`, `PublicApiToken`, `CreatedApiToken` (существующий `auth.ts`); `canAccess(role: Role | null, required: Access)` (существующий `policy.ts`); `envInt(name: string, def: number)` / `envBool(name: string, def: boolean)` (из `server/src/config.ts`).
- Produces:
  - `@sweethome/shared` (корневой entry): всё из `auth.ts` (типы + `Access` + `canAccess`) и `env.ts` (`envInt`, `envBool`).
  - `@sweethome/shared/module` (subpath, НЕ реэкспортируется из index — веб не должен тянуть типы express): `interface HomeModule { id: string; apiRouter: Router; ws?: { onConnection(ws: WebSocket): void }; attachHttp?(app: Application, ctx: { authenticate: RequestHandler }): void; start(): Promise<void>; stop(): Promise<void>; health(): ModuleHealth }`, `interface ModuleHealth { ok: boolean; details?: Record<string, unknown> }`, `interface AuthContext { kind: "session" | "token"; scopes: TokenScope[]; tokenName?: string }`, augmentation `express-serve-static-core` (`req.user`, `req.auth`), `writeSource(req): string`, `denyWithoutWrite(req, res): boolean`, `requireAdmin: RequestHandler`.

- [ ] **Step 1: Создать пакет и перенести auth**

```bash
mkdir -p packages/shared/src
git mv packages/inverter-shared/src/auth.ts packages/shared/src/auth.ts
git mv server/src/auth/policy.test.ts packages/shared/src/auth.test.ts
```

`packages/shared/package.json`:

```json
{
  "name": "@sweethome/shared",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./module": { "types": "./dist/module.d.ts", "default": "./dist/module.js" }
  },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/ws": "^8.5.10",
    "typescript": "^5.6.0"
  }
}
```

(версию `typescript` взять ту же, что в `packages/inverter-shared/package.json`). `packages/shared/tsconfig.json` — скопировать из `packages/inverter-shared/tsconfig.json` без изменений (`declaration: true` там уже есть).

В `packages/shared/src/auth.ts` дописать в конец содержимое `server/src/auth/policy.ts` (тип `Access` и функцию `canAccess` — дословно, вместе с док-комментариями), затем `git rm server/src/auth/policy.ts`. Импорт `Role` внутри файла уже не нужен (тип рядом). В `packages/shared/src/auth.test.ts` поправить импорт на `./auth`.

`packages/shared/src/index.ts`:

```ts
export * from "./auth";
export * from "./env";
```

- [ ] **Step 2: env-хелперы**

Создать `packages/shared/src/env.ts`, перенеся `envInt` и `envBool` из `server/src/config.ts` дословно, добавив `export`. В `server/src/config.ts` удалить локальные копии и импортировать: `import { envInt, envBool } from "@sweethome/shared";`

- [ ] **Step 3: Написать падающий тест на module-хелперы**

`packages/shared/src/module.test.ts`:

```ts
import type { Request, Response } from "express";
import { writeSource, denyWithoutWrite, requireAdmin } from "./module";

const reqWith = (over: Partial<Request>): Request => ({ ...over }) as Request;
const resMock = () => {
  const r: { statusCode?: number; body?: unknown } = {};
  return {
    res: {
      status(c: number) { r.statusCode = c; return this; },
      json(b: unknown) { r.body = b; return this; },
    } as unknown as Response,
    r,
  };
};

describe("writeSource", () => {
  it("names UI sessions by username", () => {
    const req = reqWith({
      auth: { kind: "session", scopes: ["read", "write"] },
      user: { userId: 1, username: "alexey", role: "admin", mustChangePassword: false, expiresAt: 0 },
    });
    expect(writeSource(req)).toBe("ui:alexey");
  });
  it("names tokens by token name", () => {
    const req = reqWith({ auth: { kind: "token", scopes: ["write"], tokenName: "ha" } });
    expect(writeSource(req)).toBe("token:ha");
  });
});

describe("denyWithoutWrite", () => {
  it("denies a token without the write scope", () => {
    const { res, r } = resMock();
    const req = reqWith({ auth: { kind: "token", scopes: ["read"] } });
    expect(denyWithoutWrite(req, res)).toBe(true);
    expect(r.statusCode).toBe(403);
  });
  it("lets sessions through", () => {
    const { res } = resMock();
    const req = reqWith({ auth: { kind: "session", scopes: ["read", "write"] } });
    expect(denyWithoutWrite(req, res)).toBe(false);
  });
});

describe("requireAdmin", () => {
  it("403 for viewer, next() for admin", () => {
    const { res, r } = resMock();
    let called = 0;
    requireAdmin(
      reqWith({ user: { userId: 2, username: "v", role: "viewer", mustChangePassword: false, expiresAt: 0 } }),
      res,
      () => called++,
    );
    expect(r.statusCode).toBe(403);
    requireAdmin(
      reqWith({ user: { userId: 1, username: "a", role: "admin", mustChangePassword: false, expiresAt: 0 } }),
      res,
      () => called++,
    );
    expect(called).toBe(1);
  });
});
```

- [ ] **Step 4: Запустить тест, убедиться в падении**

Run: `npm test -w @sweethome/server -- --testPathPattern packages/shared` (тесты `packages/shared/src` гоняются jest'ом server-а — roots добавим здесь же, см. шаг 6).
Expected: FAIL — `Cannot find module './module'`.

- [ ] **Step 5: Реализовать `packages/shared/src/module.ts`**

```ts
import type { Application, Request, RequestHandler, Response, Router } from "express";
import type { WebSocket } from "ws";
import { canAccess } from "./auth";
import type { Role, TokenScope } from "./auth";

/** Контекст авторизации запроса: сессия из UI или API-токен. */
export interface AuthContext {
  kind: "session" | "token";
  scopes: TokenScope[];
  tokenName?: string;
}

/** Личность запроса — форма SessionInfo из auth-БД хоста. */
export interface RequestIdentity {
  userId: number;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  expiresAt: number;
  tokenHash?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: RequestIdentity;
    auth?: AuthContext;
  }
}

export interface ModuleHealth {
  ok: boolean;
  details?: Record<string, unknown>;
}

/** Контракт подсистемы дома. Хост монтирует apiRouter на /api/<id> и ws на /ws/<id>. */
export interface HomeModule {
  id: string;
  apiRouter: Router;
  ws?: { onConnection(ws: WebSocket): void };
  /** Спец-маршруты вне /api/<id> (например /mcp у инвертора); ctx.authenticate — общий гейт хоста. */
  attachHttp?(app: Application, ctx: { authenticate: RequestHandler }): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): ModuleHealth;
}

/** Кто именно пишет — попадает в журнал событий (тип `control`). */
export const writeSource = (req: Request): string =>
  req.auth?.kind === "token" ? `token:${req.auth.tokenName ?? "?"}` : `ui:${req.user?.username ?? "?"}`;

/** Скоуп write обязателен для токенов; cookie-сессия из UI им обладает всегда. */
export const denyWithoutWrite = (req: Request, res: Response): boolean => {
  if (req.auth?.kind === "token" && !req.auth.scopes.includes("write")) {
    res.status(403).json({ ok: false, code: "scope_required", error: "Token lacks the 'write' scope" });
    return true;
  }
  return false;
};

/** Гейт admin-роли для модульных маршрутов. */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!canAccess(req.user?.role ?? null, "admin")) {
    return res.status(403).json({ ok: false, code: "forbidden", error: "Admins only" });
  }
  next();
};
```

- [ ] **Step 6: Подключить пакет к потребителям и починить импорты**

1. Зависимость `"@sweethome/shared": "1.0.0"` добавить в `dependencies` у: `packages/inverter-shared`, `packages/inverter-mcp`, `server`, `web`.
2. `packages/inverter-shared/src/index.ts`: убрать `export * from "./auth"`, добавить первой строкой `export * from "@sweethome/shared";` — реэкспорт сохраняет все существующие импорты auth-типов из `@sweethome/inverter-shared` рабочими (web, mcp, server не трогаем file-by-file). В `packages/inverter-shared/src/api.ts` (и других файлах пакета, где импортируется `./auth`) заменить `from "./auth"` на `from "@sweethome/shared"`.
3. `server/src/server.ts` и другие места, импортировавшие `canAccess` из `./auth/policy` (`grep -rn "auth/policy" server/src`): импортировать `canAccess` из `@sweethome/shared`.
4. Корневой `package.json`: в `build` добавить первым звеном `npm run build -w @sweethome/shared && `.
5. `server/jest.config.cjs`: в `roots` добавить `"<rootDir>/packages/shared/src"`; в `moduleNameMapper` добавить `"^@sweethome/shared$": "<rootDir>/packages/shared/src/index.ts"` и `"^@sweethome/shared/module$": "<rootDir>/packages/shared/src/module.ts"`; в `collectCoverageFrom` строку `packages/inverter-shared/src/auth.ts` заменить на `packages/shared/src/auth.ts` и добавить `packages/shared/src/module.ts`.
6. `packages/inverter-mcp/jest.config.cjs` и `web/jest.config.mjs`: добавить mapper `"^@sweethome/shared$"` → соответствующий путь до `packages/shared/src/index.ts`.
7. `server/tsconfig.test.json`: если `include` перечисляет каталоги — добавить `../packages/shared/src`.

- [ ] **Step 7: Прогнать всё**

```bash
npm install
npm run build && npm run check && npm test
```

Expected: PASS, включая новые `module.test.ts` и переехавший `auth.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(shared): add @sweethome/shared with auth types, canAccess and the HomeModule contract"
```

---

### Task 3: Перенос инверторного кода в modules/inverter

Весь инверторный код уезжает в пакет `@sweethome/inverter`. `server.ts` в этом таске сохраняет прежние маршруты (транзитная форма — импортирует классы из нового пакета); разрез на хост/модуль — Task 4.

**Files:**
- Create: `modules/inverter/package.json`, `modules/inverter/tsconfig.json`, `modules/inverter/tsconfig.test.json`, `modules/inverter/jest.config.cjs`, `modules/inverter/src/index.ts`, `modules/inverter/src/config.ts`
- Move (git mv, из `server/src/` в `modules/inverter/src/`): `protocol/`, `transport/`, `stats/`, `mcp/`, `inverter.ts`, `inverter.test.ts`, `mqtt.ts`, `mqtt.test.ts`, `store.ts`, `store.test.ts`
- Modify: `server/src/config.ts`, `server/src/index.ts`, `server/src/server.ts`, `server/src/server.http.test.ts`, `server/package.json`, `server/jest.config.cjs`, `package.json` (корень)

**Interfaces:**
- Consumes: `@sweethome/shared` (`envInt`/`envBool`), `@sweethome/inverter-shared`, `@sweethome/inverter-mcp`.
- Produces: `@sweethome/inverter` c экспортами из `src/index.ts`:
  - `class Inverter` (как была), `createStats(cfg): StatsRecorder | null`, `class StatsRecorder`, `class HaMqtt`, `mountMcp(app, deps)`, `GAUGE_FIELDS`, `type GaugeField`, `localDay`
  - `interface InverterConfig` — прежний `Config` **минус** `port`, `host`, `auth`; `dataDir` в нём — уже модульный каталог (`<root dataDir>/inverter`)
  - `loadInverterConfig(rootDataDir: string): InverterConfig` — читает те же env-имена, `dataDir: path.join(rootDataDir, "inverter")`
- Хост-`Config` (`server/src/config.ts`) сокращается до `{ port, host, dataDir, auth: { sessionTtlDays } }`.

- [ ] **Step 1: Каркас пакета**

```bash
mkdir -p modules/inverter/src
git mv server/src/protocol modules/inverter/src/protocol
git mv server/src/transport modules/inverter/src/transport
git mv server/src/stats modules/inverter/src/stats
git mv server/src/mcp modules/inverter/src/mcp
git mv server/src/inverter.ts server/src/inverter.test.ts modules/inverter/src/
git mv server/src/mqtt.ts server/src/mqtt.test.ts modules/inverter/src/
git mv server/src/store.ts server/src/store.test.ts modules/inverter/src/
```

`modules/inverter/package.json` (версии зависимостей — те же, что сейчас в `server/package.json`; `serialport` перенести из `optionalDependencies` server-а):

```json
{
  "name": "@sweethome/inverter",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "jest",
    "test": "jest",
    "test:coverage": "jest --coverage"
  },
  "dependencies": {
    "@sweethome/shared": "1.0.0",
    "@sweethome/inverter-shared": "1.0.0",
    "@sweethome/inverter-mcp": "1.0.0",
    "express": "^4.19.2",
    "mqtt": "^5.10.1",
    "ws": "^8.18.0"
  },
  "optionalDependencies": { "serialport": "^12.0.0" },
  "devDependencies": { /* скопировать блок devDependencies из server/package.json: @types/*, jest, ts-jest, typescript */ }
}
```

`modules/inverter/tsconfig.json` — копия `server/tsconfig.json` (с `declaration: true`, т.к. пакет импортируется server-ом: добавить `"declaration": true`). `modules/inverter/tsconfig.test.json` — копия `server/tsconfig.test.json` с поправленными относительными путями (те, что указывают на `../packages/...`, из `modules/inverter` выглядят как `../../packages/...`).

`modules/inverter/jest.config.cjs` — по образцу `server/jest.config.cjs`:

```js
const path = require("path");

/** @type {import('jest').Config} */
module.exports = {
  rootDir: path.resolve(__dirname, "../.."),
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/modules/inverter/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@sweethome/inverter-shared$": "<rootDir>/packages/inverter-shared/src/index.ts",
    "^@sweethome/shared$": "<rootDir>/packages/shared/src/index.ts",
    "^@sweethome/shared/module$": "<rootDir>/packages/shared/src/module.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/modules/inverter/tsconfig.test.json" }],
  },
  collectCoverageFrom: ["modules/inverter/src/**/*.ts", "!modules/inverter/src/**/*.test.ts"],
  coverageDirectory: "<rootDir>/modules/inverter/coverage",
  clearMocks: true,
};
```

- [ ] **Step 2: Разрезать конфиг**

`modules/inverter/src/config.ts` — перенести из `server/src/config.ts` интерфейс `Config` под именем `InverterConfig`, удалив поля `port`, `host`, `auth`; функцию `loadConfig` под именем `loadInverterConfig(rootDataDir: string)`, удалив соответствующие строки и заменив `dataDir: process.env.DATA_DIR || "data"` на `dataDir: path.join(rootDataDir, "inverter")` (`import path from "path"`). Всё остальное (transport, baud, slaveId, poll, timeouts, allowMock, allowControl, startupLocked, autoRelock, stats, mcp, mqtt) — дословно. `envInt`/`envBool` — из `@sweethome/shared`.

`server/src/config.ts` сокращается до:

```ts
import { envBool, envInt } from "@sweethome/shared";

export interface Config {
  port: number;
  host: string;
  /** Корень данных; модули получают свои подкаталоги (data/<module id>). */
  dataDir: string;
  auth: { sessionTtlDays: number };
}

export function loadConfig(): Config {
  return {
    port: envInt("PORT", 3000),
    host: process.env.HOST || "0.0.0.0",
    dataDir: process.env.DATA_DIR || "data",
    auth: { sessionTtlDays: envInt("AUTH_SESSION_TTL_DAYS", 30) },
  };
}
```

(если `envBool` в хосте больше не используется — не импортировать; `server/src/config.test.ts` разделить: проверки инверторных полей переезжают в `modules/inverter/src/config.test.ts` с вызовом `loadInverterConfig("data")`, проверки port/host/dataDir остаются).

Внутри перенесённых файлов заменить импорты `from "./config"` / `from "../config"` на `from "./config"` относительно нового места (протокольные файлы конфиг не импортируют; проверить: `grep -rn '\.\./config\|"./config"' modules/inverter/src`). Тип `Config` в них заменить на `InverterConfig`.

- [ ] **Step 3: index-фасад модуля**

`modules/inverter/src/index.ts`:

```ts
export { Inverter } from "./inverter";
export { createStats, StatsRecorder } from "./stats/recorder";
export { GAUGE_FIELDS, localDay } from "./stats/db";
export type { GaugeField } from "./stats/db";
export { HaMqtt } from "./mqtt";
export { mountMcp } from "./mcp/http";
export { loadInverterConfig } from "./config";
export type { InverterConfig } from "./config";
```

- [ ] **Step 4: Транзитно перевести server на новый пакет**

В `server/package.json`: удалить из `dependencies` `mqtt` и `@sweethome/inverter-mcp`, из `optionalDependencies` — `serialport`; добавить `"@sweethome/inverter": "1.0.0"`.

`server/src/index.ts` и `server/src/server.ts`: импорты `./inverter`, `./stats/recorder`, `./stats/db`, `./mqtt`, `./mcp/http` заменить на `@sweethome/inverter`; там, где использовался старый `Config` для инвертора, — `InverterConfig`. Транзитная сигнатура: `createServer(inverter, cfg: Config, invCfg: InverterConfig, stats)`, `cfg.allowControl` в `/api/meta` → `invCfg.allowControl`, `mountMcp(app, { inverter, cfg: invCfg, stats, authenticate })`. В `index.ts`: `const cfg = loadConfig(); const invCfg = loadInverterConfig(cfg.dataDir);` и дальше `new Inverter(invCfg)`, `createStats(invCfg)`, `new HaMqtt(invCfg, inverter)`.

Удалить из `server.ts` локальные `AuthContext` и `declare module` (теперь из `@sweethome/shared/module`): добавить `import "@sweethome/shared/module";` и `import type { AuthContext } from "@sweethome/shared/module";` где нужен тип. Хелперы `writeSource`/`denyWithoutWrite` в `server.ts` заменить импортом из `@sweethome/shared/module` (локальные копии удалить).

- [ ] **Step 5: Jest-раскладка**

`server/jest.config.cjs`: `collectCoverageFrom` — убрать инверторные пути, оставить `server/src/**` и пакеты shared. Корневой `package.json`: в `build` вставить `npm run build -w @sweethome/inverter && ` перед server-ом; в `check`/`test`/`test:coverage` добавить `-w @sweethome/inverter` звеном между mcp и server.

- [ ] **Step 6: Установка, сборка, тесты**

```bash
npm install
npm run build && npm run check && npm test
```

Expected: PASS. `modules/inverter` гоняет protocol/stats/mqtt/store/mcp-тесты, `server` — auth + http.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(server): extract all inverter code into the @sweethome/inverter module package"
```

---

### Task 4: Хост: ModuleHost, /api/inverter, /ws/inverter, агрегированный /api/health

Собственно модульный монолит: инверторные маршруты переезжают в роутер модуля, хост монтирует модули по контракту.

**Files:**
- Create: `server/src/host.ts`, `server/src/host.test.ts`, `modules/inverter/src/router.ts`, `modules/inverter/src/router.test.ts`, `modules/inverter/src/module.ts`
- Modify: `server/src/server.ts`, `server/src/index.ts`, `server/src/server.http.test.ts`, `modules/inverter/src/index.ts`, `modules/inverter/src/mcp/http.test.ts` (если он поднимает сервер по старым путям)

**Interfaces:**
- Consumes: `HomeModule`, `ModuleHealth`, `requireAdmin`, `writeSource`, `denyWithoutWrite` из `@sweethome/shared/module`; экспорты `@sweethome/inverter` из Task 3.
- Produces:
  - `modules/inverter`: `createInverterModule(rootDataDir: string): HomeModule` (единственная нужная хосту точка входа; фасад `index.ts` дополняется этим экспортом),
    `createInverterRouter(deps: { inverter: Inverter; stats: StatsRecorder | null; cfg: InverterConfig }): Router`.
  - `server`: `class ModuleHost { constructor(modules: HomeModule[]); readonly modules: HomeModule[]; startAll(): Promise<void>; stopAll(): Promise<void>; health(): { ok: boolean; modules: Record<string, ModuleHealth> } }`;
    `createServer(host: ModuleHost, cfg: Config): http.Server`.
  - HTTP: `/api/inverter/*` (все прежние инверторные маршруты без изменений имён), `/ws/inverter`, `/api/health` → `{ ok, modules: { inverter: {...} } }`, `/mcp` без изменений.

- [ ] **Step 1: Тест ModuleHost (падающий)**

`server/src/host.test.ts`:

```ts
import express from "express";
import type { HomeModule } from "@sweethome/shared/module";
import { ModuleHost } from "./host";

const fakeModule = (id: string, over: Partial<HomeModule> = {}): HomeModule => ({
  id,
  apiRouter: express.Router(),
  start: async () => {},
  stop: async () => {},
  health: () => ({ ok: true }),
  ...over,
});

describe("ModuleHost", () => {
  it("starts all modules and aggregates health", async () => {
    const host = new ModuleHost([fakeModule("a"), fakeModule("b")]);
    await host.startAll();
    expect(host.health()).toEqual({ ok: true, modules: { a: { ok: true }, b: { ok: true } } });
  });

  it("isolates a start() failure: the process keeps other modules alive and health reports it", async () => {
    const boom = fakeModule("boom", { start: async () => { throw new Error("no serial"); } });
    let bStarted = false;
    const host = new ModuleHost([boom, fakeModule("b", { start: async () => { bStarted = true; } })]);
    await host.startAll(); // не бросает
    expect(bStarted).toBe(true);
    const h = host.health();
    expect(h.ok).toBe(false);
    expect(h.modules.boom).toEqual({ ok: false, details: { error: "no serial" } });
    expect(h.modules.b.ok).toBe(true);
  });

  it("stopAll survives a throwing stop()", async () => {
    const host = new ModuleHost([
      fakeModule("bad", { stop: async () => { throw new Error("x"); } }),
      fakeModule("ok"),
    ]);
    await expect(host.stopAll()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Запустить, убедиться в падении**

Run: `npm test -w @sweethome/server -- --testPathPattern host`
Expected: FAIL — `Cannot find module './host'`.

- [ ] **Step 3: Реализовать `server/src/host.ts`**

```ts
import type { HomeModule, ModuleHealth } from "@sweethome/shared/module";

/** Владелец рантайм-состояния модулей: старт/стоп с изоляцией ошибок и сводное здоровье. */
export class ModuleHost {
  private startErrors = new Map<string, string>();

  constructor(readonly modules: HomeModule[]) {}

  async startAll(): Promise<void> {
    for (const m of this.modules) {
      try {
        await m.start();
      } catch (e) {
        const msg = (e as Error).message;
        this.startErrors.set(m.id, msg);
        console.error(`[sweethome] module "${m.id}" failed to start:`, msg);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const m of this.modules) {
      try {
        await m.stop();
      } catch (e) {
        console.error(`[sweethome] module "${m.id}" failed to stop:`, (e as Error).message);
      }
    }
  }

  health(): { ok: boolean; modules: Record<string, ModuleHealth> } {
    const modules: Record<string, ModuleHealth> = {};
    let ok = true;
    for (const m of this.modules) {
      const err = this.startErrors.get(m.id);
      const h: ModuleHealth = err ? { ok: false, details: { error: err } } : m.health();
      modules[m.id] = h;
      if (!h.ok) ok = false;
    }
    return { ok, modules };
  }
}
```

- [ ] **Step 4: Прогнать host.test.ts**

Run: `npm test -w @sweethome/server -- --testPathPattern host`
Expected: PASS.

- [ ] **Step 5: Роутер модуля инвертора**

`modules/inverter/src/router.ts`: перенести из `server/src/server.ts` **дословно** тела обработчиков `/api/snapshot`, `/api/meta`, `/api/control`, `/api/lock`, `/api/baseline`, `/api/baseline/recapture`, все `/api/stats/*`, `/api/raw`, вспомогательные `parseTime` и массив `CONTROL_TYPES` — сняв префикс `/api` (роутер монтируется хостом на `/api/inverter`):

```ts
import express, { Router } from "express";
import {
  OUTPUT_SOURCE_PRIORITY, CHARGER_SOURCE_PRIORITY,
  ALLOWED_MAX_CHARGE_CURRENT, ALLOWED_MAX_AC_CHARGE_CURRENT, ControlType,
} from "@sweethome/inverter-shared";
import { writeSource, denyWithoutWrite, requireAdmin } from "@sweethome/shared/module";
import { Inverter } from "./inverter";
import { StatsRecorder } from "./stats/recorder";
import { GAUGE_FIELDS, GaugeField, localDay } from "./stats/db";
import type { InverterConfig } from "./config";

export function createInverterRouter(deps: {
  inverter: Inverter;
  stats: StatsRecorder | null;
  cfg: InverterConfig;
}): Router {
  const { inverter, stats, cfg } = deps;
  const router = express.Router();
  // Admin-only зона модуля — тот же список путей, что был в server.ts, минус /api и минус users/tokens (они у хоста).
  router.use(["/control", "/lock", "/raw", "/baseline"], requireAdmin);

  router.get("/snapshot", (_req, res) => res.json(inverter.getSnapshot()));
  // ... остальные обработчики дословно из server.ts (app.get("/api/meta" → router.get("/meta" и т.д.)
  return router;
}
```

Правила переноса: `app.get("/api/xxx"` → `router.get("/xxx"`; `cfg.allowControl` остаётся (`cfg` теперь `InverterConfig`); `writeSource`/`denyWithoutWrite` — импорты из `@sweethome/shared/module`. Prefix-матчинг `router.use(["/baseline"])` покрывает и `/baseline/recapture` — как это делал `app.use` со списком.

- [ ] **Step 6: Тест роутера с фейковой авторизацией (падающий → зелёный)**

`modules/inverter/src/router.test.ts` — мини-харнесс + перенос из `server/src/server.http.test.ts` тех кейсов, что проверяют **инверторные** маршруты (гейты scope/admin на control/lock/raw/baseline, preview без скоупа, 503 статистики). Харнесс:

```ts
import express from "express";
import request from "supertest"; // если server.http.test.ts использует другой способ — повторить его; supertest есть в devDeps server-а, добавить в modules/inverter
import type { AuthContext, RequestIdentity } from "@sweethome/shared/module";
import { createInverterRouter } from "./router";

function appWith(deps: Parameters<typeof createInverterRouter>[0], user: RequestIdentity, auth: AuthContext) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; req.auth = auth; next(); });
  app.use("/api/inverter", createInverterRouter(deps));
  return app;
}
```

`deps.inverter` — реальный `new Inverter(cfg)` с `transport: "mock"` (так делает существующий `server.http.test.ts` — повторить его сетап: временный dataDir, `allowControl` и т.д.). Если `server.http.test.ts` вместо supertest ходит `fetch`-ом по живому `http.Server` — использовать тот же приём (поднять `http.createServer(app)` на порту 0), supertest не добавлять.

Run: `npm test -w @sweethome/inverter -- --testPathPattern router`
Expected: PASS.

- [ ] **Step 7: Сборка модуля `modules/inverter/src/module.ts`**

```ts
import type { Application, RequestHandler } from "express";
import { WebSocket } from "ws";
import type { HomeModule, ModuleHealth } from "@sweethome/shared/module";
import type { Snapshot } from "@sweethome/inverter-shared";
import { Inverter } from "./inverter";
import { createStats } from "./stats/recorder";
import { HaMqtt } from "./mqtt";
import { mountMcp } from "./mcp/http";
import { loadInverterConfig } from "./config";
import { createInverterRouter } from "./router";

export function createInverterModule(rootDataDir: string): HomeModule {
  const cfg = loadInverterConfig(rootDataDir);
  const inverter = new Inverter(cfg);
  const stats = createStats(cfg);
  if (stats) stats.attach(inverter);
  const mqtt = new HaMqtt(cfg, inverter);

  const clients = new Set<WebSocket>();
  inverter.on("snapshot", (snap: Snapshot) => {
    const msg = JSON.stringify({ type: "snapshot", data: snap });
    for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  });

  return {
    id: "inverter",
    apiRouter: createInverterRouter({ inverter, stats, cfg }),
    ws: {
      onConnection(ws) {
        clients.add(ws);
        ws.on("close", () => clients.delete(ws));
        ws.send(JSON.stringify({ type: "snapshot", data: inverter.getSnapshot() }));
      },
    },
    attachHttp(app: Application, ctx: { authenticate: RequestHandler }) {
      mountMcp(app, { inverter, cfg, stats, authenticate: ctx.authenticate });
    },
    async start() {
      mqtt.start();
      await inverter.start();
    },
    async stop() {
      mqtt.stop();
      stats?.stop();
      await inverter.stop();
    },
    health(): ModuleHealth {
      const c = inverter.getSnapshot().connection;
      return { ok: true, details: { connected: c.connected, transport: c.transport, mock: c.mock, lastError: c.lastError } };
    },
  };
}
```

В `modules/inverter/src/index.ts` добавить `export { createInverterModule } from "./module";` и `export { createInverterRouter } from "./router";`. Стартовые console.log про транспорт/подключение из старого `server/src/index.ts` перенести в `start()` модуля (дословно, префикс `[inverter]`).

- [ ] **Step 8: Переписать хост `server/src/server.ts` и `server/src/index.ts`**

`createServer(host: ModuleHost, cfg: Config)`. Что остаётся в `server.ts` без изменений: login/logout, `authenticate`, must_change-гейт, `/api/me`, `/api/change-password`, admin/session-гейты на `/api/users`+`/api/tokens` и все их обработчики, статика, страничные редиректы (их список правится в Task 6). Что меняется:

```ts
// вместо инверторных маршрутов:
app.get("/api/health", (_req, res) => res.json(host.health()));
for (const m of host.modules) app.use(`/api/${m.id}`, m.apiRouter);
for (const m of host.modules) m.attachHttp?.(app, { authenticate });

// WS: по WebSocketServer на модуль, авторизация центральная
const server = http.createServer(app);
for (const m of host.modules) {
  if (!m.ws) continue;
  const wss = new WebSocketServer({ server, path: `/ws/${m.id}` });
  const mod = m;
  wss.on("connection", (ws, req) => {
    const s = auth.verify(tokenFromCookieHeader(req.headers.cookie));
    const authorized =
      (!!s && !s.mustChangePassword) || !!auth.verifyToken(bearerFromHeader(req.headers.authorization));
    if (!authorized) { ws.close(4401, "Unauthorized"); return; }
    mod.ws!.onConnection(ws);
  });
}
return server;
```

Важно: `app.use("/api", authenticate)` и must_change-гейт уже стоят **до** монтирования модулей — модульные маршруты автоматически за ними. Убрать из `server.ts` все импорты `@sweethome/inverter` и `@sweethome/inverter-shared`, `CONTROL_TYPES`, `parseTime`, broadcast-логику.

`server/src/index.ts` целиком:

```ts
import { loadConfig } from "./config";
import { createServer } from "./server";
import { ModuleHost } from "./host";
import { createInverterModule } from "@sweethome/inverter";

process.on("unhandledRejection", (reason) => {
  console.error("[sweethome] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[sweethome] uncaughtException:", err);
});

async function main(): Promise<void> {
  const cfg = loadConfig();
  const host = new ModuleHost([createInverterModule(cfg.dataDir)]);

  const server = createServer(host, cfg);
  server.on("error", (e) => {
    console.error("[sweethome] HTTP server failed:", (e as Error).message);
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[sweethome] HTTP/WS listening on http://${cfg.host}:${cfg.port}`);
  });

  await host.startAll();

  const shutdown = async (sig: string) => {
    console.log(`\n[sweethome] ${sig} received, shutting down...`);
    await host.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[sweethome] fatal:", e);
  process.exit(1);
});
```

- [ ] **Step 9: Обновить `server/src/server.http.test.ts`**

Сетап: сервер строится как `createServer(new ModuleHost([createInverterModule(tmpDataDir)]), cfg)` c env `INVERTER_TRANSPORT=mock` (повторить текущий способ подготовки окружения этого файла). Изменения в кейсах:
- пути инверторных маршрутов получают префикс `/api/inverter/...`; кейсы, целиком переехавшие в `router.test.ts` (Step 6), отсюда удалить — здесь остаётся по одному smoke-кейсу на «инверторный маршрут за общим auth» (401 без сессии на `/api/inverter/snapshot`, 200 с сессией);
- `/api/health`: ожидание `{ ok: true, modules: { inverter: expect.objectContaining({ ok: true }) } }` вместо `{ ok: true }`;
- системные маршруты (`/api/me`, users, tokens, login-флоу, форс смены пароля) — без изменений путей.

Также проверить `modules/inverter/src/mcp/http.test.ts` и `local-gateway.test.ts`: они работают с `/mcp` и локальным гейтвеем — путей `/api/*` не содержат (если содержат — префикс `/api/inverter`).

- [ ] **Step 10: Полный прогон и коммит**

```bash
npm run build && npm run check && npm test
git add -A
git commit -m "feat(server): modular monolith host - mount modules at /api/<id> and /ws/<id>, aggregate health"
```

---

### Task 5: MCP-гейтвей: новые REST-пути

`HttpGateway` в `packages/inverter-mcp` ходит на REST инвертора — пути получают префикс `/api/inverter`. Эндпоинт `/mcp`, `/api/me` и токены не меняются.

**Files:**
- Modify: `packages/inverter-mcp/src/gateway/http.ts`, `packages/inverter-mcp/src/gateway/http.test.ts`

**Interfaces:**
- Consumes: HTTP-маршруты хоста из Task 4 (`/api/inverter/*`, `/api/me`).
- Produces: рабочий `HttpGateway` поверх новой раскладки; интерфейс `InverterGateway` не меняется.

- [ ] **Step 1: Обновить тест-ожидания**

В `packages/inverter-mcp/src/gateway/http.test.ts` все проверяемые пути `"/api/snapshot"`, `"/api/meta"`, `"/api/baseline"`, `"/api/control"`, `"/api/lock"`, `"/api/baseline/recapture"`, `"/api/raw"`, `"/api/stats/..."` заменить на `"/api/inverter/..."`. Путь `"/api/me"` (probe) оставить как есть.

Run: `npm test -w @sweethome/inverter-mcp -- --testPathPattern gateway`
Expected: FAIL — гейтвей ещё ходит по старым путям.

- [ ] **Step 2: Обновить `http.ts`**

В `packages/inverter-mcp/src/gateway/http.ts` те же замены (строки 100–179 по текущей нумерации): `"/api/snapshot"` → `"/api/inverter/snapshot"` и т.д.; `"/api/me"` в probe (строка ~241) и следом probe `"/api/stats/solar-window"` → `"/api/inverter/stats/solar-window"`. Затем: `grep -rn '"/api/' packages/inverter-mcp/src` — кроме `"/api/me"`, всё должно начинаться с `"/api/inverter/`.

- [ ] **Step 3: Прогнать и закоммитить**

```bash
npm test -w @sweethome/inverter-mcp
git add -A
git commit -m "fix(mcp): point HttpGateway at the /api/inverter route prefix"
```

---

### Task 6: Веб: маршруты /inverter/*, обзор дома, двухуровневая шапка, 301-редиректы

**Files:**
- Move (git mv): `web/app/(app)/page.tsx` + `page.test.tsx` → `web/app/(app)/inverter/`; каталоги `web/app/(app)/stats`, `web/app/(app)/settings`, `web/app/(app)/diagnostics` → `web/app/(app)/inverter/{stats,settings,diagnostics}`; `web/app/(app)/layout.tsx` + `layout.test.tsx` → `web/app/(app)/inverter/layout.tsx` (+ тест)
- Create: `web/app/(app)/layout.tsx` (новый системный), `web/app/(app)/layout.test.tsx`, `web/app/(app)/page.tsx` (обзор), `web/app/(app)/page.test.tsx`, `web/lib/session.tsx`, `web/lib/session.test.tsx`
- Modify: `web/lib/api.ts`, `web/lib/snapshot.tsx`, `web/lib/meta.tsx`, `web/lib/stats.ts`, `web/lib/i18n/dict.ts` (или где лежит словарь — `ls web/lib/i18n`), страницы с fetch-путями, все затронутые тесты
- Modify: `server/src/server.ts` (страничный гейт + 301), `server/src/server.http.test.ts`

**Interfaces:**
- Consumes: `/api/me` (system), `/api/inverter/*`, `/ws/inverter` (Task 4).
- Produces:
  - страницы `/` (обзор), `/inverter`, `/inverter/stats`, `/inverter/settings`, `/inverter/diagnostics`, `/users`, `/login`, `/change-password`;
  - `wsUrl(module: string): string`;
  - `SessionProvider` / `useSession(): { username: string; role: Role; mustChangePassword: boolean } | null` (модель по образцу `meta.tsx`);
  - 301: `/stats → /inverter/stats`, `/settings → /inverter/settings`, `/diagnostics → /inverter/diagnostics`.

- [ ] **Step 1: Серверные страничные маршруты и 301 (падающий тест)**

В `server/src/server.http.test.ts` добавить:

```ts
it("redirects legacy page urls to the inverter section", async () => {
  for (const [from, to] of [
    ["/stats", "/inverter/stats"],
    ["/settings", "/inverter/settings"],
    ["/diagnostics", "/inverter/diagnostics"],
  ]) {
    const res = await fetch(`${base}${from}`, { redirect: "manual", headers: authCookie });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(to);
  }
});
```

(`base`/`authCookie` — как в соседних кейсах файла.) Run: `npm test -w @sweethome/server -- --testPathPattern server.http` → FAIL.

- [ ] **Step 2: Реализовать в `server/src/server.ts`**

Перед страничным гейтом:

```ts
// Совместимость закладок: страницы инвертора переехали под /inverter.
const LEGACY_PAGES: Record<string, string> = {
  "/stats": "/inverter/stats",
  "/settings": "/inverter/settings",
  "/diagnostics": "/inverter/diagnostics",
};
app.get(Object.keys(LEGACY_PAGES), (req, res) => res.redirect(301, LEGACY_PAGES[req.path]));
```

Страничный гейт: список путей → `["/", "/index.html", "/inverter", "/inverter/stats", "/inverter/settings", "/inverter/diagnostics", "/users", "/change-password"]`; `ADMIN_PAGES = new Set(["/inverter/settings", "/inverter/diagnostics", "/users"])`. Прогнать тест из Step 1 → PASS.

- [ ] **Step 3: Переезд файлов веба**

```bash
cd web/app/'(app)'
mkdir inverter
git mv page.tsx page.test.tsx inverter/
git mv stats settings diagnostics inverter/
git mv layout.tsx inverter/layout.tsx
git mv layout.test.tsx inverter/layout.test.tsx
```

- [ ] **Step 4: `web/lib/session.tsx` + смена путей в lib**

`session.tsx` — по образцу `web/lib/meta.tsx` (тот же паттерн Provider/hook с ретраем), но: тип `SessionUser` из `@sweethome/inverter-shared` (реэкспорт из shared), fetch `getJson<{ username: string; role: Role; mustChangePassword: boolean }>("/api/me")`, экспорт `SessionProvider` и `useSession()`. Тест `session.test.tsx` — по образцу `meta.test.tsx` (успешная загрузка + ретрай при ошибке).

`web/lib/api.ts`:

```ts
export function wsUrl(module: string): string {
  if (process.env.NODE_ENV === "development") return `ws://localhost:3000/ws/${module}`;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/${module}`;
}
```

`web/lib/snapshot.tsx`: вызов `wsUrl()` → `wsUrl("inverter")`. `web/lib/meta.tsx`: `"/api/meta"` → `"/api/inverter/meta"`. `web/lib/stats.ts`: все `"/api/stats/` → `"/api/inverter/stats/`.

Остальные fetch-пути — по карте (системные не трогать):

| Старый | Новый |
|---|---|
| `/api/snapshot`, `/api/meta`, `/api/control`, `/api/lock`, `/api/raw`, `/api/baseline`, `/api/baseline/recapture`, `/api/stats/*` | `/api/inverter/...` |
| `/api/login`, `/api/logout`, `/api/me`, `/api/change-password`, `/api/users*`, `/api/tokens*`, `/api/health` | без изменений |

Найти всё: `grep -rn '"/api/\|`/api/' web --include='*.ts' --include='*.tsx' | grep -v node_modules` — пройтись по каждому вхождению (страницы `inverter/settings`, `inverter/diagnostics`, тесты). В `web/next.config.ts` dev-rewrite `/api/:path*` уже покрывает новые пути — не менять.

- [ ] **Step 5: Новый системный layout + перенос inverter-layout**

`web/app/(app)/layout.tsx` (новый):

```tsx
"use client";

import { ReactNode, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SnapshotProvider } from "@/lib/snapshot";
import { SessionProvider, useSession } from "@/lib/session";
import { ToastProvider } from "@/lib/toast";
import { useT } from "@/lib/i18n";
import { LangSwitch } from "@/components/LangSwitch";

const ADMIN_PATH_PREFIXES = ["/inverter/settings", "/inverter/diagnostics", "/users"];

function SystemNav() {
  const t = useT();
  const session = useSession();
  const pathname = usePathname();
  const isAdmin = session?.role === "admin";

  // Клиентский guard: viewer, попавший на admin-страницу, уводится на обзор
  // (сервер тоже редиректит — это подстраховка для SPA-навигации).
  useEffect(() => {
    if (!session) return;
    if (!isAdmin && ADMIN_PATH_PREFIXES.some((p) => pathname.startsWith(p))) window.location.href = "/";
  }, [session, isAdmin, pathname]);

  const sections = [
    { href: "/", label: t.navOverview, active: pathname === "/" },
    { href: "/inverter", label: t.navInverter, active: pathname.startsWith("/inverter") },
    ...(isAdmin ? [{ href: "/users", label: t.navUsers, active: pathname.startsWith("/users") }] : []),
  ];

  return (
    <nav className="nav-tabs nav-sections">
      {sections.map((s) => (
        <Link key={s.href} href={s.href} className={s.active ? "active" : ""}>
          {s.label}
        </Link>
      ))}
    </nav>
  );
}

function SystemFooter() {
  const t = useT();
  const session = useSession();
  const logout = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {}
    window.location.href = "/login";
  };
  return (
    <footer className="footer">
      <div className="footer-row">
        <span>{session ? session.username : "—"}</span>
        {session && (
          <a href="#" className="logout" onClick={logout}>
            {t.logout}
          </a>
        )}
      </div>
      <LangSwitch />
    </footer>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <SnapshotProvider>
        <ToastProvider>
          <SystemNav />
          {children}
          <SystemFooter />
        </ToastProvider>
      </SnapshotProvider>
    </SessionProvider>
  );
}
```

`web/app/(app)/inverter/layout.tsx` (бывший корневой): оставить `TopBar`, `WarningsBanner`, `NavTabs`, `MetaProvider`; удалить `SnapshotProvider`/`ToastProvider` (теперь уровнем выше), `Footer` и его рендер (системный футер общий); в `NavTabs` — вкладки `{ href: "/inverter", label: t.navDashboard }`, `/inverter/stats`, `/inverter/settings` (admin), `/inverter/diagnostics` (admin); вкладку `/users` убрать (она в системной навигации); `useDocTitle` оставить. Роль брать из `useMeta()` как раньше (внутри секции `MetaProvider` есть). Клиентский admin-guard из старого `NavTabs` удалить — он теперь в `SystemNav`.

Проверить `web/app/(app)/users/page.tsx` и `web/components/TokensPanel.tsx`: если используют `useMeta` — перевести на `useSession` (вне inverter-секции `MetaProvider` недоступен). Найти: `grep -rn useMeta web/app web/components | grep -v inverter`.

- [ ] **Step 6: Словарь i18n**

В словарь (`web/lib/i18n/` — файл с ключами `navDashboard` и т.п.) добавить во все три языка:

| Ключ | uk | ru | en |
|---|---|---|---|
| `navOverview` | `Огляд` | `Обзор` | `Overview` |
| `navInverter` | `Інвертор` | `Инвертор` | `Inverter` |
| `homeInverterCardOpen` | `Відкрити` | `Открыть` | `Open` |

(`navUsers`, `logout` уже существуют.) Типизированный словарь сам подсветит недостающие языки при `typecheck`.

- [ ] **Step 7: Страница обзора (падающий тест → реализация)**

`web/app/(app)/page.test.tsx` (рендер через существующий `web/test-utils/renderWithProviders.tsx` — тем же способом, каким тестируется дашборд в `inverter/page.test.tsx`, с фейковым снапшотом):

```tsx
// проверяем: карточка инвертора показывает badge источника, SOC, нагрузку и PV из снапшота,
// и ведёт по ссылке на /inverter
it("renders the inverter card from the snapshot", () => { /* по образцу inverter/page.test.tsx */ });
it("links to /inverter", () => { /* href проверить через getByRole("link") */ });
```

`web/app/(app)/page.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useSnapshot } from "@/lib/snapshot";
import { useT, useDocTitle, modeLabel } from "@/lib/i18n";
import { Panel } from "@/components/Panel";
import { fmt } from "@/lib/format"; // единственный форматтер чисел проекта: fmt(value, digits)

export default function HomePage() {
  const t = useT();
  useDocTitle("title"); // общий заголовок приложения; union-тип useDocTitle не расширять
  const { snapshot } = useSnapshot();
  const s = snapshot?.status ?? null;
  const source = snapshot?.powerSource ?? snapshot?.mode ?? "Unknown";

  return (
    <main className="grid home-grid">
      <Panel title={t.navInverter}>
        <div className="home-card">
          <span className={"mode-badge mode-" + source}>{modeLabel(t, source)}</span>
          {/* SOC, нагрузка, PV — те же поля, что читают карточки дашборда: */}
          {/* s.batteryCapacity (%), s.acOutputActivePower (Вт), s.pvChargingPower (Вт) */}
          {/* разметку значений взять по образцу соответствующих карточек inverter/page.tsx */}
        </div>
        <Link href="/inverter" className="home-card-link">{t.homeInverterCardOpen}</Link>
      </Panel>
    </main>
  );
}
```

Разметку строк значений скопировать из карточек дашборда (`inverter/page.tsx`): SOC — как в карточке батареи (`s.batteryCapacity`), нагрузка — как в карточке выхода (`s.acOutputActivePower`), PV — как в солнечной карточке (`s.pvChargingPower`); подписи — те же dict-ключи, что там. Пока снапшота нет — карточка показывает `t.connecting` (как делает дашборд). CSS-классы `home-grid`/`home-card`/`home-card-link` добавить в `web/app/globals.css` рядом с существующими стилями `.grid`/`.panel`, следуя их палитре.

Run: `npm test -w @sweethome/web -- --testPathPattern 'app/\(app\)/page'` → PASS.

- [ ] **Step 8: Починить оставшиеся веб-тесты**

`npm test -w @sweethome/web` — пройтись по падениям: пути fetch-моков (`/api/inverter/...`), новые href вкладок, `layout.test.tsx` разделить: старые проверки шапки инвертора — в `inverter/layout.test.tsx`, для нового системного layout написать проверки «viewer не видит /users в навигации; admin видит» (рендер с мокнутым `useSession` по образцу того, как старый тест мокал meta). `npm run typecheck -w @sweethome/web` тоже зелёный.

- [ ] **Step 9: Ручная smoke-проверка dev-режима**

```bash
npm run dev
# в другом терминале:
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/health   # 401 — auth жива
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost:3000/stats  # 301 → /inverter/stats (после логина в браузере)
```

Открыть `http://localhost:3001` (dev-веб): логин → обзор с карточкой инвертора (mock-данные) → переход в «Инвертор» → вкладки работают, `/users` доступна из шапки. Остановить dev.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(web): unified home UI - overview at /, inverter section under /inverter, system header"
```

---

### Task 7: deploy.sh, systemd-юнит sweethome, миграция Pi

**Files:**
- Create: `server/systemd/sweethome.service`
- Delete: `server/systemd/inverter-monitor.service` (git rm)
- Modify: `deploy.sh`

**Interfaces:**
- Consumes: артефакты сборки всех workspace'ов.
- Produces: рабочий деплой в `/home/pi/sweethome` под юнитом `sweethome.service`, с одноразовой миграцией старой раскладки. Health-check прежний (`/api/health`, 200/401 = жив).

- [ ] **Step 1: systemd-юнит**

`server/systemd/sweethome.service` (изменения против старого: имя, пути, идентификатор):

```ini
[Unit]
Description=Sweethome home control (inverter, heating, ...)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/sweethome/server
EnvironmentFile=-/home/pi/sweethome/server/.env
ExecStart=/usr/local/bin/node dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sweethome

[Install]
WantedBy=multi-user.target
```

```bash
git rm server/systemd/inverter-monitor.service
```

- [ ] **Step 2: deploy.sh**

Заменить содержимое (структура прежняя, меняются пути, юнит и добавляется миграция):

```bash
#!/usr/bin/env bash
# Деплой sweethome на Raspberry Pi.
# Использование: [PI_HOST=pi@raspberrypi.local] [SSH_KEY=~/.ssh/pi_key] ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

PI_HOST="${PI_HOST:-pi@raspberrypi.local}"
PI_DIR="/home/pi/sweethome"
OLD_DIR="/home/pi/inverter-monitor"

SSH=(ssh)
RSYNC_SSH="ssh"
if [ -n "${SSH_KEY:-}" ]; then
  SSH=(ssh -i "$SSH_KEY")
  RSYNC_SSH="ssh -i $SSH_KEY"
fi

echo "==> Сборка (packages + modules + server + web)"
npm run build
npm run check

echo "==> Одноразовая миграция каталога на Pi (безопасна при повторных запусках)"
"${SSH[@]}" "$PI_HOST" bash -s <<EOF
set -euo pipefail
if [ -d "$OLD_DIR" ] && [ ! -d "$PI_DIR" ]; then
  sudo systemctl disable --now inverter-monitor 2>/dev/null || true
  mv "$OLD_DIR" "$PI_DIR"
  # Раскладка данных: модульные файлы инвертора уезжают в data/inverter/
  mkdir -p "$PI_DIR/server/data/inverter"
  [ -f "$PI_DIR/server/data/stats.db" ] && mv "$PI_DIR/server/data/stats.db" "$PI_DIR/server/data/inverter/stats.db"
  [ -f "$PI_DIR/server/data/baseline.json" ] && mv "$PI_DIR/server/data/baseline.json" "$PI_DIR/server/data/inverter/baseline.json"
  sudo rm -f /etc/systemd/system/inverter-monitor.service
fi
EOF

echo "==> rsync на $PI_HOST:$PI_DIR"
rsync -az --relative --delete -e "$RSYNC_SSH" \
  package.json package-lock.json \
  packages/shared/package.json packages/shared/dist \
  packages/inverter-shared/package.json packages/inverter-shared/dist \
  packages/inverter-mcp/package.json packages/inverter-mcp/dist \
  modules/inverter/package.json modules/inverter/dist \
  server/package.json server/dist server/systemd server/.env.example \
  web/package.json web/out \
  "$PI_HOST:$PI_DIR/"

echo "==> Установка и рестарт на Pi"
"${SSH[@]}" "$PI_HOST" bash -s <<EOF
set -euo pipefail
cd "$PI_DIR"
rm -rf shared mcp   # каталоги старой раскладки, если остались
npm ci -w server -w modules/inverter -w packages/inverter-mcp --omit=dev
sudo cp server/systemd/sweethome.service /etc/systemd/system/sweethome.service
sudo systemctl daemon-reload
sudo systemctl enable sweethome >/dev/null 2>&1 || true
sudo systemctl restart sweethome
EOF

echo "==> Health-check (под может рестартовать до минуты)"
HOST_ONLY="${PI_HOST#*@}"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://$HOST_ONLY:3000/api/health" || true)
  # 200 = auth выключена, 401 = auth включена; оба значат «сервер жив»
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then
    echo "OK (HTTP $code)"
    exit 0
  fi
  sleep 2
done
echo "FAIL: сервер не ответил за 60 с — смотри: ssh $PI_HOST journalctl -u sweethome -n 50" >&2
exit 1
```

Обрати внимание: экранирование в heredoc — переменные `$PI_DIR`/`$OLD_DIR` раскрываются локально (heredoc без кавычек, как в старом скрипте); внутренних `$`-переменных на Pi в миграционном блоке нет.

- [ ] **Step 3: Проверка синтаксиса**

Run: `bash -n deploy.sh`
Expected: пусто (без ошибок). Деплой НЕ запускать — только по явной просьбе пользователя.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(deploy): deploy as the sweethome service with one-off Pi layout migration"
```

---

### Task 8: Документы: CLAUDE.md ×2, README ×2, спека и план отопления

**Files:**
- Create: `modules/inverter/CLAUDE.md`, `modules/inverter/README.md` (переезд корневого), `README.md` (новый корневой), `docs/heating/SPEC.md`, `docs/superpowers/plans/2026-07-30-heating.md`
- Modify: `CLAUDE.md` (корневой — переписывается)

**Interfaces:**
- Consumes: текущий `CLAUDE.md`, текущий `README.md`, `~/work/rancho/heating/SPEC.md`, `~/work/rancho/heating/docs/superpowers/plans/2026-07-30-heating.md`.
- Produces: двухуровневая документация; спека отопления, согласованная с монолитом.

- [ ] **Step 1: Разрезать CLAUDE.md**

`git mv README.md modules/inverter/README.md`. Создать `modules/inverter/CLAUDE.md`, перенеся из корневого CLAUDE.md **дословно** разделы: «Protocol (important: Modbus, NOT PI30)», подразделы архитектуры про `protocol/`, `transport/`, `inverter.ts`, `stats/`, `mqtt.ts`, MCP-подраздел, «The write-safety model», «Hardware (context for debugging the link)» — с поправкой путей (`server/src/protocol/*` → `modules/inverter/src/protocol/*`, `shared/` → `packages/inverter-shared/`) и имён пакетов.

Новый корневой `CLAUDE.md` — структура:

```markdown
# CLAUDE.md

## About the project
`sweethome` — модульный монолит управления домом на Raspberry Pi (мин. Pi 3B).
Модули: `modules/inverter` (см. его CLAUDE.md); отопление — по docs/heating/SPEC.md, реализация впереди.
Спека объединения: docs/superpowers/specs/2026-08-01-sweethome-unification-design.md.

## Commands (from the repository root)
npm install / npm run dev / npm run build / npm run check / npm test / ./deploy.sh
[перенести таблицу команд и предупреждение про Node ≥ 24 из старого CLAUDE.md дословно,
обновив список workspace'ов в пояснениях]

## Architecture
Монорепо npm workspaces: packages/shared → packages/inverter-shared →
packages/inverter-mcp → modules/inverter → server → web (строгий порядок сборки, импорт из dist).
- server/ — хост: Express, auth (sessions/tokens/roles), WebSocket, статика web/out,
  монтаж модулей: /api/<id>, /ws/<id>, агрегированный /api/health. Контракт — HomeModule
  из @sweethome/shared/module.
- modules/inverter — модуль инвертора, детали в modules/inverter/CLAUDE.md.
- web/ — единый Next.js (App Router, static export): / обзор, /inverter/*, /users.
[перенести из старого: разделы про авторизацию (auth/), веб-техстек, i18n — с новыми путями]

## Deploying to the Pi
[перенести раздел из старого CLAUDE.md, заменив имена: sweethome.service, /home/pi/sweethome;
data-раскладка: server/data/auth.db системная, server/data/inverter/{stats.db,baseline.json}]

## Git workflow
[дословно из старого CLAUDE.md]
```

Содержимое в квадратных скобках — инструкции переноса конкретных разделов старого файла, не текст. Ничего инверторно-специфичного в корне не оставлять.

- [ ] **Step 2: Корневой README**

`README.md` (новый, на английском — репозиторий публичный):

```markdown
# sweethome

Local, cloud-free home control running on a Raspberry Pi (3B or better).
A modular monolith: one Node process hosts independent subsystem modules
behind a single web UI, shared authentication and a single deploy.

## Modules
- **inverter** — monitoring and control of an ISolar SMG II hybrid inverter
  over Modbus RTU. See [modules/inverter/README.md](modules/inverter/README.md).
- **heating** — designed, not yet implemented. See [docs/heating/SPEC.md](docs/heating/SPEC.md).

## Stack
Node ≥ 24, TypeScript, npm workspaces, Express + WebSocket, Next.js (static
export), SQLite via node:sqlite, jest. Deploys to a Pi with rsync + systemd
(`./deploy.sh`).

## Development
npm install && npm run dev   # server :3000 (mock transport) + web :3001
npm test                     # all workspaces
```

В `modules/inverter/README.md` пройтись по упоминаниям путей: `/api/...` инверторные → `/api/inverter/...`, `/ws` → `/ws/inverter`, `mcp/dist/bin/stdio.js` → `packages/inverter-mcp/dist/bin/stdio.js`, `server/data/...` → `server/data/inverter/...` для stats/baseline (auth.db остаётся системной). Команда для поиска: `grep -n '/api/\|/ws\|mcp/dist\|data/' modules/inverter/README.md`.

- [ ] **Step 3: Спека и план отопления**

```bash
mkdir -p docs/heating
cp ~/work/rancho/heating/SPEC.md docs/heating/SPEC.md
cp ~/work/rancho/heating/docs/superpowers/plans/2026-07-30-heating.md docs/superpowers/plans/2026-07-30-heating.md
```

Правки `docs/heating/SPEC.md` (содержательные разделы — MQTT-контракт §5, лестница §6, железо §7, прошивки §8, матрица §12, тексты §13 — НЕ трогать):

1. Шапка: добавить строку «Обновлено 2026-08-01: отопление реализуется модулем монолита `sweethome` — см. `docs/superpowers/specs/2026-08-01-sweethome-unification-design.md`; правки в §2, §3, §4, §9, §10, §11.»
2. §2: строку про соседний проект `../inverter-monitor` заменить: стек тот же, но это теперь **этот же репозиторий** — модуль `modules/heating` внутри `sweethome`.
3. §3, таблица решений: «Отношение к inverter-monitor | Отдельное приложение, отдельный репозиторий и деплой, общий UI и общая авторизация» → «Отношение к остальной системе | Модуль монолита sweethome: общий процесс, общий веб, общая авторизация, общий деплой»; «Авторизация и склейка | Вариант A: forward_auth в Caddy…» → «Авторизация | Общая auth-middleware хоста sweethome; forward_auth не нужен».
4. §4, диаграмма: блок «heating-service Node 24, :3002» → «модуль heating в sweethome (Node, :3000)»; строку «Caddy /heating ▼ (forward_auth)» → «веб-раздел /heating единого интерфейса».
5. §9: заголовок «Сервис на Pi (heating-service)» → «Модуль heating в sweethome»; вводный абзац про «монорепо shared/server/web по образцу inverter-monitor» → «пакеты modules/heating и packages/heating-shared в монорепо sweethome; модуль реализует контракт HomeModule (@sweethome/shared/module)»; в таблице модулей `server.ts | Express: REST + WS + статика web/out` → `module.ts + router.ts | сборка HomeModule: REST-роутер, WS-снапшоты, start/stop`; `config.ts | .env` → `config.ts | свои ключи в общем server/.env`; хранение — `server/data/heating/heating.db`; пути API `GET /heating/api/...` → `GET /api/heating/...`, `WS /heating/ws` → `WS /ws/heating`; из «Конфигурация» удалить `PORT=3002`, `BIND=127.0.0.1`; `GET /heating/api/me` и объяснение к нему удалить — роль приходит из системного `/api/me`.
6. §10 заменить целиком на:

   ```markdown
   ## 10. Авторизация

   Модуль живёт за общей auth-middleware хоста sweethome: те же сессии, API-токены
   и роли, что у инвертора. `viewer` видит показания и графики; менять уставку и
   настройки может только `admin` (гейт `requireAdmin` на PUT-маршрутах роутера).
   Caddy не участвует: `rancho.network` уже проксирует на :3000 целиком.
   ```
7. §11: «Next 15 со статическим экспортом, basePath: '/heating'…» → «Раздел `/heating/*` единого веб-приложения sweethome (Next 15, static export)»; пункт про общую шапку с вкладками заменить: «Шапка и навигация уже общие — раздел добавляется в системную навигацию рядом с Инвертором».
8. Остальные упоминания `heating-service`, `:3002`, `forward_auth`, `/heating/api/` по файлу: `grep -n 'heating-service\|3002\|forward_auth\|/heating/api\|/heating/ws' docs/heating/SPEC.md` — привести к новой модели по смыслу пунктов выше (в §12/§14, если встречаются, — «сервис упал» читать как «процесс sweethome упал»; поведение нод не меняется).

Правки плана `docs/superpowers/plans/2026-07-30-heating.md`: добавить в шапку блок «⚠️ Обновление 2026-08-01: структура изменена — не отдельный сервис, а модуль `modules/heating` в репозитории sweethome (см. спеку объединения). Пути и имена workspace'ов в тасках читать через эту призму; перед исполнением план актуализировать под фактический каркас.» — глубокая переработка плана отопления будет отдельным заходом перед его реализацией, здесь только маркер и правка явных путей (`heating-service/` → `modules/heating/`): `grep -n 'heating-service' docs/superpowers/plans/2026-07-30-heating.md`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: split CLAUDE.md per module, add root README, adopt heating spec into the monorepo"
```

---

### Task 9: Финальная проверка, переезд рабочей копии, PR

**Files:**
- Вне репозитория: `~/work/rancho/inverter-monitor` → `~/work/rancho/sweethome`; удаление `~/work/rancho/heating` (только с подтверждением пользователя!)

**Interfaces:**
- Consumes: всё выше.
- Produces: ветка запушена, PR открыт; рабочая копия переименована.

- [ ] **Step 1: Полный прогон**

```bash
npm run build && npm run check && npm test
npx eslint $(git diff --name-only main -- 'web/**/*.ts' 'web/**/*.tsx' | tr '\n' ' ') || true  # линт только изменённых веб-файлов; починить реальные ошибки
git status --short  # чисто, без забытых артефактов
```

- [ ] **Step 2: Переезд рабочей копии (с подтверждением пользователя)**

Спросить пользователя, затем:

```bash
cd ~/work/rancho
mv inverter-monitor sweethome
# rancho/heating: SPEC.md и план уже в репозитории (Task 8) — удалить каталог
rm -rf heating
```

⚠️ Перед `rm -rf heating` свериться, что `docs/heating/SPEC.md` и план в репозитории идентичны исходникам (`diff ~/work/rancho/heating/SPEC.md ~/work/rancho/sweethome/docs/heating/SPEC.md` покажет только внесённые правки §2–§11 — убедиться, что §5–§8, §12–§20 не разошлись).

- [ ] **Step 3: Push и PR**

```bash
cd ~/work/rancho/sweethome
git push -u origin feat/sweethome-unification
gh pr create --title "Sweethome: modular monolith unification" --body "См. docs/superpowers/specs/2026-08-01-sweethome-unification-design.md"
```

PR **не мержить** без явного «да» пользователя. Деплой на Pi — отдельным шагом по явной просьбе (после мержа), помня: успешный деплой ≠ мгновенно обновлённый стенд, health-check в deploy.sh ждёт сам.

- [ ] **Step 4: Напоминания пользователю (в финальном сообщении)**

- MCP-клиенты, запускающие stdio-бинарь по абсолютному пути, должны сменить путь на `~/work/rancho/sweethome/packages/inverter-mcp/dist/bin/stdio.js`.
- Закладки на страницы работают через 301; прямые ссылки на старые REST-пути (если есть где-то ещё) — обновить на `/api/inverter/*`.

---

## Self-Review Checklist (выполнен при написании)

- Spec coverage: §3 структура — Tasks 1–3; §4 хост/контракт — Tasks 2, 4; §5 данные — Tasks 3, 7; §6 веб — Task 6; §7 деплой — Task 7; §8 документы — Task 8; §9 тесты — в каждом таске + Task 9; §10 git — ветка/коммиты по ходу; §11 вне скоупа — не затронуто.
- Отклонение от спеки, принятое сознательно: контракт `HomeModule` экспортируется subpath-ом `@sweethome/shared/module` (не из корня пакета), чтобы веб не тянул типы express. Спеке не противоречит — пакет тот же.
- Реэкспорт auth-типов из `@sweethome/inverter-shared` (Task 2, Step 6) оставлен намеренно ради меньшего диффа; чистку импортов можно сделать при реализации отопления.
