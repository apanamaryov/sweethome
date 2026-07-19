# Переезд inverter-monitor на Next.js — план имплементации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Монорепо `shared/` + `server/` + `web/`: UI переезжает на Next.js (App Router, static export), проверенный Express-демон остаётся единственным процессом на Pi и раздаёт статику.

**Architecture:** Next.js собирает UI в статику (`output: 'export'` → `web/out/`); Express-демон (`server/`) раздаёт её вместо `public/` и не меняется в остальном. Общие типы и константы — в пакете `@inverter/shared`, который собирается tsc в `shared/dist` и импортируется обоими. Спека: `docs/superpowers/specs/2026-07-19-nextjs-rewrite-design.md`.

**Tech Stack:** npm workspaces, TypeScript strict, Express 4 + ws (как есть), Next.js 15 + React 19, tsx (dev-watch), concurrently.

## Global Constraints

- **Никогда не добавлять `Co-Authored-By` в коммиты** (правило пользователя). Сообщения коммитов — на русском, в стиле истории репо.
- **Не деплоить на Pi** и не ходить по SSH на Pi без явной команды пользователя. Все проверки — локально, демон в mock-режиме.
- **Playwright не запускать** — проверки через curl/tsc/node.
- **Логику бэкенда не менять**: `inverter.ts`, `protocol/crc.ts`, парсеры/билдеры `pi30.ts`, `transport/*`, `mqtt.ts`, `auth.ts` переезжают байт-в-байт; меняются только import-строки, перечисленные явно в Task 3, и `server.ts` в Task 11.
- **Тексты словарей i18n копировать дословно** из `public/i18n.js` — ни один перевод не переписывать.
- **CSS `public/style.css` копируется как есть**; новые стили только добавляются в конец файла (Task 8). Классы/id из старой разметки сохраняются, чтобы CSS работал без правок.
- Node на dev-машине ≥ 20 (проверяется в Task 4). Порты dev: демон 3000, next dev 3001.
- Рабочая директория репо: `/home/alexey/work/rancho/inverter-monitor` (git, ветка `main`). Все пути ниже — от корня репо.
- ESLint не настраиваем и не запускаем; контроль типов — `tsc`.

## Карта файлов (итоговая)

```
inverter-monitor/
├── package.json                  # root: workspaces + build/dev/check
├── package-lock.json             # общий lock (генерируется)
├── .gitignore                    # + .next/, web/out/, next-env.d.ts
├── deploy.sh                     # сборка → rsync → npm ci → restart → health
├── shared/
│   ├── package.json  tsconfig.json
│   └── src/{types.ts, api.ts, index.ts}
├── server/
│   ├── package.json  tsconfig.json  .env.example
│   ├── scripts/selfcheck.ts      # CRC-эталоны, раундтрипы, парсеры, сеттеры
│   ├── src/{index,config,inverter,server,auth,mqtt,store}.ts
│   ├── src/protocol/{crc,pi30}.ts        # types.ts уезжает в shared
│   ├── src/transport/{types,serial,hid,mock,detect}.ts
│   └── systemd/inverter-monitor.service  # пути обновлены (Task 12)
└── web/
    ├── package.json  tsconfig.json  next.config.ts
    ├── app/
    │   ├── layout.tsx  globals.css        # globals.css = копия style.css
    │   ├── login/page.tsx
    │   └── (app)/{layout.tsx, page.tsx, settings/page.tsx, diagnostics/page.tsx}
    ├── components/{Panel,ConfirmDialog,LangSwitch,BatteryRing}.tsx
    └── lib/
        ├── api.ts  format.ts  snapshot.tsx  meta.tsx  toast.tsx
        └── i18n/{dict.ts, index.tsx}
```

---

### Task 1: Монорепо-скелет — перенос бэкенда в `server/`

**Files:**
- Create: `package.json` (root, новый), `server/package.json`
- Move: `src/` → `server/src/`, `systemd/` → `server/systemd/`, `tsconfig.json` → `server/tsconfig.json`, `.env.example` → `server/.env.example`
- Delete: `package-lock.json` (старый корневой; новый сгенерирует `npm install`)

**Interfaces:**
- Produces: workspace `server` (имя пакета `@inverter/server`) со скриптами `build`/`start`/`dev`; root-скрипты `npm run build`, `npm run dev -w server`. Демон слушает :3000 в mock.

- [ ] **Step 1: Переместить файлы бэкенда**

```bash
cd /home/alexey/work/rancho/inverter-monitor
mkdir -p server
git mv src server/src
git mv systemd server/systemd
git mv tsconfig.json server/tsconfig.json
git mv .env.example server/.env.example
git mv package.json server/package.json
git rm -q package-lock.json
rm -rf node_modules dist
```

- [ ] **Step 2: Отредактировать `server/package.json`**

Заменить целиком на:

```json
{
  "name": "@inverter/server",
  "version": "1.0.0",
  "private": true,
  "description": "Local monitoring and control for a Voltronic/SmartESS-style hybrid inverter (SK-5500P-48L) over serial/USB-HID. No cloud.",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "INVERTER_TRANSPORT=mock tsx watch src/index.ts",
    "clean": "rm -rf dist"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "express": "^4.19.2",
    "mqtt": "^5.10.1",
    "ws": "^8.18.0"
  },
  "optionalDependencies": {
    "serialport": "^12.0.0",
    "node-hid": "^3.1.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^18.19.0",
    "@types/ws": "^8.5.10",
    "tsx": "^4.19.0",
    "typescript": "^5.4.5"
  },
  "license": "MIT"
}
```

(Отличия от старого: имя, `private`, скрипт `dev` через tsx + mock, devDep `tsx`.)

- [ ] **Step 3: Создать корневой `package.json`**

```json
{
  "name": "inverter-monitor-root",
  "private": true,
  "workspaces": ["server"],
  "scripts": {
    "build": "npm run build -w server",
    "check": "npm run check -w server"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 4: Установить и собрать**

Run: `npm install && npm run build`
Expected: без ошибок; появились `node_modules/`, `package-lock.json`, `server/dist/index.js`.

- [ ] **Step 5: Смоук демона в mock**

Run: `PORT=3999 node server/dist/index.js & sleep 2 && curl -s localhost:3999/api/health && curl -s localhost:3999/api/snapshot | head -c 200; kill %1`
Expected: `{"ok":true}` и начало JSON-снапшота с `"connection":{"connected":true,...,"mock":true`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Монорепо: бэкенд переезжает в server/, корень — npm workspaces"
```

---

### Task 2: Selfcheck протокола — страховка перед рефакторингом

**Files:**
- Create: `server/scripts/selfcheck.ts`
- Modify: `server/package.json` (скрипт `check`), root `package.json` уже пробрасывает `check`

**Interfaces:**
- Consumes: `server/src/protocol/crc.ts` (`crc16`, `buildFrame`, `parseFrame`, `buildResponse`, `commandFromFrame`), `server/src/protocol/pi30.ts` (парсеры, `buildControlCommand`, `isAck`)
- Produces: команда `npm run check` → «selfcheck OK», exit 0. Этот скрипт обязан проходить после КАЖДОЙ следующей задачи, затрагивающей server/shared.

- [ ] **Step 1: Написать selfcheck (это и есть «failing test» для будущего рефакторинга)**

`server/scripts/selfcheck.ts`:

```ts
import assert from "assert";
import { crc16, buildFrame, parseFrame, buildResponse, commandFromFrame } from "../src/protocol/crc";
import {
  parseStatus,
  parseRatedInfo,
  parseFlags,
  parseMode,
  parseWarnings,
  buildControlCommand,
  isAck,
} from "../src/protocol/pi30";

// 1. CRC-эталоны (сверены с mpp-solar/skymax в сессии 2026-07-17)
const CRC_ETALONS: Array<[string, string]> = [
  ["QPIGS", "b7a9"],
  ["QPIRI", "f854"],
  ["QMOD", "49c1"],
  ["QPIWS", "b4da"],
  ["QID", "d6ea"],
];
for (const [cmd, hex] of CRC_ETALONS) {
  assert.strictEqual(crc16(Buffer.from(cmd, "ascii")).toString("hex"), hex, `CRC(${cmd})`);
}

// 2. Раундтрип кадров (запрос и ответ)
const frame = buildFrame("QPIGS");
assert.strictEqual(commandFromFrame(frame), "QPIGS");
assert.strictEqual(frame[frame.length - 1], 0x0d);
const payload =
  "230.0 50.0 230.0 50.0 0690 0600 010 410 52.40 000 078 0043 00.0 000.0 52.40 00015 00010101 00 00 00000 010";
assert.strictEqual(parseFrame(buildResponse(payload)), payload);

// 3. QPIGS: маппинг позиций
const st = parseStatus(payload);
assert.strictEqual(st.gridVoltage, 230);
assert.strictEqual(st.acOutputActivePower, 600);
assert.strictEqual(st.batteryVoltage, 52.4);
assert.strictEqual(st.batteryCapacity, 78);
assert.strictEqual(st.batteryDischargeCurrent, 15);
assert.strictEqual(st.deviceStatus, "00010101");
assert.strictEqual(st.pvChargingPower, 0);

// 4. QPIRI: маппинг позиций ключевых настроек
const rated = parseRatedInfo(
  "230.0 23.9 230.0 50.0 23.9 5500 5500 48.0 46.0 42.0 56.4 54.0 0 030 060 0 2 1 1 1 0 0 54.0"
);
assert.strictEqual(rated.acOutputRatingActivePower, 5500);
assert.strictEqual(rated.batteryRechargeVoltage, 46);
assert.strictEqual(rated.maxAcChargingCurrent, 30);
assert.strictEqual(rated.maxChargingCurrent, 60);
assert.strictEqual(rated.outputSourcePriority, 2);
assert.strictEqual(rated.chargerSourcePriority, 1);
assert.strictEqual(rated.batteryRedischargeVoltage, 54);

// 5. QFLAG / QMOD / QPIWS
const flags = parseFlags("EbkuvxyzDaj");
assert.strictEqual(flags.flags.filter((f) => f.enabled).length, 7);
assert.strictEqual(flags.flags.find((f) => f.key === "a")?.enabled, false);
assert.strictEqual(parseMode("B"), "Battery");
const warn = parseWarnings("00000100000000000000000000000000");
assert.deepStrictEqual(warn.active, ["Line fail (no utility)"]);

// 6. Сеттеры: точный формат провода (PBCV с точкой — критично для железа)
assert.strictEqual(buildControlCommand("outputSourcePriority", 2), "POP02");
assert.strictEqual(buildControlCommand("chargerSourcePriority", 3), "PCP03");
assert.strictEqual(buildControlCommand("maxChargingCurrent", 60), "MCHGC060");
assert.strictEqual(buildControlCommand("maxAcChargingCurrent", 2), "MUCHGC002");
assert.strictEqual(buildControlCommand("batteryRechargeVoltage", 46), "PBCV46.0");
assert.strictEqual(buildControlCommand("batteryRedischargeVoltage", 54), "PBDV54.0");
assert.strictEqual(isAck(" ACK "), true);
assert.throws(() => buildControlCommand("maxChargingCurrent", 55));

console.log("selfcheck OK");
```

- [ ] **Step 2: Добавить скрипт в `server/package.json`**

В `"scripts"` добавить строку:

```json
    "check": "tsx scripts/selfcheck.ts",
```

- [ ] **Step 3: Запустить**

Run: `npm run check`
Expected: `selfcheck OK`, exit 0. Если упало — НЕ подгонять эталоны под код; разбираться, что сломано (эталоны верны).

- [ ] **Step 4: Commit**

```bash
git add server/scripts/selfcheck.ts server/package.json
git commit -m "Selfcheck протокола: CRC-эталоны, раундтрипы кадров, парсеры, форматы сеттеров"
```

---

### Task 3: Пакет `shared/` и переключение сервера на него

**Files:**
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/api.ts`, `shared/src/index.ts`
- Move: `server/src/protocol/types.ts` → `shared/src/types.ts` (без правок содержимого)
- Modify: `server/src/protocol/pi30.ts`, `server/src/inverter.ts`, `server/src/mqtt.ts`, `server/src/store.ts`, `server/src/server.ts` (только import-строки и удаление перенесённых определений), `server/package.json`, root `package.json`

**Interfaces:**
- Produces: пакет `@inverter/shared` — из него импортируются `Snapshot`, `InverterStatus`, `InverterRatedInfo`, `InverterWarnings`, `InverterFlags`, `InverterFlag`, `Baseline`, `DeviceMode`, `ControlType`, `OUTPUT_SOURCE_PRIORITY`, `CHARGER_SOURCE_PRIORITY`, `ALLOWED_MAX_CHARGE_CURRENT`, `ALLOWED_MAX_AC_CHARGE_CURRENT`, `ApiMeta`, `ControlResponse`, `LoginErrorCode`. Web-задачи (5–10) импортируют типы ТОЛЬКО отсюда.

- [ ] **Step 1: Создать пакет**

`shared/package.json`:

```json
{
  "name": "@inverter/shared",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist"
  }
}
```

`shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2020"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": false
  },
  "include": ["src/**/*.ts"]
}
```

```bash
mkdir -p shared/src
git mv server/src/protocol/types.ts shared/src/types.ts
```

- [ ] **Step 2: `shared/src/api.ts` — контракт API + константы из pi30**

```ts
/** Whitelist управляющих команд, доступный API/UI. */
export type ControlType =
  | "outputSourcePriority"
  | "chargerSourcePriority"
  | "maxChargingCurrent"
  | "maxAcChargingCurrent"
  | "batteryRechargeVoltage"
  | "batteryRedischargeVoltage";

export const OUTPUT_SOURCE_PRIORITY: Record<number, string> = {
  0: "Utility first",
  1: "Solar first",
  2: "Solar → Battery → Utility (SBU)",
};

export const CHARGER_SOURCE_PRIORITY: Record<number, string> = {
  0: "Utility first",
  1: "Solar first",
  2: "Solar and Utility",
  3: "Only Solar",
};

/** Допустимый общий ток заряда (А) на этих аппаратах. */
export const ALLOWED_MAX_CHARGE_CURRENT = [10, 20, 30, 40, 50, 60, 70, 80];
/** Допустимый ток заряда от сети (А). */
export const ALLOWED_MAX_AC_CHARGE_CURRENT = [2, 10, 20, 30, 40, 50, 60];

/** Ответ GET /api/meta. */
export interface ApiMeta {
  authEnabled: boolean;
  allowControl: boolean;
  outputSourcePriority: Record<number, string>;
  chargerSourcePriority: Record<number, string>;
  maxChargingCurrent: number[];
  maxAcChargingCurrent: number[];
}

/** Ответ POST /api/control (и форма ошибок остальных POST). */
export interface ControlResponse {
  ok: boolean;
  command?: string;
  reply?: string;
  error?: string;
}

/** Машиночитаемые коды ошибок POST /api/login. */
export type LoginErrorCode = "bad_password" | "rate_limited";
```

`shared/src/index.ts`:

```ts
export * from "./types";
export * from "./api";
```

- [ ] **Step 3: Переключить импорты сервера**

В `server/src/protocol/pi30.ts`:
- заменить шапку `import {...} from "./types";` (строки 1–7) на:

```ts
import {
  InverterStatus,
  InverterRatedInfo,
  InverterWarnings,
  InverterFlags,
  DeviceMode,
  ControlType,
  OUTPUT_SOURCE_PRIORITY,
  CHARGER_SOURCE_PRIORITY,
  ALLOWED_MAX_CHARGE_CURRENT,
  ALLOWED_MAX_AC_CHARGE_CURRENT,
} from "@inverter/shared";
```

- удалить из pi30.ts собственные определения, переехавшие в shared (они там дословно): блоки `export const OUTPUT_SOURCE_PRIORITY = {...}`, `export const CHARGER_SOURCE_PRIORITY = {...}`, `export const ALLOWED_MAX_CHARGE_CURRENT = [...]`, `export const ALLOWED_MAX_AC_CHARGE_CURRENT = [...]`, `export type ControlType = ...`. Функции (`setOutputSourcePriority` … `buildControlCommand`) остаются и используют импортированные константы.

Остальные файлы — только замена источника импорта:
- `server/src/inverter.ts`: из строки 17 (импорт из `./protocol/pi30`) убрать `ControlType`; строку 18 заменить на `import { Snapshot, DeviceMode, Baseline, ControlType } from "@inverter/shared";`
- `server/src/mqtt.ts`: строку 3 заменить на `import { Snapshot, ControlType, OUTPUT_SOURCE_PRIORITY, CHARGER_SOURCE_PRIORITY, ALLOWED_MAX_CHARGE_CURRENT, ALLOWED_MAX_AC_CHARGE_CURRENT } from "@inverter/shared";` и удалить импорт этих имён из `./protocol/pi30` (строки 4–10; если оттуда импортировалось что-то ещё — оставить только это).
- `server/src/store.ts`: `import { Baseline } from "./protocol/types";` → `import { Baseline } from "@inverter/shared";`
- `server/src/server.ts`: импорт `OUTPUT_SOURCE_PRIORITY, CHARGER_SOURCE_PRIORITY, ALLOWED_MAX_CHARGE_CURRENT, ALLOWED_MAX_AC_CHARGE_CURRENT, ControlType` (строки 8–14) перевести с `./protocol/pi30` на `@inverter/shared`; импорт `Snapshot` (строка 15) — с `./protocol/types` на `@inverter/shared`.

- [ ] **Step 4: Подключить зависимость и порядок сборки**

- `server/package.json` → в `"dependencies"` добавить `"@inverter/shared": "1.0.0",`
- root `package.json` → `"workspaces": ["shared", "server"]`, `"build": "npm run build -w shared && npm run build -w server"`

- [ ] **Step 5: Пересобрать и проверить**

Run: `npm install && npm run build && npm run check`
Expected: сборка обоих пакетов без ошибок, `selfcheck OK`. `ls node_modules/@inverter` показывает симлинк `shared`.

- [ ] **Step 6: Смоук демона (как Task 1 Step 5)**

Run: `PORT=3999 node server/dist/index.js & sleep 2 && curl -s localhost:3999/api/meta; kill %1`
Expected: JSON с `authEnabled:false`, таблицами приоритетов и списками токов.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Пакет shared: общие типы и константы протокола, сервер переключён на него"
```

---

### Task 4: Каркас `web/` (Next.js static export) + корневой dev-скрипт

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/next.config.ts`, `web/app/layout.tsx`, `web/app/page.tsx`, `web/app/globals.css` (копия), `web/lib/.gitkeep` не нужен
- Modify: root `package.json` (workspaces, build, dev, concurrently), `.gitignore`

**Interfaces:**
- Produces: `npm run build` собирает и `web/out/` (статика); `npm run dev` поднимает демона (:3000, mock) и next dev (:3001, `/api/*` проксируется). Alias `@/*` → `web/*`.

- [ ] **Step 1: Проверить Node**

Run: `node -v`
Expected: v20+ (у Next 15 floor — 18.18, но целимся в 20+). Если старее — остановиться и сообщить пользователю.

- [ ] **Step 2: `web/package.json`**

```json
{
  "name": "@inverter/web",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3001",
    "build": "next build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@inverter/shared": "1.0.0",
    "next": "^15.3.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 3: `web/next.config.ts`**

```ts
import type { NextConfig } from "next";

const dev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  // В проде — чистая статика для раздачи Express-демоном.
  // В dev нужен обычный dev-сервер + прокси API на демона (:3000).
  output: dev ? undefined : "export",
  ...(dev
    ? {
        async rewrites() {
          return [{ source: "/api/:path*", destination: "http://localhost:3000/api/:path*" }];
        },
      }
    : {}),
};

export default nextConfig;
```

(WebSocket через rewrites не проксируется — клиент в dev пойдёт напрямую на `ws://localhost:3000/ws`, см. Task 6.)

- [ ] **Step 4: `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", "out"]
}
```

- [ ] **Step 5: Стили и минимальный layout/страница**

```bash
mkdir -p web/app
cp public/style.css web/app/globals.css
```

`web/app/layout.tsx`:

```tsx
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Інвертор · SK-5500P-48L",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f1f0ec",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
```

`web/app/page.tsx` (временная заглушка, заменится в Task 8):

```tsx
export default function Page() {
  return <main className="grid">web scaffold OK</main>;
}
```

- [ ] **Step 6: Root package.json + .gitignore**

root `package.json` целиком:

```json
{
  "name": "inverter-monitor-root",
  "private": true,
  "workspaces": ["shared", "server", "web"],
  "scripts": {
    "build": "npm run build -w shared && npm run build -w server && npm run build -w web",
    "check": "npm run check -w server && npm run typecheck -w web",
    "dev": "concurrently -k -n server,web -c blue,magenta \"npm run dev -w server\" \"npm run dev -w web\""
  },
  "devDependencies": {
    "concurrently": "^9.1.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

В `.gitignore` добавить строки:

```
.next/
web/out/
next-env.d.ts
```

- [ ] **Step 7: Установить, собрать, смоук dev-флоу**

Run: `npm install && npm run build`
Expected: три сборки зелёные; есть `web/out/index.html`.

Run: `npm run dev & sleep 15 && curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/ && curl -s localhost:3001/api/health; kill %1`
Expected: `200` и `{"ok":true}` (прокси работает). После kill оба процесса гаснут (`-k`).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Каркас web: Next.js со static export, dev-прокси на демона, корневой dev-скрипт"
```

---

### Task 5: i18n — словари и контекст

**Files:**
- Create: `web/lib/i18n/dict.ts`, `web/lib/i18n/index.tsx`
- Modify: `web/app/layout.tsx` (обернуть в LangProvider)

**Interfaces:**
- Consumes: словари из `public/i18n.js` (uk: строки 7–104, ru: 106–203, en: 205–274)
- Produces: `LANGS`, `type Lang`, `type Dict`, `DICTS`; хуки `useI18n(): { lang, dict, setLang }`, `useT(): Dict`, `useDocTitle(key)`; хелперы `modeLabel(dict, mode)`, `warnLabel(dict, name)`, `flagLabel(dict, key, fallback?)`. Все дальнейшие компоненты берут тексты ТОЛЬКО через `useT()`.

- [ ] **Step 1: `web/lib/i18n/dict.ts`**

Каркас файла (словарь `uk` показан целиком; поля `ru`/`en` заполняются дословным переносом значений из `public/i18n.js` строк 106–203 и 205–274 — та же структура ключей, что у `uk`; ничего не переформулировать):

```ts
export const LANGS = ["uk", "ru", "en"] as const;
export type Lang = (typeof LANGS)[number];

const uk = {
  langLocale: "uk-UA",
  title: "Інвертор · SK-5500P-48L",
  loginTitle: "Вхід · Інвертор",
  h1: "Інвертор",
  connecting: "З'єднання…",
  updated: "оновлено ",
  demoData: "Демо-дані (інвертор не підключений)",
  connectedVia: "Підключено · ",
  noConnection: "Немає зв'язку з інвертором",
  modePowerOn: "Увімкнено", modeStandby: "Очікування", modeLine: "Від мережі",
  modeBattery: "Від батареї", modeFault: "Аварія", modePowerSaving: "Економія",
  modeShutdown: "Вимкнено", modeUnknown: "—",
  cardBattery: "Батарея", cardSolar: "Сонце (PV)", cardLoad: "Навантаження", cardGrid: "Мережа",
  ringAria: "Рівень заряду батареї",
  capV: "В", capChargeA: "заряд, А", capDischargeA: "розряд, А",
  capW: "Вт", capVout: "В вих.", capHz: "Гц", capVA: "ВА", capTemp: "°C радіатор",
  charging: "заряджається ↑", discharging: "розряджається ↓", idle: "спокій",
  panelSettings: "📋 Поточні налаштування та еталон",
  panelControls: "⚙️ Керування налаштуваннями",
  panelAdvanced: "🔧 Розширене (довільна команда)",
  advNote: "Надсилання будь-якої query-команди PI30 (наприклад <code>QPIGS</code>, <code>QPIRI</code>, <code>QID</code>). Команди запису (що не починаються з <code>Q</code>) потребують розблокування керування.",
  ctlOsp: "Пріоритет джерела виходу", ctlCsp: "Пріоритет джерела заряду",
  ctlMcc: "Макс. струм заряду (А)", ctlMacc: "Макс. струм заряду від мережі (А)",
  apply: "Застосувати", send: "Надіслати",
  controlNote: "Типово запис заблоковано. Розблокуй, зміни один параметр — після запису блокування повернеться автоматично.",
  lockDisabledServer: "🔒 Запис вимкнено на сервері (лише читання)",
  lockLocked: "🔒 Заблоковано — запис в інвертор заборонено",
  lockUnlocked: "🔓 Розблоковано — зміни буде записано в інвертор",
  btnUnlock: "Розблокувати", btnLock: "Заблокувати",
  toastLockFirst: "Спочатку розблокуй керування",
  toastLocked: "🔒 Заблоковано", toastUnlocked: "🔓 Розблоковано — будь обережний",
  blTakenAt: "Еталон знято ", blDevice: " (пристрій ",
  blHint: "). Значення, що відрізняються від еталона, підсвічені.",
  blNone: "Еталон ще не знято — він захопиться автоматично при першому підключенні інвертора.",
  blNotRead: "Налаштування ще не прочитані…",
  thParam: "Параметр", thCurrent: "Зараз", thBaseline: "Еталон",
  recaptureBtn: "Перечитати еталон з інвертора",
  toastBaselineOk: "Еталон перечитано з інвертора",
  flagsTitle: "Функції (прапорці)",
  flagFallback: "Прапорець ",
  sOsp: "Пріоритет джерела виходу", sCsp: "Пріоритет джерела заряду",
  sMcc: "Макс. струм заряду", sMacc: "Макс. струм заряду від мережі",
  sRecharge: "Повернення до мережі (recharge)", sRedischarge: "Повернення до батареї (redischarge)",
  sBulk: "Напруга bulk (C.V.)", sFloat: "Напруга float",
  sCutoff: "Відсічка за низькою напругою", sBatType: "Тип батареї",
  unit_A: "А", unit_V: "В",
  osp: { 0: "Спочатку мережа", 1: "Спочатку сонце", 2: "Сонце → Батарея → Мережа (SBU)" } as Record<number, string>,
  csp: { 0: "Спочатку мережа", 1: "Спочатку сонце", 2: "Сонце і мережа", 3: "Лише сонце" } as Record<number, string>,
  toastDone: "Готово: ", toastRejected: "Відхилено: ", toastNetErr: "Помилка мережі: ", toastError: "Помилка",
  modalConfirm: "Записати в інвертор: «{label}»?", modalCancel: "Скасувати", modalOk: "Підтвердити",
  portLabel: "Порт: ", ratedLabel: " · Номінал: ", ratedUnit: " Вт",
  logout: "вийти",
  loginNote: "SK-5500P-48L · локальний моніторинг. Введи пароль доступу.",
  loginPassword: "Пароль", loginSubmit: "Увійти",
  badPassword: "Невірний пароль",
  tooMany: "Забагато спроб — зачекай {m} хв",
  // Новые ключи навигации (нет в старом i18n.js)
  navDashboard: "Огляд", navSettings: "Налаштування", navDiagnostics: "Діагностика",
  flags: {
    a: "Звуковий сигнал (buzzer)",
    b: "Обхід при перевантаженні (bypass)",
    j: "Енергозбереження",
    k: "Повернення LCD на головний екран через 1 хв",
    u: "Перезапуск після перевантаження",
    v: "Перезапуск після перегріву",
    x: "Підсвічування LCD",
    y: "Сигнал при зникненні основного джерела",
    z: "Запис кодів помилок",
  } as Record<string, string>,
  warnings: {
    // дословно из public/i18n.js, строки 75–103 (27 записей)
  } as Record<string, string>,
};

export type Dict = typeof uk;

const ru: Dict = {
  // дословно из public/i18n.js, строки 106–203, та же структура, плюс:
  // navDashboard: "Обзор", navSettings: "Настройки", navDiagnostics: "Диагностика",
} as Dict;

const en: Dict = {
  // дословно из public/i18n.js, строки 205–274 (warnings: {} — серверные имена уже английские), плюс:
  // navDashboard: "Overview", navSettings: "Settings", navDiagnostics: "Diagnostics",
} as Dict;

export const DICTS: Record<Lang, Dict> = { uk, ru, en };
```

ВАЖНО: комментарии-заглушки выше — указание на перенос; в итоговом файле `warnings` uk, а также объекты `ru`/`en` должны быть заполнены полностью, а `as Dict` у ru/en заменить на явную типизацию `const ru: Dict = { ... }` без каста (чтобы tsc проверил каждый ключ). После заполнения в файле не должно остаться комментариев «дословно из…».

- [ ] **Step 2: Проверка полноты переноса**

Run: `npx tsc --noEmit -p web` (из корня: `npm run typecheck -w web`)
Expected: 0 ошибок. Пропущенный/лишний ключ в ru/en — ошибка типов.

Run: `for k in badPassword tooMany navDashboard warnings flags osp; do grep -c "$k" web/lib/i18n/dict.ts; done`
Expected: каждый ключ встречается 3 раза (по разу на язык).

- [ ] **Step 3: `web/lib/i18n/index.tsx`**

```tsx
"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { DICTS, Dict, Lang, LANGS } from "./dict";

interface I18nCtx {
  lang: Lang;
  dict: Dict;
  setLang: (l: Lang) => void;
}

const Ctx = createContext<I18nCtx>({ lang: "uk", dict: DICTS.uk, setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  // Стартуем всегда с uk (совпадает с SSG-пререндером), реальный выбор
  // подхватываем из localStorage после маунта — иначе hydration mismatch.
  const [lang, setLangState] = useState<Lang>("uk");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("lang");
      if (saved && (LANGS as readonly string[]).includes(saved)) setLangState(saved as Lang);
    } catch {}
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = (l: Lang) => {
    try {
      localStorage.setItem("lang", l);
    } catch {}
    setLangState(l); // ре-рендер вместо перезагрузки страницы
  };

  return <Ctx.Provider value={{ lang, dict: DICTS[lang], setLang }}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  return useContext(Ctx);
}

export function useT(): Dict {
  return useContext(Ctx).dict;
}

/** Заголовок вкладки, следит за сменой языка. */
export function useDocTitle(key: "title" | "loginTitle") {
  const dict = useT();
  useEffect(() => {
    document.title = dict[key];
  }, [dict, key]);
}

export function modeLabel(dict: Dict, mode: string): string {
  const v = dict[("mode" + mode) as keyof Dict];
  return typeof v === "string" ? v : mode;
}

export function warnLabel(dict: Dict, name: string): string {
  return dict.warnings[name] || name;
}

export function flagLabel(dict: Dict, key: string, fallback?: string): string {
  return dict.flags[key] || fallback || dict.flagFallback + key;
}
```

- [ ] **Step 4: Обернуть layout**

В `web/app/layout.tsx` добавить импорт `import { LangProvider } from "@/lib/i18n";` и заменить `<body>{children}</body>` на `<body><LangProvider>{children}</LangProvider></body>`.

- [ ] **Step 5: Проверить сборку**

Run: `npm run check && npm run build -w web`
Expected: зелено.

- [ ] **Step 6: Commit**

```bash
git add web
git commit -m "web: типизированный i18n (UA/RU/EN) с контекстом и сменой языка без перезагрузки"
```

---

### Task 6: API-клиент, SnapshotProvider (WS), MetaProvider, ToastProvider

**Files:**
- Create: `web/lib/api.ts`, `web/lib/format.ts`, `web/lib/snapshot.tsx`, `web/lib/meta.tsx`, `web/lib/toast.tsx`

**Interfaces:**
- Consumes: `Snapshot`, `ApiMeta` из `@inverter/shared`; `wsUrl` логика: dev → `ws://localhost:3000/ws`, prod → same-origin `/ws`
- Produces:
  - `api.ts`: `postJson(path: string, body: unknown): Promise<Response>` (fetch с JSON-заголовком; 401 → редирект `/login` и throw), `wsUrl(): string`. Страница логина использует ГОЛЫЙ fetch (её 401 — это «неверный пароль», не «нет сессии»).
  - `format.ts`: `fmt(v: number | null | undefined, digits = 0): string` («—» для NaN/null).
  - `snapshot.tsx`: `SnapshotProvider`, `useSnapshot(): { snapshot: Snapshot | null; stale: boolean }`; ghosting — через `document.body.classList.toggle("stale", …)` (CSS `body.stale` не трогаем).
  - `meta.tsx`: `MetaProvider`, `useMeta(): ApiMeta | null` (ретрай каждые 5 с до успеха).
  - `toast.tsx`: `ToastProvider`, `useToast(): { toast(msg: string, kind?: "ok" | "bad" | ""): void }` (автоскрытие 3200 мс).

- [ ] **Step 1: `web/lib/api.ts`**

```ts
export function redirectToLogin(): void {
  window.location.href = "/login";
}

/** POST JSON. При 401 уводит на /login и бросает. Ответ разбирает вызывающий. */
export async function postJson(path: string, body: unknown): Promise<Response> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("Unauthorized");
  }
  return res;
}

export function wsUrl(): string {
  if (process.env.NODE_ENV === "development") return "ws://localhost:3000/ws";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}
```

- [ ] **Step 2: `web/lib/format.ts`**

```ts
export function fmt(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}
```

- [ ] **Step 3: `web/lib/snapshot.tsx`**

```tsx
"use client";

import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import type { Snapshot } from "@inverter/shared";
import { wsUrl, redirectToLogin } from "./api";

interface SnapshotState {
  snapshot: Snapshot | null;
  stale: boolean;
}

const Ctx = createContext<SnapshotState>({ snapshot: null, stale: false });

export function SnapshotProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [stale, setStale] = useState(false);
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 1000;

    const gotSnapshot = (snap: Snapshot) => {
      setSnapshot(snap);
      setStale(false);
      if (staleTimer.current) clearTimeout(staleTimer.current);
      staleTimer.current = setTimeout(() => setStale(true), 15000);
    };

    // Первый снапшот — по HTTP, чтобы не ждать первого пуша.
    fetch("/api/snapshot")
      .then(async (r) => {
        if (r.status === 401) return redirectToLogin();
        if (r.ok) gotSnapshot(await r.json());
      })
      .catch(() => {});

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        reconnectDelay = 1000;
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "snapshot") gotSnapshot(msg.data);
        } catch {}
      };
      ws.onclose = (ev) => {
        if (closed) return;
        if (ev.code === 4401) return redirectToLogin(); // сессия истекла/отозвана
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (staleTimer.current) clearTimeout(staleTimer.current);
      ws?.close();
    };
  }, []);

  // Ghosting при потере связи: CSS завязан на body.stale — оставляем как есть.
  useEffect(() => {
    document.body.classList.toggle("stale", stale);
    return () => document.body.classList.remove("stale");
  }, [stale]);

  return <Ctx.Provider value={{ snapshot, stale }}>{children}</Ctx.Provider>;
}

export function useSnapshot(): SnapshotState {
  return useContext(Ctx);
}
```

- [ ] **Step 4: `web/lib/meta.tsx`**

```tsx
"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import type { ApiMeta } from "@inverter/shared";
import { redirectToLogin } from "./api";

const Ctx = createContext<ApiMeta | null>(null);

export function MetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<ApiMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Если демон временно недоступен — страница живёт, meta ретраится фоном
    // (перенос поведения trySetupControls из старого app.js).
    const load = async () => {
      try {
        const res = await fetch("/api/meta");
        if (res.status === 401) return redirectToLogin();
        if (!res.ok) throw new Error(String(res.status));
        const m = (await res.json()) as ApiMeta;
        if (!cancelled) setMeta(m);
      } catch {
        if (!cancelled) timer = setTimeout(load, 5000);
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return <Ctx.Provider value={meta}>{children}</Ctx.Provider>;
}

export function useMeta(): ApiMeta | null {
  return useContext(Ctx);
}
```

- [ ] **Step 5: `web/lib/toast.tsx`**

```tsx
"use client";

import { createContext, useCallback, useContext, useRef, useState, ReactNode } from "react";

type ToastKind = "ok" | "bad" | "";

interface ToastCtx {
  toast: (msg: string, kind?: ToastKind) => void;
}

const Ctx = createContext<ToastCtx>({ toast: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ msg: string; kind: ToastKind } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((msg: string, kind: ToastKind = "") => {
    setState({ msg, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 3200);
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      {state && <div className={"toast " + state.kind}>{state.msg}</div>}
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  return useContext(Ctx);
}
```

- [ ] **Step 6: Проверка типов и сборки**

Run: `npm run check && npm run build -w web`
Expected: зелено.

- [ ] **Step 7: Commit**

```bash
git add web/lib
git commit -m "web: API-клиент, снапшот по WS с реконнектом и stale, meta с ретраем, тосты"
```

---

### Task 7: Базовые компоненты — Panel, ConfirmDialog, LangSwitch, BatteryRing

**Files:**
- Create: `web/components/Panel.tsx`, `web/components/ConfirmDialog.tsx`, `web/components/LangSwitch.tsx`, `web/components/BatteryRing.tsx`

**Interfaces:**
- Produces:
  - `Panel({ title, children })` — сворачиваемая секция (классы `.panel/.panel-toggle/.panel-body/.chev` из CSS).
  - `ConfirmDialog({ text, okLabel, cancelLabel, onOk, onCancel })` — модалка; рендерится родителем условно.
  - `LangSwitch()` — кнопки UA/RU/EN.
  - `BatteryRing({ soc, label, ariaLabel })` — SVG-кольцо 20 секторов с дизеринг-паттернами `#dith-p1..p5` (id обязаны совпадать с CSS).

- [ ] **Step 1: `web/components/Panel.tsx`**

```tsx
"use client";

import { ReactNode, useState } from "react";

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel">
      <button className={"panel-toggle" + (open ? " open" : "")} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span className="chev">▾</span>
      </button>
      <div className={"panel-body" + (open ? "" : " hidden")}>{children}</div>
    </section>
  );
}
```

- [ ] **Step 2: `web/components/ConfirmDialog.tsx`**

```tsx
"use client";

export function ConfirmDialog({
  text,
  okLabel,
  cancelLabel,
  onOk,
  onCancel,
}: {
  text: string;
  okLabel: string;
  cancelLabel: string;
  onOk: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal">
      <div className="modal-box">
        <p>{text}</p>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="btn-danger" onClick={onOk}>
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `web/components/LangSwitch.tsx`**

```tsx
"use client";

import { useI18n } from "@/lib/i18n";
import { LANGS, Lang } from "@/lib/i18n/dict";

const LABELS: Record<Lang, string> = { uk: "UA", ru: "RU", en: "EN" };

export function LangSwitch() {
  const { lang, setLang } = useI18n();
  return (
    <nav className="lang-switch" aria-label="Language">
      {LANGS.map((l) => (
        <button key={l} className={l === lang ? "active" : ""} onClick={() => setLang(l)}>
          {LABELS[l]}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: `web/components/BatteryRing.tsx`** (геометрия — прямой порт из app.js; паттерны — из index.html)

```tsx
"use client";

const RING_SEGS = 20; // по 5% на сектор
const RING_GAP_DEG = 4.5;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function segPath(cx: number, cy: number, r1: number, r2: number, a1: number, a2: number): string {
  const [x1, y1] = polar(cx, cy, r2, a1);
  const [x2, y2] = polar(cx, cy, r2, a2);
  const [x3, y3] = polar(cx, cy, r1, a2);
  const [x4, y4] = polar(cx, cy, r1, a1);
  const f = (n: number) => n.toFixed(2);
  return `M${f(x1)} ${f(y1)} A${r2} ${r2} 0 0 1 ${f(x2)} ${f(y2)} L${f(x3)} ${f(y3)} A${r1} ${r1} 0 0 0 ${f(x4)} ${f(y4)} Z`;
}

const STEP = 360 / RING_SEGS;
const SEG_PATHS = Array.from({ length: RING_SEGS }, (_, i) =>
  segPath(60, 60, 39, 55, i * STEP + RING_GAP_DEG / 2, (i + 1) * STEP - RING_GAP_DEG / 2)
);

/** Ячейки дизеринга Байера для паттернов p1..p5 (координаты 2×2-точек). */
const DITHER_CELLS: Array<Array<[number, number]>> = [
  [[0, 0], [4, 4]],
  [[0, 0], [4, 4], [4, 0], [0, 4], [2, 2]],
  [[0, 0], [4, 4], [4, 0], [0, 4], [2, 2], [6, 6], [6, 2], [2, 6]],
  [[0, 0], [4, 4], [4, 0], [0, 4], [2, 2], [6, 6], [6, 2], [2, 6], [2, 0], [6, 4], [6, 0]],
  [[0, 0], [4, 4], [4, 0], [0, 4], [2, 2], [6, 6], [6, 2], [2, 6], [2, 0], [6, 4], [6, 0], [2, 4], [0, 2], [4, 6]],
];

export function BatteryRing({ soc, label, ariaLabel }: { soc: number; label: string; ariaLabel: string }) {
  const clamped = Number.isNaN(soc) ? 0 : Math.max(0, Math.min(100, soc));
  const filled = Math.round((clamped / 100) * RING_SEGS);
  return (
    <div className={"ring-wrap" + (clamped <= 20 ? " low" : "")} role="img" aria-label={ariaLabel}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <defs>
          {DITHER_CELLS.map((cells, p) => (
            <pattern key={p} id={`dith-p${p + 1}`} patternUnits="userSpaceOnUse" width="8" height="8">
              <g fill="var(--ring-c, #55795d)">
                {cells.map(([x, y], i) => (
                  <rect key={i} width="2" height="2" x={x} y={y} />
                ))}
              </g>
            </pattern>
          ))}
        </defs>
        <g>
          {SEG_PATHS.map((d, i) => (
            <path key={i} d={d} className={`seg d${Math.floor(i / 4) + 1}${i < filled ? " on" : ""}`} />
          ))}
        </g>
      </svg>
      <div className="ring-label">
        <span className="ring-value">{label}</span>
        <span className="ring-unit">%</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Проверка**

Run: `npm run check && npm run build -w web`
Expected: зелено.

- [ ] **Step 6: Commit**

```bash
git add web/components
git commit -m "web: базовые компоненты — Panel, ConfirmDialog, LangSwitch, BatteryRing"
```

---

### Task 8: Layout группы (app) — шапка, баннер, навигация, футер — и дашборд

**Files:**
- Create: `web/app/(app)/layout.tsx`, `web/app/(app)/page.tsx`
- Delete: `web/app/page.tsx` (заглушка из Task 4)
- Modify: `web/app/globals.css` (в конец — стили навигации)

**Interfaces:**
- Consumes: `useSnapshot`, `useMeta`, `useT`, `modeLabel`, `warnLabel`, `fmt`, `LangSwitch`, `BatteryRing`, провайдеры из Task 6
- Produces: маршрут `/` — дашборд; каркас с `<TopBar/> <WarningsBanner/> <NavTabs/> {children} <Footer/>` для всех страниц группы `(app)`. CSS-классы `.nav-tabs`, `.nav-tabs a`, `.nav-tabs a.active`.

- [ ] **Step 1: `web/app/(app)/layout.tsx`**

```tsx
"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SnapshotProvider, useSnapshot } from "@/lib/snapshot";
import { MetaProvider, useMeta } from "@/lib/meta";
import { ToastProvider } from "@/lib/toast";
import { useT, useDocTitle, modeLabel, warnLabel } from "@/lib/i18n";
import { LangSwitch } from "@/components/LangSwitch";

function TopBar() {
  const t = useT();
  const { snapshot } = useSnapshot();
  const c = snapshot?.connection;

  let pillClass = "pill pill-muted";
  let pillText: string = t.connecting;
  if (c) {
    if (c.mock) {
      pillClass = "pill pill-mock";
      pillText = t.demoData;
    } else if (c.connected) {
      pillClass = "pill pill-ok";
      pillText = t.connectedVia + c.transport + (c.device ? " " + c.device : "");
    } else {
      pillClass = "pill pill-bad";
      pillText = t.noConnection;
    }
  }
  const mode = snapshot?.mode ?? "Unknown";

  return (
    <header className="topbar">
      <div className="topbar-row">
        <h1>{t.h1}</h1>
        <span className={"mode-badge mode-" + mode}>{modeLabel(t, mode)}</span>
      </div>
      <div className="topbar-row">
        <span className={pillClass}>{pillText}</span>
        {snapshot?.timestamp ? (
          // key = timestamp: ремоунт перезапускает CSS-анимацию «e-ink вспышки»
          <span key={snapshot.timestamp} className="updated flash">
            {t.updated + new Date(snapshot.timestamp).toLocaleTimeString(t.langLocale)}
          </span>
        ) : (
          <span className="updated">—</span>
        )}
      </div>
    </header>
  );
}

function WarningsBanner() {
  const t = useT();
  const { snapshot } = useSnapshot();
  const warns = snapshot?.warnings?.active ?? [];
  if (!warns.length) return null;
  return <div className="banner">{"⚠ " + warns.map((w) => warnLabel(t, w)).join(" · ")}</div>;
}

function NavTabs() {
  const t = useT();
  const pathname = usePathname();
  const tabs = [
    { href: "/", label: t.navDashboard },
    { href: "/settings", label: t.navSettings },
    { href: "/diagnostics", label: t.navDiagnostics },
  ];
  return (
    <nav className="nav-tabs">
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={pathname === tab.href ? "active" : ""}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

function Footer() {
  const t = useT();
  const { snapshot } = useSnapshot();
  const meta = useMeta();
  const c = snapshot?.connection;
  const info = snapshot?.info;

  let deviceInfo = t.portLabel + (c?.device ?? "—");
  if (info && Number.isFinite(info.acOutputRatingActivePower)) {
    deviceInfo += t.ratedLabel + info.acOutputRatingActivePower + t.ratedUnit;
  }

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
        <span>{deviceInfo}</span>
        {meta?.authEnabled && (
          <a href="#" className="logout" onClick={logout}>
            {t.logout}
          </a>
        )}
      </div>
      <LangSwitch />
    </footer>
  );
}

function Chrome({ children }: { children: ReactNode }) {
  useDocTitle("title");
  return (
    <>
      <TopBar />
      <WarningsBanner />
      <NavTabs />
      {children}
      <Footer />
    </>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SnapshotProvider>
      <MetaProvider>
        <ToastProvider>
          <Chrome>{children}</Chrome>
        </ToastProvider>
      </MetaProvider>
    </SnapshotProvider>
  );
}
```

- [ ] **Step 2: Дашборд `web/app/(app)/page.tsx`** (порт карточек из index.html 26–91 + app.js render())

```tsx
"use client";

import { useT } from "@/lib/i18n";
import { useSnapshot } from "@/lib/snapshot";
import { fmt } from "@/lib/format";
import { BatteryRing } from "@/components/BatteryRing";

export default function DashboardPage() {
  const t = useT();
  const { snapshot } = useSnapshot();
  const s = snapshot?.status ?? null;

  const charging = !!s && s.batteryChargingCurrent > 0;
  const discharging = !!s && s.batteryDischargeCurrent > 0;
  const batStateClass = charging ? "state-charge" : discharging ? "state-discharge" : "state-idle";
  const batStateText = !s ? "—" : charging ? t.charging : discharging ? t.discharging : t.idle;

  return (
    <main className="grid">
      <section className="card card-battery">
        <div className="card-head">
          <span className="card-title">{t.cardBattery}</span>
          <span className={"tag " + batStateClass}>{batStateText}</span>
        </div>
        <BatteryRing soc={s ? s.batteryCapacity : NaN} label={fmt(s?.batteryCapacity, 0)} ariaLabel={t.ringAria} />
        <div className="sub-metrics center">
          <div>
            <span>{fmt(s?.batteryVoltage, 2)}</span>
            <span className="cap">{t.capV}</span>
          </div>
          <div>
            <span>{fmt(s?.batteryChargingCurrent, 0)}</span>
            <span className="cap">{t.capChargeA}</span>
          </div>
          <div>
            <span>{fmt(s?.batteryDischargeCurrent, 0)}</span>
            <span className="cap">{t.capDischargeA}</span>
          </div>
        </div>
      </section>

      <section className="card card-solar">
        <div className="card-head">
          <span className="card-title">{t.cardSolar}</span>
        </div>
        <div className="big-metric">
          <span className="big-val">{fmt(s?.pvChargingPower, 0)}</span>
          <span className="big-unit">{t.capW}</span>
        </div>
        <div className="sub-metrics">
          <div>
            <span>{fmt(s?.pvInputVoltage, 1)}</span>
            <span className="cap">{t.capV}</span>
          </div>
          <div>
            <span>{fmt(s?.pvInputCurrent, 1)}</span>
            <span className="cap">{t.unit_A}</span>
          </div>
        </div>
      </section>

      <section className="card card-load">
        <div className="card-head">
          <span className="card-title">{t.cardLoad}</span>
          <span className="tag">{s ? fmt(s.outputLoadPercent, 0) + "%" : "—"}</span>
        </div>
        <div className="big-metric">
          <span className="big-val">{fmt(s?.acOutputActivePower, 0)}</span>
          <span className="big-unit">{t.capW}</span>
        </div>
        <div className="sub-metrics">
          <div>
            <span>{fmt(s?.acOutputVoltage, 1)}</span>
            <span className="cap">{t.capVout}</span>
          </div>
          <div>
            <span>{fmt(s?.acOutputFrequency, 1)}</span>
            <span className="cap">{t.capHz}</span>
          </div>
          <div>
            <span>{fmt(s?.acOutputApparentPower, 0)}</span>
            <span className="cap">{t.capVA}</span>
          </div>
        </div>
      </section>

      <section className="card card-grid">
        <div className="card-head">
          <span className="card-title">{t.cardGrid}</span>
        </div>
        <div className="sub-metrics wide">
          <div>
            <span>{fmt(s?.gridVoltage, 1)}</span>
            <span className="cap">{t.capV}</span>
          </div>
          <div>
            <span>{fmt(s?.gridFrequency, 1)}</span>
            <span className="cap">{t.capHz}</span>
          </div>
          <div>
            <span>{fmt(s?.heatSinkTemperature, 0)}</span>
            <span className="cap">{t.capTemp}</span>
          </div>
        </div>
      </section>
    </main>
  );
}
```

```bash
rm web/app/page.tsx
```

- [ ] **Step 3: Стили навигации — добавить В КОНЕЦ `web/app/globals.css`**

```css
/* ---------- навигация по экранам (новое в Next-версии) ---------- */
.nav-tabs {
  display: flex;
  gap: 6px;
  margin: 10px 14px 0;
}
.nav-tabs a {
  padding: 6px 14px;
  border: 1px solid var(--hairline);
  background: var(--paper-0);
  color: var(--ink-soft);
  text-decoration: none;
  font-variant: small-caps;
  letter-spacing: 0.1em;
  font-size: 14px;
}
.nav-tabs a.active {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--paper-0);
}
```

(Если переменные `--hairline`/`--ink`/`--paper-0`/`--ink-soft` в globals.css называются иначе — использовать фактические имена из файла; проверить `grep -m5 '^:root' -A20 web/app/globals.css`.)

- [ ] **Step 4: Проверить против mock-демона**

Run: `npm run check && npm run dev & sleep 15 && curl -s localhost:3001/ | grep -o 'card-battery' | head -1 && curl -s localhost:3001/api/snapshot | grep -o '"mock":true'; kill %1`
Expected: `card-battery` и `"mock":true`. (Живые данные в браузере пользователь посмотрит на финальной приёмке.)

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "web: каркас (app) — шапка, баннер, навигация, футер — и дашборд с кольцом заряда"
```

---

### Task 9: Страница /settings — таблица, флаги, эталон, панель управления

**Files:**
- Create: `web/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `useSnapshot`, `useMeta`, `useToast`, `useT`, `flagLabel`, `Panel`, `ConfirmDialog`, `postJson`, типы/константы из `@inverter/shared`
- Produces: маршрут `/settings`. Поведение 1:1 со старым `app.js`: drift-подсветка, отражение текущих значений в контролах только при `locked`, confirm-модалка перед записью, авто-relock приходит снапшотом с сервера.

- [ ] **Step 1: Написать страницу**

```tsx
"use client";

import { useEffect, useState } from "react";
import type { ControlType, InverterRatedInfo, Snapshot } from "@inverter/shared";
import { useT } from "@/lib/i18n";
import { flagLabel } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n/dict";
import { useSnapshot } from "@/lib/snapshot";
import { useMeta } from "@/lib/meta";
import { useToast } from "@/lib/toast";
import { postJson } from "@/lib/api";
import { Panel } from "@/components/Panel";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface SettingRow {
  key: keyof InverterRatedInfo;
  labelKey: keyof Dict;
  coded?: "osp" | "csp";
  unit?: "A" | "V";
  map?: Record<number, string>;
}

const SETTINGS_ROWS: SettingRow[] = [
  { key: "outputSourcePriority", labelKey: "sOsp", coded: "osp" },
  { key: "chargerSourcePriority", labelKey: "sCsp", coded: "csp" },
  { key: "maxChargingCurrent", labelKey: "sMcc", unit: "A" },
  { key: "maxAcChargingCurrent", labelKey: "sMacc", unit: "A" },
  { key: "batteryRechargeVoltage", labelKey: "sRecharge", unit: "V" },
  { key: "batteryRedischargeVoltage", labelKey: "sRedischarge", unit: "V" },
  { key: "batteryBulkVoltage", labelKey: "sBulk", unit: "V" },
  { key: "batteryFloatVoltage", labelKey: "sFloat", unit: "V" },
  { key: "batteryUnderVoltage", labelKey: "sCutoff", unit: "V" },
  { key: "batteryType", labelKey: "sBatType", map: { 0: "AGM", 1: "Flooded", 2: "User" } },
];

type Meta = NonNullable<ReturnType<typeof useMeta>>;

/** Локализованная метка кодового значения; фолбэк — серверная метка из meta, затем число. */
function codedValue(t: Dict, meta: Meta | null, coded: "osp" | "csp", value: number): string {
  if (t[coded][value] !== undefined) return t[coded][value];
  const metaMap = coded === "osp" ? meta?.outputSourcePriority : meta?.chargerSourcePriority;
  if (metaMap && metaMap[value] !== undefined) return metaMap[value];
  return String(value);
}

function settingDisplay(t: Dict, meta: Meta | null, row: SettingRow, value: number | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  if (row.coded) return codedValue(t, meta, row.coded, value);
  if (row.map && row.map[value] !== undefined) return row.map[value];
  const unit = row.unit ? " " + (t[("unit_" + row.unit) as keyof Dict] as string) : "";
  return value + unit;
}

function BaselineNote({ snapshot, t }: { snapshot: Snapshot | null; t: Dict }) {
  const b = snapshot?.baseline;
  if (!b) return <p className="note">{t.blNone}</p>;
  return (
    <p className="note">
      {t.blTakenAt}
      <b>{new Date(b.capturedAt).toLocaleString(t.langLocale)}</b>
      {t.blDevice}
      <code>{b.deviceId}</code>
      {t.blHint}
    </p>
  );
}

function SettingsTable() {
  const t = useT();
  const meta = useMeta();
  const { snapshot } = useSnapshot();
  const { toast } = useToast();
  const info = snapshot?.info ?? null;
  const base = snapshot?.baseline?.info ?? null;
  const flags = snapshot?.flags?.flags ?? [];

  const recapture = async () => {
    try {
      const data = await (await postJson("/api/baseline/recapture", {})).json();
      if (data.ok) toast(t.toastBaselineOk, "ok");
      else toast(data.error || t.toastError, "bad");
    } catch (e) {
      toast(t.toastNetErr + (e as Error).message, "bad");
    }
  };

  return (
    <>
      <BaselineNote snapshot={snapshot} t={t} />
      <div className="settings-table">
        {!info ? (
          <div className="srow">
            <span className="muted">{t.blNotRead}</span>
          </div>
        ) : (
          <>
            <div className="srow shead">
              <span>{t.thParam}</span>
              <span>{t.thCurrent}</span>
              <span>{t.thBaseline}</span>
            </div>
            {SETTINGS_ROWS.map((row) => {
              const cur = info[row.key] as number;
              const bas = base ? (base[row.key] as number) : undefined;
              const bothNaN = Number.isNaN(Number(cur)) && Number.isNaN(Number(bas));
              const drift = base !== null && !bothNaN && Number(cur) !== Number(bas);
              return (
                <div key={row.key} className={"srow" + (drift ? " drift" : "")}>
                  <span className="slabel">{t[row.labelKey] as string}</span>
                  <span className="scur">{settingDisplay(t, meta, row, cur)}</span>
                  <span className="sbase">{base ? settingDisplay(t, meta, row, bas) : "—"}</span>
                </div>
              );
            })}
          </>
        )}
      </div>
      <div className="flags-block">
        <div className="flags-title">{t.flagsTitle}</div>
        <div className="flags-list">
          {!flags.length ? (
            <span className="muted">—</span>
          ) : (
            flags.map((f) => (
              <span key={f.key} className={"flag-chip " + (f.enabled ? "on" : "off")}>
                {(f.enabled ? "✓ " : "✕ ") + flagLabel(t, f.key, f.name)}
              </span>
            ))
          )}
        </div>
      </div>
      <button className="apply ghost-btn" onClick={recapture}>
        {t.recaptureBtn}
      </button>
    </>
  );
}

function ControlPanel() {
  const t = useT();
  const meta = useMeta();
  const { snapshot } = useSnapshot();
  const { toast } = useToast();

  const control = snapshot?.control ?? null;
  const allowControl = !!control?.allowControl;
  const locked = !control || control.locked || !allowControl;
  const info = snapshot?.info ?? null;

  const [pending, setPending] = useState<{ type: ControlType; value: number; label: string } | null>(null);
  const [mcc, setMcc] = useState("");
  const [macc, setMacc] = useState("");

  // Отражать текущие значения в селектах только пока заблокировано:
  // при разблокировке пользователь выбирает значение, и его нельзя перетирать снапшотами.
  useEffect(() => {
    if (!info || !locked) return;
    if (Number.isFinite(info.maxChargingCurrent)) setMcc(String(info.maxChargingCurrent));
    if (Number.isFinite(info.maxAcChargingCurrent)) setMacc(String(info.maxAcChargingCurrent));
  }, [info, locked]);

  const request = (type: ControlType, value: number, label: string) => {
    if (!allowControl) return;
    if (control?.locked) {
      toast(t.toastLockFirst, "bad");
      return;
    }
    setPending({ type, value, label });
  };

  const send = async () => {
    const a = pending;
    setPending(null);
    if (!a) return;
    try {
      const data = await (await postJson("/api/control", { type: a.type, value: a.value })).json();
      if (data.ok) toast(t.toastDone + data.command + " → ACK", "ok");
      else toast(t.toastRejected + (data.error || data.reply || "NAK"), "bad");
    } catch (e) {
      toast(t.toastNetErr + (e as Error).message, "bad");
    }
  };

  const toggleLock = async () => {
    const currentlyLocked = control?.locked !== false;
    try {
      const data = await (await postJson("/api/lock", { locked: !currentlyLocked })).json();
      if (data.ok) toast(data.locked ? t.toastLocked : t.toastUnlocked, data.locked ? "ok" : "");
      else toast(data.error || t.toastError, "bad");
    } catch (e) {
      toast(t.toastNetErr + (e as Error).message, "bad");
    }
  };

  const segment = (coded: "osp" | "csp", type: ControlType, current: number | undefined, values: Record<number, string>) => (
    <div className="segmented">
      {Object.keys(values).map((k) => {
        const v = Number(k);
        const label = codedValue(t, meta, coded, v);
        return (
          <button
            key={k}
            disabled={locked}
            className={current === v ? "active" : ""}
            onClick={() => request(type, v, label)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <div className="lock-bar">
        {!allowControl ? (
          <span className="lock-status locked">{t.lockDisabledServer}</span>
        ) : control?.locked ? (
          <>
            <span className="lock-status locked">{t.lockLocked}</span>
            <button className="lock-toggle unlock" onClick={toggleLock}>
              {t.btnUnlock}
            </button>
          </>
        ) : (
          <>
            <span className="lock-status unlocked">{t.lockUnlocked}</span>
            <button className="lock-toggle lock" onClick={toggleLock}>
              {t.btnLock}
            </button>
          </>
        )}
      </div>
      <p className="note">{t.controlNote}</p>

      <div className="control">
        <label>{t.ctlOsp}</label>
        {meta && segment("osp", "outputSourcePriority", info?.outputSourcePriority, meta.outputSourcePriority)}
      </div>
      <div className="control">
        <label>{t.ctlCsp}</label>
        {meta && segment("csp", "chargerSourcePriority", info?.chargerSourcePriority, meta.chargerSourcePriority)}
      </div>

      <div className="control">
        <label>{t.ctlMcc}</label>
        <div className="row">
          <select value={mcc} disabled={locked} onChange={(e) => setMcc(e.target.value)}>
            {(meta?.maxChargingCurrent ?? []).map((v) => (
              <option key={v} value={String(v)}>
                {v}
              </option>
            ))}
          </select>
          <button
            className="apply"
            disabled={locked}
            onClick={() => request("maxChargingCurrent", Number(mcc), `${t.ctlMcc}: ${mcc}`)}
          >
            {t.apply}
          </button>
        </div>
      </div>
      <div className="control">
        <label>{t.ctlMacc}</label>
        <div className="row">
          <select value={macc} disabled={locked} onChange={(e) => setMacc(e.target.value)}>
            {(meta?.maxAcChargingCurrent ?? []).map((v) => (
              <option key={v} value={String(v)}>
                {v}
              </option>
            ))}
          </select>
          <button
            className="apply"
            disabled={locked}
            onClick={() => request("maxAcChargingCurrent", Number(macc), `${t.ctlMacc}: ${macc}`)}
          >
            {t.apply}
          </button>
        </div>
      </div>

      {pending && (
        <ConfirmDialog
          text={t.modalConfirm.replace("{label}", pending.label)}
          okLabel={t.modalOk}
          cancelLabel={t.modalCancel}
          onOk={send}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}

export default function SettingsPage() {
  const t = useT();
  return (
    <div>
      <Panel title={t.panelSettings}>
        <SettingsTable />
      </Panel>
      <Panel title={t.panelControls}>
        <ControlPanel />
      </Panel>
    </div>
  );
}
```

- [ ] **Step 2: Проверка типов + функциональный смоук через API**

Run: `npm run check`
Expected: зелено.

Run (демон в mock, сценарий блокировки — как проверяли раньше):
`PORT=3999 node server/dist/index.js & sleep 2 && curl -s -X POST localhost:3999/api/control -H 'Content-Type: application/json' -d '{"type":"maxChargingCurrent","value":60}' && echo && curl -s -X POST localhost:3999/api/lock -H 'Content-Type: application/json' -d '{"locked":false}' && echo && curl -s -X POST localhost:3999/api/control -H 'Content-Type: application/json' -d '{"type":"maxChargingCurrent","value":60}'; kill %1`
Expected: первая запись отклонена (locked), после unlock — `"ok":true,"command":"MCHGC060"`. (Это проверка неизменности бэкенда; UI-часть — визуально на приёмке.)

- [ ] **Step 3: Commit**

```bash
git add web/app
git commit -m "web: страница настроек — таблица с эталоном и drift, флаги, управление с блокировкой"
```

---

### Task 10: Страницы /diagnostics и /login

**Files:**
- Create: `web/app/(app)/diagnostics/page.tsx`, `web/app/login/page.tsx`

**Interfaces:**
- Consumes: `useT`, `useDocTitle`, `Panel`, `postJson` (диагностика), ГОЛЫЙ fetch (логин), `LangSwitch`
- Produces: маршруты `/diagnostics` и `/login`. Логин переводит коды `bad_password` / `rate_limited` (+minutes) — контракт `LoginErrorCode` из shared.

- [ ] **Step 1: `web/app/(app)/diagnostics/page.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { postJson } from "@/lib/api";
import { Panel } from "@/components/Panel";

export default function DiagnosticsPage() {
  const t = useT();
  const [cmd, setCmd] = useState("");
  const [out, setOut] = useState<string | null>(null);

  const send = async () => {
    const command = cmd.trim().toUpperCase();
    if (!command) return;
    setOut("…");
    try {
      const data = await (await postJson("/api/raw", { command })).json();
      setOut(data.ok ? data.reply : t.toastError + ": " + data.error);
    } catch (e) {
      setOut(t.toastNetErr + (e as Error).message);
    }
  };

  return (
    <Panel title={t.panelAdvanced}>
      {/* advNote содержит <code> из собственного словаря — не пользовательский ввод */}
      <p className="note" dangerouslySetInnerHTML={{ __html: t.advNote }} />
      <div className="row">
        <input
          type="text"
          value={cmd}
          placeholder="QPIGS"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button className="apply" onClick={send}>
          {t.send}
        </button>
      </div>
      {out !== null && <pre className="raw-out">{out}</pre>}
    </Panel>
  );
}
```

- [ ] **Step 2: `web/app/login/page.tsx`**

```tsx
"use client";

import { FormEvent, useState } from "react";
import { useT, useDocTitle } from "@/lib/i18n";
import { LangSwitch } from "@/components/LangSwitch";

export default function LoginPage() {
  const t = useT();
  useDocTitle("loginTitle");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Голый fetch: 401 здесь означает «неверный пароль», а не «нет сессии».
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json();
      if (data.ok) {
        window.location.href = "/";
        return;
      }
      let msg: string = data.error || t.toastError;
      if (data.code === "bad_password") msg = t.badPassword;
      else if (data.code === "rate_limited") msg = t.tooMany.replace("{m}", String(data.minutes ?? "?"));
      setErr(msg);
    } catch (ex) {
      setErr(t.toastNetErr + (ex as Error).message);
    }
  };

  return (
    <div className="login-wrap">
      <div className="modal-box login-box">
        <h1 className="login-title">{t.h1}</h1>
        <p className="note">{t.loginNote}</p>
        <form className="row" onSubmit={submit}>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={t.loginPassword}
            autoComplete="current-password"
            autoFocus
          />
          <button className="apply" type="submit">
            {t.loginSubmit}
          </button>
        </form>
        {err && <p className="login-err">{err}</p>}
        <LangSwitch />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Проверка**

Run: `npm run check && npm run build -w web && ls web/out`
Expected: зелено; в `web/out` есть `index.html`, `settings.html`, `diagnostics.html`, `login.html`.

- [ ] **Step 4: Commit**

```bash
git add web/app
git commit -m "web: страницы диагностики и входа"
```

---

### Task 11: Переключить сервер на `web/out/`, удалить `public/`

**Files:**
- Modify: `server/src/server.ts` (строки 36–44 старой нумерации: редирект + статика)
- Delete: `public/` (git rm)

**Interfaces:**
- Consumes: `web/out/` из сборки web
- Produces: демон раздаёт новый UI; неавторизованные GET `/`, `/settings`, `/diagnostics` → 302 `/login`. Деплой-контракт для Task 12: статика лежит в `<repo>/web/out` относительно `server/dist/../..`.

- [ ] **Step 1: Правка `server/src/server.ts`**

Заменить блок:

```ts
  // The UI shell redirects to the login page when there is no session; static
  // assets themselves (css/js/login page) stay open — they contain no data.
  app.get(["/", "/index.html"], (req, res, next) => {
    if (auth.verifyToken(reqToken(req))) return next();
    res.redirect("/login.html");
  });

  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));
```

на:

```ts
  // The UI shell redirects to the login page when there is no session; static
  // assets themselves (css/js/login page) stay open — they contain no data.
  app.get(["/", "/index.html", "/settings", "/diagnostics"], (req, res, next) => {
    if (auth.verifyToken(reqToken(req))) return next();
    res.redirect("/login");
  });

  // Статика Next.js (web/out); extensions позволяет отдавать /settings как settings.html.
  const publicDir = path.join(__dirname, "..", "..", "web", "out");
  app.use(express.static(publicDir, { extensions: ["html"] }));
```

(`__dirname` в проде — `server/dist`, в dev через tsx — `server/src`; оба на два уровня ниже корня, путь совпадает.)

- [ ] **Step 2: Удалить старый UI**

```bash
git rm -r public
```

- [ ] **Step 3: Прод-смоук без авторизации**

Run: `npm run build && PORT=3999 node server/dist/index.js & sleep 2 && curl -s -o /dev/null -w '/: %{http_code}\n' localhost:3999/ && curl -s -o /dev/null -w '/settings: %{http_code}\n' localhost:3999/settings && curl -s -o /dev/null -w '/diagnostics: %{http_code}\n' localhost:3999/diagnostics; kill %1`
Expected: все три — `200`.

- [ ] **Step 4: Прод-смоук с авторизацией**

Run: `AUTH_PASSWORD=test PORT=3999 node server/dist/index.js & sleep 2 && curl -s -o /dev/null -w '/: %{http_code} -> %{redirect_url}\n' localhost:3999/ && curl -s -o /dev/null -w '/login: %{http_code}\n' localhost:3999/login && curl -s -o /dev/null -w '/api/snapshot: %{http_code}\n' localhost:3999/api/snapshot; kill %1`
Expected: `/: 302 -> http://localhost:3999/login`, `/login: 200`, `/api/snapshot: 401`.

- [ ] **Step 5: Selfcheck + commit**

Run: `npm run check`
Expected: зелено.

```bash
git add -A
git commit -m "Сервер раздаёт web/out вместо public; редирект на логин для всех страниц"
```

---

### Task 12: deploy.sh, systemd-юнит, README

**Files:**
- Create: `deploy.sh`
- Modify: `server/systemd/inverter-monitor.service`, `README.md` (раздел про структуру/деплой)

**Interfaces:**
- Consumes: контракт путей из Task 11; SSH-доступ задаётся env `PI_HOST` (default `pi@192.168.1.112`) и опц. `SSH_KEY`
- Produces: `./deploy.sh` — полный деплой одной командой. САМ ДЕПЛОЙ НЕ ЗАПУСКАТЬ (Global Constraints) — только `bash -n`.

- [ ] **Step 1: Обновить `server/systemd/inverter-monitor.service`**

Заменить секцию `[Service]` (три строки путей):

```ini
WorkingDirectory=/home/pi/inverter-monitor/server
EnvironmentFile=-/home/pi/inverter-monitor/server/.env
ExecStart=/usr/local/bin/node dist/index.js
```

Остальное — без изменений.

- [ ] **Step 2: `deploy.sh`**

```bash
#!/usr/bin/env bash
# Деплой inverter-monitor на Raspberry Pi.
# Использование: [PI_HOST=pi@192.168.1.112] [SSH_KEY=~/.ssh/pi_key] ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

PI_HOST="${PI_HOST:-pi@192.168.1.112}"
PI_DIR="/home/pi/inverter-monitor"

SSH=(ssh)
RSYNC_SSH="ssh"
if [ -n "${SSH_KEY:-}" ]; then
  SSH=(ssh -i "$SSH_KEY")
  RSYNC_SSH="ssh -i $SSH_KEY"
fi

echo "==> Сборка (shared + server + web)"
npm run build
npm run check

echo "==> rsync на $PI_HOST:$PI_DIR"
rsync -az --relative --delete -e "$RSYNC_SSH" \
  package.json package-lock.json \
  shared/package.json shared/dist \
  server/package.json server/dist server/systemd server/.env.example \
  web/package.json web/out \
  "$PI_HOST:$PI_DIR/"

echo "==> Установка и рестарт на Pi"
"${SSH[@]}" "$PI_HOST" bash -s <<EOF
set -euo pipefail
cd "$PI_DIR"
# Одноразовая миграция со старой раскладки (безопасна при повторных запусках)
[ -d data ] && [ ! -e server/data ] && mv data server/data || true
[ -f .env ] && [ ! -e server/.env ] && mv .env server/.env || true
rm -rf dist src public
npm ci -w server --omit=dev
sudo cp server/systemd/inverter-monitor.service /etc/systemd/system/inverter-monitor.service
sudo systemctl daemon-reload
sudo systemctl restart inverter-monitor
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
echo "FAIL: сервер не ответил за 60 с — смотри: ssh $PI_HOST journalctl -u inverter-monitor -n 50" >&2
exit 1
```

```bash
chmod +x deploy.sh
```

- [ ] **Step 3: Проверить синтаксис (НЕ запускать деплой)**

Run: `bash -n deploy.sh && echo syntax-ok`
Expected: `syntax-ok`.

- [ ] **Step 4: README**

В `README.md` заменить разделы про структуру проекта, разработку и деплой на актуальные:
- структура: дерево из «Карты файлов» этого плана (без docs/);
- разработка: `npm install`, `npm run dev` (демон :3000 mock + UI :3001 с HMR), `npm run check`;
- деплой: `./deploy.sh` (сборка локально, Pi ничего не компилирует; переменные `PI_HOST`/`SSH_KEY`), пути на Pi: `server/.env`, `server/data/`, статика `web/out/`;
- упоминания `public/` убрать; описания API/конфига (`.env`) не трогать — они не менялись.

- [ ] **Step 5: Commit**

```bash
git add deploy.sh server/systemd README.md
git commit -m "deploy.sh: сборка локально, rsync, npm ci и рестарт на Pi; systemd-пути на server/"
```

---

### Task 13: Финал — чистая пересборка, тег, обновление SUMMARY

**Files:**
- Modify: `../SUMMARY.md` (вне репо — файл контекста сессий), git tag

- [ ] **Step 1: Чистая пересборка с нуля**

Run: `git clean -e '.env' -ndx` — просмотреть список; затем `rm -rf node_modules server/dist shared/dist web/.next web/out web/next-env.d.ts package-lock.json && npm install && npm run build && npm run check`
Expected: всё зелёное с нуля. `git status --short` — пусто (сборочные артефакты игнорируются).

- [ ] **Step 2: Тег на старую версию (точка отката)**

```bash
git tag legacy-vanilla-ui 4ffcf08
```

(4ffcf08 — «Исходное состояние до переезда на Next.js».)

- [ ] **Step 3: Обновить `/home/alexey/work/rancho/SUMMARY.md`**

В §4 «Приложение» отразить: монорепо shared/server/web, Next.js static export, страницы `/`, `/settings`, `/diagnostics`, `/login`, смена языка без перезагрузки; в §8 — новый деплой (`./deploy.sh`, сборка локально, пути `server/.env`, `server/data/` на Pi). Отметить: **на Pi ещё не задеплоено** (деплой — по команде пользователя).

- [ ] **Step 4: Финальная приёмка пользователем**

Запустить `npm run dev`, дать пользователю ссылку `http://localhost:3001` и чек-лист: дашборд (кольцо, карточки, «вспышка» обновления), /settings (drift, unlock → запись → авто-relock, confirm-модалка), /diagnostics (QPIGS), смена языка UA/RU/EN без перезагрузки, ghosting при остановке демона (killать server-процесс). Логин проверить, перезапустив dev-демона с `AUTH_PASSWORD=test`.

Деплой на Pi — отдельным решением пользователя (нужен SSH-ключ: `ssh-keygen … && ssh-copy-id …` в обычном терминале).

---

## Self-review плана (выполнен)

- Покрытие спеки: структура (T1, T3, T4), shared-типы (T3), фронт — страницы/компоненты/хуки/i18n (T5–T10), правки сервера (T11), dev-флоу (T4), деплой (T12), проверки (T2 + шаги Verify в каждой задаче), риски/откат (T13: тег, чистая сборка).
- Типы сходятся: `ControlType`/`ApiMeta`/`Snapshot` — единый источник `@inverter/shared` (T3), используются в T6/T9; `Dict` — T5, используется в T8/T9/T10; `postJson` — T6, используется в T9/T10.
- Плейсхолдеров нет; единственное «скопировать дословно» — словари ru/en и uk.warnings из `public/i18n.js` (файл в репо до T11, копия механическая, полнота проверяется tsc).
