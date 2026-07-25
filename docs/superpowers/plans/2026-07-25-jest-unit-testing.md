# План: покрытие inverter-monitor unit-тестами (jest)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Покрыть монорепо `inverter-monitor` (shared/server/web) unit-тестами на jest, мигрировав 4 selfcheck-скрипта в jest.

**Architecture:** Per-workspace jest. `server/` — ts-jest, `testEnvironment: node`, прогон под Node 24 (нужен `node:sqlite`), тесты `shared` гоняются из server-конфига (`roots` включает `shared/src`), `@inverter/shared` замаплен на исходники. `web/` — `next/jest` + jsdom + Testing Library. Coverage собирается, порогов нет.

**Tech Stack:** jest, ts-jest, supertest, @testing-library/react, jest-dom, jest-canvas-mock, next/jest.

## Global Constraints

- **Node 24 обязателен** для прогона server-тестов (`node:sqlite`). Перед прогоном: `nvm use` (в репо `.nvmrc` = 24). CI/локально гонять под Node ≥24.
- **shared/server — CommonJS** (`module: "commonjs"`). НЕ добавлять ESM-настройки (`extensionsToTreatAsEsm`, `--experimental-vm-modules`).
- **Эталонные значения из selfcheck НЕ менять** — это данные, снятые с живого SK-5500P-48L. Переносить в тесты 1:1.
- **Масштабирование в декодерах — делением** (`/10`, `/100`). Тесты проверяют точные значения без float-хвостов (`232.7`, не `232.70000000000002`).
- **serialport — optionalDependency**, в тестах только мокается, реально не ставится и не открывается.
- Коммиты частые, по одной задаче. Ветка: `test/jest-unit-coverage`.
- Запуск server-тестов: `npm test -w server`; web: `npm test -w web`; конкретный файл: `npm test -w server -- <path>`.

---

## Фаза 1 — Инфраструктура server + shared

### Task 1: Установка и конфигурация jest для server/shared

**Files:**
- Modify: `server/package.json` (devDeps + scripts)
- Create: `server/jest.config.cjs`
- Create: `server/src/__sanity__/sanity.test.ts`

**Interfaces:**
- Produces: рабочий `npm test -w server`, конвенция `*.test.ts` рядом с исходником, маппинг `@inverter/shared` → `shared/src/index.ts`.

- [ ] **Step 1: Установить зависимости**

Из корня репозитория:
```bash
npm install -w server -D jest@^29 ts-jest@^29 @types/jest@^29 supertest@^7 @types/supertest@^6
```
Expected: пакеты добавлены в `server/package.json` devDependencies, `npm install` без ошибок.

- [ ] **Step 2: Создать `server/jest.config.cjs`**

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/../shared/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@inverter/shared$": "<rootDir>/../shared/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/index.ts",
    "!src/**/types.ts",
    "!src/**/*.d.ts",
    "../shared/src/api.ts",
    "../shared/src/auth.ts",
  ],
  coverageReporters: ["text", "html"],
  clearMocks: true,
};
```

- [ ] **Step 3: Написать sanity-тест**

`server/src/__sanity__/sanity.test.ts`:
```ts
import { OUTPUT_SOURCE_PRIORITY } from "@inverter/shared";

describe("jest sanity", () => {
  it("runs and resolves @inverter/shared from source", () => {
    expect(typeof OUTPUT_SOURCE_PRIORITY).toBe("object");
    expect(2 + 2).toBe(4);
  });
});
```

- [ ] **Step 4: Обновить scripts в `server/package.json`**

Добавить (не удаляя `check` пока — миграция selfcheck в Task 13):
```json
"test": "jest",
"test:coverage": "jest --coverage"
```

- [ ] **Step 5: Прогнать sanity под Node 24**

Run: `nvm use && npm test -w server -- src/__sanity__`
Expected: PASS, 1 тест зелёный, маппинг `@inverter/shared` резолвится (нет ошибки "Cannot find module").

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/jest.config.cjs server/src/__sanity__ package-lock.json
git commit -m "test(server): инфраструктура jest (ts-jest, node, маппинг shared)"
```

---

## Фаза 2 — protocol + миграция selfcheck.ts

### Task 2: modbus.ts — сборка/разбор кадров, CRC

**Files:**
- Test: `server/src/protocol/modbus.test.ts`
- Source: `server/src/protocol/modbus.ts` (не меняется)

**Interfaces:**
- Consumes: `crc16`, `buildReadRequest`, `buildWriteRequest`, `expectedResponseLength`, `parseReadResponse`, `parseWriteResponse`, `toSigned`, `ModbusError` из `../src/protocol/modbus` (пути в тесте: `./modbus`).

- [ ] **Step 1: Написать тест `server/src/protocol/modbus.test.ts`**

Эталонные значения перенесены из `scripts/selfcheck.ts:24-76` без изменений.
```ts
import {
  crc16,
  buildReadRequest,
  buildWriteRequest,
  expectedResponseLength,
  parseReadResponse,
  parseWriteResponse,
  toSigned,
  ModbusError,
} from "./modbus";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");

describe("crc16", () => {
  it("matches live read request CRC (LE 54 34)", () => {
    expect(crc16(hex("01 03 00 c9 00 01"))).toBe(0x3454);
  });
});

describe("buildReadRequest", () => {
  it("builds live etalon frame for reg 201", () => {
    expect(buildReadRequest(1, 201, 1)).toEqual(hex("01 03 00 c9 00 01 54 34"));
  });
  it("builds live etalon frame for reg 215", () => {
    expect(buildReadRequest(1, 215, 1)).toEqual(hex("01 03 00 d7 00 01 34 32"));
  });
});

describe("parseReadResponse — live etalon frames", () => {
  it.each([
    ["mode", "01 03 02 00 03 f8 45", 3],
    ["ac voltage", "01 03 02 09 17 fe 1a", 2327],
    ["battery voltage", "01 03 02 02 0a 39 23", 522],
    ["soc", "01 03 02 00 48 b8 72", 72],
  ])("decodes %s", (_name, frame, value) => {
    const [v] = parseReadResponse(hex(frame as string), 1, 1);
    expect(v).toBe(value);
  });

  it("rejects bad CRC", () => {
    expect(() => parseReadResponse(hex("01 03 02 00 03 f8 46"), 1, 1)).toThrow(/CRC/);
  });

  it("throws ModbusError with exception code on exception frame", () => {
    const exBody = Buffer.from([1, 0x83, 0x02]);
    const c = crc16(exBody);
    const ex = Buffer.concat([exBody, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
    expect(() => parseReadResponse(ex, 1, 1)).toThrow(
      expect.objectContaining({ exceptionCode: 2 }) as unknown as Error
    );
    try {
      parseReadResponse(ex, 1, 1);
    } catch (e) {
      expect(e).toBeInstanceOf(ModbusError);
    }
  });
});

describe("buildWriteRequest / parseWriteResponse", () => {
  it("uses fn 0x10 and correct length", () => {
    const w = buildWriteRequest(1, 331, [3]);
    expect(w[1]).toBe(0x10);
    expect(w.length).toBe(11);
    expect(expectedResponseLength(w)).toBe(8);
  });
  it("accepts a valid write echo", () => {
    const echoBody = Buffer.from([1, 0x10, 331 >> 8, 331 & 0xff, 0, 1]);
    const c = crc16(echoBody);
    const echo = Buffer.concat([echoBody, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
    expect(() => parseWriteResponse(echo, 1, 331, 1)).not.toThrow();
  });
  it("rejects echo with wrong address", () => {
    const echoBody = Buffer.from([1, 0x10, 0, 99, 0, 1]);
    const c = crc16(echoBody);
    const echo = Buffer.concat([echoBody, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
    expect(() => parseWriteResponse(echo, 1, 331, 1)).toThrow(/echo mismatch/);
  });
});

describe("expectedResponseLength", () => {
  it("computes read length for 17 registers", () => {
    expect(expectedResponseLength(buildReadRequest(1, 201, 17))).toBe(3 + 34 + 2);
  });
  it("throws on unsupported function", () => {
    const bogus = Buffer.from([1, 0x06, 0, 0, 0, 0, 0, 0]);
    expect(() => expectedResponseLength(bogus)).toThrow(/Unsupported function/);
  });
});

describe("toSigned", () => {
  it.each([
    [0xfff6, -10],
    [0x020a, 522],
    [0x8000, -32768],
    [0x7fff, 32767],
  ])("toSigned(0x%s)", (input, expected) => {
    expect(toSigned(input as number)).toBe(expected);
  });
});
```

- [ ] **Step 2: Прогнать**

Run: `npm test -w server -- src/protocol/modbus.test.ts`
Expected: PASS, все describe зелёные.

- [ ] **Step 3: Commit**

```bash
git add server/src/protocol/modbus.test.ts
git commit -m "test(protocol): modbus — кадры, CRC, эталоны, исключения (миграция selfcheck)"
```

### Task 3: smg.ts — декодеры и сеттеры

**Files:**
- Test: `server/src/protocol/smg.test.ts`
- Source: `server/src/protocol/smg.ts` (не меняется)

**Interfaces:**
- Consumes: `decodeStatus`, `decodeSettings`, `decodeFlags`, `decodeAlarms`, `decodeMode`, `buildControlWrite`, `RegisterMap` из `./smg`.

- [ ] **Step 1: Написать тест `server/src/protocol/smg.test.ts`**

Эталоны перенесены из `scripts/selfcheck.ts:78-202` без изменений.
```ts
import {
  decodeStatus,
  decodeSettings,
  decodeFlags,
  decodeAlarms,
  decodeMode,
  buildControlWrite,
  RegisterMap,
} from "./smg";

describe("decodeStatus", () => {
  const regs: RegisterMap = new Map<number, number>([
    [201, 2], [202, 2327], [203, 5001], [204, 150], [208, 600],
    [210, 2298], [212, 5000], [213, 600], [214, 690], [215, 522],
    [217, 0x10000 - 520], [219, 2805], [220, 114], [223, 3200],
    [224, 2680], [225, 11], [226, 41], [227, 43], [229, 72],
    [232, 0x10000 - 100],
  ]);
  const st = decodeStatus(regs);
  it("scales voltages/frequencies by division (no float tails)", () => {
    expect(st.gridVoltage).toBe(232.7);
    expect(st.gridFrequency).toBe(50.01);
    expect(st.acOutputVoltage).toBe(229.8);
    expect(st.batteryVoltage).toBe(52.2);
  });
  it("maps powers and derives charge/discharge current", () => {
    expect(st.acOutputActivePower).toBe(600);
    expect(st.batteryPower).toBe(-520);
    expect(st.batteryChargingCurrent).toBe(0);
    expect(st.batteryDischargeCurrent).toBe(10);
    expect(st.batteryCapacity).toBe(72);
    expect(st.pvPower).toBe(3200);
    expect(st.pvChargingPower).toBe(2680);
    expect(st.heatSinkTemperature).toBe(43);
  });
  it("returns NaN for missing registers", () => {
    expect(Number.isNaN(decodeStatus(new Map()).gridVoltage)).toBe(true);
  });
});

describe("decodeMode", () => {
  it.each([
    [0, "PowerOn"], [1, "Standby"], [2, "Line"], [3, "Battery"],
    [4, "Bypass"], [5, "Charging"], [6, "Fault"], [99, "Unknown"],
  ])("mode %i", (reg, name) => {
    expect(decodeMode(reg as number)).toBe(name);
  });
});

describe("decodeSettings", () => {
  const regs: RegisterMap = new Map<number, number>([
    [300, 0], [301, 2], [302, 0], [303, 1], [305, 1], [306, 1], [307, 0],
    [310, 1], [313, 0], [320, 2300], [321, 5000], [322, 3], [324, 564],
    [325, 540], [326, 540], [327, 460], [329, 420], [331, 1], [332, 600],
    [333, 300], [341, 30], [342, 80], [343, 10], [643, 5500],
  ]);
  const info = decodeSettings(regs);
  it("decodes priorities, currents, voltages, SOC, rated power", () => {
    expect(info.outputSourcePriority).toBe(2);
    expect(info.chargerSourcePriority).toBe(1);
    expect(info.maxChargingCurrent).toBe(60);
    expect(info.maxAcChargingCurrent).toBe(30);
    expect(info.batteryRechargeVoltage).toBe(46);
    expect(info.batteryRedischargeVoltage).toBe(54);
    expect(info.batteryBulkVoltage).toBe(56.4);
    expect(info.batteryUnderVoltage).toBe(42);
    expect(info.batteryType).toBe(3);
    expect(info.socBackToUtility).toBe(30);
    expect(info.acOutputRatingActivePower).toBe(5500);
  });
});

describe("decodeFlags", () => {
  const regs: RegisterMap = new Map<number, number>([
    [306, 1], [307, 0], [310, 1], [313, 0],
  ]);
  const flags = decodeFlags(regs);
  it("maps single-bit toggles", () => {
    expect(flags.flags.find((f) => f.key === "lcdHome")?.enabled).toBe(true);
    expect(flags.flags.find((f) => f.key === "ecoMode")?.enabled).toBe(false);
    expect(flags.flags.find((f) => f.key === "overloadBypass")?.enabled).toBe(true);
  });
  it("omits flags for absent registers", () => {
    expect(decodeFlags(new Map()).flags).toHaveLength(0);
  });
});

describe("decodeAlarms", () => {
  it("lists active fault+warning bits by name", () => {
    const regs: RegisterMap = new Map<number, number>([
      [100, 0], [101, 1 << 6], [108, 0], [109, (1 << 3) | (1 << 8)],
    ]);
    expect(decodeAlarms(regs).active).toEqual([
      "Output over load", "Mains low voltage", "Battery low voltage",
    ]);
  });
  it("returns empty list when no bits set", () => {
    expect(decodeAlarms(new Map([[100, 0], [101, 0], [108, 0], [109, 0]])).active).toEqual([]);
  });
});

describe("buildControlWrite", () => {
  it("maps registers, scales ×10, labels", () => {
    expect(buildControlWrite("outputSourcePriority", 2).register).toBe(301);
    expect(buildControlWrite("chargerSourcePriority", 3)).toEqual({
      register: 331, rawValue: 3, label: "charger priority = Only PV",
    });
    expect(buildControlWrite("maxChargingCurrent", 60).rawValue).toBe(600);
    expect(buildControlWrite("maxAcChargingCurrent", 30).rawValue).toBe(300);
    expect(buildControlWrite("batteryRechargeVoltage", 46).register).toBe(327);
    expect(buildControlWrite("batteryRechargeVoltage", 46).rawValue).toBe(460);
    expect(buildControlWrite("batteryRedischargeVoltage", 54).register).toBe(326);
  });
  it("validates values", () => {
    expect(() => buildControlWrite("maxChargingCurrent", 55)).toThrow(/must be one of/);
    expect(() => buildControlWrite("batteryRechargeVoltage", 70)).toThrow(/out of range/);
    expect(() => buildControlWrite("outputSourcePriority", 9)).toThrow(/Invalid/);
  });
});
```

- [ ] **Step 2: Прогнать**

Run: `npm test -w server -- src/protocol/smg.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/protocol/smg.test.ts
git commit -m "test(protocol): smg — декодеры статуса/настроек/аварий, сеттеры (миграция selfcheck)"
```

---

## Фаза 3 — transport

### Task 4: mock.ts — эмулятор Modbus-slave

**Files:**
- Test: `server/src/transport/mock.test.ts`
- Source: `server/src/transport/mock.ts`

**Interfaces:**
- Consumes: экспортируемый класс/фабрику mock-транспорта и его `transact(frame, timeout, expectedLen)` (уточнить сигнатуру по `src/transport/mock.ts` и `src/transport/types.ts`).

- [ ] **Step 1: Прочитать `src/transport/mock.ts` и `src/transport/types.ts`**, зафиксировать точное имя экспорта и сигнатуру `transact`/`open`/`close`.

- [ ] **Step 2: Написать тест `mock.test.ts`** — конкретные кейсы:
  - `transact(buildReadRequest(1, 201, 1))` возвращает валидный кадр, `parseReadResponse` даёт корректный режим (0..6).
  - Чтение блока статуса (`buildReadRequest(1, 201, 17)`) возвращает `expectedResponseLength` байт, все регистры парсятся.
  - Запись `buildWriteRequest(1, 331, [3])` (fn 0x10) → корректное эхо, `parseWriteResponse` не бросает; последующее чтение 331 отражает записанное значение.
  - Чтение недокументированного/вне карты регистра → exception-кадр (бит 0x80), `parseReadResponse` бросает `ModbusError`.
  - `transact` завершается по накоплению `expectedLen` (не виснет) — проверить через `await` без таймаута.

  Для каждого кейса — `import { buildReadRequest, buildWriteRequest, parseReadResponse, parseWriteResponse } from "../protocol/modbus"` и реальные ассерты на значения.

- [ ] **Step 3: Прогнать** `npm test -w server -- src/transport/mock.test.ts` → PASS.
- [ ] **Step 4: Commit** — `test(transport): mock — эмулятор slave, fn 0x03/0x10, исключения`.

### Task 5: serial.ts — обёртка serialport (мок)

**Files:**
- Test: `server/src/transport/serial.test.ts`
- Source: `server/src/transport/serial.ts`

- [ ] **Step 1: Прочитать `src/transport/serial.ts`**, зафиксировать как импортируется `serialport` и сигнатуры (open/close/transact/isAvailable).
- [ ] **Step 2: Замокать модуль** `jest.mock("serialport", () => ({ SerialPort: jest.fn() ... }))` с управляемым fake-портом (эмулировать событие `data`, `open`, `error`).
- [ ] **Step 3: Написать тест `serial.test.ts`** — кейсы:
  - `isAvailable()` возвращает `true`, когда модуль `serialport` резолвится (мок присутствует).
  - `transact` пишет кадр в порт и резолвится накопленным ответом при эмиссии `data` нужной длины.
  - Таймаут: если `data` не приходит — `transact` реджектится по таймауту (использовать fake timers).
  - `close()` закрывает порт (вызывает `.close` мока).
- [ ] **Step 4: Прогнать** → PASS. **Step 5: Commit** — `test(transport): serial — обёртка serialport на моках`.

### Task 6: detect.ts — выбор транспорта

**Files:**
- Test: `server/src/transport/detect.test.ts`
- Source: `server/src/transport/detect.ts`

- [ ] **Step 1: Прочитать `src/transport/detect.ts`** — понять как перечисляются порты и как читается env (`INVERTER_TRANSPORT`, `INVERTER_SERIAL_DEVICE`).
- [ ] **Step 2: Замокать** listing портов (`SerialPort.list` или аналог) и `process.env`.
- [ ] **Step 3: Написать тест `detect.test.ts`** — кейсы:
  - `INVERTER_TRANSPORT=mock` → выбирается mock-транспорт.
  - `auto` без USB-serial → mock последним (fallback).
  - `auto` с USB-serial портом → выбирается serial; onboard-UART (`ttyAMA*`/`ttyS0`) отфильтровывается.
  - Явный `INVERTER_SERIAL_DEVICE` → используется указанный путь даже если это UART.
- [ ] **Step 4: Прогнать** → PASS. **Step 5: Commit** — `test(transport): detect — порядок и фильтрация транспортов`.

---

## Фаза 4 — stats + миграция selfcheck-stats.ts

### Task 7: stats/db.ts — SQLite схема, свёртки, retention

**Files:**
- Test: `server/src/stats/db.test.ts`
- Source: `server/src/stats/db.ts`
- Reference: `server/scripts/selfcheck-stats.ts` (перенести assert-логику)

- [ ] **Step 1: Прочитать `src/stats/db.ts` и `scripts/selfcheck-stats.ts`** — зафиксировать конструктор (путь БД → использовать `":memory:"`), методы записи семплов, свёрток по watermark, retention, и точные ожидаемые значения из selfcheck-stats.
- [ ] **Step 2: Написать тест `db.test.ts`** — кейсы (перенос из selfcheck-stats 1:1 по значениям):
  - Схема создаётся: таблицы `samples`, `samples_minute`, `daily`, `events` существуют.
  - Вставка семплов → свёртка в `samples_minute`/`daily` по watermark даёт ожидаемые агрегаты.
  - Retention: семплы старше 30 дней удаляются из `samples`; `samples_minute` — 2 года; `daily`/`events` — бессрочно.
  - Идемпотентность свёртки (повторный вызов не дублирует).
  - Все БД — `new ...(":memory:")`, закрывать в `afterEach`.
- [ ] **Step 3: Прогнать** `npm test -w server -- src/stats/db.test.ts` (под Node 24!) → PASS.
- [ ] **Step 4: Commit** — `test(stats): db — схема, свёртки, retention на :memory: (миграция selfcheck-stats)`.

### Task 8: stats/recorder.ts — деривация событий, буфер/флаш

**Files:**
- Test: `server/src/stats/recorder.test.ts`
- Source: `server/src/stats/recorder.ts`

- [ ] **Step 1: Прочитать `src/stats/recorder.ts`** — как подписывается на `"snapshot"`, интервал флаша (60 с), логику диффа снапшотов.
- [ ] **Step 2: Написать тест `recorder.test.ts`** с `jest.useFakeTimers()` и in-memory db (или мок db-слоя) — кейсы:
  - Буфер флашится раз в 60 с (`jest.advanceTimersByTime(60000)` → db получает записи).
  - Событие смены режима при изменении `mode` между снапшотами.
  - Событие потери/возврата сети (`mainsPower`/mode).
  - Событие появления/снятия аварии (дифф `warnings.active`).
  - Старт/стоп зарядки от солнца по гистерезису Шмитта на `pvChargingPower` (два порога — проверить, что нет дребезга у границы).
  - Recorder НЕ вызывает запись в инвертор (нет обращений к control/write).
- [ ] **Step 3: Прогнать** → PASS. **Step 4: Commit** — `test(stats): recorder — события из диффа снапшотов, буфер/флаш`.

---

## Фаза 5 — auth + server/HTTP + миграция selfcheck-auth*.ts

### Task 9: auth/hash.ts + auth/policy.ts

**Files:**
- Test: `server/src/auth/hash.test.ts`, `server/src/auth/policy.test.ts`
- Sources: `src/auth/hash.ts`, `src/auth/policy.ts`
- Reference: `scripts/selfcheck-auth.ts`

- [ ] **Step 1: Прочитать `hash.ts`, `policy.ts`, `selfcheck-auth.ts`** — сигнатуры и ожидаемые значения.
- [ ] **Step 2: Написать `hash.test.ts`** — кейсы:
  - `hash(password)` → строка с солью; `verify(password, hash)` = true.
  - Неверный пароль → `verify` = false.
  - Два хеша одного пароля различаются (разная соль).
- [ ] **Step 3: Написать `policy.test.ts`** — таблица истинности `canAccess`:
  - `admin` имеет доступ ко всему (admin-required и viewer-required).
  - `viewer` — доступ к viewer-required, отказ на admin-required.
- [ ] **Step 4: Прогнать оба** → PASS. **Step 5: Commit** — `test(auth): hash + policy (миграция selfcheck-auth)`.

### Task 10: auth/db.ts + auth/service.ts

**Files:**
- Test: `server/src/auth/db.test.ts`, `server/src/auth/service.test.ts`
- Sources: `src/auth/db.ts`, `src/auth/service.ts`

- [ ] **Step 1: Прочитать `db.ts`, `service.ts`** — конструкторы (использовать `:memory:`), методы, anti-brute-force параметры.
- [ ] **Step 2: Написать `db.test.ts`** — кейсы:
  - Сидинг admin/user при пустой БД (проверить наличие двух пользователей и ролей).
  - CRUD: создание/поиск/удаление пользователя, уникальность имени.
  - Сессии: создание/поиск/удаление сессии по токену.
- [ ] **Step 3: Написать `service.test.ts`** с fake timers — кейсы:
  - Успешный логин → сессия + роль.
  - Неверный пароль → отказ, счётчик попыток растёт.
  - Lockout по IP после N неудач; сброс после окна (advance timers).
  - Смена пароля снимает `must_change_password`.
- [ ] **Step 4: Прогнать** (Node 24) → PASS. **Step 5: Commit** — `test(auth): db + service — сессии, роли, anti-brute-force`.

### Task 11: server.ts — REST + WS + auth-гейты (supertest)

**Files:**
- Test: `server/src/server.http.test.ts`
- Source: `src/server.ts`
- Reference: `scripts/selfcheck-auth-http.ts` (перенести сценарии)

- [ ] **Step 1: Прочитать `server.ts` и `selfcheck-auth-http.ts`** — как создаётся app (`createServer`), какие роуты, как инжектится `Inverter` (использовать mock-транспорт или фейковый Inverter), как поднимается WS.
- [ ] **Step 2: Написать `server.http.test.ts`** через `supertest(app)` — сценарии из selfcheck-auth-http:
  - Без сессии → `/api/*` отдаёт 401/редирект; `/login` доступен.
  - Логин admin → cookie сессии; доступ к admin-роутам.
  - Логин viewer → 403 на admin-роутах, 200 на `/` и `/stats`.
  - `must_change_password` → весь `/api` кроме `me`/`change-password`/`logout` заблокирован.
  - Lockout по IP (trust proxy + `req.ip`) после серии неудачных логинов.
  - (Опц.) WS `/ws` пушит snapshot после апгрейда — через `ws`-клиент к поднятому серверу.
- [ ] **Step 3: Прогнать** → PASS. Закрывать сервер/Inverter в `afterAll`.
- [ ] **Step 4: Commit** — `test(server): HTTP-флоу авторизации через supertest (миграция selfcheck-auth-http)`.

---

## Фаза 6 — config, store, mqtt, inverter

### Task 12: config.ts + store.ts

**Files:**
- Test: `server/src/config.test.ts`, `server/src/store.test.ts`
- Sources: `src/config.ts`, `src/store.ts`

- [ ] **Step 1: Прочитать `config.ts`, `store.ts`.**
- [ ] **Step 2: `config.test.ts`** — сохранять/восстанавливать `process.env` в `beforeEach`/`afterEach`; кейсы:
  - Дефолты при пустом env: `INVERTER_BAUD` = 9600, `MODBUS_SLAVE_ID` = 1, transport = `auto`.
  - Переопределение из env (baud/slave/transport).
  - Булевы флаги `ALLOW_CONTROL`/`STARTUP_LOCKED`/`AUTO_RELOCK` парсятся из строк.
- [ ] **Step 3: `store.test.ts`** — мок `node:fs`; кейсы: чтение существующего baseline, отсутствие файла → null/дефолт, запись baseline на диск (проверить вызов write с корректным JSON).
- [ ] **Step 4: Прогнать** → PASS. **Step 5: Commit** — `test(server): config (env-дефолты) + store (baseline на моках fs)`.

### Task 13: mqtt.ts

**Files:**
- Test: `server/src/mqtt.test.ts`
- Source: `src/mqtt.ts`

- [ ] **Step 1: Прочитать `mqtt.ts`** — как импортируется `mqtt`, что публикуется, автодискавери HA, gate управления.
- [ ] **Step 2: Замокать `mqtt`** (`jest.mock("mqtt")` с фейковым клиентом: `publish`, `on`, `subscribe`).
- [ ] **Step 3: `mqtt.test.ts`** — кейсы:
  - При `MQTT_URL` пустом — клиент не создаётся (модуль выключен).
  - При заданном URL — публикация snapshot в правильные топики.
  - HA-автодискавери: публикуются config-топики устройств.
  - Управление через MQTT работает только при `MQTT_ENABLE_CONTROL=true` (иначе входящее сообщение игнорируется); проверить `bypassLock`.
- [ ] **Step 4: Прогнать** → PASS. **Step 5: Commit** — `test(mqtt): публикация, HA-дискавери, gate управления на моках`.

### Task 14: inverter.ts — ядро

**Files:**
- Test: `server/src/inverter.test.ts`
- Source: `src/inverter.ts`

- [ ] **Step 1: Прочитать `inverter.ts`** — конструктор (принимает transport?), методы `connect`/`enqueue`/`control`/`rawQuery`, события, параметры пейсинга/поллинга.
- [ ] **Step 2: `inverter.test.ts`** с mock-транспортом + `jest.useFakeTimers()` — кейсы:
  - `enqueue` сериализует команды с пейсингом 120 мс (две команды не идут одновременно; advance timers).
  - Probe при коннекте: чтение 201 с валидацией режима; невалидный режим → повтор/ошибка.
  - Поллинг: статус+аварии каждый цикл (эмитится `"snapshot"`), настройки раз в ~6 циклов и на первом цикле.
  - Автопереподключение после 3 подряд ошибок транспорта.
  - Захват baseline один раз на устройство (второй коннект не перезаписывает).
  - Гейты записи: `ALLOW_CONTROL=false` → `control()` бросает; `STARTUP_LOCKED` → заблокировано; `AUTO_RELOCK` → после успешной записи снова locked.
  - `rawQuery("R 201")` работает всегда; `rawQuery("W 331 3")` — под теми же гейтами, что `control()`.
- [ ] **Step 3: Прогнать** → PASS. Очищать таймеры/интервалы в `afterEach`.
- [ ] **Step 4: Commit** — `test(inverter): очередь/пейсинг, поллинг, probe, реконнект, гейты записи`.

### Task 15: Миграция — удалить selfcheck, переопределить `check`, обновить доки

**Files:**
- Delete: `server/scripts/selfcheck.ts`, `selfcheck-stats.ts`, `selfcheck-auth.ts`, `selfcheck-auth-http.ts`
- Modify: `server/package.json`, корневой `package.json`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Убедиться**, что все 4 selfcheck покрыты jest-тестами (Task 2,3,7,9,10,11). Прогнать полный `npm test -w server` → PASS.
- [ ] **Step 2: Удалить** 4 файла `scripts/selfcheck*.ts` (оставить `reset-password.ts`).
- [ ] **Step 3: Переопределить** `server/package.json` `"check": "jest"`.
- [ ] **Step 4: Обновить `CLAUDE.md`** (раздел «Команды», строки про 4 selfcheck и «основной тест») и `README.md` — заменить описание на jest.
- [ ] **Step 5: Прогнать** `npm run check -w server` → jest зелёный. Проверить `git status`.
- [ ] **Step 6: Commit** — `test(server): миграция selfcheck → jest завершена, обновлены check и доки`.

---

## Фаза 7 — Инфраструктура web

### Task 16: Установка и конфигурация jest для web

**Files:**
- Modify: `web/package.json`
- Create: `web/jest.config.ts`, `web/jest.setup.ts`
- Create: `web/lib/__sanity__/sanity.test.ts`

- [ ] **Step 1: Установить**
```bash
npm install -w web -D jest@^29 jest-environment-jsdom@^29 @types/jest@^29 \
  @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14 \
  jest-canvas-mock@^2
```

- [ ] **Step 2: `web/jest.config.ts`** через next/jest:
```ts
import nextJest from "next/jest.js";
const createJestConfig = nextJest({ dir: "./" });
const config = {
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    "^@inverter/shared$": "<rootDir>/../shared/src/index.ts",
  },
  collectCoverageFrom: [
    "lib/**/*.{ts,tsx}",
    "components/**/*.{ts,tsx}",
    "app/**/*.{ts,tsx}",
    "!**/*.d.ts",
  ],
  coverageReporters: ["text", "html"],
  clearMocks: true,
};
export default createJestConfig(config);
```

- [ ] **Step 3: `web/jest.setup.ts`**:
```ts
import "@testing-library/jest-dom";
import "jest-canvas-mock";
```

- [ ] **Step 4: `web/package.json` scripts**: `"test": "jest"`, `"test:coverage": "jest --coverage"`.

- [ ] **Step 5: sanity `web/lib/__sanity__/sanity.test.ts`**:
```tsx
import { render, screen } from "@testing-library/react";
it("jsdom renders", () => {
  render(<div>hello</div>);
  expect(screen.getByText("hello")).toBeInTheDocument();
});
```

- [ ] **Step 6: Прогнать** `npm test -w web -- lib/__sanity__` → PASS.
- [ ] **Step 7: Commit** — `test(web): инфраструктура jest (next/jest, jsdom, RTL, canvas-мок)`.

---

## Фаза 8 — web/lib + web/components

### Task 17: web/lib — чистые модули (format, api, stats, i18n)

**Files:**
- Test: `web/lib/format.test.ts`, `web/lib/api.test.ts`, `web/lib/stats.test.ts`, `web/lib/i18n/i18n.test.tsx`
- Sources: соответствующие файлы

- [ ] **Step 1: Прочитать** `lib/format.ts`, `lib/api.ts`, `lib/stats.ts`, `lib/i18n/index.tsx`, `lib/i18n/dict.ts`.
- [ ] **Step 2: `format.test.ts`** — форматтеры значений (числа/единицы) на конкретных вход→выход.
- [ ] **Step 3: `api.test.ts`** — `wsUrl()` возвращает `ws://localhost:3000` в dev и относительный/прод-URL в прод (мокать `window.location` / env-признак dev).
- [ ] **Step 4: `stats.test.ts`** — клиент `/api/stats/*` с `global.fetch = jest.fn()`: корректные URL/парсинг ответа, обработка ошибки fetch.
- [ ] **Step 5: `i18n.test.tsx`** — провайдер стартует с `uk`; переключение языка; словарь содержит одинаковый набор ключей для UA/RU/EN (инвариант — проход по ключам).
- [ ] **Step 6: Прогнать** → PASS. **Step 7: Commit** — `test(web/lib): format, api(wsUrl), stats(fetch), i18n`.

### Task 18: web/lib — провайдеры с контекстом (snapshot, meta, toast)

**Files:**
- Test: `web/lib/snapshot.test.tsx`, `web/lib/meta.test.tsx`, `web/lib/toast.test.tsx`
- Sources: соответствующие файлы

- [ ] **Step 1: Прочитать** `snapshot.tsx`, `meta.tsx`, `toast.tsx`.
- [ ] **Step 2: `snapshot.test.tsx`** — замокать `WebSocket` (класс-заглушка с `onmessage`/`onclose`): получение snapshot обновляет контекст; закрытие сокета → реконнект + пометка stale.
- [ ] **Step 3: `meta.test.tsx`** — мок `fetch`: загрузка `ApiMeta` с ретраем при ошибке; несёт сессию/роль.
- [ ] **Step 4: `toast.test.tsx`** — добавление тоста рендерит сообщение; автоскрытие по таймеру (fake timers); закрытие по клику (user-event).
- [ ] **Step 5: Прогнать** → PASS. **Step 6: Commit** — `test(web/lib): провайдеры snapshot/meta/toast на моках WS/fetch`.

### Task 19: web/components

**Files:**
- Test: `web/components/{BatteryRing,Panel,ConfirmDialog,LangSwitch,TimeChart}.test.tsx`
- Sources: соответствующие компоненты

- [ ] **Step 1: Прочитать** пять компонентов, зафиксировать пропсы.
- [ ] **Step 2: Тесты (RTL)** — по одному файлу на компонент:
  - `Panel` — рендерит заголовок и children.
  - `BatteryRing` — рендерит переданный процент/цвет (проверить текст/атрибут).
  - `ConfirmDialog` — показывает сообщение; клик «подтвердить»/«отмена» вызывает соответствующий колбэк (user-event).
  - `LangSwitch` — переключение языка вызывает смену (в связке с i18n-провайдером или мок-колбэком).
  - `TimeChart` — монтируется без ошибок под `jest-canvas-mock`; при пустых данных не падает.
- [ ] **Step 3: Прогнать** → PASS. **Step 4: Commit** — `test(web/components): BatteryRing, Panel, ConfirmDialog, LangSwitch, TimeChart`.

---

## Фаза 9 — web/app страницы

### Task 20: Тестовые обёртки провайдеров + страницы

**Files:**
- Create: `web/test-utils/renderWithProviders.tsx`
- Test: `web/app/**/page.test.tsx` (по странице)
- Sources: страницы `app/(app)/*`, `app/login`, `app/change-password`

**Interfaces:**
- Produces: `renderWithProviders(ui, { role, snapshot, meta })` — оборачивает компонент в мок-провайдеры i18n/snapshot/meta/toast.

- [ ] **Step 1: Прочитать** страницы и их зависимости от контекстов; выяснить, что мокать (WS, fetch, `next/navigation`).
- [ ] **Step 2: Создать `renderWithProviders.tsx`** — единая обёртка с настраиваемыми моками контекстов; мок `next/navigation` (`useRouter`/`redirect`).
- [ ] **Step 3: Тесты страниц** (по возможности; при чрезмерной хрупкости конкретной страницы — зафиксировать как известное ограничение в финальном отчёте, Task 21):
  - `login` — форма, сабмит вызывает вход (мок fetch), ошибка показывает сообщение.
  - `change-password` — валидация подтверждения пароля, сабмит.
  - Дашборд `(app)/page` — рендерит данные из snapshot-мока.
  - `stats` — рендерит графики из stats-мока (canvas-мок).
  - `settings` — рендерит справочники из meta-мока; viewer не видит admin-контролов.
  - `users` — admin видит список/форму; viewer получает редирект (мок navigation).
  - `diagnostics` — рендер raw-запросов.
- [ ] **Step 4: Прогнать** каждый файл → PASS. **Step 5: Commit** — `test(web/app): страницы через мок-провайдеры`.

---

## Фаза 10 — Финал

### Task 21: Полный прогон coverage и корневой скрипт

**Files:**
- Modify: корневой `package.json`

- [ ] **Step 1: Добавить корневые scripts**:
```json
"test": "npm test -w server && npm test -w web",
"test:coverage": "npm run test:coverage -w server && npm run test:coverage -w web"
```

- [ ] **Step 2: Прогнать всё под Node 24**: `nvm use && npm test` → server и web зелёные.
- [ ] **Step 3: Прогнать coverage**: `npm run test:coverage` → отчёты `text` в консоли, `html` в `*/coverage/`.
- [ ] **Step 4: Записать краткий отчёт** о покрытии и известных ограничениях (если какие-то страницы web/app не покрыты) в конец спеки или в `docs/superpowers/plans/`.
- [ ] **Step 5: Commit** — `test: корневой npm test/coverage, финальный прогон монорепо`.

- [ ] **Step 6: Финализация ветки** — при завершении использовать superpowers:finishing-a-development-branch (PR/merge по правилам репо; в `main` не мержить без явного подтверждения владельца).

---

## Self-review заметки

- Все 4 selfcheck покрыты: `selfcheck.ts` → Task 2+3; `selfcheck-stats.ts` → Task 7; `selfcheck-auth.ts` → Task 9+10; `selfcheck-auth-http.ts` → Task 11. Удаление — Task 15 (после подтверждения покрытия).
- Coverage-исключения (index.ts, types.ts, *.d.ts) заданы в конфигах (Task 1, Task 16), thresholds отсутствуют — совпадает со спекой.
- Node 24 (node:sqlite) — в Global Constraints и в шагах Task 7/10.
- `@inverter/shared` маппинг — в обоих конфигах (Task 1, Task 16).
- Задачи, требующие чтения исходника перед написанием (transport, stats, auth-db/service, mqtt, inverter, web) начинаются с явного шага «Прочитать <источник>» — тесты пишутся против реального поведения (TDD-цикл: тест → прогон → зелёный → коммит).
