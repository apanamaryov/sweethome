# MCP-сервер Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать MCP-клиентам полный доступ к инвертору — чтение, статистика, диагностика и управление под гейтами — через общее ядро с двумя транспортами: stdio-бинарь и эндпоинт `/mcp` в самом сервисе.

**Architecture:** Новый workspace `@inverter/mcp` содержит всю логику инструментов и общается с сервисом только через интерфейс `InverterGateway`. Реализаций две: `HttpGateway` (REST + WS под Bearer, для stdio) и `LocalGateway` (прямые вызовы `Inverter`/`StatsDb`, для `/mcp`). Набор инструментов собирается по правам предъявленного токена.

**Tech Stack:** TypeScript (CommonJS-эмит, `moduleResolution: node16`), `@modelcontextprotocol/sdk` ^1.29, zod ^4, ws, jest + ts-jest, Express 4.

## Global Constraints

- **Предусловие:** выполнен план `2026-07-27-api-tokens.md` — токены, `req.auth`, скоуп `write`, Bearer в WS и `Inverter.previewControl` уже существуют.
- Node ≥ 24, TypeScript strict; воркспейс `mcp/` эмитит **CommonJS** (в `mcp/package.json` нет `"type": "module"`), иначе `server` его не подключит.
- Порядок сборки строго `shared → mcp → server → web`.
- Публичный API `@inverter/mcp` не экспонирует типы SDK наружу — только собственные интерфейсы и `express.RequestHandler`.
- Каждый инструмент отдаёт `structuredContent` **и** короткий человекочитаемый текст.
- Никакого молчаливого усечения: прореживание и обрезка списков всегда видны в ответе.
- Инструменты записи не регистрируются, если нет прав — они не должны появляться в `tools/list`.
- Комментарии в коде — русские, как в остальном сервере.

---

### Task 1: Каркас воркспейса `@inverter/mcp` и разбор времени

**Files:**
- Create: `mcp/package.json`, `mcp/tsconfig.json`, `mcp/tsconfig.test.json`, `mcp/jest.config.cjs`, `mcp/src/index.ts`, `mcp/src/time.ts`
- Test: `mcp/src/time.test.ts`
- Modify: `package.json` (корневой: workspaces и скрипты)

**Interfaces:**
- Produces: `parseTime(input: string | number, now: number): number` (бросает `Error` на мусоре), `parseDay(input: string, now: number): string` (YYYY-MM-DD), пакет `@inverter/mcp` с рабочим `npm test -w mcp`.

- [ ] **Step 1: Создать `mcp/package.json`**

```json
{
  "name": "@inverter/mcp",
  "version": "1.0.0",
  "private": true,
  "description": "MCP server exposing the inverter monitor to LLM agents",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": { "inverter-mcp": "dist/bin/stdio.js" },
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist",
    "check": "jest",
    "test": "jest"
  },
  "engines": { "node": ">=24" },
  "dependencies": {
    "@inverter/shared": "1.0.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "ws": "^8.18.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "@types/node": "^24.0.0",
    "@types/ws": "^8.5.10",
    "jest": "^29.7.0",
    "ts-jest": "^29.4.12",
    "typescript": "^5.4.5"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Создать `mcp/tsconfig.json` и `mcp/tsconfig.test.json`**

`mcp/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "node16",
    "moduleResolution": "node16",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`mcp/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "types": ["jest", "node"] },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Создать `mcp/jest.config.cjs`**

```js
const path = require("path");

/** @type {import('jest').Config} */
module.exports = {
  // rootDir на корень монорепо — как в server/jest.config.cjs: иначе shared/src
  // не подхватится маппером и покрытием.
  rootDir: path.resolve(__dirname, ".."),
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/mcp/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@inverter/shared$": "<rootDir>/shared/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/mcp/tsconfig.test.json" }],
  },
};
```

- [ ] **Step 4: Подключить воркспейс в корневом `package.json`**

```json
  "workspaces": ["shared", "mcp", "server", "web"],
  "scripts": {
    "build": "npm run build -w shared && npm run build -w mcp && npm run build -w server && npm run build -w web",
    "check": "npm run check -w mcp && npm run check -w server && npm run typecheck -w web",
    "dev": "concurrently -k -n server,web -c blue,magenta \"npm run dev -w server\" \"npm run dev -w web\"",
    "test": "npm test -w mcp && npm test -w server && npm test -w web",
    "test:coverage": "npm run test:coverage -w server && npm run test:coverage -w web"
  },
```

Затем выполнить `npm install` в корне (создаст симлинки воркспейсов и поставит SDK).

- [ ] **Step 5: Написать падающий тест `mcp/src/time.test.ts`**

```ts
import { parseTime, parseDay } from "./time";

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0); // 2026-07-27T12:00:00Z

describe("parseTime", () => {
  it("accepts unix ms as number and as string", () => {
    expect(parseTime(1_700_000_000_000, NOW)).toBe(1_700_000_000_000);
    expect(parseTime("1700000000000", NOW)).toBe(1_700_000_000_000);
  });

  it("accepts ISO 8601", () => {
    expect(parseTime("2026-07-27T00:00:00Z", NOW)).toBe(Date.UTC(2026, 6, 27));
  });

  it("accepts now and relative offsets", () => {
    expect(parseTime("now", NOW)).toBe(NOW);
    expect(parseTime("-1h", NOW)).toBe(NOW - 3_600_000);
    expect(parseTime("-90m", NOW)).toBe(NOW - 90 * 60_000);
    expect(parseTime("-7d", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseTime("-30s", NOW)).toBe(NOW - 30_000);
  });

  it("rejects garbage with a helpful message", () => {
    expect(() => parseTime("yesterday-ish", NOW)).toThrow(/unix ms/);
    expect(() => parseTime("", NOW)).toThrow(/unix ms/);
    expect(() => parseTime("+1h", NOW)).toThrow(/unix ms/);
  });
});

describe("parseDay", () => {
  it("passes through YYYY-MM-DD", () => {
    expect(parseDay("2026-01-05", NOW)).toBe("2026-01-05");
  });

  it("resolves today, yesterday and negative day offsets in local time", () => {
    const local = (ms: number) => {
      const d = new Date(ms);
      const p = (x: number) => String(x).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    expect(parseDay("today", NOW)).toBe(local(NOW));
    expect(parseDay("yesterday", NOW)).toBe(local(NOW - 86_400_000));
    expect(parseDay("-3d", NOW)).toBe(local(NOW - 3 * 86_400_000));
  });

  it("rejects garbage", () => {
    expect(() => parseDay("07/27/2026", NOW)).toThrow(/YYYY-MM-DD/);
  });
});
```

- [ ] **Step 6: Запустить тест — убедиться, что падает**

Run: `npm test -w mcp -- src/time.test.ts`
Expected: FAIL — `Cannot find module './time'`.

- [ ] **Step 7: Реализовать `mcp/src/time.ts`**

```ts
/**
 * Разбор временных аргументов инструментов. Агент может передать unix ms,
 * ISO 8601 или относительное смещение — все три формы приводятся к unix ms.
 * Чистая функция: «сейчас» приходит аргументом, поэтому тестируется без моков.
 */

const REL_RE = /^-(\d+)(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseTime(input: string | number, now: number): number {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  const s = String(input ?? "").trim();
  if (s === "now") return now;

  const rel = s.match(REL_RE);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]];

  if (/^\d+$/.test(s)) return Number(s);

  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return iso;

  throw new Error(
    `Cannot parse time "${s}": use unix ms, ISO 8601 (2026-07-27T00:00:00Z), "now" or an offset like "-24h"`
  );
}

/** Локальный день (YYYY-MM-DD) из дня, "today"/"yesterday" или смещения "-3d". */
export function parseDay(input: string, now: number): string {
  const s = String(input ?? "").trim();
  if (DAY_RE.test(s)) return s;

  const localDay = (ms: number): string => {
    const d = new Date(ms);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  if (s === "today") return localDay(now);
  if (s === "yesterday") return localDay(now - 86_400_000);

  const rel = s.match(/^-(\d+)d$/);
  if (rel) return localDay(now - Number(rel[1]) * 86_400_000);

  throw new Error(`Cannot parse day "${s}": use YYYY-MM-DD, "today", "yesterday" or "-3d"`);
}
```

- [ ] **Step 8: Создать заглушку `mcp/src/index.ts`**

```ts
export { parseTime, parseDay } from "./time";
```

- [ ] **Step 9: Запустить тесты и сборку**

Run: `npm test -w mcp` затем `npm run build -w mcp`
Expected: PASS; в `mcp/dist/` появились `time.js`, `index.js`, `index.d.ts`.

- [ ] **Step 10: Коммит**

```bash
git add package.json package-lock.json mcp/
git commit -m "feat(mcp): каркас воркспейса @inverter/mcp и разбор времени"
```

---

### Task 2: Прореживание рядов и человекочитаемое форматирование

**Files:**
- Create: `mcp/src/downsample.ts`, `mcp/src/format.ts`
- Test: `mcp/src/downsample.test.ts`, `mcp/src/format.test.ts`
- Modify: `mcp/src/index.ts`

**Interfaces:**
- Consumes: типы `Snapshot` из `@inverter/shared`.
- Produces: `downsample<T>(rows: T[], maxPoints: number): { rows: T[]; downsampled: boolean; sourcePoints: number }`; `summarizeSnapshot(snap: Snapshot, now: number): string`; `formatWatts(w: number): string`.

- [ ] **Step 1: Написать падающий тест `mcp/src/downsample.test.ts`**

```ts
import { downsample } from "./downsample";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i }));

describe("downsample", () => {
  it("returns the input untouched when it already fits", () => {
    const r = downsample(rows(10), 10);
    expect(r).toEqual({ rows: rows(10), downsampled: false, sourcePoints: 10 });
  });

  it("thins the series down to at most maxPoints", () => {
    const r = downsample(rows(1000), 100);
    expect(r.downsampled).toBe(true);
    expect(r.sourcePoints).toBe(1000);
    expect(r.rows.length).toBeLessThanOrEqual(100);
  });

  it("always keeps the first and the last point", () => {
    const r = downsample(rows(1000), 7);
    expect(r.rows[0]).toEqual({ t: 0 });
    expect(r.rows[r.rows.length - 1]).toEqual({ t: 999 });
  });

  it("handles empty input and maxPoints below 2", () => {
    expect(downsample([], 100)).toEqual({ rows: [], downsampled: false, sourcePoints: 0 });
    const one = downsample(rows(5), 1);
    expect(one.rows).toEqual([{ t: 0 }, { t: 4 }]);
    expect(one.downsampled).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w mcp -- src/downsample.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `mcp/src/downsample.ts`**

```ts
/**
 * Равномерное прореживание ряда до maxPoints точек. Первая и последняя точки
 * сохраняются всегда — иначе агент видит «обрезанный» интервал и делает выводы
 * о данных, которых нет.
 */
export function downsample<T>(
  rows: T[],
  maxPoints: number
): { rows: T[]; downsampled: boolean; sourcePoints: number } {
  const sourcePoints = rows.length;
  if (sourcePoints <= maxPoints) return { rows, downsampled: false, sourcePoints };

  const limit = Math.max(2, Math.trunc(maxPoints));
  const step = Math.ceil(sourcePoints / limit);
  const picked = rows.filter((_, i) => i % step === 0);
  const last = rows[sourcePoints - 1];
  if (picked[picked.length - 1] !== last) picked.push(last);
  return { rows: picked, downsampled: true, sourcePoints };
}
```

- [ ] **Step 4: Написать падающий тест `mcp/src/format.test.ts`**

```ts
import type { Snapshot } from "@inverter/shared";
import { summarizeSnapshot, formatWatts } from "./format";

const NOW = 1_700_000_010_000;

const base: Snapshot = {
  timestamp: NOW - 3000,
  connection: { connected: true, transport: "serial", device: "/dev/ttyUSB0", deviceId: "dev-1", mock: false, lastError: null },
  control: { allowControl: true, locked: true },
  mode: "Battery",
  status: {
    gridVoltage: 232.7, gridFrequency: 50, mainsPower: 0, inverterPower: 430,
    acOutputVoltage: 230, acOutputFrequency: 50, acOutputActivePower: 430, acOutputApparentPower: 500,
    outputLoadPercent: 8, batteryVoltage: 52.2, batteryPower: -400, batteryChargingCurrent: 0,
    batteryDischargeCurrent: 7.7, batteryCapacity: 72, pvInputVoltage: 310, pvInputCurrent: 4,
    pvPower: 1240, pvChargingPower: 800, dcdcTemperature: 35, heatSinkTemperature: 41, raw: "",
  },
  info: null,
  flags: null,
  warnings: { active: [], raw: "fault=0x0 warning=0x0" },
  baseline: null,
};

describe("formatWatts", () => {
  it("switches to kW above a kilowatt", () => {
    expect(formatWatts(430)).toBe("430 W");
    expect(formatWatts(1240)).toBe("1.24 kW");
    expect(formatWatts(-400)).toBe("-400 W");
  });
});

describe("summarizeSnapshot", () => {
  it("renders one readable line with mode, SOC, PV, load and grid", () => {
    const line = summarizeSnapshot(base, NOW);
    expect(line).toContain("Battery");
    expect(line).toContain("SOC 72%");
    expect(line).toContain("PV 1.24 kW");
    expect(line).toContain("load 430 W");
    expect(line).toContain("232.7 V");
    expect(line).toContain("3 s ago");
  });

  it("says so when the inverter is not connected", () => {
    const off = { ...base, connection: { ...base.connection, connected: false }, status: null };
    expect(summarizeSnapshot(off, NOW)).toContain("no connection");
  });

  it("marks demo data", () => {
    const mock = { ...base, connection: { ...base.connection, mock: true, transport: "mock" } };
    expect(summarizeSnapshot(mock, NOW)).toContain("demo data");
  });

  it("lists active alarms", () => {
    const bad = { ...base, warnings: { active: ["Over temperature"], raw: "" } };
    expect(summarizeSnapshot(bad, NOW)).toContain("alarms: Over temperature");
  });
});
```

- [ ] **Step 5: Запустить тест — убедиться, что падает**

Run: `npm test -w mcp -- src/format.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 6: Реализовать `mcp/src/format.ts`**

```ts
import type { Snapshot } from "@inverter/shared";

/** Ватты в читаемом виде: до киловатта — W, дальше — kW с двумя знаками. */
export function formatWatts(w: number): string {
  return Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`;
}

/** Одна строка о текущем состоянии — то, что человек читает в клиенте MCP. */
export function summarizeSnapshot(snap: Snapshot, now: number): string {
  if (!snap.connection.connected || !snap.status) {
    const why = snap.connection.lastError ? ` (${snap.connection.lastError})` : "";
    return `Inverter: no connection${why}`;
  }
  const s = snap.status;
  const age = Math.max(0, Math.round((now - snap.timestamp) / 1000));
  const parts = [
    `Mode: ${snap.mode}`,
    `SOC ${s.batteryCapacity}%`,
    `battery ${s.batteryVoltage} V / ${formatWatts(s.batteryPower)}`,
    `PV ${formatWatts(s.pvPower)}`,
    `load ${formatWatts(s.acOutputActivePower)} (${s.outputLoadPercent}%)`,
    `grid ${s.gridVoltage} V / ${s.gridFrequency} Hz`,
    `${age} s ago`,
  ];
  if (snap.connection.mock) parts.push("demo data");
  if (snap.control.locked) parts.push("write locked");
  if (snap.warnings?.active.length) parts.push(`alarms: ${snap.warnings.active.join(", ")}`);
  return parts.join(" · ");
}
```

- [ ] **Step 7: Запустить тесты**

Run: `npm test -w mcp`
Expected: PASS (time, downsample, format).

- [ ] **Step 8: Дополнить `mcp/src/index.ts`**

```ts
export { parseTime, parseDay } from "./time";
export { downsample } from "./downsample";
export { summarizeSnapshot, formatWatts } from "./format";
```

- [ ] **Step 9: Коммит**

```bash
git add mcp/src/downsample.ts mcp/src/downsample.test.ts mcp/src/format.ts mcp/src/format.test.ts mcp/src/index.ts
git commit -m "feat(mcp): прореживание рядов и текстовые резюме снапшота"
```

---

### Task 3: Карта регистров в `shared` и тест согласованности

**Files:**
- Create: `shared/src/registers.ts`
- Modify: `shared/src/index.ts`
- Test: `server/src/protocol/registers.test.ts`

**Interfaces:**
- Produces: `REGISTER_DOCS: RegisterDoc[]`, тип `RegisterDoc { addr; key; name; unit; scale; access; notes? }`, функция `registerDocsMarkdown(): string`.

- [ ] **Step 1: Написать падающий тест `server/src/protocol/registers.test.ts`**

```ts
import { REGISTER_DOCS, registerDocsMarkdown } from "@inverter/shared";
import type { InverterStatus, InverterRatedInfo } from "@inverter/shared";
import { STATUS_BLOCKS, ALARM_BLOCKS, SETTINGS_BLOCKS, decodeStatus, decodeSettings } from "./smg";

/** Все адреса, которые поллер реально читает. */
function readableAddresses(): Set<number> {
  const set = new Set<number>();
  for (const [start, count] of [...STATUS_BLOCKS, ...ALARM_BLOCKS, ...SETTINGS_BLOCKS]) {
    for (let a = start; a < start + count; a++) set.add(a);
  }
  return set;
}

describe("REGISTER_DOCS", () => {
  it("documents only registers the poller actually reads", () => {
    const readable = readableAddresses();
    const orphans = REGISTER_DOCS.filter((d) => !readable.has(d.addr));
    expect(orphans.map((d) => `${d.addr} (${d.key})`)).toEqual([]);
  });

  it("has no duplicate addresses and no empty names", () => {
    const addrs = REGISTER_DOCS.map((d) => d.addr);
    expect(new Set(addrs).size).toBe(addrs.length);
    expect(REGISTER_DOCS.filter((d) => !d.name.trim() || !d.key.trim())).toEqual([]);
  });

  it("covers every decoded status field", () => {
    const decoded = decodeStatus(new Map()) as InverterStatus;
    const documented = new Set(REGISTER_DOCS.map((d) => d.key));
    const missing = Object.keys(decoded).filter((k) => k !== "raw" && !documented.has(k));
    expect(missing).toEqual([]);
  });

  it("covers every decoded settings field", () => {
    const decoded = decodeSettings(new Map()) as InverterRatedInfo;
    const documented = new Set(REGISTER_DOCS.map((d) => d.key));
    const missing = Object.keys(decoded).filter((k) => k !== "raw" && !documented.has(k));
    expect(missing).toEqual([]);
  });

  it("renders a markdown table with a row per register", () => {
    const md = registerDocsMarkdown();
    expect(md).toContain("| Address | Key |");
    expect(md.split("\n").filter((l) => /^\| \d+ \|/.test(l))).toHaveLength(REGISTER_DOCS.length);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w server -- src/protocol/registers.test.ts`
Expected: FAIL — `REGISTER_DOCS` не экспортируется из `@inverter/shared`.

- [ ] **Step 3: Реализовать `shared/src/registers.ts`**

Значения `addr`/`scale`/`unit` бери **из `server/src/protocol/smg.ts`** — открой `decodeStatus` и `decodeSettings` и перенеси в таблицу ровно те адреса и делители, которые там используются. Каркас и первые строки:

```ts
/**
 * Справочная карта регистров SMG II (наш SK-5500P-48L). Это документация для
 * агентов и людей: декодирование живёт в server/src/protocol/smg.ts, а здесь —
 * структурированное описание тех же адресов. Согласованность проверяется тестом
 * server/src/protocol/registers.test.ts.
 */
export interface RegisterDoc {
  addr: number;
  /** Имя поля в InverterStatus / InverterRatedInfo. */
  key: string;
  name: string;
  /** Единица измерения после масштабирования; "" для безразмерных кодов. */
  unit: string;
  /** Делитель сырого значения: 1, 10 или 100. */
  scale: 1 | 10 | 100;
  access: "r" | "rw";
  notes?: string;
}

export const REGISTER_DOCS: RegisterDoc[] = [
  // --- Статус (201–234), только чтение ---
  { addr: 202, key: "gridVoltage", name: "Grid voltage", unit: "V", scale: 10, access: "r" },
  { addr: 203, key: "gridFrequency", name: "Grid frequency", unit: "Hz", scale: 100, access: "r" },
  { addr: 204, key: "mainsPower", name: "Average power drawn from the grid", unit: "W", scale: 1, access: "r" },
  { addr: 208, key: "inverterPower", name: "Inverter power", unit: "W", scale: 1, access: "r", notes: "positive = supplying, negative = consuming" },
  // …перенеси остальные поля decodeStatus: 210, 212, 213, 214, 215, 217, 219, 220,
  //    223, 224, 225, 226, 227, 229, 232 — ключи те же, что в InverterStatus.

  // --- Настройки (300–343, 643) ---
  { addr: 301, key: "outputSourcePriority", name: "Output source priority", unit: "", scale: 1, access: "rw", notes: "0 UTI, 1 SOL, 2 SBU, 3 SUB" },
  { addr: 331, key: "chargerSourcePriority", name: "Battery charging priority", unit: "", scale: 1, access: "rw", notes: "0 Utility, 1 PV, 2 PV+Utility, 3 Only PV" },
  { addr: 332, key: "maxChargingCurrent", name: "Max charging current", unit: "A", scale: 10, access: "rw" },
  // …перенеси остальные поля decodeSettings: 300, 302, 303, 305, 320, 321, 322,
  //    323, 324, 325, 326, 327, 329, 333, 334, 341, 342, 343, 643.
];

/** Markdown-таблица для ресурса inverter://registers/map. */
export function registerDocsMarkdown(): string {
  const head = [
    "# SMG II register map (SK-5500P-48L)",
    "",
    "Values are read over Modbus RTU (function 0x03); writes use function 0x10 only.",
    "`Scale` is a divisor: the raw register value divided by it gives the physical value.",
    "",
    "| Address | Key | Name | Unit | Scale | Access | Notes |",
    "|---:|---|---|---|---:|---|---|",
  ];
  const rows = REGISTER_DOCS.map(
    (d) => `| ${d.addr} | ${d.key} | ${d.name} | ${d.unit || "—"} | ${d.scale} | ${d.access} | ${d.notes ?? ""} |`
  );
  return [...head, ...rows, ""].join("\n");
}
```

- [ ] **Step 4: Экспортировать из `shared/src/index.ts`**

```ts
export * from "./types";
export * from "./api";
export * from "./auth";
export * from "./registers";
```

- [ ] **Step 5: Запустить тест — довести до зелёного**

Run: `npm test -w server -- src/protocol/registers.test.ts`
Expected: PASS. Если тест «covers every decoded field» падает — добавь недостающую строку в `REGISTER_DOCS` (сообщение теста прямо перечисляет ключи).

- [ ] **Step 6: Коммит**

```bash
git add shared/src/registers.ts shared/src/index.ts server/src/protocol/registers.test.ts
git commit -m "feat(shared): структурированная карта регистров SMG II"
```

---

### Task 4: `diffSettings` в `shared`

**Files:**
- Create: `shared/src/settings.ts`
- Modify: `shared/src/index.ts`
- Test: `shared/src/settings.test.ts`

**Interfaces:**
- Consumes: `InverterRatedInfo`, `InverterFlags`, `Baseline`, карты значений из `api.ts`, `REGISTER_DOCS`.
- Produces: `diffSettings(info, flags, baseline) → SettingsDiff`, типы `SettingDiffRow`, `SettingsDiff`.

- [ ] **Step 1: Написать падающий тест `shared/src/settings.test.ts`**

```ts
import { diffSettings } from "./settings";
import type { Baseline, InverterFlags, InverterRatedInfo } from "./types";

const info = {
  outputMode: 0, outputSourcePriority: 2, inputVoltageRange: 0, buzzerMode: 0, lcdBacklight: 1,
  acOutputRatingVoltage: 230, acOutputRatingFrequency: 50, batteryType: 3, batteryOverVoltage: 60,
  batteryBulkVoltage: 56.4, batteryFloatVoltage: 54, batteryRedischargeVoltage: 52,
  batteryRechargeVoltage: 48, batteryUnderVoltage: 46, chargerSourcePriority: 3,
  maxChargingCurrent: 60, maxAcChargingCurrent: 30, eqChargingVoltage: 56.4,
  socBackToUtility: 20, socBackToBattery: 80, socLowCutoff: 10,
  acOutputRatingActivePower: 5500, raw: "",
} satisfies InverterRatedInfo;

const flags: InverterFlags = {
  flags: [{ key: "ecoMode", name: "Eco mode", enabled: true }],
  raw: "",
};

const baseline: Baseline = {
  deviceId: "dev-1",
  capturedAt: 1000,
  info: { ...info, chargerSourcePriority: 1, maxChargingCurrent: 40 },
  flags: { flags: [{ key: "ecoMode", name: "Eco mode", enabled: false }], raw: "" },
};

describe("diffSettings", () => {
  it("marks fields that drifted from the baseline", () => {
    const d = diffSettings(info, flags, baseline);
    const drifted = d.settings.filter((r) => r.drifted).map((r) => r.key);
    expect(drifted.sort()).toEqual(["chargerSourcePriority", "maxChargingCurrent"]);
    expect(d.driftCount).toBe(3); // два поля настроек + один флаг
  });

  it("renders coded values through the shared maps", () => {
    const d = diffSettings(info, flags, baseline);
    const csp = d.settings.find((r) => r.key === "chargerSourcePriority")!;
    expect(csp.currentLabel).toBe("Only PV");
    expect(csp.baselineLabel).toBe("PV first");
    const mcc = d.settings.find((r) => r.key === "maxChargingCurrent")!;
    expect(mcc.currentLabel).toBe("60 A");
  });

  it("reports flag drift separately", () => {
    const d = diffSettings(info, flags, baseline);
    expect(d.flags).toEqual([
      { key: "ecoMode", name: "Eco mode", current: true, baseline: false, drifted: true },
    ]);
  });

  it("works without a baseline and without flags", () => {
    const d = diffSettings(info, null, null);
    expect(d.driftCount).toBe(0);
    expect(d.settings.every((r) => r.drifted === false && r.baseline === null)).toBe(true);
    expect(d.flags).toEqual([]);
  });

  it("returns an empty diff when settings have not been read yet", () => {
    const d = diffSettings(null, null, baseline);
    expect(d.settings).toEqual([]);
    expect(d.driftCount).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w server -- shared/src/settings.test.ts`
(jest сервера включает `shared/src` в `roots`, отдельный прогон не нужен.)
Expected: FAIL — модуль `./settings` не найден.

- [ ] **Step 3: Реализовать `shared/src/settings.ts`**

```ts
import type { Baseline, InverterFlags, InverterRatedInfo } from "./types";
import { CHARGER_SOURCE_PRIORITY, OUTPUT_SOURCE_PRIORITY } from "./api";
import { REGISTER_DOCS } from "./registers";

export interface SettingDiffRow {
  key: string;
  name: string;
  addr: number | null;
  current: number;
  currentLabel: string;
  baseline: number | null;
  baselineLabel: string | null;
  drifted: boolean;
}

export interface SettingFlagDiffRow {
  key: string;
  name: string;
  current: boolean;
  baseline: boolean | null;
  drifted: boolean;
}

export interface SettingsDiff {
  capturedAt: number | null;
  deviceId: string | null;
  settings: SettingDiffRow[];
  flags: SettingFlagDiffRow[];
  driftCount: number;
}

const BATTERY_TYPES: Record<number, string> = {
  0: "AGM", 1: "Flooded", 2: "User", 3: "Li1", 4: "Li2", 5: "Li3", 6: "Li4", 8: "Lib",
};

const CODED: Record<string, Record<number, string>> = {
  outputSourcePriority: OUTPUT_SOURCE_PRIORITY,
  chargerSourcePriority: CHARGER_SOURCE_PRIORITY,
  batteryType: BATTERY_TYPES,
};

function label(key: string, value: number, unit: string): string {
  const coded = CODED[key];
  if (coded && coded[value] !== undefined) return coded[value];
  return unit ? `${value} ${unit}` : String(value);
}

/**
 * Сравнение текущих настроек с эталоном «как нашли». Чистая функция без i18n:
 * подписи — английские имена из карты регистров, локализация остаётся делом UI.
 */
export function diffSettings(
  info: InverterRatedInfo | null,
  flags: InverterFlags | null,
  baseline: Baseline | null
): SettingsDiff {
  const docs = new Map(REGISTER_DOCS.map((d) => [d.key, d]));
  const base = baseline?.info ?? null;

  const settings: SettingDiffRow[] = info
    ? Object.entries(info)
        .filter(([key, v]) => key !== "raw" && typeof v === "number")
        .map(([key, v]) => {
          const doc = docs.get(key);
          const unit = doc?.unit ?? "";
          const current = v as number;
          const baseVal = base ? ((base as unknown as Record<string, number>)[key] ?? null) : null;
          const bothNaN = Number.isNaN(current) && baseVal !== null && Number.isNaN(baseVal);
          return {
            key,
            name: doc?.name ?? key,
            addr: doc?.addr ?? null,
            current,
            currentLabel: label(key, current, unit),
            baseline: baseVal,
            baselineLabel: baseVal === null ? null : label(key, baseVal, unit),
            drifted: baseVal !== null && !bothNaN && current !== baseVal,
          };
        })
    : [];

  const baseFlags = new Map((baseline?.flags?.flags ?? []).map((f) => [f.key, f.enabled]));
  const flagRows: SettingFlagDiffRow[] = (flags?.flags ?? []).map((f) => {
    const b = baseFlags.has(f.key) ? baseFlags.get(f.key)! : null;
    return { key: f.key, name: f.name, current: f.enabled, baseline: b, drifted: b !== null && b !== f.enabled };
  });

  return {
    capturedAt: baseline?.capturedAt ?? null,
    deviceId: baseline?.deviceId ?? null,
    settings,
    flags: flagRows,
    driftCount: settings.filter((r) => r.drifted).length + flagRows.filter((r) => r.drifted).length,
  };
}
```

- [ ] **Step 4: Экспортировать и прогнать тесты**

В `shared/src/index.ts` добавить `export * from "./settings";`

Run: `npm test -w server -- shared/src/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add shared/src/settings.ts shared/src/settings.test.ts shared/src/index.ts
git commit -m "feat(shared): diffSettings — сравнение текущих настроек с эталоном"
```

---

### Task 5: Интерфейс `InverterGateway` и его HTTP-реализация

**Files:**
- Create: `mcp/src/gateway/types.ts`, `mcp/src/gateway/http.ts`
- Test: `mcp/src/gateway/http.test.ts`
- Modify: `mcp/src/index.ts`

**Interfaces:**
- Consumes: `Snapshot`, `ApiMeta`, `Baseline`, `ControlType`, `ControlResponse`, `TokenScope`.
- Produces: типы `InverterGateway`, `GatewayCapabilities`, `StatsGateway`, `SeriesQuery`, `EventsQuery`, `ControlPreview`, `SolarWindowResult`, `GatewayError`; класс `HttpGateway` и фабрика `createHttpGateway(opts): Promise<InverterGateway>`.

- [ ] **Step 1: Написать `mcp/src/gateway/types.ts`**

```ts
import type {
  ApiMeta, Baseline, ControlResponse, ControlType, Role, Snapshot, TokenScope,
} from "@inverter/shared";

/** Что инструментам разрешено — считается один раз при старте сервера MCP. */
export interface GatewayCapabilities {
  role: Role;
  scopes: TokenScope[];
  allowControl: boolean;
  statsEnabled: boolean;
}

export interface SeriesQuery {
  fields: string[];
  from: number;
  to: number;
  res: "raw" | "minute";
}

export interface EventsQuery {
  from?: number;
  to?: number;
  type?: string;
  limit: number;
  offset: number;
}

export interface SolarWindowResult {
  day: string;
  start: number | null;
  end: number | null;
  state: "idle" | "active" | "ended";
}

export interface ControlPreview {
  register: number;
  rawValue: number;
  label: string;
  currentValue: number | null;
  baselineValue: number | null;
}

export interface StatsGateway {
  series(q: SeriesQuery): Promise<Array<Record<string, number | null>>>;
  daily(from: string, to: string): Promise<Array<Record<string, unknown>>>;
  energy(from: number, to: number, bucket: "hour" | "day"): Promise<Array<Record<string, number>>>;
  events(q: EventsQuery): Promise<Array<{ id: number; ts: number; type: string; detail: string }>>;
  solarWindow(day?: string): Promise<SolarWindowResult>;
  exportCsv(q: { from: number; to: number; res: "raw" | "minute" }): Promise<{ csv: string; truncated: boolean }>;
}

/** Единственная граница между ядром MCP и сервисом. */
export interface InverterGateway {
  snapshot(): Promise<Snapshot>;
  meta(): Promise<ApiMeta>;
  baseline(): Promise<Baseline | null>;
  control(type: ControlType, value: number): Promise<ControlResponse>;
  previewControl(type: ControlType, value: number): Promise<ControlPreview>;
  setLock(locked: boolean): Promise<{ locked: boolean }>;
  recaptureBaseline(): Promise<Baseline>;
  raw(command: string): Promise<string>;
  stats: StatsGateway | null;
  /** Подписка на снапшоты; возвращает отписку. */
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  capabilities(): GatewayCapabilities;
  close(): void;
}

/** Ошибка обращения к сервису — инструменты превращают её в isError-ответ. */
export class GatewayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Предел размера CSV-выгрузки: агенту нельзя вываливать гигабайты. */
export const CSV_LIMIT_BYTES = 5 * 1024 * 1024;
```

- [ ] **Step 2: Написать падающий тест `mcp/src/gateway/http.test.ts`**

```ts
import type { Snapshot } from "@inverter/shared";
import { createHttpGateway } from "./http";
import { GatewayError } from "./types";

const SNAPSHOT = { timestamp: 1, mode: "Battery" } as unknown as Snapshot;

const ME = { username: "bot", role: "admin", mustChangePassword: false, auth: "token", scopes: ["read", "write"] };
const META = { session: { username: "bot", role: "admin", mustChangePassword: false }, allowControl: true, outputSourcePriority: {}, chargerSourcePriority: {}, maxChargingCurrent: [], maxAcChargingCurrent: [] };

function res(body: unknown, status = 200, text?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text ?? JSON.stringify(body),
  } as Response;
}

/** fetch-мок, отвечающий по пути запроса. */
function fetchMock(routes: Record<string, () => Response>) {
  return jest.fn(async (url: string | URL) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unexpected fetch: ${path}`);
    return routes[key]();
  });
}

const BASE_ROUTES = {
  "/api/me": () => res(ME),
  "/api/meta": () => res(META),
  "/api/stats/solar-window": () => res({ day: "2026-07-27", start: null, end: null, state: "idle" }),
};

describe("HttpGateway", () => {
  it("sends the bearer token and reports capabilities from /api/me and /api/meta", async () => {
    const f = fetchMock(BASE_ROUTES);
    const gw = await createHttpGateway({ baseUrl: "http://pi:3000", token: "inv_x", fetchImpl: f as unknown as typeof fetch });

    expect(gw.capabilities()).toEqual({ role: "admin", scopes: ["read", "write"], allowControl: true, statsEnabled: true });
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer inv_x");
    gw.close();
  });

  it("marks stats as unavailable when the service answers 503", async () => {
    const gw = await createHttpGateway({
      baseUrl: "http://pi:3000",
      token: "inv_x",
      fetchImpl: fetchMock({ ...BASE_ROUTES, "/api/stats/solar-window": () => res({ ok: false }, 503) }) as unknown as typeof fetch,
    });
    expect(gw.capabilities().statsEnabled).toBe(false);
    expect(gw.stats).toBeNull();
    gw.close();
  });

  it("fetches a snapshot", async () => {
    const gw = await createHttpGateway({
      baseUrl: "http://pi:3000",
      token: "inv_x",
      fetchImpl: fetchMock({ ...BASE_ROUTES, "/api/snapshot": () => res(SNAPSHOT) }) as unknown as typeof fetch,
    });
    await expect(gw.snapshot()).resolves.toEqual(SNAPSHOT);
    gw.close();
  });

  it("turns API errors into GatewayError with the server message", async () => {
    const gw = await createHttpGateway({
      baseUrl: "http://pi:3000",
      token: "inv_x",
      fetchImpl: fetchMock({
        ...BASE_ROUTES,
        "/api/control": () => res({ ok: false, error: "Settings are locked (read-only)" }, 400),
      }) as unknown as typeof fetch,
    });
    await expect(gw.control("chargerSourcePriority", 3)).rejects.toBeInstanceOf(GatewayError);
    await expect(gw.control("chargerSourcePriority", 3)).rejects.toThrow(/locked/);
    gw.close();
  });

  it("explains an unreachable service", async () => {
    const gw = await createHttpGateway({
      baseUrl: "http://pi:3000",
      token: "inv_x",
      fetchImpl: fetchMock(BASE_ROUTES) as unknown as typeof fetch,
    });
    (gw as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(gw.snapshot()).rejects.toThrow(/http:\/\/pi:3000/);
    gw.close();
  });

  it("passes preview through to /api/control", async () => {
    const preview = { register: 331, rawValue: 3, label: "Only PV", currentValue: 1, baselineValue: 1 };
    const f = fetchMock({ ...BASE_ROUTES, "/api/control": () => res({ ok: true, preview: true, ...preview }) });
    const gw = await createHttpGateway({ baseUrl: "http://pi:3000", token: "inv_x", fetchImpl: f as unknown as typeof fetch });

    await expect(gw.previewControl("chargerSourcePriority", 3)).resolves.toEqual(preview);
    const body = JSON.parse((f.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).toEqual({ type: "chargerSourcePriority", value: 3, preview: true });
    gw.close();
  });

  it("builds stats queries with the expected query string", async () => {
    const f = fetchMock({ ...BASE_ROUTES, "/api/stats/series": () => res([{ t: 1, pvPower: 100 }]) });
    const gw = await createHttpGateway({ baseUrl: "http://pi:3000", token: "inv_x", fetchImpl: f as unknown as typeof fetch });

    await gw.stats!.series({ fields: ["pvPower", "batteryPower"], from: 10, to: 20, res: "minute" });
    const url = String(f.mock.calls.at(-1)![0]);
    expect(url).toContain("/api/stats/series?fields=pvPower%2CbatteryPower&from=10&to=20&res=minute");
    gw.close();
  });
});
```

- [ ] **Step 3: Запустить тест — убедиться, что падает**

Run: `npm test -w mcp -- src/gateway/http.test.ts`
Expected: FAIL — модуль `./http` не найден.

- [ ] **Step 4: Реализовать `mcp/src/gateway/http.ts`**

```ts
import { WebSocket } from "ws";
import type {
  ApiMeta, Baseline, ControlResponse, ControlType, Snapshot, TokenScope,
} from "@inverter/shared";
import {
  ControlPreview, EventsQuery, GatewayCapabilities, GatewayError, InverterGateway,
  SeriesQuery, SolarWindowResult, StatsGateway, CSV_LIMIT_BYTES,
} from "./types";

export interface HttpGatewayOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Подменяется в тестах; по умолчанию — ws. */
  webSocketImpl?: typeof WebSocket;
}

interface MeResponseShape {
  role: "admin" | "viewer";
  scopes: TokenScope[];
}

/** Клиент сервиса inverter-monitor поверх REST + WS под Bearer-токеном. */
class HttpGateway implements InverterGateway {
  readonly stats: StatsGateway | null;
  private fetchImpl: typeof fetch;
  private ws: WebSocket | null = null;
  private listeners = new Set<(s: Snapshot) => void>();
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private opts: HttpGatewayOptions,
    private caps: GatewayCapabilities
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.stats = caps.statsEnabled ? this.buildStats() : null;
  }

  capabilities(): GatewayCapabilities {
    return this.caps;
  }

  private url(path: string): string {
    return new URL(path, this.opts.baseUrl).toString();
  }

  private async request<T>(path: string, init?: RequestInit & { raw?: boolean }): Promise<T> {
    const timeout = this.opts.timeoutMs ?? 10_000;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        ...init,
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } catch (e) {
      throw new GatewayError(
        `Inverter service at ${this.opts.baseUrl} is unreachable: ${(e as Error).message}. ` +
          `Check INVERTER_MCP_URL and that the service is running.`
      );
    } finally {
      clearTimeout(timer);
    }

    if (init?.raw) {
      const text = await res.text();
      if (!res.ok) throw new GatewayError(`HTTP ${res.status} for ${path}`, res.status);
      return text as unknown as T;
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* пустой ответ */
    }
    if (!res.ok) {
      const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      throw new GatewayError(msg, res.status);
    }
    return body as T;
  }

  snapshot(): Promise<Snapshot> {
    return this.request<Snapshot>("/api/snapshot");
  }

  meta(): Promise<ApiMeta> {
    return this.request<ApiMeta>("/api/meta");
  }

  baseline(): Promise<Baseline | null> {
    return this.request<Baseline | null>("/api/baseline");
  }

  control(type: ControlType, value: number): Promise<ControlResponse> {
    return this.request<ControlResponse>("/api/control", {
      method: "POST",
      body: JSON.stringify({ type, value }),
    });
  }

  async previewControl(type: ControlType, value: number): Promise<ControlPreview> {
    const r = await this.request<ControlPreview & { ok: boolean; preview: boolean }>("/api/control", {
      method: "POST",
      body: JSON.stringify({ type, value, preview: true }),
    });
    return {
      register: r.register,
      rawValue: r.rawValue,
      label: r.label,
      currentValue: r.currentValue,
      baselineValue: r.baselineValue,
    };
  }

  async setLock(locked: boolean): Promise<{ locked: boolean }> {
    const r = await this.request<{ ok: boolean; locked: boolean }>("/api/lock", {
      method: "POST",
      body: JSON.stringify({ locked }),
    });
    return { locked: r.locked };
  }

  async recaptureBaseline(): Promise<Baseline> {
    const r = await this.request<{ ok: boolean; baseline: Baseline }>("/api/baseline/recapture", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return r.baseline;
  }

  async raw(command: string): Promise<string> {
    const r = await this.request<{ ok: boolean; reply: string }>("/api/raw", {
      method: "POST",
      body: JSON.stringify({ command }),
    });
    return r.reply;
  }

  private buildStats(): StatsGateway {
    const qs = (params: Record<string, string | number | undefined>): string =>
      new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)])
      ).toString();

    return {
      series: (q: SeriesQuery) =>
        this.request(`/api/stats/series?${qs({ fields: q.fields.join(","), from: q.from, to: q.to, res: q.res })}`),
      daily: (from: string, to: string) => this.request(`/api/stats/daily?${qs({ from, to })}`),
      energy: (from: number, to: number, bucket: "hour" | "day") =>
        this.request(`/api/stats/energy?${qs({ from, to, bucket })}`),
      events: (q: EventsQuery) =>
        this.request(`/api/stats/events?${qs({ from: q.from, to: q.to, type: q.type, limit: q.limit, offset: q.offset })}`),
      solarWindow: (day?: string) => this.request<SolarWindowResult>(`/api/stats/solar-window?${qs({ day })}`),
      exportCsv: async (q) => {
        const csv = await this.request<string>(
          `/api/stats/export.csv?${qs({ from: q.from, to: q.to, res: q.res })}`,
          { raw: true }
        );
        return csv.length > CSV_LIMIT_BYTES
          ? { csv: csv.slice(0, CSV_LIMIT_BYTES), truncated: true }
          : { csv, truncated: false };
      },
    };
  }

  onSnapshot(cb: (s: Snapshot) => void): () => void {
    this.listeners.add(cb);
    this.ensureSocket();
    return () => {
      this.listeners.delete(cb);
      if (!this.listeners.size) this.dropSocket();
    };
  }

  private ensureSocket(): void {
    if (this.ws || this.closed) return;
    const Impl = this.opts.webSocketImpl ?? WebSocket;
    const url = this.url("/ws").replace(/^http/, "ws");
    const sock = new Impl(url, { headers: { Authorization: `Bearer ${this.opts.token}` } });
    this.ws = sock;

    sock.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(String(data)) as { type: string; data: Snapshot };
        if (msg.type === "snapshot") for (const cb of this.listeners) cb(msg.data);
      } catch {
        /* мусор в сокете игнорируем */
      }
    });
    const retry = () => {
      this.ws = null;
      if (this.closed || !this.listeners.size) return;
      this.reconnectTimer = setTimeout(() => this.ensureSocket(), 5000);
    };
    sock.on("close", retry);
    sock.on("error", retry);
  }

  private dropSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.dropSocket();
  }
}

/** Создать шлюз и выяснить права токена (один раунд-трип на старте). */
export async function createHttpGateway(opts: HttpGatewayOptions): Promise<InverterGateway> {
  const probe = new HttpGateway(opts, { role: "viewer", scopes: [], allowControl: false, statsEnabled: false });
  const me = await (probe as unknown as { request<T>(p: string): Promise<T> }).request<MeResponseShape>("/api/me");
  const meta = await probe.meta();
  let statsEnabled = true;
  try {
    await (probe as unknown as { request<T>(p: string): Promise<T> }).request("/api/stats/solar-window");
  } catch (e) {
    if (e instanceof GatewayError && e.status === 503) statsEnabled = false;
    else throw e;
  }
  probe.close();

  return new HttpGateway(opts, {
    role: me.role,
    scopes: me.scopes ?? [],
    allowControl: meta.allowControl,
    statsEnabled,
  });
}
```

- [ ] **Step 5: Запустить тесты**

Run: `npm test -w mcp -- src/gateway/http.test.ts`
Expected: PASS (7 тестов).

- [ ] **Step 6: Экспортировать типы из `mcp/src/index.ts`**

```ts
export { parseTime, parseDay } from "./time";
export { downsample } from "./downsample";
export { summarizeSnapshot, formatWatts } from "./format";
export * from "./gateway/types";
export { createHttpGateway } from "./gateway/http";
export type { HttpGatewayOptions } from "./gateway/http";
```

- [ ] **Step 7: Коммит**

```bash
git add mcp/src/gateway mcp/src/index.ts
git commit -m "feat(mcp): InverterGateway и HTTP-реализация под Bearer"
```

---

### Task 6: Ядро сервера MCP и инструменты чтения

**Files:**
- Create: `mcp/src/server.ts`, `mcp/src/tools/read.ts`, `mcp/src/testing/fake-gateway.ts`
- Test: `mcp/src/tools/read.test.ts`
- Modify: `mcp/src/index.ts`

**Interfaces:**
- Consumes: `InverterGateway`, `summarizeSnapshot`, `diffSettings`.
- Produces: `buildMcpServer(ctx: McpContext): McpServer`; `McpContext { gateway; readOnly?; version }`; `createFakeGateway(overrides?): FakeGateway` (тестовая утилита с полем `calls`); инструменты `get_snapshot`, `get_settings_diff`, `get_alarms`, `get_meta`, `get_health`, `read_registers`.

- [ ] **Step 1: Написать тестовую утилиту `mcp/src/testing/fake-gateway.ts`**

```ts
import type { Baseline, ControlResponse, ControlType, Snapshot, ApiMeta } from "@inverter/shared";
import type { ControlPreview, GatewayCapabilities, InverterGateway, StatsGateway } from "../gateway/types";

export const FAKE_SNAPSHOT: Snapshot = {
  timestamp: 1_700_000_000_000,
  connection: { connected: true, transport: "serial", device: "/dev/ttyUSB0", deviceId: "dev-1", mock: false, lastError: null },
  control: { allowControl: true, locked: true },
  mode: "Battery",
  status: {
    gridVoltage: 232.7, gridFrequency: 50, mainsPower: 0, inverterPower: 430,
    acOutputVoltage: 230, acOutputFrequency: 50, acOutputActivePower: 430, acOutputApparentPower: 500,
    outputLoadPercent: 8, batteryVoltage: 52.2, batteryPower: -400, batteryChargingCurrent: 0,
    batteryDischargeCurrent: 7.7, batteryCapacity: 72, pvInputVoltage: 310, pvInputCurrent: 4,
    pvPower: 1240, pvChargingPower: 800, dcdcTemperature: 35, heatSinkTemperature: 41,
    raw: "201=3 202=2327",
  },
  info: {
    outputMode: 0, outputSourcePriority: 2, inputVoltageRange: 0, buzzerMode: 0, lcdBacklight: 1,
    acOutputRatingVoltage: 230, acOutputRatingFrequency: 50, batteryType: 3, batteryOverVoltage: 60,
    batteryBulkVoltage: 56.4, batteryFloatVoltage: 54, batteryRedischargeVoltage: 52,
    batteryRechargeVoltage: 48, batteryUnderVoltage: 46, chargerSourcePriority: 3,
    maxChargingCurrent: 60, maxAcChargingCurrent: 30, eqChargingVoltage: 56.4,
    socBackToUtility: 20, socBackToBattery: 80, socLowCutoff: 10,
    acOutputRatingActivePower: 5500, raw: "",
  },
  flags: { flags: [{ key: "ecoMode", name: "Eco mode", enabled: true }], raw: "" },
  warnings: { active: [], raw: "fault=0x0 warning=0x0" },
  baseline: null,
};

export const FAKE_META: ApiMeta = {
  session: { username: "bot", role: "admin", mustChangePassword: false },
  allowControl: true,
  outputSourcePriority: { 0: "UTI", 1: "SOL", 2: "SBU", 3: "SUB" },
  chargerSourcePriority: { 0: "Utility first", 1: "PV first", 2: "PV and Utility", 3: "Only PV" },
  maxChargingCurrent: [10, 20, 30, 40, 50, 60],
  maxAcChargingCurrent: [10, 20, 30],
};

export interface FakeGateway extends InverterGateway {
  calls: Array<{ method: string; args: unknown[] }>;
  emitSnapshot(s: Snapshot): void;
  snapshotValue: Snapshot;
}

/** Ин-мемори шлюз для тестов ядра: пишет все вызовы в `calls`. */
export function createFakeGateway(overrides: Partial<InverterGateway & { caps: Partial<GatewayCapabilities> }> = {}): FakeGateway {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const listeners = new Set<(s: Snapshot) => void>();
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });

  const caps: GatewayCapabilities = {
    role: "admin",
    scopes: ["read", "write"],
    allowControl: true,
    statsEnabled: true,
    ...(overrides as { caps?: Partial<GatewayCapabilities> }).caps,
  };

  const stats: StatsGateway = {
    async series(q) { record("series", q); return [{ t: 1, pvPower: 100 }, { t: 2, pvPower: 200 }]; },
    async daily(from, to) { record("daily", from, to); return [{ day: "2026-07-26", pv_wh: 8000, load_wh: 5000, grid_wh: 1000, batt_charge_wh: 3000, batt_discharge_wh: 2500, batteryCapacity_min: 40, batteryCapacity_max: 100, solar_start_ts: 1, solar_end_ts: 2 }]; },
    async energy(from, to, bucket) { record("energy", from, to, bucket); return [{ t: 1, pv_wh: 100, load_wh: 90, grid_wh: 10, batt_charge_wh: 5, batt_discharge_wh: 4 }]; },
    async events(q) { record("events", q); return [{ id: 1, ts: 5, type: "mode", detail: '{"from":"Line","to":"Battery"}' }]; },
    async solarWindow(day) { record("solarWindow", day); return { day: day ?? "2026-07-27", start: 10, end: null, state: "active" }; },
    async exportCsv(q) { record("exportCsv", q); return { csv: "ts,mode\n1,Battery\n", truncated: false }; },
  };

  const gw: FakeGateway = {
    calls,
    snapshotValue: FAKE_SNAPSHOT,
    async snapshot() { record("snapshot"); return gw.snapshotValue; },
    async meta() { record("meta"); return FAKE_META; },
    async baseline() { record("baseline"); return null; },
    async control(type: ControlType, value: number) {
      record("control", type, value);
      return { ok: true, command: `reg 331 := ${value}`, reply: "ACK" } as ControlResponse;
    },
    async previewControl(type: ControlType, value: number) {
      record("previewControl", type, value);
      return { register: 331, rawValue: value, label: "Only PV", currentValue: 1, baselineValue: 1 } as ControlPreview;
    },
    async setLock(locked: boolean) { record("setLock", locked); return { locked }; },
    async recaptureBaseline() {
      record("recaptureBaseline");
      return { deviceId: "dev-1", capturedAt: 1, info: FAKE_SNAPSHOT.info, flags: FAKE_SNAPSHOT.flags } as Baseline;
    },
    async raw(command: string) { record("raw", command); return "201 = 3 (0x0003)"; },
    stats: caps.statsEnabled ? stats : null,
    onSnapshot(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    capabilities() { return caps; },
    close() { record("close"); },
    emitSnapshot(s: Snapshot) { for (const cb of listeners) cb(s); },
    ...overrides,
  };
  return gw;
}
```

- [ ] **Step 2: Написать падающий тест `mcp/src/tools/read.test.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../server";
import { createFakeGateway, FAKE_SNAPSHOT } from "../testing/fake-gateway";
import type { InverterGateway } from "../gateway/types";

async function connect(gateway: InverterGateway) {
  const server = buildMcpServer({ gateway, version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("read tools", () => {
  it("exposes the read tool set", async () => {
    const { client } = await connect(createFakeGateway());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["get_snapshot", "get_settings_diff", "get_alarms", "get_meta", "get_health", "read_registers"])
    );
  });

  it("get_snapshot returns structured data plus a readable summary", async () => {
    const { client } = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_snapshot", arguments: {} });
    const structured = r.structuredContent as { mode: string; status: { batteryCapacity: number } };
    expect(structured.mode).toBe("Battery");
    expect(structured.status.batteryCapacity).toBe(72);
    expect((r.content as Array<{ text: string }>)[0].text).toContain("SOC 72%");
  });

  it("get_snapshot honours the sections filter", async () => {
    const { client } = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_snapshot", arguments: { sections: ["connection"] } });
    const structured = r.structuredContent as Record<string, unknown>;
    expect(structured.connection).toBeDefined();
    expect(structured.status).toBeUndefined();
    expect(structured.settings).toBeUndefined();
  });

  it("get_settings_diff reports drift against the baseline", async () => {
    const gw = createFakeGateway();
    gw.snapshotValue = {
      ...FAKE_SNAPSHOT,
      baseline: {
        deviceId: "dev-1",
        capturedAt: 1,
        info: { ...FAKE_SNAPSHOT.info!, chargerSourcePriority: 1 },
        flags: FAKE_SNAPSHOT.flags,
      },
    };
    const { client } = await connect(gw);
    const r = await client.callTool({ name: "get_settings_diff", arguments: {} });
    const d = r.structuredContent as { driftCount: number; settings: Array<{ key: string; drifted: boolean }> };
    expect(d.driftCount).toBe(1);
    expect(d.settings.find((s) => s.key === "chargerSourcePriority")!.drifted).toBe(true);
  });

  it("get_health surfaces transport, mock flag and snapshot age", async () => {
    const { client } = await connect(createFakeGateway());
    const r = await client.callTool({ name: "get_health", arguments: {} });
    const h = r.structuredContent as { connected: boolean; transport: string; mock: boolean; snapshotAgeMs: number };
    expect(h).toMatchObject({ connected: true, transport: "serial", mock: false });
    expect(typeof h.snapshotAgeMs).toBe("number");
  });

  it("read_registers passes an R command to the gateway", async () => {
    const gw = createFakeGateway();
    const { client } = await connect(gw);
    const r = await client.callTool({ name: "read_registers", arguments: { address: 201, count: 2 } });
    expect(gw.calls).toContainEqual({ method: "raw", args: ["R 201 2"] });
    expect((r.structuredContent as { reply: string }).reply).toContain("201");
  });

  it("reports gateway failures as tool errors instead of throwing", async () => {
    const gw = createFakeGateway({
      snapshot: async () => {
        throw new Error("Inverter service at http://pi:3000 is unreachable: ECONNREFUSED");
      },
    });
    const { client } = await connect(gw);
    const r = await client.callTool({ name: "get_snapshot", arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0].text).toContain("unreachable");
  });
});
```

- [ ] **Step 3: Запустить тест — убедиться, что падает**

Run: `npm test -w mcp -- src/tools/read.test.ts`
Expected: FAIL — модуль `../server` не найден.

- [ ] **Step 4: Реализовать `mcp/src/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InverterGateway } from "./gateway/types";
import { registerReadTools } from "./tools/read";

export interface McpContext {
  gateway: InverterGateway;
  /** Локальный тумблер: скрыть инструменты записи даже у write-токена. */
  readOnly?: boolean;
  version: string;
}

/** Права на запись: роль, скоуп, мастер-выключатель сервиса и локальный тумблер. */
export function canWrite(ctx: McpContext): boolean {
  const caps = ctx.gateway.capabilities();
  return !ctx.readOnly && caps.role === "admin" && caps.scopes.includes("write") && caps.allowControl;
}

export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "inverter-monitor", version: ctx.version },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        logging: {},
      },
      instructions:
        "Local monitoring and control of an ISolar/EASUN SMG II hybrid inverter (SK-5500P-48L) " +
        "over Modbus RTU. Reads are always safe. Writes change battery and charging behaviour: " +
        "preview first, keep one change at a time, and read inverter://docs/control-contract before writing.",
    }
  );

  registerReadTools(server, ctx);
  return server;
}
```

- [ ] **Step 5: Реализовать `mcp/src/tools/read.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { diffSettings } from "@inverter/shared";
import type { McpContext } from "../server";
import { summarizeSnapshot } from "../format";

/** Обёртка: превращает исключение шлюза в ответ isError, а не в обрыв протокола. */
export async function guard<T>(
  fn: () => Promise<{ structuredContent: T; text: string }>
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: T; isError?: boolean }> {
  try {
    const { structuredContent, text } = await fn();
    return { content: [{ type: "text", text }], structuredContent };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  }
}

const SECTIONS = ["connection", "status", "settings", "flags", "warnings", "baseline"] as const;

export function registerReadTools(server: McpServer, ctx: McpContext): void {
  const gw = ctx.gateway;

  server.registerTool(
    "get_snapshot",
    {
      title: "Inverter snapshot",
      description:
        "Current inverter state: connection, live measurements, settings, flags, alarms and the settings baseline. " +
        "Pass `sections` to fetch only what you need.",
      inputSchema: {
        sections: z
          .array(z.enum(SECTIONS))
          .optional()
          .describe("Subset of sections to return; all of them when omitted"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ sections }) =>
      guard(async () => {
        const snap = await gw.snapshot();
        const want = new Set(sections ?? SECTIONS);
        const out: Record<string, unknown> = { timestamp: snap.timestamp, mode: snap.mode, control: snap.control };
        if (want.has("connection")) out.connection = snap.connection;
        if (want.has("status")) out.status = snap.status;
        if (want.has("settings")) out.settings = snap.info;
        if (want.has("flags")) out.flags = snap.flags;
        if (want.has("warnings")) out.warnings = snap.warnings;
        if (want.has("baseline")) out.baseline = snap.baseline;
        return { structuredContent: out, text: summarizeSnapshot(snap, Date.now()) };
      })
  );

  server.registerTool(
    "get_settings_diff",
    {
      title: "Settings vs baseline",
      description:
        "Every inverter setting next to the 'as-found' baseline captured when the device first connected, " +
        "with drifted values flagged.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const snap = await gw.snapshot();
        const d = diffSettings(snap.info, snap.flags, snap.baseline);
        const drifted = [...d.settings.filter((r) => r.drifted), ...d.flags.filter((r) => r.drifted)];
        const text = !snap.info
          ? "Settings have not been read yet."
          : d.driftCount === 0
            ? `All ${d.settings.length} settings match the baseline.`
            : `${d.driftCount} setting(s) drifted from the baseline: ` +
              drifted.map((r) => r.name).join(", ");
        return { structuredContent: d as unknown as Record<string, unknown>, text };
      })
  );

  server.registerTool(
    "get_alarms",
    {
      title: "Active alarms",
      description: "Active fault and warning bits decoded into names (registers 100/101 and 108/109).",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const snap = await gw.snapshot();
        const active = snap.warnings?.active ?? [];
        return {
          structuredContent: { active, raw: snap.warnings?.raw ?? null, count: active.length },
          text: active.length ? `Active alarms: ${active.join(", ")}` : "No active alarms.",
        };
      })
  );

  server.registerTool(
    "get_meta",
    {
      title: "Control metadata",
      description:
        "Allowed values for every control command, whether writes are enabled on the server, and the role/scopes of the current credentials.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const meta = await gw.meta();
        const caps = gw.capabilities();
        const structuredContent = {
          allowControl: meta.allowControl,
          role: caps.role,
          scopes: caps.scopes,
          statsEnabled: caps.statsEnabled,
          outputSourcePriority: meta.outputSourcePriority,
          chargerSourcePriority: meta.chargerSourcePriority,
          maxChargingCurrent: meta.maxChargingCurrent,
          maxAcChargingCurrent: meta.maxAcChargingCurrent,
        };
        return {
          structuredContent,
          text:
            `Role ${caps.role}, scopes [${caps.scopes.join(", ")}]; ` +
            `writes ${meta.allowControl ? "enabled" : "disabled (ALLOW_CONTROL=false)"}.`,
        };
      })
  );

  server.registerTool(
    "get_health",
    {
      title: "Service health",
      description: "Is the service reachable, is the inverter actually connected, which transport is in use and how fresh the data is.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const snap = await gw.snapshot();
        const ageMs = Date.now() - snap.timestamp;
        const h = {
          serviceReachable: true,
          connected: snap.connection.connected,
          transport: snap.connection.transport,
          device: snap.connection.device,
          mock: snap.connection.mock,
          snapshotAgeMs: ageMs,
          lastError: snap.connection.lastError,
          writeLocked: snap.control.locked,
          allowControl: snap.control.allowControl,
        };
        const text = snap.connection.mock
          ? "Service is up, but serving demo data — no inverter attached."
          : snap.connection.connected
            ? `Connected via ${snap.connection.transport} (${snap.connection.device ?? "?"}), data ${Math.round(ageMs / 1000)} s old.`
            : `Service is up, inverter not connected${snap.connection.lastError ? `: ${snap.connection.lastError}` : ""}.`;
        return { structuredContent: h, text };
      })
  );

  server.registerTool(
    "read_registers",
    {
      title: "Read Modbus registers",
      description:
        "Read raw holding registers (Modbus function 0x03). Always safe. See inverter://registers/map for the address list.",
      inputSchema: {
        address: z.number().int().min(0).max(65535).describe("First register address"),
        count: z.number().int().min(1).max(32).default(1).describe("How many consecutive registers to read"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ address, count }) =>
      guard(async () => {
        const reply = await gw.raw(`R ${address} ${count ?? 1}`);
        return { structuredContent: { address, count: count ?? 1, reply }, text: reply };
      })
  );
}
```

- [ ] **Step 6: Запустить тесты**

Run: `npm test -w mcp -- src/tools/read.test.ts`
Expected: PASS (7 тестов).

- [ ] **Step 7: Экспортировать ядро и собрать**

В `mcp/src/index.ts` добавить:

```ts
export { buildMcpServer, canWrite } from "./server";
export type { McpContext } from "./server";
```

Run: `npm run build -w mcp`
Expected: сборка без ошибок.

- [ ] **Step 8: Коммит**

```bash
git add mcp/src/server.ts mcp/src/tools mcp/src/testing mcp/src/index.ts
git commit -m "feat(mcp): ядро сервера и инструменты чтения"
```

---

### Task 7: Инструменты статистики

**Files:**
- Create: `mcp/src/tools/stats.ts`
- Test: `mcp/src/tools/stats.test.ts`
- Modify: `mcp/src/server.ts` (вызов регистрации)

**Interfaces:**
- Consumes: `gateway.stats`, `parseTime`, `parseDay`, `downsample`, `guard` из `tools/read`.
- Produces: `registerStatsTools(server, ctx): void`; инструменты `get_series`, `get_daily`, `get_energy`, `get_events`, `get_solar_window`, `summarize_period`, `export_csv`.

- [ ] **Step 1: Написать падающий тест `mcp/src/tools/stats.test.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../server";
import { createFakeGateway } from "../testing/fake-gateway";
import type { InverterGateway } from "../gateway/types";

async function connect(gateway: InverterGateway) {
  const server = buildMcpServer({ gateway, version: "test" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("stats tools", () => {
  it("registers the stats tool set when statistics are available", async () => {
    const client = await connect(createFakeGateway());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_series", "get_daily", "get_energy", "get_events", "get_solar_window",
        "summarize_period", "export_csv",
      ])
    );
  });

  it("omits every stats tool when statistics are disabled", async () => {
    const client = await connect(createFakeGateway({ stats: null, caps: { statsEnabled: false } } as never));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["get_series", "get_daily", "get_energy", "get_events", "get_solar_window", "summarize_period", "export_csv"]) {
      expect(names).not.toContain(n);
    }
    expect(names).toContain("get_snapshot"); // чтение остаётся
  });

  it("get_series resolves relative time and asks the gateway for the right window", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    await client.callTool({ name: "get_series", arguments: { fields: ["pvPower"], from: "-1h", to: "now" } });

    const call = gw.calls.find((c) => c.method === "series")!;
    const q = call.args[0] as { fields: string[]; from: number; to: number; res: string };
    expect(q.fields).toEqual(["pvPower"]);
    expect(q.to - q.from).toBe(3_600_000);
    expect(q.res).toBe("raw"); // окно ≤ 6 ч
  });

  it("get_series picks minute resolution for long windows and reports downsampling", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ t: i, pvPower: i }));
    const gw = createFakeGateway();
    gw.stats!.series = async () => many;
    const client = await connect(gw);

    const r = await client.callTool({
      name: "get_series",
      arguments: { fields: ["pvPower"], from: "-7d", to: "now", maxPoints: 100 },
    });
    const s = r.structuredContent as { downsampled: boolean; sourcePoints: number; points: unknown[]; res: string };
    expect(s.res).toBe("minute");
    expect(s.downsampled).toBe(true);
    expect(s.sourcePoints).toBe(5000);
    expect(s.points.length).toBeLessThanOrEqual(101);
    expect((r.content as Array<{ text: string }>)[0].text).toContain("downsampled");
  });

  it("get_daily accepts day keywords", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    await client.callTool({ name: "get_daily", arguments: { from: "-1d", to: "today" } });
    const call = gw.calls.find((c) => c.method === "daily")!;
    expect(String(call.args[0])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(call.args[1])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("get_events flags truncation at the limit", async () => {
    const gw = createFakeGateway();
    gw.stats!.events = async () => Array.from({ length: 5 }, (_, i) => ({ id: i, ts: i, type: "mode", detail: "{}" }));
    const client = await connect(gw);
    const r = await client.callTool({ name: "get_events", arguments: { limit: 5 } });
    expect((r.structuredContent as { truncated: boolean }).truncated).toBe(true);
  });

  it("summarize_period aggregates energy, SOC and alarms in one call", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "summarize_period", arguments: { from: "-1d", to: "now" } });
    const s = r.structuredContent as {
      pvKwh: number; loadKwh: number; gridKwh: number; socMin: number | null; socMax: number | null; alarmCount: number;
    };
    expect(s.pvKwh).toBeCloseTo(8);
    expect(s.loadKwh).toBeCloseTo(5);
    expect(s.socMin).toBe(40);
    expect(s.socMax).toBe(100);
    expect(typeof s.alarmCount).toBe("number");
    expect((r.content as Array<{ text: string }>)[0].text).toContain("PV 8");
  });

  it("export_csv returns a resource link instead of the payload", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.callTool({ name: "export_csv", arguments: { from: 1000, to: 2000, res: "minute" } });
    const link = (r.content as Array<{ type: string; uri?: string }>).find((c) => c.type === "resource_link");
    expect(link?.uri).toBe("inverter://stats/export/minute/1000/2000.csv");
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w mcp -- src/tools/stats.test.ts`
Expected: FAIL — инструментов нет в `tools/list`.

- [ ] **Step 3: Реализовать `mcp/src/tools/stats.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server";
import { parseDay, parseTime } from "../time";
import { downsample } from "../downsample";
import { guard } from "./read";

/** Величины, доступные в /api/stats/series (совпадает с GAUGE_FIELDS сервера). */
const GAUGE_FIELDS = [
  "pvPower", "acOutputActivePower", "mainsPower", "batteryPower", "batteryVoltage",
  "batteryCapacity", "gridVoltage", "outputLoadPercent", "dcdcTemperature", "heatSinkTemperature",
] as const;

const SIX_HOURS_MS = 6 * 3_600_000;
const WH_IN_KWH = 1000;

const timeArg = z.union([z.string(), z.number()]);

export function registerStatsTools(server: McpServer, ctx: McpContext): void {
  const stats = ctx.gateway.stats;
  if (!stats) return; // статистика выключена — инструментов просто нет

  server.registerTool(
    "get_series",
    {
      title: "Time series",
      description:
        "Historical series for one or more metrics. Time accepts unix ms, ISO 8601, \"now\" or an offset like \"-24h\". " +
        "Resolution defaults to raw for windows up to 6 hours and per-minute averages beyond that.",
      inputSchema: {
        fields: z.array(z.enum(GAUGE_FIELDS)).min(1).describe("Metrics to fetch"),
        from: timeArg.describe('Window start, e.g. "-24h"'),
        to: timeArg.default("now").describe('Window end, e.g. "now"'),
        res: z.enum(["auto", "raw", "minute"]).default("auto").describe("Sample resolution"),
        maxPoints: z.number().int().min(2).max(5000).default(500).describe("Cap on returned points"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ fields, from, to, res, maxPoints }) =>
      guard(async () => {
        const now = Date.now();
        const f = parseTime(from, now);
        const t = parseTime(to ?? "now", now);
        if (t <= f) throw new Error("`to` must be later than `from`");
        const effective = res && res !== "auto" ? res : t - f <= SIX_HOURS_MS ? "raw" : "minute";
        const rows = await stats.series({ fields: [...fields], from: f, to: t, res: effective });
        const d = downsample(rows, maxPoints ?? 500);
        const text =
          `${d.rows.length} point(s) of ${fields.join(", ")} at ${effective} resolution` +
          (d.downsampled ? ` (downsampled from ${d.sourcePoints})` : "");
        return {
          structuredContent: {
            from: f, to: t, res: effective, fields: [...fields],
            downsampled: d.downsampled, sourcePoints: d.sourcePoints, points: d.rows,
          },
          text,
        };
      })
  );

  server.registerTool(
    "get_daily",
    {
      title: "Daily totals",
      description: 'Per-day energy totals, SOC range and solar window. Days accept YYYY-MM-DD, "today", "yesterday" or "-7d".',
      inputSchema: {
        from: z.string().describe('First day, e.g. "-7d"'),
        to: z.string().default("today").describe("Last day"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to }) =>
      guard(async () => {
        const now = Date.now();
        const rows = await stats.daily(parseDay(from, now), parseDay(to ?? "today", now));
        return {
          structuredContent: { days: rows, count: rows.length },
          text: rows.length ? `${rows.length} day(s) of totals.` : "No data for that range.",
        };
      })
  );

  server.registerTool(
    "get_energy",
    {
      title: "Energy buckets",
      description: "Energy in watt-hours bucketed by hour or day: PV generated, load consumed, taken from the grid, battery charge/discharge.",
      inputSchema: {
        from: timeArg.describe("Window start"),
        to: timeArg.default("now").describe("Window end"),
        bucket: z.enum(["hour", "day"]).default("day").describe("Bucket size"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to, bucket }) =>
      guard(async () => {
        const now = Date.now();
        const f = parseTime(from, now);
        const t = parseTime(to ?? "now", now);
        if (t <= f) throw new Error("`to` must be later than `from`");
        const buckets = await stats.energy(f, t, bucket ?? "day");
        const pv = buckets.reduce((a, b) => a + (b.pv_wh ?? 0), 0);
        return {
          structuredContent: { from: f, to: t, bucket: bucket ?? "day", buckets },
          text: `${buckets.length} bucket(s); PV total ${(pv / WH_IN_KWH).toFixed(2)} kWh.`,
        };
      })
  );

  server.registerTool(
    "get_events",
    {
      title: "Event log",
      description: "Event log: mode changes, grid loss and restore, faults, connectivity and control writes.",
      inputSchema: {
        from: timeArg.optional().describe("Window start"),
        to: timeArg.optional().describe("Window end"),
        type: z.string().optional().describe('Filter by event type, e.g. "control" or "mode"'),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to, type, limit, offset }) =>
      guard(async () => {
        const now = Date.now();
        const lim = limit ?? 100;
        const rows = await stats.events({
          from: from === undefined ? undefined : parseTime(from, now),
          to: to === undefined ? undefined : parseTime(to, now),
          type,
          limit: lim,
          offset: offset ?? 0,
        });
        const truncated = rows.length === lim;
        return {
          structuredContent: { events: rows, count: rows.length, truncated },
          text:
            `${rows.length} event(s)` +
            (truncated ? ` — the limit was reached, raise \`limit\` or page with \`offset\` for more.` : "."),
        };
      })
  );

  server.registerTool(
    "get_solar_window",
    {
      title: "Solar day window",
      description: "When stable PV output started and stopped on a given day; today's window may still be in progress.",
      inputSchema: { day: z.string().default("today").describe('YYYY-MM-DD, "today", "yesterday" or "-3d"') },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ day }) =>
      guard(async () => {
        const w = await stats.solarWindow(parseDay(day ?? "today", Date.now()));
        const hhmm = (ms: number | null) => (ms === null ? "—" : new Date(ms).toLocaleTimeString());
        const text =
          w.state === "idle"
            ? `${w.day}: no stable solar output.`
            : w.state === "active"
              ? `${w.day}: solar running since ${hhmm(w.start)}.`
              : `${w.day}: solar ${hhmm(w.start)} – ${hhmm(w.end)}.`;
        return { structuredContent: w as unknown as Record<string, unknown>, text };
      })
  );

  server.registerTool(
    "summarize_period",
    {
      title: "Period summary",
      description:
        "One-call summary of a period: PV generated, load consumed, taken from the grid, battery charge/discharge, SOC range and alarm events.",
      inputSchema: {
        from: timeArg.default("-1d").describe("Window start"),
        to: timeArg.default("now").describe("Window end"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to }) =>
      guard(async () => {
        const now = Date.now();
        const f = parseTime(from ?? "-1d", now);
        const t = parseTime(to ?? "now", now);
        if (t <= f) throw new Error("`to` must be later than `from`");

        const [days, events] = await Promise.all([
          stats.daily(
            parseDay(new Date(f).toISOString().slice(0, 10), now),
            parseDay(new Date(t).toISOString().slice(0, 10), now)
          ),
          stats.events({ from: f, to: t, limit: 500, offset: 0 }),
        ]);

        const sum = (key: string) => days.reduce((a, d) => a + (Number(d[key]) || 0), 0);
        const socValues = days
          .flatMap((d) => [d.batteryCapacity_min, d.batteryCapacity_max])
          .map(Number)
          .filter((n) => Number.isFinite(n));
        const alarms = events.filter((e) => e.type === "fault" || e.type === "warning");

        const summary = {
          from: f,
          to: t,
          days: days.length,
          pvKwh: sum("pv_wh") / WH_IN_KWH,
          loadKwh: sum("load_wh") / WH_IN_KWH,
          gridKwh: sum("grid_wh") / WH_IN_KWH,
          batteryChargedKwh: sum("batt_charge_wh") / WH_IN_KWH,
          batteryDischargedKwh: sum("batt_discharge_wh") / WH_IN_KWH,
          socMin: socValues.length ? Math.min(...socValues) : null,
          socMax: socValues.length ? Math.max(...socValues) : null,
          eventCount: events.length,
          alarmCount: alarms.length,
          alarmTypes: [...new Set(alarms.map((a) => a.type))],
        };
        const text =
          `${summary.days} day(s): PV ${summary.pvKwh.toFixed(2)} kWh, load ${summary.loadKwh.toFixed(2)} kWh, ` +
          `grid ${summary.gridKwh.toFixed(2)} kWh, battery +${summary.batteryChargedKwh.toFixed(2)}/` +
          `-${summary.batteryDischargedKwh.toFixed(2)} kWh, SOC ${summary.socMin ?? "?"}–${summary.socMax ?? "?"}%, ` +
          `${summary.alarmCount} alarm event(s).`;
        return { structuredContent: summary, text };
      })
  );

  server.registerTool(
    "export_csv",
    {
      title: "Export CSV",
      description:
        "Prepare a CSV export of raw or per-minute samples. Returns a resource link — read that resource to get the file, " +
        "so the data does not land in the conversation unless you ask for it.",
      inputSchema: {
        from: timeArg.describe("Window start"),
        to: timeArg.default("now").describe("Window end"),
        res: z.enum(["raw", "minute"]).default("minute").describe("Sample resolution"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ from, to, res }) => {
      try {
        const now = Date.now();
        const f = parseTime(from, now);
        const t = parseTime(to ?? "now", now);
        if (t <= f) throw new Error("`to` must be later than `from`");
        const kind = res ?? "minute";
        const uri = `inverter://stats/export/${kind}/${f}/${t}.csv`;
        return {
          content: [
            { type: "text" as const, text: `CSV export ready at ${uri} — read that resource to fetch it.` },
            { type: "resource_link" as const, uri, name: `stats-${kind}-${f}-${t}.csv`, mimeType: "text/csv" },
          ],
          structuredContent: { uri, from: f, to: t, res: kind },
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
```

- [ ] **Step 4: Подключить в `mcp/src/server.ts`**

```ts
import { registerStatsTools } from "./tools/stats";
```
и после `registerReadTools(server, ctx);` добавить `registerStatsTools(server, ctx);`

- [ ] **Step 5: Запустить тесты**

Run: `npm test -w mcp`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add mcp/src/tools/stats.ts mcp/src/tools/stats.test.ts mcp/src/server.ts
git commit -m "feat(mcp): инструменты статистики"
```

---

### Task 8: Инструменты записи и видимость по правам

**Files:**
- Create: `mcp/src/tools/control.ts`
- Test: `mcp/src/tools/control.test.ts`
- Modify: `mcp/src/server.ts`

**Interfaces:**
- Consumes: `canWrite(ctx)`, `gateway.control/previewControl/setLock/recaptureBaseline/raw`.
- Produces: `registerControlTools(server, ctx): void`; инструменты `set_control`, `set_lock`, `recapture_baseline`, `write_register`.

- [ ] **Step 1: Написать падающий тест `mcp/src/tools/control.test.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../server";
import { createFakeGateway } from "../testing/fake-gateway";
import type { InverterGateway } from "../gateway/types";

const WRITE_TOOLS = ["set_control", "set_lock", "recapture_baseline", "write_register"];

async function connect(gateway: InverterGateway, readOnly = false) {
  const server = buildMcpServer({ gateway, version: "test", readOnly });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name);
}

describe("control tools visibility", () => {
  it("exposes write tools to an admin token with the write scope", async () => {
    const names = await toolNames(await connect(createFakeGateway()));
    expect(names).toEqual(expect.arrayContaining(WRITE_TOOLS));
  });

  it("hides write tools from a viewer", async () => {
    const client = await connect(createFakeGateway({ caps: { role: "viewer", scopes: ["read"] } } as never));
    const names = await toolNames(client);
    for (const n of WRITE_TOOLS) expect(names).not.toContain(n);
    expect(names).toContain("get_snapshot");
  });

  it("hides write tools from an admin token without the write scope", async () => {
    const client = await connect(createFakeGateway({ caps: { scopes: ["read"] } } as never));
    for (const n of WRITE_TOOLS) expect(await toolNames(client)).not.toContain(n);
  });

  it("hides write tools when ALLOW_CONTROL is off on the server", async () => {
    const client = await connect(createFakeGateway({ caps: { allowControl: false } } as never));
    for (const n of WRITE_TOOLS) expect(await toolNames(client)).not.toContain(n);
  });

  it("hides write tools when the local read-only switch is on", async () => {
    const client = await connect(createFakeGateway(), true);
    for (const n of WRITE_TOOLS) expect(await toolNames(client)).not.toContain(n);
  });
});

describe("control tools behaviour", () => {
  it("set_control with preview does not write", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    const r = await client.callTool({
      name: "set_control",
      arguments: { type: "chargerSourcePriority", value: 3, preview: true },
    });
    expect(gw.calls.some((c) => c.method === "control")).toBe(false);
    expect(gw.calls).toContainEqual({ method: "previewControl", args: ["chargerSourcePriority", 3] });
    expect((r.structuredContent as { preview: boolean; register: number }).register).toBe(331);
    expect((r.content as Array<{ text: string }>)[0].text).toContain("Nothing was written");
  });

  it("set_control writes when not previewing", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    const r = await client.callTool({ name: "set_control", arguments: { type: "chargerSourcePriority", value: 3 } });
    expect(gw.calls).toContainEqual({ method: "control", args: ["chargerSourcePriority", 3] });
    expect((r.structuredContent as { ok: boolean }).ok).toBe(true);
  });

  it("turns a locked-inverter error into a hint about set_lock", async () => {
    const gw = createFakeGateway({
      control: async () => {
        throw new Error("Settings are locked (read-only). Unlock control before writing.");
      },
    });
    const client = await connect(gw);
    const r = await client.callTool({ name: "set_control", arguments: { type: "chargerSourcePriority", value: 3 } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0].text).toContain("set_lock");
  });

  it("set_lock toggles the write lock", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    const r = await client.callTool({ name: "set_lock", arguments: { locked: false } });
    expect(gw.calls).toContainEqual({ method: "setLock", args: [false] });
    expect((r.structuredContent as { locked: boolean }).locked).toBe(false);
  });

  it("write_register previews by reading the current value", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    const r = await client.callTool({ name: "write_register", arguments: { address: 331, value: 3, preview: true } });
    expect(gw.calls).toContainEqual({ method: "raw", args: ["R 331 1"] });
    expect(gw.calls.some((c) => c.method === "raw" && String(c.args[0]).startsWith("W"))).toBe(false);
    expect((r.structuredContent as { preview: boolean }).preview).toBe(true);
  });

  it("write_register writes a raw value", async () => {
    const gw = createFakeGateway();
    const client = await connect(gw);
    await client.callTool({ name: "write_register", arguments: { address: 331, value: 3 } });
    expect(gw.calls).toContainEqual({ method: "raw", args: ["W 331 3"] });
  });

  it("marks write tools as destructive in their annotations", async () => {
    const client = await connect(createFakeGateway());
    const tools = (await client.listTools()).tools;
    const setControl = tools.find((t) => t.name === "set_control")!;
    expect(setControl.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w mcp -- src/tools/control.test.ts`
Expected: FAIL — write-инструментов нет.

- [ ] **Step 3: Реализовать `mcp/src/tools/control.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ControlType } from "@inverter/shared";
import { canWrite, type McpContext } from "../server";
import { guard } from "./read";

const CONTROL_TYPES = [
  "outputSourcePriority",
  "chargerSourcePriority",
  "maxChargingCurrent",
  "maxAcChargingCurrent",
  "batteryRechargeVoltage",
  "batteryRedischargeVoltage",
] as const;

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;

/** Ошибку блокировки превращаем в подсказку — агент иначе не догадается про set_lock. */
function explain(e: Error): string {
  const msg = e.message;
  if (/locked/i.test(msg)) {
    return `${msg} Call set_lock with locked=false first; the lock re-engages automatically after a successful write.`;
  }
  return msg;
}

async function guardWrite<T>(
  fn: () => Promise<{ structuredContent: T; text: string }>
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: T; isError?: boolean }> {
  try {
    const { structuredContent, text } = await fn();
    return { content: [{ type: "text", text }], structuredContent };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${explain(e as Error)}` }], isError: true };
  }
}

export function registerControlTools(server: McpServer, ctx: McpContext): void {
  if (!canWrite(ctx)) return; // без прав инструменты записи не существуют
  const gw = ctx.gateway;

  server.registerTool(
    "set_control",
    {
      title: "Change a setting",
      description:
        "Write one whitelisted setting to the inverter. Use preview=true first to see the register, the raw value and " +
        "the current one. Changing charging currents and voltage thresholds affects battery health — change one thing at a time.",
      inputSchema: {
        type: z.enum(CONTROL_TYPES).describe("Which setting to change"),
        value: z.number().describe("New value in human units (A, V or the code from get_meta)"),
        preview: z.boolean().default(false).describe("Show what would be written without writing"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ type, value, preview }) =>
      guardWrite(async () => {
        if (preview) {
          const p = await gw.previewControl(type as ControlType, value);
          return {
            structuredContent: { preview: true, type, value, ...p },
            text:
              `Would write register ${p.register} := ${p.rawValue} (${p.label}); ` +
              `current ${p.currentValue ?? "?"}, baseline ${p.baselineValue ?? "?"}. Nothing was written.`,
          };
        }
        const r = await gw.control(type as ControlType, value);
        return {
          structuredContent: { preview: false, ok: r.ok, command: r.command ?? null, reply: r.reply ?? null },
          text: `Wrote ${type} = ${value}. ${r.command ?? ""} ${r.reply ?? ""}`.trim(),
        };
      })
  );

  server.registerTool(
    "set_lock",
    {
      title: "Write lock",
      description:
        "Engage or release the write lock. The service starts locked and re-locks after every successful write (AUTO_RELOCK).",
      inputSchema: { locked: z.boolean().describe("true = read-only, false = writes allowed") },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ locked }) =>
      guardWrite(async () => {
        const r = await gw.setLock(locked);
        return {
          structuredContent: r,
          text: r.locked ? "Write lock engaged — the inverter is read-only." : "Write lock released — writes are allowed.",
        };
      })
  );

  server.registerTool(
    "recapture_baseline",
    {
      title: "Recapture baseline",
      description:
        "Re-read all settings and overwrite the stored 'as-found' baseline. Does not change the inverter, but the previous baseline is lost.",
      annotations: WRITE_ANNOTATIONS,
    },
    async () =>
      guardWrite(async () => {
        const b = await gw.recaptureBaseline();
        return {
          structuredContent: b as unknown as Record<string, unknown>,
          text: `Baseline recaptured for device ${b.deviceId} at ${new Date(b.capturedAt).toISOString()}.`,
        };
      })
  );

  server.registerTool(
    "write_register",
    {
      title: "Write a raw register",
      description:
        "Write a raw value to a Modbus register (function 0x10). No whitelist beyond the service's own gates — " +
        "prefer set_control. Use preview=true to see the current value first. See inverter://registers/map.",
      inputSchema: {
        address: z.number().int().min(0).max(65535).describe("Register address"),
        value: z.number().int().min(0).max(65535).describe("Raw value as stored in the register (mind the scale)"),
        preview: z.boolean().default(false).describe("Read the current value instead of writing"),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ address, value, preview }) =>
      guardWrite(async () => {
        if (preview) {
          const current = await gw.raw(`R ${address} 1`);
          return {
            structuredContent: { preview: true, address, value, current },
            text: `Register ${address} currently reads:\n${current}\nWould write ${value}. Nothing was written.`,
          };
        }
        const reply = await gw.raw(`W ${address} ${value}`);
        return { structuredContent: { preview: false, address, value, reply }, text: reply };
      })
  );
}
```

- [ ] **Step 4: Подключить в `mcp/src/server.ts`**

```ts
import { registerControlTools } from "./tools/control";
```
и после `registerStatsTools(server, ctx);` добавить `registerControlTools(server, ctx);`

- [ ] **Step 5: Запустить тесты**

Run: `npm test -w mcp`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add mcp/src/tools/control.ts mcp/src/tools/control.test.ts mcp/src/server.ts
git commit -m "feat(mcp): инструменты записи под гейтами прав"
```

---

### Task 9: Ресурсы и подписка на снапшот

**Files:**
- Create: `mcp/src/resources.ts`
- Test: `mcp/src/resources.test.ts`
- Modify: `mcp/src/server.ts`

**Interfaces:**
- Consumes: `gateway.snapshot/baseline/stats`, `REGISTER_DOCS`, `registerDocsMarkdown`, карты значений из `@inverter/shared`.
- Produces: `registerResources(server, ctx): () => void` (возвращает функцию остановки подписки); ресурсы `inverter://snapshot`, `settings`, `baseline`, `alarms`, `events/recent`, `registers/map`, `docs/control-contract`, шаблоны `stats/daily/{day}` и `stats/export/{res}/{from}/{to}.csv`.

- [ ] **Step 1: Написать падающий тест `mcp/src/resources.test.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "./server";
import { createFakeGateway, FAKE_SNAPSHOT } from "./testing/fake-gateway";
import type { InverterGateway } from "./gateway/types";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

async function connect(gateway: InverterGateway) {
  const server = buildMcpServer({ gateway, version: "test" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

describe("resources", () => {
  it("lists the static resources", async () => {
    const { client } = await connect(createFakeGateway());
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        "inverter://snapshot",
        "inverter://settings",
        "inverter://baseline",
        "inverter://alarms",
        "inverter://events/recent",
        "inverter://registers/map",
        "inverter://docs/control-contract",
      ])
    );
  });

  it("reads the snapshot resource as JSON", async () => {
    const { client } = await connect(createFakeGateway());
    const r = await client.readResource({ uri: "inverter://snapshot" });
    expect(r.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(String(r.contents[0].text)).mode).toBe("Battery");
  });

  it("renders the register map as markdown with real addresses", async () => {
    const { client } = await connect(createFakeGateway());
    const r = await client.readResource({ uri: "inverter://registers/map" });
    expect(r.contents[0].mimeType).toBe("text/markdown");
    const text = String(r.contents[0].text);
    expect(text).toContain("| 202 |");
    expect(text).toContain("gridVoltage");
  });

  it("documents the control contract with allowed values and warnings", async () => {
    const { client } = await connect(createFakeGateway());
    const text = String((await client.readResource({ uri: "inverter://docs/control-contract" })).contents[0].text);
    expect(text).toContain("chargerSourcePriority");
    expect(text).toContain("331");
    expect(text).toMatch(/battery/i);
  });

  it("omits stats-backed resources when statistics are disabled", async () => {
    const { client } = await connect(createFakeGateway({ stats: null, caps: { statsEnabled: false } } as never));
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).not.toContain("inverter://events/recent");
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toEqual([]);
  });

  it("serves the daily template", async () => {
    const gw = createFakeGateway();
    const { client } = await connect(gw);
    const r = await client.readResource({ uri: "inverter://stats/daily/2026-07-26" });
    expect(JSON.parse(String(r.contents[0].text))).toHaveLength(1);
    expect(gw.calls).toContainEqual({ method: "daily", args: ["2026-07-26", "2026-07-26"] });
  });

  it("serves the CSV export template", async () => {
    const { client } = await connect(createFakeGateway());
    const r = await client.readResource({ uri: "inverter://stats/export/minute/1000/2000.csv" });
    expect(r.contents[0].mimeType).toBe("text/csv");
    expect(String(r.contents[0].text)).toContain("ts,mode");
  });

  it("advertises subscribe support and notifies on new snapshots", async () => {
    const gw = createFakeGateway();
    const { client } = await connect(gw);
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);

    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });

    await client.subscribeResource({ uri: "inverter://snapshot" });
    gw.emitSnapshot({ ...FAKE_SNAPSHOT, timestamp: Date.now() });
    await new Promise((r) => setTimeout(r, 50));
    expect(updates).toContain("inverter://snapshot");

    await client.unsubscribeResource({ uri: "inverter://snapshot" });
    updates.length = 0;
    gw.emitSnapshot({ ...FAKE_SNAPSHOT, timestamp: Date.now() });
    await new Promise((r) => setTimeout(r, 50));
    expect(updates).toEqual([]);
  });

  it("throttles snapshot notifications to one per interval", async () => {
    const gw = createFakeGateway();
    const { client } = await connect(gw);
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => updates.push(n.params.uri));

    await client.subscribeResource({ uri: "inverter://snapshot" });
    for (let i = 0; i < 5; i++) gw.emitSnapshot({ ...FAKE_SNAPSHOT, timestamp: Date.now() + i });
    await new Promise((r) => setTimeout(r, 50));
    expect(updates).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w mcp -- src/resources.test.ts`
Expected: FAIL — список ресурсов пуст.

- [ ] **Step 3: Реализовать `mcp/src/resources.ts`**

```ts
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ALLOWED_MAX_AC_CHARGE_CURRENT,
  ALLOWED_MAX_CHARGE_CURRENT,
  CHARGER_SOURCE_PRIORITY,
  OUTPUT_SOURCE_PRIORITY,
  REGISTER_DOCS,
  registerDocsMarkdown,
} from "@inverter/shared";
import type { McpContext } from "./server";

const SNAPSHOT_URI = "inverter://snapshot";
/** Поллер ходит раз в 5 с; чаще уведомлять бессмысленно. */
const NOTIFY_INTERVAL_MS = 5000;
const RECENT_EVENTS = 100;

const json = (uri: string, value: unknown) => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
});

function controlContractMarkdown(): string {
  const enumRows = (map: Record<number, string>) =>
    Object.entries(map).map(([k, v]) => `  - \`${k}\` — ${v}`).join("\n");
  const reg = (key: string) => REGISTER_DOCS.find((d) => d.key === key)?.addr ?? "?";

  return [
    "# Control contract",
    "",
    "Only these settings can be written through `set_control`. Every write goes through the",
    "service whitelist, needs the write lock released, and re-locks afterwards.",
    "",
    `## outputSourcePriority (register ${reg("outputSourcePriority")})`,
    "Which source powers the load first.",
    enumRows(OUTPUT_SOURCE_PRIORITY),
    "",
    `## chargerSourcePriority (register ${reg("chargerSourcePriority")})`,
    "Where charging energy comes from.",
    enumRows(CHARGER_SOURCE_PRIORITY),
    "",
    `## maxChargingCurrent (register ${reg("maxChargingCurrent")}, amps)`,
    `Allowed values: ${ALLOWED_MAX_CHARGE_CURRENT.join(", ")}.`,
    "Too high a current for the battery bank shortens its life — match the battery datasheet.",
    "",
    `## maxAcChargingCurrent (register ${reg("maxAcChargingCurrent")}, amps)`,
    `Allowed values: ${ALLOWED_MAX_AC_CHARGE_CURRENT.join(", ")}.`,
    "Bounded by the grid connection as well as the battery.",
    "",
    `## batteryRechargeVoltage (register ${reg("batteryRechargeVoltage")}, volts)`,
    "Voltage at which the inverter switches the load back to the grid. Setting it too low",
    "deep-discharges the battery; too high keeps the system on the grid permanently.",
    "",
    `## batteryRedischargeVoltage (register ${reg("batteryRedischargeVoltage")}, volts)`,
    "Voltage at which the inverter returns to battery power. Keep a sensible gap from",
    "batteryRechargeVoltage, otherwise the system oscillates between grid and battery.",
    "",
    "## Safety rules",
    "",
    "- Preview first (`set_control` with `preview: true`).",
    "- Change one parameter at a time and verify with `get_snapshot`.",
    "- For lithium banks the SOC thresholds (registers 341–343) matter more than voltages;",
    "  they are read-only here — change them on the inverter's own panel.",
    "- `write_register` bypasses the value whitelist. Use it only for registers you have",
    "  looked up in `inverter://registers/map`.",
    "",
  ].join("\n");
}

/** Регистрирует ресурсы и подписки; возвращает функцию остановки. */
export function registerResources(server: McpServer, ctx: McpContext): () => void {
  const gw = ctx.gateway;

  server.registerResource(
    "snapshot",
    SNAPSHOT_URI,
    {
      title: "Live snapshot",
      description: "Full inverter state, updated on every poll. Subscribe to be notified about changes.",
      mimeType: "application/json",
    },
    async () => json(SNAPSHOT_URI, await gw.snapshot())
  );

  server.registerResource(
    "settings",
    "inverter://settings",
    { title: "Current settings", description: "Settings and function flags as currently read from the inverter.", mimeType: "application/json" },
    async () => {
      const s = await gw.snapshot();
      return json("inverter://settings", { info: s.info, flags: s.flags });
    }
  );

  server.registerResource(
    "baseline",
    "inverter://baseline",
    { title: "Settings baseline", description: "The 'as-found' settings captured when the device first connected.", mimeType: "application/json" },
    async () => json("inverter://baseline", await gw.baseline())
  );

  server.registerResource(
    "alarms",
    "inverter://alarms",
    { title: "Active alarms", description: "Decoded fault and warning bits.", mimeType: "application/json" },
    async () => {
      const s = await gw.snapshot();
      return json("inverter://alarms", s.warnings ?? { active: [], raw: null });
    }
  );

  server.registerResource(
    "registers-map",
    "inverter://registers/map",
    { title: "SMG II register map", description: "Addresses, units, scales and access for every documented register.", mimeType: "text/markdown" },
    async () => ({
      contents: [{ uri: "inverter://registers/map", mimeType: "text/markdown", text: registerDocsMarkdown() }],
    })
  );

  server.registerResource(
    "control-contract",
    "inverter://docs/control-contract",
    { title: "Control contract", description: "What can be written, allowed values and why each setting is risky.", mimeType: "text/markdown" },
    async () => ({
      contents: [{ uri: "inverter://docs/control-contract", mimeType: "text/markdown", text: controlContractMarkdown() }],
    })
  );

  const stats = gw.stats;
  if (stats) {
    server.registerResource(
      "recent-events",
      "inverter://events/recent",
      { title: "Recent events", description: `Last ${RECENT_EVENTS} events from the log.`, mimeType: "application/json" },
      async () => json("inverter://events/recent", await stats.events({ limit: RECENT_EVENTS, offset: 0 }))
    );

    server.registerResource(
      "daily",
      new ResourceTemplate("inverter://stats/daily/{day}", { list: undefined }),
      { title: "Daily totals", description: "Totals for one day (YYYY-MM-DD).", mimeType: "application/json" },
      async (uri, { day }) => json(uri.href, await stats.daily(String(day), String(day)))
    );

    server.registerResource(
      "export",
      new ResourceTemplate("inverter://stats/export/{res}/{from}/{to}.csv", { list: undefined }),
      { title: "CSV export", description: "Raw or per-minute samples as CSV, capped at 5 MB.", mimeType: "text/csv" },
      async (uri, { res, from, to }) => {
        const kind = String(res) === "raw" ? ("raw" as const) : ("minute" as const);
        const r = await stats.exportCsv({ from: Number(from), to: Number(to), res: kind });
        if (r.truncated) {
          throw new Error(
            "Export exceeds the 5 MB limit — narrow the time range or use res=minute."
          );
        }
        return { contents: [{ uri: uri.href, mimeType: "text/csv", text: r.csv }] };
      }
    );
  }

  // --- Подписки: McpServer их не обрабатывает, вешаем сами на низкоуровневый сервер ---
  const subscribers = new Set<string>();
  let unsubscribeGateway: (() => void) | null = null;
  let lastNotifiedAt = 0;

  const startFeed = () => {
    if (unsubscribeGateway) return;
    unsubscribeGateway = gw.onSnapshot(() => {
      const now = Date.now();
      if (now - lastNotifiedAt < NOTIFY_INTERVAL_MS) return;
      lastNotifiedAt = now;
      if (subscribers.has(SNAPSHOT_URI)) {
        void server.server.sendResourceUpdated({ uri: SNAPSHOT_URI }).catch(() => undefined);
      }
    });
  };

  const stopFeed = () => {
    unsubscribeGateway?.();
    unsubscribeGateway = null;
  };

  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    subscribers.add(params.uri);
    if (params.uri === SNAPSHOT_URI) startFeed();
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    subscribers.delete(params.uri);
    if (!subscribers.has(SNAPSHOT_URI)) stopFeed();
    return {};
  });

  return () => {
    subscribers.clear();
    stopFeed();
  };
}
```

- [ ] **Step 4: Подключить в `mcp/src/server.ts`**

Импортировать `registerResources` и сохранить функцию остановки на самом сервере, чтобы транспорты могли её вызвать:

```ts
import { registerResources } from "./resources";

export function buildMcpServer(ctx: McpContext): McpServer {
  // …создание server, registerReadTools, registerStatsTools, registerControlTools…
  const stopResources = registerResources(server, ctx);
  const prevClose = server.close.bind(server);
  server.close = async () => {
    stopResources();
    await prevClose();
  };
  return server;
}
```

- [ ] **Step 5: Запустить тесты**

Run: `npm test -w mcp -- src/resources.test.ts`
Expected: PASS (9 тестов).

- [ ] **Step 6: Коммит**

```bash
git add mcp/src/resources.ts mcp/src/resources.test.ts mcp/src/server.ts
git commit -m "feat(mcp): ресурсы, документация регистров и подписка на снапшот"
```

---

### Task 10: Промпты и completions

**Files:**
- Create: `mcp/src/prompts.ts`
- Test: `mcp/src/prompts.test.ts`
- Modify: `mcp/src/server.ts`

**Interfaces:**
- Consumes: `gateway.stats.daily`, `parseDay`, `completable` из SDK.
- Produces: `registerPrompts(server, ctx): void`; промпты `diagnose-connection`, `daily-report`, `battery-health-check`, `plan-setting-change`.

- [ ] **Step 1: Написать падающий тест `mcp/src/prompts.test.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "./server";
import { createFakeGateway } from "./testing/fake-gateway";
import type { InverterGateway } from "./gateway/types";

async function connect(gateway: InverterGateway, readOnly = false) {
  const server = buildMcpServer({ gateway, version: "test", readOnly });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("prompts", () => {
  it("lists the prompt set", async () => {
    const client = await connect(createFakeGateway());
    const names = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(["diagnose-connection", "daily-report", "battery-health-check", "plan-setting-change"])
    );
  });

  it("diagnose-connection walks through the hardware checklist", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.getPrompt({ name: "diagnose-connection", arguments: {} });
    const text = r.messages.map((m) => (m.content as { text: string }).text).join("\n");
    expect(text).toContain("get_health");
    expect(text).toMatch(/Modbus ID/i);
    expect(text).toMatch(/RS232/i);
  });

  it("daily-report resolves the day argument", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.getPrompt({ name: "daily-report", arguments: { day: "2026-07-26" } });
    const text = r.messages.map((m) => (m.content as { text: string }).text).join("\n");
    expect(text).toContain("2026-07-26");
    expect(text).toContain("get_daily");
  });

  it("completes the day argument from available days", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.complete({
      ref: { type: "ref/prompt", name: "daily-report" },
      argument: { name: "day", value: "2026" },
    });
    expect(r.completion.values).toContain("2026-07-26");
  });

  it("completes the setting type argument", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.complete({
      ref: { type: "ref/prompt", name: "plan-setting-change" },
      argument: { name: "type", value: "charger" },
    });
    expect(r.completion.values).toEqual(["chargerSourcePriority"]);
  });

  it("plan-setting-change refuses to write and says so", async () => {
    const client = await connect(createFakeGateway());
    const r = await client.getPrompt({ name: "plan-setting-change", arguments: { type: "maxChargingCurrent" } });
    const text = r.messages.map((m) => (m.content as { text: string }).text).join("\n");
    expect(text).toContain("maxChargingCurrent");
    expect(text).toMatch(/do not write|without writing/i);
  });

  it("omits daily-report when statistics are unavailable", async () => {
    const client = await connect(createFakeGateway({ stats: null, caps: { statsEnabled: false } } as never));
    const names = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(names).not.toContain("daily-report");
    expect(names).toContain("diagnose-connection");
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w mcp -- src/prompts.test.ts`
Expected: FAIL — промптов нет.

- [ ] **Step 3: Реализовать `mcp/src/prompts.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpContext } from "./server";
import { parseDay } from "./time";

const CONTROL_TYPES = [
  "outputSourcePriority",
  "chargerSourcePriority",
  "maxChargingCurrent",
  "maxAcChargingCurrent",
  "batteryRechargeVoltage",
  "batteryRedischargeVoltage",
];

const user = (text: string) => ({ role: "user" as const, content: { type: "text" as const, text } });

export function registerPrompts(server: McpServer, ctx: McpContext): void {
  const gw = ctx.gateway;

  server.registerPrompt(
    "diagnose-connection",
    {
      title: "Diagnose the inverter link",
      description: "Systematic check when the dashboard shows demo data or no connection.",
    },
    () => ({
      messages: [
        user(
          [
            "Diagnose why the inverter monitor is not talking to the inverter. Work through this checklist and",
            "report findings with the evidence you gathered:",
            "",
            "1. Call `get_health`. Note `transport`, `mock`, `connected`, `snapshotAgeMs` and `lastError`.",
            "2. If `mock` is true, the service found no serial device: the USB-RS232 adapter is missing, not permitted",
            "   (user must be in the `dialout` group), or filtered out because it is an onboard Pi UART.",
            "3. If a serial device is present but every request times out, the likely causes in order are:",
            "   wrong Modbus ID (inverter menu setting #25 must match MODBUS_SLAVE_ID, default 1),",
            "   wrong baud rate (this inverter answers only at 9600), or the stock SmartESS dongle still occupying the port.",
            "4. If replies arrive but CRC fails, suspect cabling: RJ45 crimp, the DB9 junction, or interference.",
            "5. Remember the hardware trap: cheap CH340 'USB-RS232' dongles are actually USB-TTL (0/3.3 V) and are",
            "   physically incompatible — the port opens and the line stays silent. A working adapter idles at −5…−12 V",
            "   on TX (DB9 pin 3) and needs a real RS232 level shifter (FTDI FT231X is verified working).",
            "6. Try `read_registers` with address 201, count 1 — register 201 is the device mode and is the cheapest probe.",
            "",
            "Do not write anything to the inverter while diagnosing.",
          ].join("\n")
        ),
      ],
    })
  );

  if (gw.stats) {
    server.registerPrompt(
      "daily-report",
      {
        title: "Daily report",
        description: "Summarize one day: generation, consumption, grid dependence, solar window and events.",
        argsSchema: {
          day: completable(
            z.string().describe('Day as YYYY-MM-DD, "today", "yesterday" or "-3d"'),
            async (value) => {
              try {
                const rows = await gw.stats!.daily(parseDay("-30d", Date.now()), parseDay("today", Date.now()));
                return rows
                  .map((r) => String(r.day))
                  .filter((d) => d.startsWith(String(value ?? "")))
                  .slice(0, 30);
              } catch {
                return [];
              }
            }
          ),
        },
      },
      ({ day }) => ({
        messages: [
          user(
            [
              `Produce a report for ${day}.`,
              "",
              `1. \`get_daily\` with from=${day} and to=${day} for the energy totals and SOC range.`,
              `2. \`get_solar_window\` with day=${day} for when solar output started and stopped.`,
              `3. \`get_events\` for that day to catch mode changes, grid loss and alarms.`,
              "4. Optionally `get_series` for pvPower and acOutputActivePower to describe the shape of the day.",
              "",
              "Report: how much solar was generated, how much the load consumed, how much came from the grid,",
              "how deep the battery was cycled, and anything unusual. Numbers in kWh with two decimals.",
            ].join("\n")
          ),
        ],
      })
    );
  }

  server.registerPrompt(
    "battery-health-check",
    {
      title: "Battery health check",
      description: "Compare live battery behaviour against the configured thresholds and the battery type.",
    },
    () => ({
      messages: [
        user(
          [
            "Assess the battery configuration and behaviour.",
            "",
            "1. `get_snapshot` — battery voltage, current, SOC, power, and the configured battery type.",
            "2. `get_settings_diff` — check the voltage thresholds and SOC thresholds against the baseline.",
            "3. `get_series` for batteryCapacity and batteryVoltage over the last 7 days at minute resolution.",
            "",
            "Then check for these specific problems and say which apply:",
            "- SOC repeatedly dropping to or below socLowCutoff (deep cycling shortens lithium life).",
            "- batteryRechargeVoltage and batteryRedischargeVoltage too close together (the system will oscillate",
            "  between grid and battery).",
            "- batteryUnderVoltage set below what the pack's BMS allows.",
            "- maxChargingCurrent far above what the bank is rated for.",
            "- For lithium types (Li1…Li4, Lib) the SOC thresholds govern switching, not the voltage ones —",
            "  say which set is actually in charge.",
            "",
            "Report findings and recommendations. Do not change anything.",
          ].join("\n")
        ),
      ],
    })
  );

  server.registerPrompt(
    "plan-setting-change",
    {
      title: "Plan a setting change",
      description: "Work out — without writing — what changing one setting would do.",
      argsSchema: {
        type: completable(z.string().describe("Which setting to plan a change for"), (value) =>
          CONTROL_TYPES.filter((t) => t.startsWith(String(value ?? "")))
        ),
      },
    },
    ({ type }) => ({
      messages: [
        user(
          [
            `Plan a change to \`${type}\`. Do not write anything — this is analysis only.`,
            "",
            "1. Read `inverter://docs/control-contract` for the allowed values and the risk of this setting.",
            "2. `get_snapshot` and `get_settings_diff` for the current value and how it compares to the baseline.",
            "3. `get_meta` for the exact set of values the service will accept.",
            "4. `set_control` with `preview: true` for the candidate value — it shows the register and raw value",
            "   without writing.",
            "",
            "Then explain: what the current value does, what the new value would do, what could go wrong,",
            "and the exact steps to apply it safely (release the lock, write one value, verify, the lock re-engages).",
          ].join("\n")
        ),
      ],
    })
  );
}
```

- [ ] **Step 4: Подключить в `mcp/src/server.ts`**

```ts
import { registerPrompts } from "./prompts";
```
и вызвать `registerPrompts(server, ctx);` после регистрации инструментов, до `registerResources`.

- [ ] **Step 5: Запустить тесты**

Run: `npm test -w mcp`
Expected: PASS всё.

- [ ] **Step 6: Коммит**

```bash
git add mcp/src/prompts.ts mcp/src/prompts.test.ts mcp/src/server.ts
git commit -m "feat(mcp): промпты-сценарии и completions"
```

---

### Task 11: stdio-вход `inverter-mcp`

**Files:**
- Create: `mcp/src/config.ts`, `mcp/src/bin/stdio.ts`
- Test: `mcp/src/config.test.ts`
- Modify: `mcp/src/index.ts`

**Interfaces:**
- Consumes: `createHttpGateway`, `buildMcpServer`, `StdioServerTransport`.
- Produces: `loadStdioConfig(env): StdioConfig`; исполняемый `mcp/dist/bin/stdio.js`.

- [ ] **Step 1: Написать падающий тест `mcp/src/config.test.ts`**

```ts
import { loadStdioConfig } from "./config";

describe("loadStdioConfig", () => {
  it("requires a token", () => {
    expect(() => loadStdioConfig({})).toThrow(/INVERTER_MCP_TOKEN/);
  });

  it("falls back to localhost and sane defaults", () => {
    const c = loadStdioConfig({ INVERTER_MCP_TOKEN: "inv_x" });
    expect(c).toEqual({
      baseUrl: "http://localhost:3000",
      token: "inv_x",
      timeoutMs: 10_000,
      readOnly: false,
    });
  });

  it("reads every override", () => {
    const c = loadStdioConfig({
      INVERTER_MCP_TOKEN: "inv_x",
      INVERTER_MCP_URL: "http://192.168.1.112:3000/",
      INVERTER_MCP_TIMEOUT_MS: "2500",
      INVERTER_MCP_READ_ONLY: "true",
    });
    expect(c).toEqual({
      baseUrl: "http://192.168.1.112:3000/",
      token: "inv_x",
      timeoutMs: 2500,
      readOnly: true,
    });
  });

  it("ignores a non-numeric timeout", () => {
    const c = loadStdioConfig({ INVERTER_MCP_TOKEN: "inv_x", INVERTER_MCP_TIMEOUT_MS: "soon" });
    expect(c.timeoutMs).toBe(10_000);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w mcp -- src/config.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `mcp/src/config.ts`**

```ts
export interface StdioConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  readOnly: boolean;
}

/** Конфигурация stdio-входа целиком из env — как и у сервера. */
export function loadStdioConfig(env: NodeJS.ProcessEnv): StdioConfig {
  const token = env.INVERTER_MCP_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "INVERTER_MCP_TOKEN is required. Issue one on the Users page or with " +
        "`DATA_DIR=data npx tsx scripts/issue-token.ts <name> --write` on the Pi."
    );
  }
  const timeout = Number(env.INVERTER_MCP_TIMEOUT_MS);
  return {
    baseUrl: env.INVERTER_MCP_URL?.trim() || "http://localhost:3000",
    token,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000,
    readOnly: /^(1|true|yes|on)$/i.test(env.INVERTER_MCP_READ_ONLY ?? ""),
  };
}
```

- [ ] **Step 4: Реализовать `mcp/src/bin/stdio.ts`**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadStdioConfig } from "../config";
import { createHttpGateway } from "../gateway/http";
import { buildMcpServer } from "../server";

// Версия пакета — в отчёте клиенту; читаем из собственного package.json.
const { version } = require("../../package.json") as { version: string };

async function main(): Promise<void> {
  const cfg = loadStdioConfig(process.env);
  const gateway = await createHttpGateway({
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    timeoutMs: cfg.timeoutMs,
  });

  const caps = gateway.capabilities();
  // stderr — единственный безопасный канал: stdout занят протоколом.
  console.error(
    `[inverter-mcp] connected to ${cfg.baseUrl} as ${caps.role} ` +
      `[${caps.scopes.join(", ") || "no scopes"}]; ` +
      `writes ${!cfg.readOnly && caps.allowControl && caps.scopes.includes("write") ? "available" : "hidden"}; ` +
      `stats ${caps.statsEnabled ? "on" : "off"}`
  );

  const server = buildMcpServer({ gateway, version, readOnly: cfg.readOnly });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(`[inverter-mcp] fatal: ${(e as Error).message}`);
  process.exit(1);
});
```

- [ ] **Step 5: Собрать и проверить рукопожатие вручную**

```bash
npm run build -w mcp
# сервис должен быть запущен локально (npm run dev) и токен выдан
INVERTER_MCP_TOKEN=inv_… INVERTER_MCP_URL=http://localhost:3000 \
  node mcp/dist/bin/stdio.js <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```
Expected: в stderr — строка `[inverter-mcp] connected to …`, в stdout — JSON-ответ с `"serverInfo":{"name":"inverter-monitor"…}`.

- [ ] **Step 6: Запустить тесты и закоммитить**

Run: `npm test -w mcp`
Expected: PASS.

```bash
git add mcp/src/config.ts mcp/src/config.test.ts mcp/src/bin
git commit -m "feat(mcp): stdio-вход inverter-mcp"
```

---

### Task 12: `LocalGateway` и эндпоинт `/mcp`

**Files:**
- Create: `server/src/mcp/local-gateway.ts`, `server/src/mcp/http.ts`
- Modify: `server/src/config.ts`, `server/src/server.ts`, `server/.env.example`
- Test: `server/src/mcp/http.test.ts`

**Interfaces:**
- Consumes: `Inverter`, `StatsRecorder`, `Config`, `buildMcpServer`, `InverterGateway`.
- Produces: `createLocalGateway(inverter, cfg, stats, caps): InverterGateway`; `mountMcp(app, deps): void`; поля конфига `cfg.mcp.enabled`, `cfg.mcp.maxSessions`.

- [ ] **Step 1: Написать падающий тест `server/src/mcp/http.test.ts`**

```ts
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import request from "supertest";
import { loadConfig } from "../config";
import { Inverter } from "../inverter";
import { createServer } from "../server";
import { Auth } from "../auth/service";

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

const ACCEPT = "application/json, text/event-stream";

describe("/mcp endpoint", () => {
  let tmp: string;
  let inverter: Inverter;
  let server: http.Server;
  let token: string;

  beforeEach(() => {
    process.env.INVERTER_TRANSPORT = "mock";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-test-"));
    process.env.DATA_DIR = tmp;
    delete process.env.MCP_ENABLED;

    const cfg = loadConfig();
    inverter = new Inverter(cfg);
    server = createServer(inverter, cfg, null);

    const a = new Auth(tmp, 30);
    const u = a.db.getByUsername("admin")!;
    a.db.setPassword(u.id, "secret1", false, Date.now());
    token = a.issueToken("mcp", u.id, ["read", "write"]).token;
    a.db.close();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    inverter.removeAllListeners();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(server).post("/mcp").set("Accept", ACCEPT).send(INIT);
    expect(res.status).toBe(401);
  });

  it("initializes a session and returns the session id", async () => {
    const res = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .send(INIT);

    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeDefined();
    expect(res.text).toContain("inverter-monitor");
  });

  it("lists tools within an initialized session", async () => {
    const init = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .send(INIT);
    const sid = init.headers["mcp-session-id"] as string;

    await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sid)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const list = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sid)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(list.status).toBe(200);
    expect(list.text).toContain("get_snapshot");
    expect(list.text).toContain("set_control"); // токен со скоупом write
  });

  it("hides write tools from a read-only token", async () => {
    const a = new Auth(tmp, 30);
    const readToken = a.issueToken("ro", a.db.getByUsername("admin")!.id, ["read"]).token;
    a.db.close();

    const init = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${readToken}`)
      .set("Accept", ACCEPT)
      .send(INIT);
    const sid = init.headers["mcp-session-id"] as string;
    await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${readToken}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sid)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const list = await request(server)
      .post("/mcp")
      .set("Authorization", `Bearer ${readToken}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sid)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(list.text).toContain("get_snapshot");
    expect(list.text).not.toContain("set_control");
  });

  it("refuses more sessions than MCP_MAX_SESSIONS", async () => {
    process.env.MCP_MAX_SESSIONS = "1";
    const cfg = loadConfig();
    const inv = new Inverter(cfg);
    const srv = createServer(inv, cfg, null);
    try {
      const first = await request(srv).post("/mcp").set("Authorization", `Bearer ${token}`).set("Accept", ACCEPT).send(INIT);
      expect(first.status).toBe(200);
      const second = await request(srv).post("/mcp").set("Authorization", `Bearer ${token}`).set("Accept", ACCEPT).send(INIT);
      expect(second.status).toBe(503);
    } finally {
      delete process.env.MCP_MAX_SESSIONS;
      inv.removeAllListeners();
    }
  });

  it("returns 404 when MCP_ENABLED=false", async () => {
    process.env.MCP_ENABLED = "false";
    const cfg = loadConfig();
    const inv = new Inverter(cfg);
    const srv = createServer(inv, cfg, null);
    try {
      const res = await request(srv).post("/mcp").set("Authorization", `Bearer ${token}`).set("Accept", ACCEPT).send(INIT);
      expect(res.status).toBe(404);
    } finally {
      delete process.env.MCP_ENABLED;
      inv.removeAllListeners();
    }
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w server -- src/mcp/http.test.ts`
Expected: FAIL — `/mcp` отвечает 404 всегда.

- [ ] **Step 3: Добавить конфиг в `server/src/config.ts`**

В интерфейс `Config` рядом с `auth`:

```ts
  /** MCP-эндпоинт для агентов (/mcp). */
  mcp: {
    enabled: boolean;
    maxSessions: number; // Pi 3B: держим потолок низким
  };
```

В `loadConfig()`:

```ts
    mcp: {
      enabled: envBool("MCP_ENABLED", true),
      maxSessions: envInt("MCP_MAX_SESSIONS", 8),
    },
```

В `server/.env.example` дописать:

```
# MCP endpoint for LLM agents (same Bearer auth as /api)
MCP_ENABLED=true
MCP_MAX_SESSIONS=8
```

- [ ] **Step 4: Реализовать `server/src/mcp/local-gateway.ts`**

```ts
import type { InverterGateway, GatewayCapabilities, StatsGateway } from "@inverter/mcp";
import type { ControlType, Snapshot } from "@inverter/shared";
import type { Inverter } from "../inverter";
import type { Config } from "../config";
import type { StatsRecorder } from "../stats/recorder";
import { GAUGE_FIELDS, type GaugeField, localDay } from "../stats/db";

const CSV_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * Шлюз без HTTP-хопа: /mcp живёт в том же процессе, что и Inverter, поэтому
 * ходить к себе по сети незачем. Гейты записи остаются серверные — они внутри
 * Inverter.control()/rawQuery().
 */
export function createLocalGateway(
  inverter: Inverter,
  cfg: Config,
  stats: StatsRecorder | null,
  caps: GatewayCapabilities,
  source: string
): InverterGateway {
  const statsGateway: StatsGateway | null = stats
    ? {
        async series(q) {
          const fields = q.fields.filter((f): f is GaugeField =>
            (GAUGE_FIELDS as readonly string[]).includes(f)
          );
          return stats.db.querySeries(fields, q.from, q.to, q.res);
        },
        async daily(from, to) {
          return stats.db.queryDaily(from, to);
        },
        async energy(from, to, bucket) {
          return stats.db.queryEnergy(from, to, bucket) as unknown as Array<Record<string, number>>;
        },
        async events(q) {
          return stats.db.queryEvents(q);
        },
        async solarWindow(day) {
          const now = Date.now();
          const today = localDay(now);
          const d = day ?? today;
          return { day: d, ...stats.db.querySolarWindow(d, d === today ? now : undefined) };
        },
        async exportCsv(q) {
          const cols = stats.db.exportColumns(q.res);
          const parts = [cols.join(",")];
          let size = parts[0].length;
          let after = q.from - 1;
          let truncated = false;
          for (;;) {
            const chunk = stats.db.exportChunk(q.res, after, q.to, 10_000);
            if (!chunk.length) break;
            for (const row of chunk) {
              const line = cols.map((c) => row[c] ?? "").join(",");
              size += line.length + 1;
              if (size > CSV_LIMIT_BYTES) {
                truncated = true;
                break;
              }
              parts.push(line);
            }
            if (truncated) break;
            after = Number(chunk[chunk.length - 1].ts);
          }
          return { csv: parts.join("\n") + "\n", truncated };
        },
      }
    : null;

  return {
    async snapshot() {
      return inverter.getSnapshot();
    },
    async meta() {
      const {
        OUTPUT_SOURCE_PRIORITY, CHARGER_SOURCE_PRIORITY,
        ALLOWED_MAX_CHARGE_CURRENT, ALLOWED_MAX_AC_CHARGE_CURRENT,
      } = await import("@inverter/shared");
      return {
        session: { username: source, role: caps.role, mustChangePassword: false },
        allowControl: cfg.allowControl,
        outputSourcePriority: OUTPUT_SOURCE_PRIORITY,
        chargerSourcePriority: CHARGER_SOURCE_PRIORITY,
        maxChargingCurrent: ALLOWED_MAX_CHARGE_CURRENT,
        maxAcChargingCurrent: ALLOWED_MAX_AC_CHARGE_CURRENT,
      };
    },
    async baseline() {
      return inverter.getBaseline();
    },
    // `source` попадёт в вызовы в задаче 13 — сейчас метод Inverter его ещё не принимает.
    async control(type: ControlType, value: number) {
      return inverter.control(type, value);
    },
    async previewControl(type: ControlType, value: number) {
      return inverter.previewControl(type, value);
    },
    async setLock(locked: boolean) {
      return inverter.setLock(locked);
    },
    async recaptureBaseline() {
      return inverter.recaptureBaseline();
    },
    async raw(command: string) {
      return inverter.rawQuery(command);
    },
    stats: statsGateway,
    onSnapshot(cb: (s: Snapshot) => void) {
      inverter.on("snapshot", cb);
      return () => inverter.off("snapshot", cb);
    },
    capabilities() {
      return caps;
    },
    close() {
      /* локальный шлюз ничем не владеет */
    },
  };
}
```

- [ ] **Step 5: Реализовать `server/src/mcp/http.ts`**

```ts
import { randomUUID } from "crypto";
import type express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "@inverter/mcp";
import type { Inverter } from "../inverter";
import type { Config } from "../config";
import type { StatsRecorder } from "../stats/recorder";
import { createLocalGateway } from "./local-gateway";

const { version } = require("../../package.json") as { version: string };

export interface McpMountDeps {
  inverter: Inverter;
  cfg: Config;
  stats: StatsRecorder | null;
  /** Тот же гейт авторизации, что у /api: заполняет req.user и req.auth. */
  authenticate: express.RequestHandler;
}

/**
 * Монтирует /mcp на Streamable HTTP. McpServer создаётся на сессию, потому что
 * набор инструментов зависит от прав предъявленного токена.
 */
export function mountMcp(app: express.Express, deps: McpMountDeps): void {
  const { inverter, cfg, stats } = deps;
  if (!cfg.mcp.enabled) return;

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const handle: express.RequestHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found — reinitialize" },
        id: null,
      });
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: Mcp-Session-Id required" },
        id: null,
      });
      return;
    }

    if (sessions.size >= cfg.mcp.maxSessions) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Too many MCP sessions (limit ${cfg.mcp.maxSessions}); close an existing one or raise MCP_MAX_SESSIONS`,
        },
        id: null,
      });
      return;
    }

    const user = req.user!;
    const auth = req.auth!;
    const gateway = createLocalGateway(
      inverter,
      cfg,
      stats,
      {
        role: user.role,
        scopes: auth.scopes,
        allowControl: cfg.allowControl,
        statsEnabled: stats !== null,
      },
      auth.kind === "token" ? `token:${auth.tokenName ?? "?"}` : `ui:${user.username}`
    );

    const server = buildMcpServer({ gateway, version });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      gateway.close();
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  app.post("/mcp", deps.authenticate, handle);
  app.get("/mcp", deps.authenticate, handle);
  app.delete("/mcp", deps.authenticate, handle);
}
```

- [ ] **Step 6: Подключить в `server/src/server.ts`**

Авторизационный middleware `/api` вынести в именованную константу, чтобы переиспользовать:

```ts
  const authenticate: express.RequestHandler = (req, res, next) => { /* тело существующего middleware из задачи 3 плана по токенам */ };
  app.use("/api", authenticate);
```

Затем перед `const server = http.createServer(app);` добавить:

```ts
  mountMcp(app, { inverter, cfg, stats, authenticate });
```

и импорт `import { mountMcp } from "./mcp/http";`

Добавить `@inverter/mcp` в зависимости `server/package.json`:

```json
    "@inverter/mcp": "1.0.0",
```

и выполнить `npm install` в корне.

- [ ] **Step 7: Запустить тесты**

Run: `npm test -w server -- src/mcp/http.test.ts` затем `npm test -w server`
Expected: PASS.

- [ ] **Step 8: Коммит**

```bash
git add server/src/mcp server/src/config.ts server/src/server.ts server/package.json server/.env.example package-lock.json
git commit -m "feat(server): эндпоинт /mcp на Streamable HTTP и локальный шлюз"
```

---

### Task 13: Аудит записей в журнале событий

**Files:**
- Modify: `server/src/inverter.ts` (событие `"write"`, параметр `source`), `server/src/stats/recorder.ts` (подписка), `server/src/server.ts` (проброс источника), `server/src/mqtt.ts` (источник `mqtt`), `web/lib/i18n/dict.ts`, `web/app/(app)/stats/page.tsx`
- Test: `server/src/stats/recorder.test.ts` (дописать), `server/src/inverter.test.ts` (дописать)

**Interfaces:**
- Consumes: `Inverter.control(type, value, opts)`, `Inverter.rawQuery(command, opts)`.
- Produces: событие `"write"` с `{ ts, source, kind: "control" | "raw", type?, value?, register, rawValue }`; строка `events` с типом `control`.

- [ ] **Step 1: Написать падающий тест в `server/src/inverter.test.ts`**

```ts
  it("emits a write event carrying the source after a successful control write", async () => {
    process.env.INVERTER_TRANSPORT = "mock";
    const cfg = loadConfig();
    const inv = new Inverter(cfg);
    await inv.start();
    inv.setLock(false);

    const events: unknown[] = [];
    inv.on("write", (e) => events.push(e));
    await inv.control("chargerSourcePriority", 3, { source: "token:mcp" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "token:mcp",
      kind: "control",
      type: "chargerSourcePriority",
      value: 3,
      register: 331,
    });
    await inv.stop();
  });

  it("emits a write event for a raw W command", async () => {
    process.env.INVERTER_TRANSPORT = "mock";
    const cfg = loadConfig();
    const inv = new Inverter(cfg);
    await inv.start();
    inv.setLock(false);

    const events: Array<{ kind: string; register: number; source: string }> = [];
    inv.on("write", (e) => events.push(e));
    await inv.rawQuery("W 331 3", { source: "ui:admin" });

    expect(events).toEqual([expect.objectContaining({ kind: "raw", register: 331, source: "ui:admin" })]);
    await inv.stop();
  });
```

(В этом файле уже есть обвязка с `loadConfig`/`Inverter` — используй существующие импорты.)

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w server -- src/inverter.test.ts -t "write event"`
Expected: FAIL — событие не испускается.

- [ ] **Step 3: Реализовать событие в `server/src/inverter.ts`**

Тип события рядом с другими типами файла:

```ts
/** Факт записи в инвертор — для журнала событий (кто и что изменил). */
export interface WriteEvent {
  ts: number;
  source: string; // "ui:<user>" | "token:<name>" | "mqtt"
  kind: "control" | "raw";
  type?: ControlType;
  value?: number;
  register: number;
  rawValue: number;
}
```

В `control()` расширить опции и испустить событие после успешной записи (сразу после `await this.writeRegister(...)`, до обновления настроек):

```ts
  async control(
    type: ControlType,
    value: number,
    opts: { bypassLock?: boolean; source?: string } = {}
  ): Promise<{ ok: boolean; command: string; reply: string }> {
    // …существующие проверки и writeRegister…
    this.emit("write", {
      ts: Date.now(),
      source: opts.source ?? "unknown",
      kind: "control",
      type,
      value,
      register: w.register,
      rawValue: w.rawValue,
    } satisfies WriteEvent);
```

В `rawQuery()` — сигнатура `async rawQuery(command: string, opts: { source?: string } = {})`, и после `await this.writeRegister(addr, arg)`:

```ts
    this.emit("write", {
      ts: Date.now(),
      source: opts.source ?? "unknown",
      kind: "raw",
      register: addr,
      rawValue: arg,
    } satisfies WriteEvent);
```

- [ ] **Step 4: Написать падающий тест в `server/src/stats/recorder.test.ts`**

```ts
  it("records an explicit control event when the inverter reports a write", () => {
    const { recorder, db } = freshRecorder(); // существующая обвязка файла
    recorder.attach(inverterStub);            // тот же стаб, что в соседних тестах

    inverterStub.emit("write", {
      ts: 1_700_000_000_000,
      source: "token:mcp",
      kind: "control",
      type: "chargerSourcePriority",
      value: 3,
      register: 331,
      rawValue: 3,
    });
    recorder.flush(); // существующий метод сброса буфера

    const rows = db.queryEvents({ limit: 10, offset: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("control");
    expect(JSON.parse(rows[0].detail)).toMatchObject({
      source: "token:mcp",
      kind: "control",
      type: "chargerSourcePriority",
      value: 3,
      register: 331,
    });
  });
```

Если в файле нет `freshRecorder`/`inverterStub`/`flush` под такими именами — используй те, что там уже есть (посмотри соседние тесты и повтори их обвязку).

- [ ] **Step 5: Реализовать подписку в `server/src/stats/recorder.ts`**

В методе `attach(inverter)` рядом с существующей подпиской на `"snapshot"`:

```ts
    inverter.on("write", (e: WriteEvent) => {
      this.push(e.ts, "control", {
        source: e.source,
        kind: e.kind,
        type: e.type ?? null,
        value: e.value ?? null,
        register: e.register,
        rawValue: e.rawValue,
      });
    });
```

(импортировать тип: `import type { WriteEvent } from "../inverter";`)

- [ ] **Step 6: Пробросить источник в вызывающих**

В `server/src/server.ts`, роут `POST /api/control`:

```ts
      const src = req.auth!.kind === "token" ? `token:${req.auth!.tokenName ?? "?"}` : `ui:${req.user!.username}`;
      const result = await inverter.control(type as ControlType, numValue, { source: src });
```

В `POST /api/raw` — тот же `src` и `await inverter.rawQuery(command, { source: src })`.

В `server/src/mqtt.ts` — там, где вызывается `inverter.control(..., { bypassLock: true })`, добавить `source: "mqtt"`.

В `server/src/mcp/local-gateway.ts` — вернуть проброс источника, ради которого туда и передаётся `source`:

```ts
    async control(type: ControlType, value: number) {
      return inverter.control(type, value, { source });
    },
    async raw(command: string) {
      return inverter.rawQuery(command, { source });
    },
```

Так записи через `/mcp` попадают в журнал с именем токена, а не как `unknown`.

- [ ] **Step 7: Показать событие в UI**

В `web/lib/i18n/dict.ts` добавить ключ `evControl` во все три языка: uk — `"Зміна налаштування"`, ru — `"Изменение настройки"`, en — `"Setting changed"`.

В `web/app/(app)/stats/page.tsx` найти функцию, отображающую тип события (`evText` или подобную), добавить ветку для `"control"`, которая печатает `t.evControl` и подробности из `detail` (`type`/`value`/`source`), и добавить `"control"` в список типов фильтра журнала.

- [ ] **Step 8: Прогнать всё**

Run: `npm test -w server` затем `npm test -w web` и `npm run typecheck -w web`
Expected: PASS.

- [ ] **Step 9: Коммит**

```bash
git add server/src/inverter.ts server/src/inverter.test.ts server/src/stats/recorder.ts server/src/stats/recorder.test.ts server/src/server.ts server/src/mqtt.ts web/lib/i18n/dict.ts web/app/\(app\)/stats/page.tsx
git commit -m "feat(stats): журналирование записей в инвертор с источником"
```

---

### Task 14: Логирование в клиент (MCP logging)

**Files:**
- Create: `mcp/src/logging.ts`
- Modify: `mcp/src/server.ts`, `mcp/src/tools/read.ts` (`guard`), `mcp/src/tools/control.ts` (`guardWrite`)
- Test: `mcp/src/logging.test.ts`

**Interfaces:**
- Consumes: `McpServer.sendLoggingMessage`.
- Produces: `createLogger(server): Logger` с методами `info(logger: string, data: unknown)` и `error(logger: string, data: unknown)`; `guard`/`guardWrite` принимают необязательный логгер.

- [ ] **Step 1: Написать падающий тест `mcp/src/logging.test.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "./server";
import { createFakeGateway } from "./testing/fake-gateway";

async function connect(gateway = createFakeGateway()) {
  const server = buildMcpServer({ gateway, version: "test" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: { logging: {} } });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, gateway };
}

describe("MCP logging", () => {
  it("advertises the logging capability", async () => {
    const { client } = await connect();
    expect(client.getServerCapabilities()?.logging).toBeDefined();
  });

  it("logs a write at info level", async () => {
    const messages: Array<{ level: string; logger?: string; data: unknown }> = [];
    const { client } = await connect();
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => messages.push(n.params));
    await client.setLoggingLevel("info");

    await client.callTool({ name: "set_control", arguments: { type: "chargerSourcePriority", value: 3 } });
    await new Promise((r) => setTimeout(r, 50));

    const write = messages.find((m) => m.logger === "control");
    expect(write).toBeDefined();
    expect(write!.level).toBe("info");
    expect(JSON.stringify(write!.data)).toContain("chargerSourcePriority");
  });

  it("logs gateway failures at error level", async () => {
    const gw = createFakeGateway({
      snapshot: async () => {
        throw new Error("service unreachable");
      },
    });
    const messages: Array<{ level: string; data: unknown }> = [];
    const { client } = await connect(gw);
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => messages.push(n.params));
    await client.setLoggingLevel("error");

    await client.callTool({ name: "get_snapshot", arguments: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(messages.some((m) => m.level === "error" && JSON.stringify(m.data).includes("unreachable"))).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w mcp -- src/logging.test.ts`
Expected: FAIL — уведомлений нет.

- [ ] **Step 3: Реализовать `mcp/src/logging.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface Logger {
  info(logger: string, data: unknown): void;
  error(logger: string, data: unknown): void;
}

/**
 * Логирование в клиента. Отправка «в никуда» (клиент не запросил уровень или уже
 * отключился) не должна ронять инструмент — все ошибки глотаем.
 */
export function createLogger(server: McpServer): Logger {
  const send = (level: "info" | "error", logger: string, data: unknown) => {
    void server.server.sendLoggingMessage({ level, logger, data }).catch(() => undefined);
  };
  return {
    info: (logger, data) => send("info", logger, data),
    error: (logger, data) => send("error", logger, data),
  };
}
```

- [ ] **Step 4: Прокинуть логгер в обёртки**

В `mcp/src/tools/read.ts` изменить сигнатуру `guard`:

```ts
export async function guard<T>(
  fn: () => Promise<{ structuredContent: T; text: string }>,
  log?: { logger: Logger; name: string }
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: T; isError?: boolean }> {
  try {
    const { structuredContent, text } = await fn();
    return { content: [{ type: "text", text }], structuredContent };
  } catch (e) {
    log?.logger.error(log.name, { error: (e as Error).message });
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  }
}
```

`registerReadTools`/`registerStatsTools`/`registerControlTools` получают третий параметр `logger: Logger` и передают `{ logger, name: "<tool name>" }` в каждый вызов `guard`/`guardWrite`.

В `guardWrite` (`mcp/src/tools/control.ts`) дополнительно логировать успех:

```ts
    const { structuredContent, text } = await fn();
    log?.logger.info(log.name, structuredContent);
    return { content: [{ type: "text", text }], structuredContent };
```

- [ ] **Step 5: Создать логгер в `buildMcpServer`**

```ts
  const logger = createLogger(server);
  registerReadTools(server, ctx, logger);
  registerStatsTools(server, ctx, logger);
  registerControlTools(server, ctx, logger);
```

- [ ] **Step 6: Запустить тесты**

Run: `npm test -w mcp`
Expected: PASS всё (включая ранее написанные тесты — сигнатуры расширены необязательным параметром).

- [ ] **Step 7: Коммит**

```bash
git add mcp/src/logging.ts mcp/src/logging.test.ts mcp/src/server.ts mcp/src/tools
git commit -m "feat(mcp): логирование записей и ошибок в клиента"
```

---

### Task 15: Деплой и документация

**Files:**
- Modify: `deploy.sh`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: собранный `mcp/dist`, эндпоинт `/mcp`, bin `inverter-mcp`.
- Produces: рабочий деплой на Pi и инструкции подключения.

- [ ] **Step 1: Обновить `deploy.sh`**

В список путей `rsync` добавить `mcp/dist` и `mcp/package.json` (рядом с тем, как заливаются `shared/dist` и `server/dist`). Команду установки на Pi заменить на:

```bash
npm ci -w server -w mcp --omit=dev
```

- [ ] **Step 2: Проверить деплой-скрипт локально в dry-run**

Run: `bash -n deploy.sh` (синтаксис) и просмотреть diff глазами.
Expected: без ошибок; в rsync-списке есть `mcp/dist`.

- [ ] **Step 3: Дописать раздел «MCP» в README**

После раздела про Home Assistant вставить:

````markdown
## 🤖 MCP (LLM agents)

The service ships an **MCP server** so agents (Claude Code, Claude Desktop, any MCP client)
can read the inverter, dig through history and — with an explicitly scoped token — change
settings. Two ways to connect, same tools behind both.

**1. Over the network** — the service exposes `POST/GET/DELETE /mcp` (Streamable HTTP),
authorized by the same Bearer token as `/api`:

```
http://<pi-address>:3000/mcp     header: Authorization: Bearer inv_…
```

**2. Locally over stdio** — for clients that prefer spawning a process:

```json
{
  "mcpServers": {
    "inverter": {
      "command": "node",
      "args": ["/path/to/inverter-monitor/mcp/dist/bin/stdio.js"],
      "env": {
        "INVERTER_MCP_URL": "http://<pi-address>:3000",
        "INVERTER_MCP_TOKEN": "inv_…"
      }
    }
  }
}
```

**Tools.** Reading: `get_snapshot`, `get_settings_diff`, `get_alarms`, `get_meta`,
`get_health`, `read_registers`. History: `get_series`, `get_daily`, `get_energy`,
`get_events`, `get_solar_window`, `summarize_period`, `export_csv`. Writing (admin token
with the `write` scope only): `set_control`, `set_lock`, `recapture_baseline`,
`write_register`.

**Resources.** `inverter://snapshot` (subscribable — live push), `settings`, `baseline`,
`alarms`, `events/recent`, plus two documents an agent cannot get anywhere else:
`inverter://registers/map` (the SMG II register map) and `inverter://docs/control-contract`
(what may be written and why each setting is risky). Templates:
`inverter://stats/daily/{day}` and `inverter://stats/export/{res}/{from}/{to}.csv`.

**Prompts.** `diagnose-connection`, `daily-report`, `battery-health-check`,
`plan-setting-change`.

**Safety.** Write tools are not even listed unless the token is an admin one with the
`write` scope and `ALLOW_CONTROL` is on. Writes still require the lock to be released and
re-lock afterwards, exactly like the UI. Every write is recorded in the event log with its
source (`token:<name>`). `INVERTER_MCP_READ_ONLY=true` hides write tools locally even for a
write-capable token.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_ENABLED` | `true` | Serve `/mcp` |
| `MCP_MAX_SESSIONS` | `8` | Concurrent MCP sessions (Pi 3B) |
| `INVERTER_MCP_URL` | `http://localhost:3000` | stdio: service address |
| `INVERTER_MCP_TOKEN` | — | stdio: token, required |
| `INVERTER_MCP_TIMEOUT_MS` | `10000` | stdio: request timeout |
| `INVERTER_MCP_READ_ONLY` | `false` | stdio: hide write tools |
````

Также добавить `- [MCP (LLM agents)](#-mcp-llm-agents)` в оглавление и строку про MCP в
список Features, а в разделе «Project structure» — каталог `mcp/`.

- [ ] **Step 4: Дописать `CLAUDE.md`**

В раздел «Архитектура» добавить описание слоя:

```markdown
### `mcp/` — MCP-сервер для агентов
`@inverter/mcp` — ядро инструментов/ресурсов/промптов, не знающее о транспорте: всё общение
с сервисом идёт через интерфейс `InverterGateway` (`mcp/src/gateway/types.ts`). Реализаций
две: `HttpGateway` (REST + WS под Bearer, для stdio-бинаря `mcp/dist/bin/stdio.js`) и
`LocalGateway` (`server/src/mcp/local-gateway.ts`, прямые вызовы `Inverter`/`StatsDb` для
эндпоинта `/mcp`). Набор инструментов собирается по правам: write-инструменты вообще не
регистрируются без admin-роли, скоупа `write`, `ALLOW_CONTROL` и при
`INVERTER_MCP_READ_ONLY`. Сборка: `mcp` идёт после `shared` и до `server` (сервер
импортирует собранный `dist`). tsconfig воркспейса — `module/moduleResolution: node16`
(иначе не резолвятся subpath-экспорты SDK), эмит CommonJS.
```

Обновить правило синхронизации управляющих команд:

```markdown
**Добавление новой управляющей команды** трогает: `shared/src/api.ts` → `server/src/protocol/smg.ts`
→ `server/src/server.ts` (`CONTROL_TYPES`) → `web/` (UI) → `mcp/src/tools/control.ts`
(`CONTROL_TYPES` + описание) → `shared/src/registers.ts` (строка регистра) и тесты обоих.
```

- [ ] **Step 5: Полная проверка**

Run: `npm run build && npm run check && npm test -w web`
Expected: PASS всё.

- [ ] **Step 6: Коммит**

```bash
git add deploy.sh README.md CLAUDE.md
git commit -m "docs: раздел MCP в README и CLAUDE.md, деплой mcp/dist на Pi"
```

- [ ] **Step 7: Проверка на живом стенде**

```bash
PI_HOST=pi@192.168.1.112 SSH_KEY=~/.ssh/personal_190726 ./deploy.sh
# дождаться рестарта пода/сервиса, затем:
curl -sS -X POST http://192.168.1.112:3000/mcp \
  -H "Authorization: Bearer inv_…" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```
Expected: ответ с `"serverInfo":{"name":"inverter-monitor"}` и заголовком `mcp-session-id`.
