# Power-Source Indicator («От солнца») Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Значок режима в шапке дашборда получает третье состояние «От солнца», которое сервер выводит из телеметрии и публикует в снапшоте — а значит, и в MQTT/Home Assistant и MCP.

**Architecture:** Чистый модуль `shared/src/source.ts` считает мгновенного кандидата (`instantSource`) и гасит дребезг редьюсером (`stepSource`). `Inverter` держит состояние гистерезиса полем класса, прогоняет его в конце каждого цикла поллинга и кладёт результат в новое обязательное поле `Snapshot.powerSource`. Все потребители (веб, MQTT, MCP) читают готовое значение — своей логики не имеют.

**Tech Stack:** TypeScript 5.4, Node ≥ 24, npm workspaces (`shared` → `mcp` → `server` → `web`), jest + ts-jest, Next.js 15 (App Router, static export), mqtt.js.

Спека: `docs/superpowers/specs/2026-07-28-power-source-indicator-design.md`.

## Global Constraints

- **Node ≥ 24 обязателен.** Локальный дефолт — v20, поэтому каждую команду запускать с префиксом `export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"`. На Node 20 тесты падают не на ассертах, а на загрузке модуля: `No such built-in module: node:sqlite`.
- **Порядок сборки строго `shared → mcp → server → web`.** Jest сервера читает `@inverter/shared` из исходников (`moduleNameMapper` в `server/jest.config.cjs`), поэтому серверным тестам сборка не нужна. А `web` и `mcp` тянут `@inverter/shared` из собранного `dist/` — перед их тайпчеком/тестами нужен `npm run build -w shared`.
- **Пороги — константы в модуле, env-переменных не добавляем:** `PV_MIN_W = 50`, `DISCHARGE_EPS_A = 0.5`, `SWITCH_AFTER = 2`.
- **Масштабирование значений — делением** (`/10`, `/100`), никогда умножением на 0.1. В этой работе новых декодеров нет, но правило действует, если придётся трогать `smg.ts`.
- **Сообщения коммитов — на английском**, conventional commits (`feat(shared): …`, `feat(web): …`). Общение с владельцем — на русском.
- **Работа идёт в ветке `feat/power-source-indicator`** (уже создана, в ней лежит коммит спеки). В `main` не мержить без явного «да» владельца.
- **Ничего не деплоить на Pi** без явной просьбы владельца.

---

## File Structure

**Создаются:**

| Файл | Ответственность |
|---|---|
| `shared/src/source.ts` | Чистый вывод источника питания: константы, `instantSource`, `stepSource`, `initialSourceState`. Без БД, сети, таймеров и `Date.now()`. |
| `shared/src/source.test.ts` | Unit-тесты обеих функций. Живёт в `shared/src`, гоняется jest'ом сервера. |

**Модифицируются:**

| Файл | Что меняется |
|---|---|
| `shared/src/types.ts` | Тип `PowerSource`; обязательное поле `powerSource` в `Snapshot`. |
| `shared/src/index.ts` | Реэкспорт `./source`. |
| `server/jest.config.cjs` | `shared/src/source.ts` в `collectCoverageFrom`. |
| `server/src/inverter.ts` | Поле `sourceState`, расчёт в цикле поллинга, сброс при дисконнекте, `powerSource` в дефолтном снапшоте и в `setConnection`. |
| `server/src/inverter.test.ts` | Тесты расчёта в цикле, гистерезиса и сброса. |
| `server/src/mqtt.ts` | Сенсор `power_source` в `SENSORS` + значение в payload. |
| `server/src/mqtt.test.ts` | `powerSource` в фикстуре `makeSnapshot`; тесты дискавери и payload. |
| `server/src/stats/recorder.test.ts` | `powerSource` в фикстуре `snapshot()`. |
| `mcp/src/testing/fake-gateway.ts` | `powerSource` в `FAKE_SNAPSHOT`. |
| `mcp/src/format.test.ts` | `powerSource` в литерале снапшота. |
| `web/test-utils/renderWithProviders.tsx` | `powerSource` в фикстуре `buildSnapshot`. |
| `web/app/(app)/layout.tsx` | Бейдж читает `powerSource` вместо `mode`. |
| `web/app/(app)/layout.test.tsx` | Тест бейджа «От солнца». |
| `web/lib/i18n/dict.ts` | Ключ `modeSolar` в три словаря. |
| `web/app/globals.css` | Правило `.mode-Solar`. |

---

### Task 1: Контракт и чистый вывод источника (`shared/`)

Задача добавляет тип, обязательное поле и чистую логику, а затем возвращает монорепо в компилируемое состояние: обязательное поле ломает шесть литералов снапшота, все они правятся здесь же.

**Files:**
- Create: `shared/src/source.ts`
- Create: `shared/src/source.test.ts`
- Modify: `shared/src/types.ts` (после `DeviceMode`, ~строка 94; и в `Snapshot` после `mode: DeviceMode;`, ~строка 108)
- Modify: `shared/src/index.ts`
- Modify: `server/jest.config.cjs` (массив `collectCoverageFrom`)
- Modify: `server/src/inverter.ts:63` (дефолтный снапшот)
- Modify: `server/src/mqtt.test.ts` (хелпер `makeSnapshot`, ~строка 201)
- Modify: `server/src/stats/recorder.test.ts` (хелпер `snapshot`, ~строка 32)
- Modify: `mcp/src/testing/fake-gateway.ts:17` (`FAKE_SNAPSHOT`)
- Modify: `mcp/src/format.test.ts:17`
- Modify: `web/test-utils/renderWithProviders.tsx:243` (`buildSnapshot`)
- Test: `shared/src/source.test.ts`

**Interfaces:**
- Consumes: `DeviceMode`, `InverterStatus`, `Snapshot` из `shared/src/types.ts`.
- Produces:
  - `type PowerSource = DeviceMode | "Solar"`
  - `interface SourceState { shown: PowerSource; pending: PowerSource; count: number }`
  - `const PV_MIN_W = 50`, `const DISCHARGE_EPS_A = 0.5`, `const SWITCH_AFTER = 2`
  - `initialSourceState(shown?: PowerSource): SourceState`
  - `instantSource(mode: DeviceMode, status: InverterStatus | null): PowerSource`
  - `stepSource(prev: SourceState, candidate: PowerSource): SourceState`
  - `Snapshot.powerSource: PowerSource` (обязательное)

- [ ] **Step 1: Написать падающий тест**

Создать `shared/src/source.test.ts`:

```ts
/**
 * Unit-тесты чистого вывода источника питания (shared/src/source.ts).
 *
 * Гоняются jest'ом сервера: его конфиг держит `shared/src` в `roots`
 * (server/jest.config.cjs) — тот же приём, что у settings.test.ts.
 */
import {
  DISCHARGE_EPS_A,
  PV_MIN_W,
  initialSourceState,
  instantSource,
  stepSource,
} from "./source";
import type { InverterStatus } from "./types";

/** Полный статус с нулевым солнцем и спокойной батареей; переопределяем нужное. */
function status(over: Partial<InverterStatus> = {}): InverterStatus {
  return {
    gridVoltage: 0,
    gridFrequency: 0,
    mainsPower: 0,
    inverterPower: 300,
    acOutputVoltage: 230,
    acOutputFrequency: 50,
    acOutputActivePower: 300,
    acOutputApparentPower: 350,
    outputLoadPercent: 6,
    batteryVoltage: 52,
    batteryPower: 0,
    batteryChargingCurrent: 0,
    batteryDischargeCurrent: 0,
    batteryCapacity: 70,
    pvInputVoltage: 300,
    pvInputCurrent: 3,
    pvPower: 0,
    pvChargingPower: 0,
    dcdcTemperature: 30,
    heatSinkTemperature: 35,
    raw: "",
    ...over,
  };
}

describe("instantSource — мгновенный кандидат по одному замеру", () => {
  it("ночью в автономе остаётся Battery: выработки нет", () => {
    expect(instantSource("Battery", status({ pvPower: 0 }))).toBe("Battery");
  });

  it("на рассвете остаётся Battery: солнце есть, но банка всё ещё разряжается", () => {
    expect(instantSource("Battery", status({ pvPower: 400, batteryDischargeCurrent: 4 }))).toBe("Battery");
  });

  it("даёт Solar, когда есть выработка и из батареи ничего не течёт", () => {
    expect(instantSource("Battery", status({ pvPower: 900, batteryDischargeCurrent: 0 }))).toBe("Solar");
  });

  it("даёт Solar и при профиците, уходящем в заряд", () => {
    const s = status({ pvPower: 1800, pvChargingPower: 1200, batteryChargingCurrent: 20 });
    expect(instantSource("Battery", s)).toBe("Solar");
  });

  it("не подменяет режим Line даже при ярком солнце: нагрузку тянет сеть", () => {
    expect(instantSource("Line", status({ pvPower: 1500 }))).toBe("Line");
  });

  it("не подменяет режим Charging", () => {
    expect(instantSource("Charging", status({ pvPower: 1500 }))).toBe("Charging");
  });

  it("возвращает режим как есть, когда статуса нет", () => {
    expect(instantSource("Battery", null)).toBe("Battery");
  });

  it("трактует NaN в выработке как «не солнце»", () => {
    expect(instantSource("Battery", status({ pvPower: NaN }))).toBe("Battery");
  });

  it("трактует NaN в токе разряда как «не солнце»", () => {
    expect(instantSource("Battery", status({ pvPower: 900, batteryDischargeCurrent: NaN }))).toBe("Battery");
  });

  it("порог выработки строгий: ровно PV_MIN_W не считается солнцем", () => {
    expect(instantSource("Battery", status({ pvPower: PV_MIN_W }))).toBe("Battery");
    expect(instantSource("Battery", status({ pvPower: PV_MIN_W + 1 }))).toBe("Solar");
  });

  it("допуск по разряду нестрогий: ровно DISCHARGE_EPS_A ещё считается солнцем", () => {
    const s = status({ pvPower: 900, batteryDischargeCurrent: DISCHARGE_EPS_A });
    expect(instantSource("Battery", s)).toBe("Solar");
  });
});

describe("stepSource — гистерезис в два замера подряд", () => {
  it("одиночный выброс не переключает показанное значение", () => {
    const s0 = initialSourceState("Battery");
    const s1 = stepSource(s0, "Solar");
    expect(s1.shown).toBe("Battery");
    expect(s1.pending).toBe("Solar");
    expect(s1.count).toBe(1);
  });

  it("два одинаковых замера подряд переключают", () => {
    let s = initialSourceState("Battery");
    s = stepSource(s, "Solar");
    s = stepSource(s, "Solar");
    expect(s.shown).toBe("Solar");
    expect(s.count).toBe(0);
  });

  it("смена кандидата на полпути начинает счёт заново", () => {
    let s = initialSourceState("Battery");
    s = stepSource(s, "Solar");
    s = stepSource(s, "Line"); // другой кандидат — счёт с 1, переключения нет
    expect(s.shown).toBe("Battery");
    expect(s.pending).toBe("Line");
    expect(s.count).toBe(1);
    s = stepSource(s, "Line");
    expect(s.shown).toBe("Line");
  });

  it("кандидат, равный показанному, сбрасывает ожидание", () => {
    let s = initialSourceState("Battery");
    s = stepSource(s, "Solar");
    s = stepSource(s, "Battery"); // облако ушло, вернулись к текущему
    expect(s).toEqual({ shown: "Battery", pending: "Battery", count: 0 });
  });

  it("облачный день не даёт переключений: кандидаты чередуются каждый замер", () => {
    let s = initialSourceState("Battery");
    for (const c of ["Solar", "Battery", "Solar", "Battery", "Solar"] as const) {
      s = stepSource(s, c);
    }
    expect(s.shown).toBe("Battery");
  });

  it("initialSourceState по умолчанию стартует с Unknown", () => {
    expect(initialSourceState()).toEqual({ shown: "Unknown", pending: "Unknown", count: 0 });
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- source.test
```

Ожидаемо: FAIL — `Cannot find module './source'`.

- [ ] **Step 3: Добавить тип `PowerSource` и поле в `Snapshot`**

В `shared/src/types.ts` сразу после объявления `DeviceMode` (заканчивается на `| "Unknown";`):

```ts
/**
 * Что фактически питает нагрузку прямо сейчас.
 *
 * Это НЕ регистр: режима «от солнца» у инвертора нет — работая от PV, он
 * рапортует `Battery`, потому что солнце идёт через батарейную шину. Значение
 * выводится из телеметрии (см. `source.ts`) и считается на сервере, чтобы
 * попасть во все каналы разом: WS, REST, MQTT/HA, MCP.
 */
export type PowerSource = DeviceMode | "Solar";
```

В интерфейсе `Snapshot` сразу после `mode: DeviceMode;`:

```ts
  /** Выведенный источник питания: то же, что `mode`, но с отдельным "Solar". */
  powerSource: PowerSource;
```

- [ ] **Step 4: Создать `shared/src/source.ts`**

```ts
/**
 * Вывод источника питания из телеметрии — чистый модуль.
 *
 * Зачем: у инвертора нет режима «от солнца» (регистр 201 знает только
 * PowerOn/Standby/Line/Battery/Bypass/Charging/Fault), поэтому состояние
 * приходится выводить. Здесь нет БД, сети, таймеров и Date.now() — всё
 * тестируется в отрыве, а состояние гистерезиса владелец модуля хранит сам.
 */
import type { DeviceMode, InverterStatus, PowerSource } from "./types";

/**
 * Порог выработки, ниже которого солнце источником не считается: отсекает
 * ночной ноль и шум датчика PV.
 */
export const PV_MIN_W = 50;

/**
 * Допуск по току разряда. 0.5 А на ~51 В — это ≈25 Вт, то есть шум измерения
 * регистра 232, а не осмысленная отдача батареи.
 */
export const DISCHARGE_EPS_A = 0.5;

/** Сколько подряд одинаковых замеров нужно, чтобы переключить показанное значение. */
export const SWITCH_AFTER = 2;

/**
 * Состояние гистерезиса. `shown` — то, что показывается наружу;
 * `pending`/`count` копят подряд идущие одинаковые кандидаты.
 */
export interface SourceState {
  shown: PowerSource;
  pending: PowerSource;
  count: number;
}

export function initialSourceState(shown: PowerSource = "Unknown"): SourceState {
  return { shown, pending: shown, count: 0 };
}

/**
 * Мгновенный кандидат по одному замеру, без сглаживания.
 *
 * "Solar" — только когда инвертор в автономном режиме, солнце реально даёт
 * мощность и при этом из батареи ничего не течёт: значит нагрузку тянет
 * исключительно PV. Условия записаны через отрицание (`!(a > b)`), чтобы NaN
 * в неполном замере автоматически означал «не солнце»: любое сравнение с NaN
 * даёт false.
 */
export function instantSource(mode: DeviceMode, status: InverterStatus | null): PowerSource {
  if (!status) return mode;
  if (mode !== "Battery") return mode;
  if (!(status.pvPower > PV_MIN_W)) return mode;
  if (!(status.batteryDischargeCurrent <= DISCHARGE_EPS_A)) return mode;
  return "Solar";
}

/**
 * Шаг гистерезиса: первый отличающийся кандидат только взводит ожидание,
 * второй подряд такой же — переключает. Смена кандидата на полпути начинает
 * счёт заново с 1, а кандидат, равный показанному, сбрасывает ожидание.
 */
export function stepSource(prev: SourceState, candidate: PowerSource): SourceState {
  if (candidate === prev.shown) {
    return { shown: prev.shown, pending: prev.shown, count: 0 };
  }
  const count = candidate === prev.pending ? prev.count + 1 : 1;
  if (count >= SWITCH_AFTER) {
    return { shown: candidate, pending: candidate, count: 0 };
  }
  return { shown: prev.shown, pending: candidate, count };
}
```

- [ ] **Step 5: Реэкспортировать модуль**

В `shared/src/index.ts` добавить строку после `export * from "./settings";`:

```ts
export * from "./source";
```

- [ ] **Step 6: Запустить тест и убедиться, что он проходит**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- source.test
```

Ожидаемо: PASS, 17 тестов (11 на `instantSource`, 6 на `stepSource`).

- [ ] **Step 7: Добавить модуль в сбор покрытия**

В `server/jest.config.cjs`, в массив `collectCoverageFrom`, после `"shared/src/auth.ts",`:

```js
    "shared/src/source.ts",
```

- [ ] **Step 8: Дополнить дефолтный снапшот сервера**

В `server/src/inverter.ts`, в литерале `private snapshot` — строка после `mode: "Unknown",`:

```ts
    powerSource: "Unknown",
```

- [ ] **Step 9: Дополнить пять фикстур снапшота**

Обязательное поле ломает компиляцию во всех литералах `Snapshot`. Правки механические — по строке в каждый:

`server/src/mqtt.test.ts`, в `makeSnapshot`: в объект `opts` добавить поле

```ts
    powerSource?: Snapshot["powerSource"];
```

а в возвращаемый литерал, после `mode: opts.mode ?? "Battery",`:

```ts
    powerSource: opts.powerSource ?? opts.mode ?? "Battery",
```

Отдельная опция нужна, потому что Task 3 проверяет именно случай, когда `powerSource` расходится с `mode` (`Battery` + `Solar`). По умолчанию поле совпадает с режимом, так что существующие тесты не меняются.

`server/src/stats/recorder.test.ts`, в хелпере `snapshot`, после `mode: opts.mode ?? "Battery",`:

```ts
    powerSource: opts.mode ?? "Battery",
```

`mcp/src/testing/fake-gateway.ts`, в `FAKE_SNAPSHOT`, после `mode: "Battery",`:

```ts
  powerSource: "Solar",
```

(В фикстуре MCP намеренно ставим `"Solar"`, а не `"Battery"`: она должна показывать, что поле отличается от `mode` — иначе рассинхрон с реальной схемой снова пройдёт незамеченным, как было с `soc_min`.)

`mcp/src/format.test.ts`, в литерале снапшота, после `mode: "Battery",`:

```ts
  powerSource: "Battery",
```

`web/test-utils/renderWithProviders.tsx`, в `buildSnapshot`, после `mode: "Line",`:

```ts
    powerSource: "Line",
```

- [ ] **Step 10: Прогнать все проверки монорепо**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm run build -w shared && npm run check
```

Ожидаемо: сборка `shared` проходит, `npm run check` зелёный целиком (mcp + server + тайпчек web). Если тайпчек web ругается на `powerSource` — значит `shared/dist` не пересобран; повторить `npm run build -w shared`.

- [ ] **Step 11: Коммит**

```bash
git add shared/src/source.ts shared/src/source.test.ts shared/src/types.ts shared/src/index.ts \
        server/jest.config.cjs server/src/inverter.ts server/src/mqtt.test.ts \
        server/src/stats/recorder.test.ts mcp/src/testing/fake-gateway.ts mcp/src/format.test.ts \
        web/test-utils/renderWithProviders.tsx
git commit -m "feat(shared): derive power source with hysteresis, add Snapshot.powerSource"
```

---

### Task 2: Расчёт в цикле поллинга (`server/src/inverter.ts`)

**Files:**
- Modify: `server/src/inverter.ts` (импорт; поле класса рядом с `private deviceId`, ~строка 56; `closeTransport()` ~строка 128; `setConnection()` ~строка 246; сборка снапшота в `poll()` ~строка 306)
- Test: `server/src/inverter.test.ts` (новый `describe` в конец файла)

**Interfaces:**
- Consumes: `initialSourceState`, `instantSource`, `stepSource`, `SourceState` из Task 1 (через `@inverter/shared`); `Snapshot.powerSource`.
- Produces: снапшот с актуальным `powerSource` — на него опираются Task 3 (MQTT) и Task 4 (веб).

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `server/src/inverter.test.ts`:

```ts
describe("powerSource — вывод источника питания с гистерезисом", () => {
  it("подменяет Battery на Solar после двух подряд солнечных циклов, не после первого", async () => {
    // 201=3 Battery, 223=900 Вт выработки, 232=0 (ни заряда, ни разряда)
    const t = new FakeTransport({ regs: fullRegs({ 201: 3, 223: 900, 232: 0 }) });
    detectTransportsMock.mockReturnValue([t]);
    const inv = makeInverter();
    const snaps: Snapshot[] = [];
    inv.on("snapshot", (s: Snapshot) => snaps.push(s));

    await connectAndFreeze(inv);

    // Первый поллинг: кандидат Solar только взводит ожидание.
    const first = await waitForSnapshot(snaps);
    expect(first.mode).toBe("Battery");
    expect(first.powerSource).toBe("Battery");

    // Второй подряд такой же — переключение.
    const second = await waitForSnapshot(snaps);
    expect(second.powerSource).toBe("Solar");
  });

  it("возвращается к Battery через два цикла, когда батарея начала разряжаться", async () => {
    const t = new FakeTransport({ regs: fullRegs({ 201: 3, 223: 900, 232: 0 }) });
    detectTransportsMock.mockReturnValue([t]);
    const inv = makeInverter();
    const snaps: Snapshot[] = [];
    inv.on("snapshot", (s: Snapshot) => snaps.push(s));

    await connectAndFreeze(inv);
    await waitForSnapshot(snaps);
    expect((await waitForSnapshot(snaps)).powerSource).toBe("Solar");

    // Солнце село: выработки нет, из банки течёт 4.0 А (232 = -40).
    t.regs.set(223, 0);
    t.regs.set(232, 0x10000 - 40);

    expect((await waitForSnapshot(snaps)).powerSource).toBe("Solar"); // взвели ожидание
    expect((await waitForSnapshot(snaps)).powerSource).toBe("Battery"); // переключились
  });

  it("не подменяет режим Line даже при полном солнце", async () => {
    // 201=2 Line
    const t = new FakeTransport({ regs: fullRegs({ 201: 2, 223: 1500, 232: 0 }) });
    detectTransportsMock.mockReturnValue([t]);
    const inv = makeInverter();
    const snaps: Snapshot[] = [];
    inv.on("snapshot", (s: Snapshot) => snaps.push(s));

    await connectAndFreeze(inv);
    await waitForSnapshot(snaps);
    const s = await waitForSnapshot(snaps);
    expect(s.mode).toBe("Line");
    expect(s.powerSource).toBe("Line");
  });

  it("сбрасывает источник в Unknown на отключении, чтобы Solar не залежался", async () => {
    const t = new FakeTransport({ regs: fullRegs({ 201: 3, 223: 900, 232: 0 }) });
    detectTransportsMock.mockReturnValue([t]);
    const inv = makeInverter();
    const snaps: Snapshot[] = [];
    inv.on("snapshot", (s: Snapshot) => snaps.push(s));

    await connectAndFreeze(inv);
    await waitForSnapshot(snaps);
    expect((await waitForSnapshot(snaps)).powerSource).toBe("Solar");

    // Связь пропала — poll() ловит ошибку и эмитит отключённый снапшот.
    t.failAll = true;
    const dead = await waitForSnapshot(snaps);
    expect(dead.connection.connected).toBe(false);
    expect(dead.powerSource).toBe("Unknown");
  });

  it("отдаёт Unknown в снапшоте до первого успешного поллинга", () => {
    const inv = makeInverter();
    expect(inv.getSnapshot().powerSource).toBe("Unknown");
  });
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- inverter.test
```

Ожидаемо: FAIL — `powerSource` в снапшотах поллинга остаётся `"Unknown"` (`Expected "Solar", received "Unknown"`). Последний тест (`до первого поллинга`) пройдёт сразу: дефолт добавлен в Task 1.

- [ ] **Step 3: Расширить импорт из `@inverter/shared`**

В `server/src/inverter.ts` строка 24 сейчас:

```ts
import { Snapshot, DeviceMode, Baseline, ControlType } from "@inverter/shared";
```

Заменить на:

```ts
import {
  Snapshot,
  DeviceMode,
  Baseline,
  ControlType,
  SourceState,
  initialSourceState,
  instantSource,
  stepSource,
} from "@inverter/shared";
```

- [ ] **Step 4: Добавить поле состояния**

В `server/src/inverter.ts` рядом с остальными полями класса, сразу после `private deviceId: string | null = null;`:

```ts
  /** Состояние гистерезиса выведенного источника питания (см. shared/src/source.ts). */
  private sourceState: SourceState = initialSourceState();
```

- [ ] **Step 5: Считать источник в цикле поллинга**

В `poll()`, сразу после строки `const mode: DeviceMode = decodeMode(statusRegs.get(201) ?? -1);` добавить:

```ts
      this.sourceState = stepSource(this.sourceState, instantSource(mode, status));
```

И в собираемый литерал снапшота (там, где `this.consecutiveFailures = 0;` и `this.snapshot = {`), сразу после строки `mode,`:

```ts
        powerSource: this.sourceState.shown,
```

- [ ] **Step 6: Сбрасывать состояние на отключении и смене устройства**

В `closeTransport()`, после строки `this.ratedCounter = 0; // so settings are re-read on the first poll after reconnect`:

```ts
    this.sourceState = initialSourceState(); // иначе после реконнекта всплывёт залежавшийся "Solar"
```

В `setConnection()` литерал сейчас спредит прошлый снапшот. Добавить в него после блока `connection: { … },` строку:

```ts
      powerSource: connected ? this.snapshot.powerSource : "Unknown",
```

и сразу перед `this.snapshot = {` в том же методе:

```ts
    if (!connected) this.sourceState = initialSourceState();
```

Смысл: пока связь есть, `setConnection` не должен трогать выведенный источник (его владелец — цикл поллинга). Как только связь потеряна, показывать «От солнца» нельзя — это ввело бы в заблуждение сильнее, чем устаревший `mode`.

- [ ] **Step 7: Запустить тесты и убедиться, что они проходят**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- inverter.test
```

Ожидаемо: PASS, включая пять новых тестов.

- [ ] **Step 8: Прогнать все серверные тесты — расчёт трогает общий путь снапшота**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server
```

Ожидаемо: зелёно целиком.

- [ ] **Step 9: Коммит**

```bash
git add server/src/inverter.ts server/src/inverter.test.ts
git commit -m "feat(server): compute powerSource each poll cycle, reset it on disconnect"
```

---

### Task 3: Сенсор для Home Assistant (`server/src/mqtt.ts`)

Та часть, ради которой выбран серверный вариант: по сущности «источник питания» владелец будет писать автоматизации.

**Files:**
- Modify: `server/src/mqtt.ts` (массив `SENSORS`, ~строка 38; литерал payload, ~строка 260)
- Test: `server/src/mqtt.test.ts`

**Interfaces:**
- Consumes: `Snapshot.powerSource` из Task 1, заполняемый в Task 2.
- Produces: MQTT-топик `<baseTopic>/state` с полем `power_source` и retained-конфиг дискавери для сенсора `power_source`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `server/src/mqtt.test.ts` в конец файла. Хелперы `baseConfig`, `fakeInverter`, `startConnected(cfg, inverter)` и `configTopics(client)` в файле уже есть — используем их как есть:

```ts
describe("HaMqtt — сенсор источника питания", () => {
  it("объявляет power_source в автодискавери HA", () => {
    const cfg = baseConfig({ enableControl: false });
    const inverter = fakeInverter(makeSnapshot());
    const { client } = startConnected(cfg, inverter);

    const call = configTopics(client).find(
      ([topic]) => topic === "homeassistant/sensor/test-node/power_source/config"
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call![1])).toEqual(
      expect.objectContaining({
        name: "Источник питания",
        unique_id: "test-node_power_source",
        state_topic: "inverter/test-node/state",
        value_template: "{{ value_json.power_source }}",
        icon: "mdi:solar-power-variant",
      })
    );
  });

  it("публикует power_source в состоянии, отдельно от mode", () => {
    const cfg = baseConfig({ enableControl: false });
    const inverter = fakeInverter(makeSnapshot());
    const { client } = startConnected(cfg, inverter);
    client.publish.mockClear();

    inverter.emit("snapshot", makeSnapshot({ mode: "Battery", powerSource: "Solar" }));

    const state = client.publish.mock.calls.find(([topic]) => String(topic).endsWith("/state"));
    expect(state).toBeDefined();
    const body = JSON.parse(String(state![1]));
    expect(body.mode).toBe("Battery");
    expect(body.power_source).toBe("Solar");
  });
});
```

- [ ] **Step 1b: Поправить существующий счётчик сенсоров дискавери**

Новый сенсор ломает уже существующий тест `publishes one retained config topic per sensor/binary_sensor…`, который жёстко проверяет количество. В `server/src/mqtt.test.ts` заменить

```ts
    // 17 telemetry sensors + 3 binary_sensor (connected/problem/locked) + 4 settings-as-sensor.
    expect(configs).toHaveLength(24);
```

на

```ts
    // 18 telemetry sensors + 3 binary_sensor (connected/problem/locked) + 4 settings-as-sensor.
    expect(configs).toHaveLength(25);
```

Ровно этот счётчик и есть страховка от случайного добавления сущностей в HA, поэтому правим его осознанно, а не «чтобы позеленело».

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- mqtt.test
```

Ожидаемо: FAIL — конфиг `power_source` не публикуется (`expected length 1, received 0`).

- [ ] **Step 3: Объявить сенсор**

В `server/src/mqtt.ts`, в массиве `SENSORS`, сразу после строки `{ key: "mode", name: "Режим", icon: "mdi:power-settings" },`:

```ts
  { key: "power_source", name: "Источник питания", icon: "mdi:solar-power-variant" },
```

- [ ] **Step 4: Добавить значение в payload**

В том же файле, в литерале состояния, сразу после `mode: snap.mode,`:

```ts
      power_source: snap.powerSource,
```

- [ ] **Step 5: Запустить тесты и убедиться, что они проходят**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- mqtt.test
```

Ожидаемо: PASS.

- [ ] **Step 6: Коммит**

```bash
git add server/src/mqtt.ts server/src/mqtt.test.ts
git commit -m "feat(server): publish power_source as a Home Assistant sensor"
```

---

### Task 4: Бейдж в шапке (`web/`)

**Files:**
- Modify: `web/app/(app)/layout.tsx:31` и `:37`
- Modify: `web/lib/i18n/dict.ts` (три словаря: uk ~строка 15, ru ~строка 203, en ~строка 387)
- Modify: `web/app/globals.css` (после правила `.mode-Charging`, ~строка 124)
- Test: `web/app/(app)/layout.test.tsx`

**Interfaces:**
- Consumes: `Snapshot.powerSource` (Task 1), заполняемый сервером (Task 2); существующая `modeLabel(dict, value)` из `web/lib/i18n`.
- Produces: конечный UI. Дальше ничего не зависит.

- [ ] **Step 1: Написать падающий тест**

Добавить в `web/app/(app)/layout.test.tsx` после блока `describe("AppLayout — TopBar connection pill", …)`:

```tsx
describe("AppLayout — бейдж источника питания", () => {
  it("показывает выведенный источник, а не режим инвертора", async () => {
    const snapshot = buildSnapshot({ mode: "Battery", powerSource: "Solar" });
    await renderLayout(<div>child</div>, { snapshot });

    const badge = screen.getByText(t.modeSolar);
    expect(badge).toHaveClass("mode-badge", "mode-Solar");
    expect(screen.queryByText(t.modeBattery)).not.toBeInTheDocument();
  });

  it("показывает режим как есть, когда солнце не выведено", async () => {
    const snapshot = buildSnapshot({ mode: "Battery", powerSource: "Battery" });
    await renderLayout(<div>child</div>, { snapshot });

    expect(screen.getByText(t.modeBattery)).toHaveClass("mode-badge", "mode-Battery");
  });

  it("до первого снапшота показывает Unknown", async () => {
    const { container } = await renderLayout(<div>child</div>, { snapshot: null });

    // Запрос по классу, а не по тексту: `modeUnknown` — это "—", и такой же
    // текст без снапшота стоит в спане времени обновления, поэтому
    // getByText("—") нашёл бы два элемента и упал.
    const badge = container.querySelector(".mode-badge")!;
    expect(badge).toHaveClass("mode-Unknown");
    expect(badge).toHaveTextContent(t.modeUnknown);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w web -- layout.test
```

Ожидаемо: FAIL — `t.modeSolar` не определён (`Unable to find an element with the text: undefined`).

- [ ] **Step 3: Добавить ключ в три словаря**

В `web/lib/i18n/dict.ts` в украинский словарь, в строку рядом с `modeBattery`:

```ts
  modeSolar: "Від сонця",
```

В русский:

```ts
  modeSolar: "От солнца",
```

В английский:

```ts
  modeSolar: "Solar",
```

Ключ должен попасть в тип `Dict` — если он объявлен явным интерфейсом, добавить `modeSolar: string;` и туда; если выводится из украинского словаря, достаточно трёх строк выше.

- [ ] **Step 4: Переключить бейдж на `powerSource`**

В `web/app/(app)/layout.tsx` строка 31:

```tsx
  const mode = snapshot?.mode ?? "Unknown";
```

заменить на:

```tsx
  // Бейдж показывает выведенный источник питания, а не сырой режим: у инвертора
  // нет режима «от солнца», его считает сервер (shared/src/source.ts).
  const source = snapshot?.powerSource ?? "Unknown";
```

и строку 37:

```tsx
        <span className={"mode-badge mode-" + mode}>{modeLabel(t, mode)}</span>
```

на:

```tsx
        <span className={"mode-badge mode-" + source}>{modeLabel(t, source)}</span>
```

- [ ] **Step 5: Добавить стиль бейджа**

В `web/app/globals.css` сразу после строки `.mode-Charging { border-color: var(--moss-deep); color: var(--moss-deep); }`:

```css
.mode-Solar { background: var(--sun-deep); border-color: var(--sun-deep); color: var(--paper-0); } /* нагрузку тянет солнце */
```

- [ ] **Step 6: Запустить тест и убедиться, что он проходит**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w web -- layout.test
```

Ожидаемо: PASS.

- [ ] **Step 7: Прогнать веб целиком и тайпчек**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm run build -w shared && npm test -w web && npm run typecheck -w web
```

Ожидаемо: всё зелёное.

- [ ] **Step 8: Коммит**

```bash
git add web/app/\(app\)/layout.tsx web/app/\(app\)/layout.test.tsx web/lib/i18n/dict.ts web/app/globals.css
git commit -m "feat(web): show the derived power source in the header badge"
```

---

### Task 5: Финальная проверка и документация

**Files:**
- Modify: `README.md` (раздел `## ✨ Features` и раздел про MQTT/Home Assistant)
- Modify: `CLAUDE.md` (раздел про `shared/` и про `server/` слои)

**Interfaces:**
- Consumes: всё из Task 1–4.
- Produces: ничего в коде.

- [ ] **Step 1: Прогнать полный набор проверок монорепо**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm run build && npm test
```

Ожидаемо: сборка в порядке `shared → mcp → server → web` проходит, все три набора тестов зелёные. Никаких правок на этом шаге быть не должно — если что-то красное, чинить в соответствующей задаче.

- [ ] **Step 2: Проверить вживую в mock-режиме**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm run dev
```

Открыть `http://localhost:3001`. Mock-транспорт — полноценный эмулятор Modbus-slave с правдоподобной динамикой; убедиться, что бейдж в шапке отражает выведенный источник и меняется не чаще, чем раз в два цикла опроса. Остановить `npm run dev`.

- [ ] **Step 3: Обновить `README.md`**

В разделе `## ✨ Features` дополнить пункт про UI строкой о третьем состоянии бейджа: он показывает выведенный источник питания (сеть / батарея / солнце), причём «солнце» — это не режим инвертора, а вывод из телеметрии.

В разделе про Home Assistant дописать, что среди публикуемых сенсоров есть `power_source` — по нему удобно вешать автоматизации «работаем от солнца».

- [ ] **Step 4: Обновить `CLAUDE.md`**

В описании `shared/` добавить, что модуль держит ещё и чистый вывод источника питания (`source.ts`: `instantSource` + гистерезис `stepSource`), который считает сервер, а потребляют веб/MQTT/MCP.

В описании `server/src/inverter.ts` дописать, что ядро держит состояние гистерезиса источника и сбрасывает его при дисконнекте.

- [ ] **Step 5: Коммит**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document the derived power source in README and CLAUDE.md"
```

---

## Порядок и зависимости

Задачи строго последовательны: Task 1 задаёт контракт, без которого не компилируются остальные; Task 2 наполняет поле; Task 3 и Task 4 — независимые потребители (их можно поменять местами, но не запускать раньше Task 2, иначе тесты будут проверять всегда-`Unknown`); Task 5 закрывает работу.

## Чего этот план не делает

- Не добавляет событий смены источника в статистику — историю «когда было солнце» закрывает солнечное окно, а на переменной облачности такие события засорили бы журнал.
- Не добавляет env-переменных: пороги остаются константами.
- Не трогает карточку «Солнце» на дашборде, `SolarToday` и `SolarWindowPanel`.
- Не меняет `decodeMode`, карту регистров и `shared/src/registers.ts` — новых регистров нет.
- Не деплоит на Pi.
