# Solar Day Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Показывать за сутки ровно две устойчивые отметки — когда утром солнце стабильно начало давать энергию и когда вечером полностью прекратило, — вместо дребезжащих событий на каждое облако.

**Architecture:** Чистая функция `computeSolarWindow` (модуль `server/src/stats/solar.ts`) считает окно по поминутному ряду `pvPower`. Она — единственный источник правды: `db.ts` зовёт её при суточной свёртке (пишет в `daily`), при разовой миграции-бэкофилле и для живого «сегодня»; роут `/api/stats/solar-window` и UI — её потребители через API. Старая логика гистерезиса по `pvChargingPower` из `recorder.ts` удаляется.

**Tech Stack:** TypeScript, Node ≥ 24 (`node:sqlite`), Express, Jest, Next.js (App Router).

## Global Constraints

- **Сигнал окна — `pvPower` (регистр 223)**, вся выработка PV. НЕ `pvChargingPower`.
- **Дефолты чувствительности: порог `200` Вт, устойчивость `15` мин.** Тюнятся только через env, не хардкод в логике.
- **Node ≥ 24.** В неинтерактивных командах префикс: `export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"`.
- **Тесты — jest, рядом с исходником** (`*.test.ts`). `npm test -w server` и `npm test -w web`.
- **После правок в `server/src/stats/*` обязательно гонять `npm test -w server`.**
- **Не коммитить в `main`.** Работаем в ветке `feat/solar-day-window` (уже создана).
- **`ts` везде — unix-время в миллисекундах UTC**; суточные границы — по локальному TZ хоста.
- **`node:sqlite` печатает `ExperimentalWarning` в stderr — это норма, не ошибка.**

---

### Task 1: Чистая функция `computeSolarWindow`

**Files:**
- Create: `server/src/stats/solar.ts`
- Test: `server/src/stats/solar.test.ts`

**Interfaces:**
- Consumes: ничего (чистый модуль, без БД/сети/времени).
- Produces:
  - `type SolarState = "idle" | "active" | "ended"`
  - `interface SolarWindow { start: number | null; end: number | null; state: SolarState }`
  - `interface SolarParams { thresholdW: number; dwellMin: number }`
  - `interface SolarPoint { ts: number; pv: number }`
  - `function computeSolarWindow(points: SolarPoint[], params: SolarParams, nowMs?: number): SolarWindow`

- [ ] **Step 1: Написать падающий тест**

Создать `server/src/stats/solar.test.ts`:

```ts
import { computeSolarWindow, SolarParams, SolarPoint } from "./solar";

const P: SolarParams = { thresholdW: 200, dwellMin: 15 };
const MIN = 60_000;

/** Ряд поминутных точек: с ts0, по одной на минуту, значения pv из массива. */
function series(ts0: number, pv: number[]): SolarPoint[] {
  return pv.map((v, i) => ({ ts: ts0 + i * MIN, pv: v }));
}
/** Прямоугольный «прогон»: n минут подряд со значением v, начиная с ts0. */
function run(ts0: number, n: number, v: number): SolarPoint[] {
  return series(ts0, Array(n).fill(v));
}

describe("computeSolarWindow", () => {
  it("пустой ряд → idle, null/null", () => {
    expect(computeSolarWindow([], P)).toEqual({ start: null, end: null, state: "idle" });
  });

  it("полностью тёмный день (всё ниже порога) → idle", () => {
    expect(computeSolarWindow(run(0, 600, 50), P)).toEqual({ start: null, end: null, state: "idle" });
  });

  it("нормальный день: 07:00–19:00 выше порога → start=07:00, end=19:00, ended", () => {
    const day0 = new Date(2026, 0, 15, 0, 0, 0).getTime();
    const t7 = day0 + 7 * 60 * MIN;
    const pts = run(t7, 12 * 60 + 1, 800); // 07:00..19:00 включительно
    const w = computeSolarWindow(pts, P);
    expect(w.state).toBe("ended");
    expect(w.start).toBe(t7);
    expect(w.end).toBe(t7 + 12 * 60 * MIN);
  });

  it("рассветный всплеск (5 мин) отфильтровывается — начало у реального прогона", () => {
    const spike = run(0, 5, 900);              // 00:00..00:04 — 5 надпороговых минут < 15
    const real = run(60 * MIN, 120, 800);      // 01:00.. — 120 минут
    const w = computeSolarWindow([...spike, ...real], P);
    expect(w.start).toBe(60 * MIN);
    expect(w.end).toBe(60 * MIN + 119 * MIN);
  });

  it("закатный всплеск (5 мин) отфильтровывается — конец у реального прогона", () => {
    const real = run(0, 120, 800);                     // 00:00.. 120 минут
    const spike = run(300 * MIN, 5, 900);              // много позже, изолирован >15 мин тьмы
    const w = computeSolarWindow([...real, ...spike], P);
    expect(w.start).toBe(0);
    expect(w.end).toBe(119 * MIN);
  });

  it("длинное облако среди дня (30 мин ниже порога) — одна пара, конец у последнего прогона", () => {
    const morning = run(0, 120, 800);                          // 00:00..01:59
    const cloud = run(120 * MIN, 30, 0);                       // 30 мин тьмы (>15 → разрыв)
    const afternoon = run(150 * MIN, 120, 800);                // 02:30..04:29
    const w = computeSolarWindow([...morning, ...cloud, ...afternoon], P);
    expect(w.state).toBe("ended");
    expect(w.start).toBe(0);
    expect(w.end).toBe(150 * MIN + 119 * MIN);
  });

  it("короткое облако (10 мин < dwell) НЕ рвёт прогон", () => {
    const a = run(0, 60, 800);
    const gap = run(60 * MIN, 10, 0);          // 10 мин < 15 → мост
    const b = run(70 * MIN, 60, 800);
    const w = computeSolarWindow([...a, ...gap, ...b], P);
    expect(w.start).toBe(0);
    expect(w.end).toBe(70 * MIN + 59 * MIN);
  });

  it("граница: прогон ровно 15 надпороговых минут — засчитывается", () => {
    const w = computeSolarWindow(run(0, 15, 800), P);
    expect(w.state).toBe("ended");
    expect(w.start).toBe(0);
  });

  it("граница: прогон 14 минут — отбрасывается (idle)", () => {
    expect(computeSolarWindow(run(0, 14, 800), P).state).toBe("idle");
  });

  it("live: последний надпороговый ~5 мин назад → active, end=null", () => {
    const pts = run(0, 120, 800);              // до 01:59
    const now = 120 * MIN + 5 * MIN;           // 02:04
    const w = computeSolarWindow(pts, P, now);
    expect(w.state).toBe("active");
    expect(w.start).toBe(0);
    expect(w.end).toBeNull();
  });

  it("live: последний надпороговый >15 мин назад → ended, end проставлен", () => {
    const pts = run(0, 120, 800);              // до 01:59
    const now = 120 * MIN + 30 * MIN;          // 02:29
    const w = computeSolarWindow(pts, P, now);
    expect(w.state).toBe("ended");
    expect(w.start).toBe(0);
    expect(w.end).toBe(119 * MIN);
  });

  it("live без единого прогона → idle", () => {
    const w = computeSolarWindow(run(0, 10, 800), P, 100 * MIN);
    expect(w).toEqual({ start: null, end: null, state: "idle" });
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- src/stats/solar.test.ts
```
Ожидается: FAIL — `Cannot find module './solar'`.

- [ ] **Step 3: Реализовать `solar.ts`**

Создать `server/src/stats/solar.ts`:

```ts
/**
 * Устойчивое окно солнечного дня по поминутному ряду pvPower.
 * Чистая функция: без БД, сети и обращения к текущему времени (для live
 * `nowMs` передаётся аргументом). Единственный источник правды для истории
 * (svёртка в daily, бэкофилл) и для «сегодня» (эндпоинт).
 */

export type SolarState = "idle" | "active" | "ended";

export interface SolarWindow {
  start: number | null; // unix ms первого устойчивого выхода PV выше порога
  end: number | null; //   unix ms последнего такого момента (null пока «идёт»)
  state: SolarState;
}

export interface SolarParams {
  thresholdW: number; // порог мощности PV, Вт
  dwellMin: number; //   устойчивость в минутах (мин. длина прогона и величина «разрыва»)
}

export interface SolarPoint {
  ts: number; // unix ms, минутно-выровненный
  pv: number; // pvPower, Вт
}

const MIN_MS = 60_000;

interface Run {
  start: number; // ts первой надпороговой минуты прогона
  end: number; //   ts последней надпороговой минуты прогона
  count: number; // число надпороговых минут (без перешагнутых провалов)
}

export function computeSolarWindow(
  points: SolarPoint[],
  params: SolarParams,
  nowMs?: number,
): SolarWindow {
  const { thresholdW, dwellMin } = params;
  const gapMs = dwellMin * MIN_MS;

  // Склеиваем надпороговые минуты в прогоны, перешагивая провалы короче dwellMin.
  const runs: Run[] = [];
  for (const p of points) {
    if (p.pv < thresholdW) continue;
    const last = runs[runs.length - 1];
    if (last && p.ts - last.end < gapMs) {
      last.end = p.ts;
      last.count++;
    } else {
      runs.push({ start: p.ts, end: p.ts, count: 1 });
    }
  }

  // Оставляем прогоны длиной не меньше dwellMin надпороговых минут (спайки — прочь).
  const surviving = runs.filter((r) => r.count >= dwellMin);
  if (surviving.length === 0) return { start: null, end: null, state: "idle" };

  const start = surviving[0].start;
  const lastEnd = surviving[surviving.length - 1].end;

  if (nowMs === undefined) return { start, end: lastEnd, state: "ended" };
  if (nowMs - lastEnd < gapMs) return { start, end: null, state: "active" };
  return { start, end: lastEnd, state: "ended" };
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- src/stats/solar.test.ts
```
Ожидается: PASS (все кейсы зелёные).

- [ ] **Step 5: Коммит**

```bash
git add server/src/stats/solar.ts server/src/stats/solar.test.ts
git commit -m "feat(stats): computeSolarWindow — устойчивое окно солнечного дня"
```

---

### Task 2: Конфиг — порог и устойчивость из env

**Files:**
- Modify: `server/src/config.ts` (интерфейс `Config.stats` + `loadConfig`)
- Modify: `server/src/config.test.ts:63` (ассерт дефолтов `stats`)
- Modify: `server/.env.example` (документируем ключи)

**Interfaces:**
- Consumes: `SolarParams` из Task 1 (концептуально; здесь просто два числа).
- Produces: `cfg.stats.solarThresholdW: number` (default 200), `cfg.stats.solarDwellMin: number` (default 15).

- [ ] **Step 1: Обновить падающий тест**

В `server/src/config.test.ts` заменить строку 63:

```ts
    expect(cfg.stats).toEqual({ enabled: true, rawDays: 30, minuteDays: 730 });
```
на:
```ts
    expect(cfg.stats).toEqual({
      enabled: true,
      rawDays: 30,
      minuteDays: 730,
      solarThresholdW: 200,
      solarDwellMin: 15,
    });
```

- [ ] **Step 2: Запустить — убедиться, что падает**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- src/config.test.ts
```
Ожидается: FAIL — `stats` не содержит `solarThresholdW`/`solarDwellMin`.

- [ ] **Step 3: Расширить `config.ts`**

В `server/src/config.ts` в интерфейсе (около строк 21–25) добавить два поля в группу `stats`:

```ts
  stats: {
    enabled: boolean;
    rawDays: number; //    retention сырых 5-сек снапшотов
    minuteDays: number; // retention поминутных агрегатов
    solarThresholdW: number; // порог PV (Вт) для окна солнечного дня
    solarDwellMin: number; //  устойчивость окна, мин
  };
```

В `loadConfig` (около строк 72–76) дополнить объект `stats`:

```ts
    stats: {
      enabled: envBool("STATS_ENABLED", true),
      rawDays: envInt("STATS_RAW_DAYS", 30),
      minuteDays: envInt("STATS_MINUTE_DAYS", 730),
      solarThresholdW: envInt("STATS_SOLAR_THRESHOLD_W", 200),
      solarDwellMin: envInt("STATS_SOLAR_DWELL_MIN", 15),
    },
```

- [ ] **Step 4: Дописать `.env.example`**

В `server/.env.example` добавить строки (рядом с прочими `STATS_`):

```dotenv
# Окно солнечного дня: порог мощности PV (Вт) и устойчивость (мин)
STATS_SOLAR_THRESHOLD_W=200
STATS_SOLAR_DWELL_MIN=15
```

- [ ] **Step 5: Запустить — убедиться, что проходит**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- src/config.test.ts
```
Ожидается: PASS.

- [ ] **Step 6: Коммит**

```bash
git add server/src/config.ts server/src/config.test.ts server/.env.example
git commit -m "feat(config): STATS_SOLAR_THRESHOLD_W / STATS_SOLAR_DWELL_MIN"
```

---

### Task 3: Хранение окна в SQLite (миграция v2, бэкофилл, свёртка, запрос)

**Files:**
- Modify: `server/src/stats/db.ts` (импорт, поля `solar`, `migrate`, `prepare`, `rollupDaily`, новый `windowForDay`/`querySolarWindow`)
- Modify: `server/src/stats/recorder.ts` (`createStats` прокидывает solar-параметры)
- Test: `server/src/stats/db.test.ts` (миграция, свёртка, запрос)

**Interfaces:**
- Consumes: `computeSolarWindow`, `SolarParams`, `SolarWindow`, `SolarPoint` (Task 1); `cfg.stats.solarThresholdW`/`solarDwellMin` (Task 2); helpers `dayStartMs`/`nextDayStartMs` (существуют в `db.ts`).
- Produces:
  - `new StatsDb(file: string, solar?: SolarParams)` — 2-й аргумент, default `{ thresholdW: 200, dwellMin: 15 }`.
  - `StatsDb.querySolarWindow(day: string, nowMs?: number): SolarWindow`.
  - Строки `daily` содержат `solar_start_ts: number | null`, `solar_end_ts: number | null`.

- [ ] **Step 1: Написать падающие тесты**

В `server/src/stats/db.test.ts` добавить новый блок (в конец файла). Хелпер `sample(...)` и `n(...)` уже есть вверху файла; используем их и публичные `db.all` / `db.transaction` / `db.rollupMinutes` / `db.rollupDaily`.

Сначала расширить существующий импорт вверху файла (строка 1) — добавить `dayStartMs`:

```ts
import { StatsDb, SAMPLE_FIELDS, SampleField, SampleRow, prevCalendarDay, dayStartMs } from "./db";
```

Затем добавить новый блок в конец файла:

```ts
describe("StatsDb — окно солнечного дня", () => {
  let db: StatsDb;
  afterEach(() => db.close());

  const MIN = 60_000;

  /** Залить N минут подряд с заданным pvPower, начиная с ts0 (по одному сэмплу на минуту). */
  function seedMinutes(d: StatsDb, ts0: number, n: number, pv: number) {
    d.transaction(() => {
      for (let i = 0; i < n; i++) d.insertSample(sample(ts0 + i * MIN, { pvPower: pv }));
    });
  }

  it("свежая БД: таблица daily имеет столбцы solar_start_ts / solar_end_ts", () => {
    db = new StatsDb(":memory:");
    const cols = db.all("PRAGMA table_info(daily)").map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["solar_start_ts", "solar_end_ts"]));
  });

  it("querySolarWindow (ретроспектива): 16-минутный прогон → ended, start/end по минутам", () => {
    db = new StatsDb(":memory:", { thresholdW: 200, dwellMin: 15 });
    const day = "2026-01-15";
    const t8 = dayStartMs(day) + 8 * 60 * MIN;
    seedMinutes(db, t8, 16, 800); // 16 надпороговых минут ≥ dwell
    db.rollupMinutes(t8 + 60 * MIN, 60_000); // свернуть в samples_minute
    const w = db.querySolarWindow(day);
    expect(w.state).toBe("ended");
    expect(w.start).toBe(t8);
    expect(w.end).toBe(t8 + 15 * MIN);
  });

  it("querySolarWindow (live): передан nowMs вскоре после последней минуты → active", () => {
    db = new StatsDb(":memory:", { thresholdW: 200, dwellMin: 15 });
    const day = "2026-01-15";
    const t8 = dayStartMs(day) + 8 * 60 * MIN;
    seedMinutes(db, t8, 20, 800);
    const upto = t8 + 20 * MIN;
    db.rollupMinutes(upto, 60_000);
    const w = db.querySolarWindow(day, upto + 5 * MIN); // 5 мин после последней минуты
    expect(w.state).toBe("active");
    expect(w.start).toBe(t8);
    expect(w.end).toBeNull();
  });

  it("querySolarWindow: тёмный день → idle", () => {
    db = new StatsDb(":memory:", { thresholdW: 200, dwellMin: 15 });
    const day = "2026-01-15";
    const t8 = dayStartMs(day) + 8 * 60 * MIN;
    seedMinutes(db, t8, 30, 50); // всё ниже порога
    db.rollupMinutes(t8 + 60 * MIN, 60_000);
    expect(db.querySolarWindow(day)).toEqual({ start: null, end: null, state: "idle" });
  });

  it("rollupDaily пишет solar_start_ts / solar_end_ts в строку daily", () => {
    db = new StatsDb(":memory:", { thresholdW: 200, dwellMin: 15 });
    const day = "2026-01-15";
    const t8 = dayStartMs(day) + 8 * 60 * MIN;
    seedMinutes(db, t8, 16, 800);
    db.rollupMinutes(t8 + 60 * MIN, 60_000);
    db.rollupDaily(dayStartMs("2026-01-17")); // «сейчас» — позже, чтобы day был закрыт
    const row = db.all("SELECT solar_start_ts, solar_end_ts FROM daily WHERE day = ?", day)[0];
    expect(Number(row.solar_start_ts)).toBe(t8);
    expect(Number(row.solar_end_ts)).toBe(t8 + 15 * MIN);
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- src/stats/db.test.ts
```
Ожидается: FAIL — нет столбцов / нет метода `querySolarWindow`.

- [ ] **Step 3: Реализовать в `db.ts`**

3a. Импорт вверху `server/src/stats/db.ts` (после строки 2):

```ts
import { computeSolarWindow, SolarParams, SolarWindow } from "./solar";
```

3b. Дефолт рядом с другими константами (после `DAY_EXPR`, строка ~74):

```ts
const DEFAULT_SOLAR: SolarParams = { thresholdW: 200, dwellMin: 15 };
```

3c. Поле класса и запрос-стейтмент (в блок объявлений полей, около строк 82–85):

```ts
  private solar: SolarParams;
  private solarUpdStmt!: StatementSync;
```

3d. Конструктор (строки 87–93) — принять `solar`, задать поле ДО `migrate()` (бэкофилл его использует):

```ts
  constructor(file: string, solar: SolarParams = DEFAULT_SOLAR) {
    this.solar = solar;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
    this.prepare();
  }
```

3e. Переписать `migrate()` (строки 99–129), сохранив существующий CREATE как ветку v0→v1 и добавив v1→v2:

```ts
  private migrate(): void {
    const v = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v < 1) {
      this.db.exec(`
        CREATE TABLE samples (
          ts INTEGER PRIMARY KEY,
          mode TEXT NOT NULL,
          ${SAMPLE_FIELDS.map((f) => `${f} REAL`).join(",\n        ")}
        );
        CREATE TABLE samples_minute (
          ts INTEGER PRIMARY KEY,
          sample_count INTEGER NOT NULL,
          ${GAUGE_FIELDS.map((f) => `${f}_avg REAL, ${f}_min REAL, ${f}_max REAL`).join(",\n        ")},
          ${ENERGY_COLS.map((c) => `${c} REAL`).join(", ")}
        );
        CREATE TABLE daily (
          day TEXT PRIMARY KEY,
          ${ENERGY_COLS.map((c) => `${c} REAL`).join(", ")},
          soc_min REAL, soc_max REAL, grid_loss_count INTEGER, sample_count INTEGER
        );
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          type TEXT NOT NULL,
          detail TEXT NOT NULL
        );
        CREATE INDEX idx_events_ts ON events(ts);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    }
    if (v < 2) this.migrateV2();
  }

  /** v1→v2: столбцы окна солнечного дня + разовый бэкофилл истории из samples_minute. */
  private migrateV2(): void {
    this.db.exec(`
      ALTER TABLE daily ADD COLUMN solar_start_ts INTEGER;
      ALTER TABLE daily ADD COLUMN solar_end_ts INTEGER;
    `);
    const days = this.db
      .prepare(`SELECT DISTINCT ${DAY_EXPR} AS day FROM samples_minute ORDER BY 1`)
      .all() as Array<{ day: string }>;
    const upd = this.db.prepare(
      "UPDATE daily SET solar_start_ts = ?, solar_end_ts = ? WHERE day = ?"
    );
    for (const { day } of days) {
      const w = this.windowForDay(day);
      upd.run(w.start, w.end, day);
    }
    this.db.exec("PRAGMA user_version = 2");
  }
```

3f. В `prepare()` (после подготовки `dailyQueryStmt`, около строки 165) добавить:

```ts
    this.solarUpdStmt = this.db.prepare(
      "UPDATE daily SET solar_start_ts = ?, solar_end_ts = ? WHERE day = ?"
    );
```

3g. Дописать `rollupDaily` (строки 212–228): после `this.dailyStmt.run(...)` в цикле считать и писать окно. Заменить строку с циклом:

```ts
    for (const { day } of days) this.dailyStmt.run({ day, dayStart: dayStartMs(day), dayEnd: nextDayStartMs(day) });
```
на:
```ts
    for (const { day } of days) {
      this.dailyStmt.run({ day, dayStart: dayStartMs(day), dayEnd: nextDayStartMs(day) });
      const w = this.windowForDay(day); // закрытый день → ретроспектива
      this.solarUpdStmt.run(w.start, w.end, day);
    }
```

3h. Добавить приватный `windowForDay` и публичный `querySolarWindow` (рядом с `queryDaily`, около строки 256):

```ts
  /** Окно солнечного дня по минуткам локального дня `day`. Общий движок для
   *  свёртки, бэкофилла и live-запроса. `nowMs` задаётся только для «сегодня». */
  private windowForDay(day: string, nowMs?: number): SolarWindow {
    const rows = this.db
      .prepare(
        "SELECT ts, pvPower_avg AS pv FROM samples_minute WHERE ts >= ? AND ts < ? ORDER BY ts"
      )
      .all(dayStartMs(day), nextDayStartMs(day)) as Array<{ ts: number; pv: number | null }>;
    const points = rows.map((r) => ({ ts: Number(r.ts), pv: Number(r.pv) || 0 }));
    return computeSolarWindow(points, this.solar, nowMs);
  }

  querySolarWindow(day: string, nowMs?: number): SolarWindow {
    return this.windowForDay(day, nowMs);
  }
```

3i. Прокинуть параметры в `server/src/stats/recorder.ts::createStats` (строка 181):

```ts
    const db = new StatsDb(path.join(cfg.dataDir, "stats.db"), {
      thresholdW: cfg.stats.solarThresholdW,
      dwellMin: cfg.stats.solarDwellMin,
    });
```

- [ ] **Step 4: Запустить — убедиться, что проходит (и старые тесты `db.test.ts` тоже)**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- src/stats/db.test.ts
```
Ожидается: PASS (новый блок + все прежние тесты схемы/свёрток/retention).

- [ ] **Step 5: Собрать сервер (проверка типов) и коммит**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm run build
```
Ожидается: сборка без ошибок TypeScript.

```bash
git add server/src/stats/db.ts server/src/stats/db.test.ts server/src/stats/recorder.ts
git commit -m "feat(stats): окно солнечного дня в daily — миграция v2, бэкофилл, свёртка, запрос"
```

---

### Task 4: API-роут `GET /api/stats/solar-window`

**Files:**
- Modify: `server/src/server.ts` (импорт `localDay`; новый роут после `/api/stats/daily`, ~строка 332)
- Test: `server/src/server.http.test.ts` (гейт авторизации + 503 при выключенной статистике)

**Interfaces:**
- Consumes: `stats.db.querySolarWindow(day, nowMs?)` (Task 3); `localDay` из `./stats/db`.
- Produces: `GET /api/stats/solar-window?day=YYYY-MM-DD` → `200 { day, start, end, state }`; `400` при кривом `day`; `503` без статистики; за сессионной авторизацией.

- [ ] **Step 1: Написать падающий тест**

В `server/src/server.http.test.ts`, внутри существующего `describe("server.ts (HTTP integration via supertest)")`, добавить блок (например, после кейсов admin-логина). Сервер здесь создаётся с `stats = null` (см. строку 39), поэтому проверяем гейт и недоступность — happy-path вычисления окна покрыт в `db.test.ts`/`solar.test.ts`:

```ts
  describe("GET /api/stats/solar-window", () => {
    it("без сессии → 401", async () => {
      const res = await request(server).get("/api/stats/solar-window");
      expect(res.status).toBe(401);
    });

    it("с сессией, но статистика выключена (stats=null) → 503", async () => {
      const cookie = await freshSessionCookie("admin", "admin", "admin123");
      const res = await request(server).get("/api/stats/solar-window").set("Cookie", cookie);
      expect(res.status).toBe(503);
    });
  });
```

- [ ] **Step 2: Запустить — убедиться, что падает**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- src/server.http.test.ts
```
Ожидается: FAIL — маршрут не существует (401-гейт может пройти на общем middleware, но 503-кейс упадёт: без роута вернётся 404).

- [ ] **Step 3: Реализовать роут**

3a. В `server/src/server.ts` строка 20 — добавить `localDay` в импорт из `./stats/db`:

```ts
import { GAUGE_FIELDS, GaugeField, localDay } from "./stats/db";
```

3b. Вставить роут сразу после блока `app.get("/api/stats/daily", …)` (после строки 332):

```ts
  app.get("/api/stats/solar-window", (req, res) => {
    try {
      if (!stats) return res.status(503).json({ ok: false, error: "stats unavailable" });
      const dayRe = /^\d{4}-\d{2}-\d{2}$/;
      const now = Date.now();
      const today = localDay(now);
      const day = req.query.day ? String(req.query.day) : today;
      if (!dayRe.test(day)) {
        return res.status(400).json({ ok: false, error: "day must be YYYY-MM-DD" });
      }
      const win = stats.db.querySolarWindow(day, day === today ? now : undefined);
      res.json({ day, ...win });
    } catch (e) {
      console.error("[inverter-monitor] stats query failed:", (e as Error).message);
      res.status(503).json({ ok: false, error: "stats unavailable" });
    }
  });
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- src/server.http.test.ts
```
Ожидается: PASS (401 без сессии, 503 при stats=null).

- [ ] **Step 5: Собрать сервер и коммит**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm run build
```
Ожидается: без ошибок типов.

```bash
git add server/src/server.ts server/src/server.http.test.ts
git commit -m "feat(api): GET /api/stats/solar-window"
```

---

### Task 5: Удалить дребезжащие solar-charge события из recorder

**Files:**
- Modify: `server/src/stats/recorder.ts` (константы, поле, ветка деривации)
- Modify: `server/src/stats/recorder.test.ts` (удалить блок теста гистерезиса, строки 272–364)

**Interfaces:**
- Consumes: —
- Produces: `StatsRecorder` больше не пишет события `solar-charge-start`/`solar-charge-stop`. Прочие события (mode/grid/alarm/conn/device) без изменений.

- [ ] **Step 1: Удалить блок теста гистерезиса**

Удалить в `server/src/stats/recorder.test.ts` весь `describe("StatsRecorder — solar-charging Schmitt-trigger hysteresis", () => { … })` — строки **272–364** включительно (заканчивается `});` перед `describe("StatsRecorder — connection events reset diff baselines"` на строке 366).

- [ ] **Step 2: Запустить — убедиться, что падает сборка/остальные тесты (ветка в recorder.ts ещё пишет события, но тестов на неё уже нет)**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- src/stats/recorder.test.ts
```
Ожидается: PASS по оставшимся тестам (удаление тестов их не ломает). Это шаг-подготовка; удаление кода — следующим шагом (чтобы не осталось мёртвой логики).

- [ ] **Step 3: Удалить логику из `recorder.ts`**

3a. Удалить константы (строки 20–24):

```ts
// Зарядка от солнца — по регистру 224 (pvChargingPower, PV-мощность в заряд).
// Гистерезис (Шмитт): старт выше START, стоп ниже STOP — чтобы дребезг у нуля
// (рассвет/закат, набегающие облака) не плодил пары событий.
const SOLAR_CHARGE_START_W = 50;
const SOLAR_CHARGE_STOP_W = 20;
```

3b. Удалить поле (строка 39):

```ts
  private prevSolarCharging: boolean | null = null;
```

3c. В `deriveEvents`, в блоке сброса при обрыве связи, удалить строку (строка 94):

```ts
      this.prevSolarCharging = null;
```

3d. Удалить весь финальный блок деривации (строки 129–138):

```ts
    if (snap.status) {
      const pcp = snap.status.pvChargingPower;
      let charging = this.prevSolarCharging ?? false;
      if (!charging && pcp > SOLAR_CHARGE_START_W) charging = true;
      else if (charging && pcp < SOLAR_CHARGE_STOP_W) charging = false;
      if (this.prevSolarCharging !== null && charging !== this.prevSolarCharging) {
        this.push(ts, charging ? "solar-charge-start" : "solar-charge-stop", { pvChargingPower: pcp });
      }
      this.prevSolarCharging = charging;
    }
```

- [ ] **Step 4: Запустить тесты и сборку**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w server -- src/stats/recorder.test.ts && npm run build
```
Ожидается: PASS; сборка без ошибок (переменная `ts` в `deriveEvents` всё ещё используется другими ветками — проверить, что нет unused-warning; если `ts` больше нигде не нужен — это не наш случай, он используется в conn/mode/grid ветках).

- [ ] **Step 5: Коммит**

```bash
git add server/src/stats/recorder.ts server/src/stats/recorder.test.ts
git commit -m "refactor(stats): убрать дребезжащие solar-charge события (заменены окном дня)"
```

---

### Task 6: Web — клиент API, колонки в суточной таблице, чистка журнала

**Files:**
- Modify: `web/lib/stats.ts` (поля `DailyRow`; типы `SolarState`/`SolarWindow`; `fetchSolarWindow`)
- Modify: `web/app/(app)/stats/page.tsx` (2 колонки в таблице; убрать solar из фильтра/меток/`evText`)
- Modify: `web/app/(app)/stats/page.test.tsx` (обновить `SAMPLE_DAILY`)
- Modify: `web/lib/i18n/dict.ts` (заголовки колонок; убрать `stEvSolarStart`/`stEvSolarStop`)

**Interfaces:**
- Consumes: `GET /api/stats/solar-window` (Task 4); поля `solar_start_ts`/`solar_end_ts` в ответе `/api/stats/daily` (Task 3).
- Produces:
  - `interface DailyRow { …; solar_start_ts: number | null; solar_end_ts: number | null }`
  - `type SolarState = "idle" | "active" | "ended"`
  - `interface SolarWindow { day: string; start: number | null; end: number | null; state: SolarState }`
  - `function fetchSolarWindow(day?: string): Promise<SolarWindow>`

- [ ] **Step 1: Расширить `web/lib/stats.ts`**

1a. В `interface DailyRow` (строки 5–16) добавить два поля перед `soc_min`:

```ts
export interface DailyRow {
  day: string;
  pv_wh: number;
  load_wh: number;
  grid_wh: number;
  batt_charge_wh: number;
  batt_discharge_wh: number;
  solar_start_ts: number | null;
  solar_end_ts: number | null;
  soc_min: number | null;
  soc_max: number | null;
  grid_loss_count: number;
  sample_count: number;
}
```

1b. Добавить тип и фетчер (после `fetchDaily`, около строки 41):

```ts
export type SolarState = "idle" | "active" | "ended";

export interface SolarWindow {
  day: string;
  start: number | null; // unix ms
  end: number | null; //   unix ms
  state: SolarState;
}

export function fetchSolarWindow(day?: string): Promise<SolarWindow> {
  return getJson(`/api/stats/solar-window${day ? `?day=${day}` : ""}`);
}
```

- [ ] **Step 2: Добавить i18n-ключи, убрать старые (в `web/lib/i18n/dict.ts`)**

Во всех трёх словарях (`uk`, `ru`, `en`):

2a. Удалить строку `stEvSolarStart … stEvSolarStop …` (строки 108 / 274 / 436).

2b. Добавить рядом с `stThDay …` (строки 100 / 266 / 428) заголовки колонок и подписи панели дашборда.

Для `uk` (после `stThDay: "День", …`):
```ts
  stThSolarStart: "Початок", stThSolarEnd: "Кінець",
  solarTodayTitle: "Сонце сьогодні", solarNotStarted: "ще не почалося", solarOngoing: "триває з",
```
Для `ru`:
```ts
  stThSolarStart: "Начало", stThSolarEnd: "Конец",
  solarTodayTitle: "Солнце сегодня", solarNotStarted: "ещё не началось", solarOngoing: "идёт с",
```
Для `en`:
```ts
  stThSolarStart: "Start", stThSolarEnd: "End",
  solarTodayTitle: "Solar today", solarNotStarted: "not started yet", solarOngoing: "since",
```

- [ ] **Step 3: Правки страницы `web/app/(app)/stats/page.tsx`**

3a. Убрать записи в карте меток (строки 151–152) — удалить:
```ts
        "solar-charge-start": t.stEvSolarStart,
        "solar-charge-stop": t.stEvSolarStop,
```

3b. Убрать ветку в `evText` (строки 181–183) — удалить:
```ts
      case "solar-charge-start":
      case "solar-charge-stop":
        return `${d.pvChargingPower ?? "—"} ${t.capW}`;
```

3c. Убрать из списка фильтра (строка 323) — заменить массив на без solar:
```ts
          {["mode-change", "grid-loss", "grid-restore", "fault-set", "fault-clear",
            "warning-set", "warning-clear", "conn-lost", "conn-restored", "device-changed"].map((k) => (
```

3d. В `<thead>` суточной таблицы (после `<th>{t.stThDay}</th>` и пустого `<th></th>`, строки 284–285) добавить две колонки перед `<th>{t.stThPv}</th>`:
```ts
                  <th>{t.stThDay}</th>
                  <th></th>
                  <th>{t.stThSolarStart}</th>
                  <th>{t.stThSolarEnd}</th>
                  <th>{t.stThPv}</th>
```

3e. Добавить хелпер форматирования времени рядом с `fmtT` (около строки 190):
```ts
  const hhmm = (ms: number | null) =>
    ms == null ? "—" : new Date(ms).toLocaleTimeString(t.langLocale, { hour: "2-digit", minute: "2-digit" });
```

3f. В `<tbody>` таблицы (после `<td>{r.day}</td>` и ячейки-бара, строки 297–300) добавить две ячейки перед `<td>{kwh(r.pv_wh)}</td>`:
```ts
                    <td>{r.day}</td>
                    <td className="stats-bar-cell">
                      <span className="stats-bar" style={{ width: `${(r.pv_wh / maxWh) * 100}%` }} />
                    </td>
                    <td>{hhmm(r.solar_start_ts)}</td>
                    <td>{hhmm(r.solar_end_ts)}</td>
                    <td>{kwh(r.pv_wh)}</td>
```

- [ ] **Step 4: Обновить `SAMPLE_DAILY` в `web/app/(app)/stats/page.test.tsx`**

В объекте `SAMPLE_DAILY` (строки 54–65) добавить два поля (например, после `batt_discharge_wh`):
```ts
    batt_discharge_wh: 300,
    solar_start_ts: Date.UTC(2026, 6, 25, 6, 40, 0),
    solar_end_ts: Date.UTC(2026, 6, 25, 18, 20, 0),
    soc_min: 60,
```

- [ ] **Step 5: Прогнать web-тесты и проверку типов**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w web -- stats/page.test.tsx && npm run check -w web
```
Ожидается: PASS; `tsc --noEmit` без ошибок (в т.ч. i18n-парити uk/ru/en, раз ключи добавлены/убраны согласованно во всех трёх).

- [ ] **Step 6: Коммит**

```bash
git add web/lib/stats.ts web/lib/i18n/dict.ts "web/app/(app)/stats/page.tsx" "web/app/(app)/stats/page.test.tsx"
git commit -m "feat(web/stats): колонки начало/конец в суточной таблице; чистка журнала от solar-charge"
```

---

### Task 7: Web — панель «Солнце сегодня» на дашборде

**Files:**
- Create: `web/components/SolarToday.tsx`
- Test: `web/components/SolarToday.test.tsx`
- Modify: `web/app/(app)/page.tsx` (встроить `<SolarToday />` в карточку солнца)

**Interfaces:**
- Consumes: `fetchSolarWindow`, `SolarWindow` (Task 6); i18n `solarTodayTitle`/`solarNotStarted`/`solarOngoing` (Task 6).
- Produces: клиентский компонент `SolarToday` — тянет `/api/stats/solar-window` на маунте и раз в 60 с, показывает `начало → конец` / «идёт с HH:MM» / «ещё не началось».

- [ ] **Step 1: Написать падающий тест**

Создать `web/components/SolarToday.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { LangProvider } from "@/lib/i18n";
import * as stats from "@/lib/stats";
import { SolarToday } from "./SolarToday";

jest.mock("@/lib/stats", () => ({
  __esModule: true,
  fetchSolarWindow: jest.fn(),
}));
const mockFetch = stats.fetchSolarWindow as jest.MockedFunction<typeof stats.fetchSolarWindow>;

function renderWith(win: stats.SolarWindow) {
  mockFetch.mockResolvedValue(win);
  return render(
    <LangProvider>
      <SolarToday />
    </LangProvider>
  );
}

afterEach(() => jest.clearAllMocks());

describe("SolarToday", () => {
  it("state=ended → показывает начало и конец (HH:MM)", async () => {
    renderWith({
      day: "2026-07-26",
      start: Date.UTC(2026, 6, 26, 4, 40, 0), // 07:40 в Europe/Kyiv (UTC+3 летом)
      end: Date.UTC(2026, 6, 26, 15, 20, 0), // 18:20
      state: "ended",
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    // формат времени зависит от TZ раннера; проверяем сам факт двух отметок через разделитель
    expect(await screen.findByText(/→/)).toBeInTheDocument();
  });

  it("state=active → показывает «идёт с …», без конца", async () => {
    renderWith({ day: "2026-07-26", start: Date.UTC(2026, 6, 26, 4, 40, 0), end: null, state: "active" });
    expect(await screen.findByText(/идёт с|триває з|since/)).toBeInTheDocument();
  });

  it("state=idle → «ещё не началось»", async () => {
    renderWith({ day: "2026-07-26", start: null, end: null, state: "idle" });
    expect(await screen.findByText(/ещё не началось|ще не почалося|not started yet/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w web -- SolarToday.test.tsx
```
Ожидается: FAIL — `Cannot find module './SolarToday'`.

- [ ] **Step 3: Реализовать компонент**

Создать `web/components/SolarToday.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { fetchSolarWindow, SolarWindow } from "@/lib/stats";

export function SolarToday() {
  const t = useT();
  const [win, setWin] = useState<SolarWindow | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => fetchSolarWindow().then((w) => alive && setWin(w)).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const hhmm = (ms: number) =>
    new Date(ms).toLocaleTimeString(t.langLocale, { hour: "2-digit", minute: "2-digit" });

  let body: string;
  if (!win || win.state === "idle" || win.start === null) {
    body = t.solarNotStarted;
  } else if (win.state === "active" || win.end === null) {
    body = `${t.solarOngoing} ${hhmm(win.start)}`;
  } else {
    body = `${hhmm(win.start)} → ${hhmm(win.end)}`;
  }

  return (
    <div className="solar-today">
      <span className="cap">{t.solarTodayTitle}</span>
      <strong>{body}</strong>
    </div>
  );
}
```

- [ ] **Step 4: Встроить в дашборд `web/app/(app)/page.tsx`**

4a. Добавить импорт (после строки 6):
```ts
import { SolarToday } from "@/components/SolarToday";
```

4b. Внутри `<section className="card card-solar">`, сразу после закрывающего `</div>` блока `sub-metrics` (после строки 59), добавить:
```tsx
        <SolarToday />
```

- [ ] **Step 5: Запустить тест компонента и проверку типов**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w web -- SolarToday.test.tsx && npm run check -w web
```
Ожидается: PASS; `tsc --noEmit` чисто.

- [ ] **Step 6: Коммит**

```bash
git add web/components/SolarToday.tsx web/components/SolarToday.test.tsx "web/app/(app)/page.tsx"
git commit -m "feat(web/dashboard): панель «Солнце сегодня» (начало → конец)"
```

---

### Task 8: Финальная сборка и полный прогон тестов

**Files:** — (без правок кода; проверка целостности монорепо)

- [ ] **Step 1: Полная сборка в порядке shared → server → web**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm run build
```
Ожидается: успешная сборка всех трёх воркспейсов.

- [ ] **Step 2: Полный `check` сервера и веба**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm run check -w server && npm run check -w web
```
Ожидается: все jest-сьюты сервера зелёные (протокол/stats/auth/http); web typecheck чистый.

- [ ] **Step 3: Полный прогон web-тестов**

```bash
export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"
npm test -w web
```
Ожидается: PASS (включая обновлённые stats/page и новый SolarToday).

- [ ] **Step 4: Проверить чистоту дерева**

```bash
git status --short
```
Ожидается: пусто (всё закоммичено).

---

## Примечания по развёртыванию (после мержа, отдельная сессия)

- Миграция `v1→v2` (ALTER + бэкофилл) отработает автоматически при первом старте нового билда на Pi. `daily` уже с данными — `ADD COLUMN` безопасен, бэкофилл пересчитает историю из `samples_minute` (2 года).
- `deploy.sh` каталог `data/` не трогает; env на Pi править не нужно — дефолты 200 Вт / 15 мин зашиты.
- Деплой на Pi — по явной просьбе владельца (правило CLAUDE.md); в прод — только по отдельному «да».
