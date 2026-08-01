# Overview Energy-Flow Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить строчную карточку инвертора на `/` диаграммой потоков энергии (инвертор в центре, узлы солнце/сеть/батарея/нагрузка, свечение активных источников, анимация направления) по спеке `docs/superpowers/specs/2026-08-01-overview-flow-card-design.md`.

**Architecture:** Новый компонент `web/components/InverterFlow.tsx` — чистый рендер SVG от `{ snapshot, pvPeakW }`; логика активности — чистая функция `flowState(snapshot)`. Страница `/` оборачивает карточку в `<Link>` и `MetaProvider` (за `pvPeakW`). Бэкенд: один новый конфиг-параметр `INVERTER_PV_PEAK_W`, прокинутый в `/api/inverter/meta`.

**Tech Stack:** React 19 / Next 15 (static export), inline SVG + SVG-фильтры (feGaussianBlur), CSS-анимация штрихов, jest + @testing-library.

## Global Constraints

- Node ≥ 24 в shell: `export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH"` перед npm-командами.
- Ветка `feat/overview-flow-card`; коммиты на английском, conventional commits, без Co-Authored-By.
- Никаких внешних ассетов (LAN без интернета): иконки — только инлайн-SVG.
- Цвета — только существующие CSS-переменные e-ink палитры (`--sun`, `--moss`, `--slate`, `--plum`, `--brick`, их `-deep`, `--paper-*`, `--ink*`, `--hairline`).
- Дашборд `/inverter` не трогать. Env-имена не переименовывать.
- `@media (prefers-reduced-motion: reduce)` — анимация штрихов отключается.
- Линтить только изменённые файлы (`npx eslint <files>` из web/ — если конфиг отсутствует, пропустить); typecheck обязателен.

---

### Task 1: pvPeakW — конфиг, ApiMeta, роут meta, fake-gateway

**Files:**
- Modify: `modules/inverter/src/config.ts`, `modules/inverter/src/config.test.ts`
- Modify: `packages/inverter-shared/src/api.ts` (interface `ApiMeta`)
- Modify: `modules/inverter/src/router.ts:36-46` (обработчик `/meta`)
- Modify: `modules/inverter/src/router.test.ts`
- Modify: `packages/inverter-mcp/src/testing/fake-gateway.ts` (фикстура meta)

**Interfaces:**
- Consumes: `envInt` из `@sweethome/shared`; существующий `InverterConfig`.
- Produces: `InverterConfig.pvPeakW: number` (0 = не задан); `ApiMeta.pvPeakW?: number`; `GET /api/inverter/meta` отдаёт `pvPeakW` только когда он > 0.

- [ ] **Step 1: Падающий тест конфига** — в `modules/inverter/src/config.test.ts` добавить (рядом с существующими кейсами, тем же стилем сохранения/восстановления env, что уже используется в файле):

```ts
it("reads INVERTER_PV_PEAK_W (default 0 = unset)", () => {
  delete process.env.INVERTER_PV_PEAK_W;
  expect(loadInverterConfig("data").pvPeakW).toBe(0);
  process.env.INVERTER_PV_PEAK_W = "5160";
  expect(loadInverterConfig("data").pvPeakW).toBe(5160);
});
```

- [ ] **Step 2: Убедиться, что падает** — `npm test -w @sweethome/inverter -- --testPathPattern config` → FAIL (`pvPeakW` отсутствует в типе).

- [ ] **Step 3: Реализация** — в `modules/inverter/src/config.ts`: в interface `InverterConfig` добавить строку `/** Пик PV-массива, Вт (для % на карточке обзора); 0 = не задан. */ pvPeakW: number;` рядом с `allowMock`, а в `loadInverterConfig` — `pvPeakW: envInt("INVERTER_PV_PEAK_W", 0),`.

- [ ] **Step 4: Тест зелёный** — `npm test -w @sweethome/inverter -- --testPathPattern config` → PASS.

- [ ] **Step 5: ApiMeta + роут + тест роутера.** В `packages/inverter-shared/src/api.ts` в `interface ApiMeta` добавить `/** Пик PV-массива, Вт; отсутствует, если не задан. */ pvPeakW?: number;`. В `modules/inverter/src/router.ts` в ответ `/meta` добавить строку `pvPeakW: cfg.pvPeakW > 0 ? cfg.pvPeakW : undefined,`. В `modules/inverter/src/router.test.ts` — кейс (тем же харнесс-способом, что соседние):

```ts
it("meta exposes pvPeakW only when configured", async () => {
  // существующий сетап собирает cfg через loadInverterConfig: выставить
  // process.env.INVERTER_PV_PEAK_W = "5160" ДО сборки deps этого кейса
  // (см. как соседние кейсы строят router/deps) и проверить:
  //   res.body.pvPeakW === 5160
  // затем — вариант без env: поле отсутствует (undefined).
});
```

Реализовать кейс полностью по образцу соседних (в файле уже есть тесты `/meta`; скопировать их сетап, меняя env до создания конфига).

- [ ] **Step 6: fake-gateway** — в `packages/inverter-mcp/src/testing/fake-gateway.ts` в объект-фикстуру meta (строки ~44-52, где `allowControl: true`) добавить `pvPeakW: 5160,` — фикстура обязана зеркалить реальную схему (см. предупреждение в modules/inverter/CLAUDE.md про разъезд фикстур).

- [ ] **Step 7: Полный прогон воркспейсов** — `npm run build && npm test -w @sweethome/inverter && npm test -w @sweethome/inverter-mcp` → зелёные.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(inverter): expose PV array peak wattage (INVERTER_PV_PEAK_W) via meta"`

---

### Task 2: flowState + InverterFlow + WarnChip + CSS + словарь

**Files:**
- Create: `web/components/InverterFlow.tsx`, `web/components/InverterFlow.test.tsx`
- Modify: `web/lib/i18n/dict.ts` (все три языка)
- Modify: `web/app/globals.css` (после блока `.home-card-*`, ~строка 195)

**Interfaces:**
- Consumes: `Snapshot` из `@sweethome/inverter-shared` (`status.{pvPower, mainsPower, batteryPower, batteryCapacity, gridVoltage, acOutputActivePower, outputLoadPercent}`, `mode`, `warnings.active`, `info.acOutputRatingActivePower`), `fmt` из `@/lib/format`, `useT` из `@/lib/i18n`.
- Produces:
  - `flowState(s: Snapshot): FlowState` где `FlowState = { sunActive; gridActive; batteryDischarging; batteryCharging; gridAbsent; bypass; fault; overloadFault; overload: boolean }`;
  - `pctLabel(watts: number, peak?: number | null): string | null`;
  - `<InverterFlow snapshot={Snapshot} pvPeakW={number | undefined} />`;
  - `<WarnChip tone="amber" | "brick" label={string} />`;
  - data-атрибуты для тестов: свечение — `circle.flow-glow[data-node="sun|grid|battery|inverter"]`; ветки — `path[data-branch="sun|grid|battery|load"][data-active="1|0"]`, у батареи дополнительно `data-dir="charge|discharge"`.

- [ ] **Step 1: Словарь.** В `web/lib/i18n/dict.ts` добавить в каждый из трёх блоков (uk ~строка 17, ru ~207, en ~393, рядом с `cardBattery…`):

```ts
// uk:
flowSun: "Сонце", flowGridAbsent: "немає", flowChipBypass: "Байпас",
flowChipOverload: "Перевантаження", flowChipFault: "Аварія", flowWas: "було",
// ru:
flowSun: "Солнце", flowGridAbsent: "нет", flowChipBypass: "Байпас",
flowChipOverload: "Перегрузка", flowChipFault: "Авария", flowWas: "было",
// en:
flowSun: "Solar", flowGridAbsent: "none", flowChipBypass: "Bypass",
flowChipOverload: "Overload", flowChipFault: "Fault", flowWas: "was",
```

Типизированный словарь сам потребует все три языка (`npm run typecheck -w @sweethome/web`).

- [ ] **Step 2: Падающие тесты** — `web/components/InverterFlow.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { buildSnapshot, buildStatus } from "@/test-utils/renderWithProviders";
import { InverterFlow, flowState, pctLabel } from "./InverterFlow";

const snap = (st: Parameters<typeof buildStatus>[0], over: Parameters<typeof buildSnapshot>[0] = {}) =>
  buildSnapshot({ status: buildStatus(st), ...over });

describe("flowState", () => {
  it("evening: sun and battery feed simultaneously", () => {
    const f = flowState(snap({ pvPower: 380, mainsPower: 0, batteryPower: -520 }));
    expect(f.sunActive).toBe(true);
    expect(f.batteryDischarging).toBe(true);
    expect(f.gridActive).toBe(false);
  });
  it("cloudy SUB: sun + grid feed, charging battery is a consumer", () => {
    const f = flowState(snap({ pvPower: 600, mainsPower: 400, batteryPower: 150 }));
    expect(f.sunActive).toBe(true);
    expect(f.gridActive).toBe(true);
    expect(f.batteryDischarging).toBe(false);
    expect(f.batteryCharging).toBe(true);
  });
  it("grid absence is voltage-based", () => {
    expect(flowState(snap({ gridVoltage: 0 })).gridAbsent).toBe(true);
    expect(flowState(snap({ gridVoltage: 231 })).gridAbsent).toBe(false);
  });
  it("fault: everything idles, overload bit recognized", () => {
    const f = flowState(
      snap({ pvPower: 500 }, { mode: "Fault", warnings: { active: ["Overload"], raw: "" } }),
    );
    expect(f.fault).toBe(true);
    expect(f.overloadFault).toBe(true);
    expect(f.sunActive).toBe(false);
  });
  it("bypass and overload flags", () => {
    const f = flowState(snap({ outputLoadPercent: 107 }, { mode: "Bypass" }));
    expect(f.bypass).toBe(true);
    expect(f.overload).toBe(true);
  });
});

describe("pctLabel", () => {
  it("rounds percent of peak and hides when peak is unset", () => {
    expect(pctLabel(380, 5160)).toBe("7%");
    expect(pctLabel(380, 0)).toBeNull();
    expect(pctLabel(380, undefined)).toBeNull();
  });
});

describe("InverterFlow render", () => {
  it("glows every feeding source and animates its branch", () => {
    const { container } = render(
      <InverterFlow snapshot={snap({ pvPower: 380, mainsPower: 0, batteryPower: -520 })} pvPeakW={5160} />,
    );
    const glows = [...container.querySelectorAll(".flow-glow")].map((el) => el.getAttribute("data-node"));
    expect(glows).toContain("sun");
    expect(glows).toContain("battery");
    expect(glows).not.toContain("grid");
    expect(container.querySelector('path[data-branch="sun"]')?.getAttribute("data-active")).toBe("1");
    expect(container.querySelector('path[data-branch="grid"]')?.getAttribute("data-active")).toBe("0");
    expect(container.querySelector('path[data-branch="battery"]')?.getAttribute("data-dir")).toBe("discharge");
  });
  it("charging flips the battery branch direction", () => {
    const { container } = render(
      <InverterFlow snapshot={snap({ pvPower: 1240, batteryPower: 680 })} pvPeakW={5160} />,
    );
    expect(container.querySelector('path[data-branch="battery"]')?.getAttribute("data-dir")).toBe("charge");
    expect(
      [...container.querySelectorAll(".flow-glow")].map((el) => el.getAttribute("data-node")),
    ).not.toContain("battery");
  });
  it("shows node values: percent-first for sun and load, SOC and signed watts for battery", () => {
    const { container } = render(
      <InverterFlow
        snapshot={snap({
          pvPower: 380, batteryPower: -520, batteryCapacity: 58,
          acOutputActivePower: 900, mainsPower: 0,
        })}
        pvPeakW={5160}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("7% · 380");
    expect(text).toContain("58% · −520");
    // load % от info.acOutputRatingActivePower (buildSnapshot даёт номинал — сверить его значение в test-utils и подставить ожидание)
  });
  it("grid absence shows the brick 'none' label instead of watts", () => {
    const { container } = render(<InverterFlow snapshot={snap({ gridVoltage: 0, mainsPower: 0 })} />);
    expect(container.textContent).toContain("немає"); // язык по умолчанию uk
  });
  it("fault: idle branches, brick inverter with '!' mark", () => {
    const { container } = render(
      <InverterFlow snapshot={snap({}, { mode: "Fault", warnings: { active: ["Overload"], raw: "" } })} />,
    );
    expect(container.querySelectorAll('path[data-active="1"]').length).toBe(0);
    expect(container.querySelector('[data-node="inverter-fault"]')).toBeInTheDocument();
  });
});
```

Проверить в `web/test-utils/renderWithProviders.tsx`, какой номинал (`info.acOutputRatingActivePower`) зашит в `buildSnapshot`, и дописать ожидание процента нагрузки в третьем кейсе (например при номинале 5500 и 900 Вт — `16% · 900`).

- [ ] **Step 3: Убедиться, что падают** — `npm test -w @sweethome/web -- --testPathPattern InverterFlow` → FAIL (модуля нет).

- [ ] **Step 4: Реализация `web/components/InverterFlow.tsx`.** Полный состав:

```tsx
"use client";

import { useRef } from "react";
import type { Snapshot } from "@sweethome/inverter-shared";
import { useT } from "@/lib/i18n";
import { fmt } from "@/lib/format";

export interface FlowState {
  sunActive: boolean;
  gridActive: boolean;
  batteryDischarging: boolean;
  batteryCharging: boolean;
  gridAbsent: boolean;
  bypass: boolean;
  fault: boolean;
  overloadFault: boolean;
  overload: boolean;
}

/** Правило свечения/потоков (§3, §5 спеки): активность — по фактической отдаче. */
export function flowState(s: Snapshot): FlowState {
  const st = s.status;
  const fault = s.mode === "Fault";
  return {
    sunActive: !fault && (st?.pvPower ?? 0) > 0,
    gridActive: !fault && (st?.mainsPower ?? 0) > 0,
    batteryDischarging: !fault && (st?.batteryPower ?? 0) < 0,
    batteryCharging: !fault && (st?.batteryPower ?? 0) > 0,
    gridAbsent: (st?.gridVoltage ?? 0) < 100,
    bypass: s.mode === "Bypass",
    fault,
    overloadFault: fault && (s.warnings?.active ?? []).includes("Overload"),
    overload: (st?.outputLoadPercent ?? 0) > 100,
  };
}

/** «7%» от пика; null — если пик не задан (процент скрывается). */
export function pctLabel(watts: number, peak?: number | null): string | null {
  if (!peak || peak <= 0) return null;
  return `${Math.round((watts / peak) * 100)}%`;
}

export function WarnChip({ tone, label }: { tone: "amber" | "brick"; label: string }) {
  return (
    <span className={`warnchip ${tone}`}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3 L22 20 H2 Z" />
        <line x1="12" y1="9.5" x2="12" y2="14.5" />
        <circle cx="12" cy="17.5" r="0.6" fill="currentColor" />
      </svg>
      {label}
    </span>
  );
}

/* Геометрия из согласованного макета (flow-variant-v19): viewBox 320×250,
   инвертор 140,100 40×40; узлы: солнце (48,44), сеть (272,44), батарея (48,196),
   нагрузка (272,196). Ветки рисуются ОТ источника К приёмнику — штрихи текут
   по направлению энергии. */

const GLOW = { wide: 24, tight: 18, disc: 16 };

function NodeGlow({ x, y, color, node }: { x: number; y: number; color: string; node: string }) {
  return (
    <>
      <circle className="flow-glow" data-node={node} cx={x} cy={y} r={GLOW.wide}
        fill={color} opacity="0.30" filter="url(#flowGlowWide)" />
      <circle cx={x} cy={y} r={GLOW.tight} fill={color} opacity="0.45" filter="url(#flowGlowTight)" />
    </>
  );
}

export function InverterFlow({ snapshot, pvPeakW }: { snapshot: Snapshot; pvPeakW?: number }) {
  const t = useT();
  const f = flowState(snapshot);
  const st = snapshot.status;
  const rated = snapshot.info?.acOutputRatingActivePower;
  // Последняя ненулевая нагрузка — для «0 Вт · було N» в аварии (§5).
  const lastLoad = useRef(0);
  const loadW = st?.acOutputActivePower ?? 0;
  if (loadW > 0) lastLoad.current = loadW;

  const pvW = st?.pvPower ?? 0;
  const battW = st?.batteryPower ?? 0;
  const mainsW = st?.mainsPower ?? 0;
  const soc = st?.batteryCapacity ?? 0;

  const sunPct = pctLabel(pvW, pvPeakW);
  const loadPct = pctLabel(loadW, rated);
  const w = ` ${t.capW}`;

  const sunVal = sunPct ? `${sunPct} · ${fmt(pvW, 0)}${w}` : `${fmt(pvW, 0)}${w}`;
  const battVal = `${fmt(soc, 0)}% · ${battW > 0 ? "+" : battW < 0 ? "−" : ""}${fmt(Math.abs(battW), 0)}${w}`;
  const gridVal = f.gridAbsent ? t.flowGridAbsent : `${fmt(mainsW, 0)}${w}`;
  const loadVal = f.fault
    ? lastLoad.current > 0
      ? `0${w} · ${t.flowWas} ${fmt(lastLoad.current, 0)}`
      : `0${w}`
    : loadPct
      ? `${loadPct} · ${fmt(loadW, 0)}${w}`
      : `${fmt(loadW, 0)}${w}`;

  const loadAlarm = f.overload || f.fault;
  // Ветки: [класс цвета, активна?, путь]; путь батареи зависит от направления.
  const battPath = f.batteryDischarging ? "M66 178 L140 136" : "M140 136 L66 178";
  const line = (active: boolean, boost = false) =>
    active ? `flow-line${boost ? " boost" : ""}` : "flow-line-idle";

  return (
    <svg className="flow-svg" viewBox="0 0 320 250" role="img" aria-label={t.navInverter}>
      <defs>
        <filter id="flowGlowWide" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <filter id="flowGlowTight" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>

      {/* ветки */}
      <path data-branch="sun" data-active={f.sunActive ? "1" : "0"}
        className={`${line(f.sunActive, true)} flow-sun`} d="M66 62 L140 104" />
      <path data-branch="grid" data-active={f.gridActive ? "1" : "0"}
        className={`${line(f.gridActive, true)} flow-grid`} d="M254 62 L180 104" />
      <path data-branch="battery" data-active={f.batteryDischarging || f.batteryCharging ? "1" : "0"}
        data-dir={f.batteryDischarging ? "discharge" : "charge"}
        className={`${line(f.batteryDischarging || f.batteryCharging, f.batteryDischarging)} flow-moss`}
        d={battPath} />
      <path data-branch="load" data-active={!f.fault && loadW > 0 ? "1" : "0"}
        className={`${line(!f.fault && loadW > 0)} ${loadAlarm ? "flow-brick" : "flow-slate"}`}
        d="M180 136 L254 178" />

      {/* инвертор в центре */}
      {f.bypass && (
        <>
          <rect className="flow-glow" data-node="inverter" x="130" y="90" width="60" height="60" rx="10"
            fill="var(--sun)" opacity="0.30" filter="url(#flowGlowWide)" />
          <rect x="136" y="96" width="48" height="48" rx="7"
            fill="var(--sun)" opacity="0.40" filter="url(#flowGlowTight)" />
        </>
      )}
      <g className={f.fault ? "flow-inv-fault" : f.bypass ? "flow-inv-bypass" : "flow-inv"}
        strokeLinecap="round" strokeLinejoin="round" fill="none">
        <rect x="140" y="100" width="40" height="40" rx="4" strokeWidth="2" className="flow-inv-body" />
        <line x1="144" y1="136" x2="176" y2="104" strokeWidth="1.6" />
        <line x1="147" y1="109" x2="159" y2="109" strokeWidth="2" />
        <line x1="147" y1="113.5" x2="159" y2="113.5" strokeWidth="2" strokeDasharray="2.6 2.2" />
        <path d="M161 128.5 q3.75 -6.5 7.5 0 t7.5 0" strokeWidth="2" />
      </g>
      {f.fault && (
        <g data-node="inverter-fault">
          <circle cx="180" cy="100" r="9" fill="var(--brick)" />
          <text x="180" y="104" textAnchor="middle" className="flow-fault-mark">!</text>
        </g>
      )}

      {/* солнце */}
      {f.sunActive && <NodeGlow x={48} y={44} color="var(--sun)" node="sun" />}
      <circle cx="48" cy="44" r={GLOW.disc} className={f.sunActive ? "flow-disc disc-sun" : "flow-disc disc-off"} />
      <g className="flow-icon" strokeLinecap="round">
        <circle cx="48" cy="44" r="5.5" />
        <path d="M48 33v3.5M48 51.5v3.5M37 44h3.5M55.5 44h3.5M40 36l2.5 2.5M53.5 49.5l2.5 2.5M56 36l-2.5 2.5M42.5 49.5L40 52" />
      </g>
      <text className={`flow-lab${f.sunActive ? " on" : ""}`} x="48" y="76" textAnchor="middle">{t.flowSun}</text>
      <text className="flow-val val-sun" x="48" y="90" textAnchor="middle">{f.sunActive || pvW > 0 ? sunVal : `0${w}`}</text>

      {/* сеть: опора ЛЭП */}
      {f.gridActive && <NodeGlow x={272} y={44} color="var(--plum)" node="grid" />}
      <circle cx="272" cy="44" r={GLOW.disc} className={f.gridActive ? "flow-disc disc-grid" : "flow-disc disc-off"} />
      <g className="flow-icon thin" strokeLinecap="round" strokeLinejoin="round">
        <path d="M267 53 L271.2 34 h1.6 L277 53" />
        <path d="M264 39 H280" />
        <path d="M266 39 v3 M278 39 v3" />
        <path d="M268.6 46 H275.4 M268.6 46 L275.4 50.5 M275.4 46 L268.6 50.5 M268 50.5 H276" />
      </g>
      <text className={`flow-lab${f.gridActive ? " on" : ""}${f.gridAbsent ? " alarm" : ""}`} x="272" y="76" textAnchor="middle">{t.cardGrid}</text>
      <text className={`flow-val ${f.gridAbsent ? "val-alarm" : "val-grid"}`} x="272" y="90" textAnchor="middle">{gridVal}</text>

      {/* батарея */}
      {f.batteryDischarging && <NodeGlow x={48} y={196} color="var(--moss)" node="battery" />}
      <circle cx="48" cy="196" r={GLOW.disc} className="flow-disc disc-batt" />
      <g className="flow-icon" strokeLinecap="round">
        <rect x="39" y="191" width="16" height="10" rx="1.5" />
        <line x1="57.5" y1="193.5" x2="57.5" y2="198.5" />
        <rect x="41.5" y="193.5" width="8" height="5" className="flow-icon-fill" />
      </g>
      <text className={`flow-lab${f.batteryDischarging ? " on" : ""}`} x="48" y="226" textAnchor="middle">{t.cardBattery}</text>
      <text className="flow-val val-batt" x="48" y="240" textAnchor="middle">{battVal}</text>

      {/* нагрузка: домик */}
      <circle cx="272" cy="196" r={GLOW.disc}
        className={`flow-disc ${loadAlarm ? "disc-alarm" : f.fault ? "disc-off" : "disc-load"}`} />
      <g className="flow-icon house" strokeLinecap="round" strokeLinejoin="round">
        <path d="M262.5 197.5 L272 188 L281.5 197.5" />
        <path d="M265.5 196 V204.5 H278.5 V196" />
        <path d="M270.5 204.5 V200 H273.5 V204.5" />
      </g>
      <text className={`flow-lab${loadAlarm ? " alarm" : ""}`} x="272" y="226" textAnchor="middle">{t.cardLoad}</text>
      <text className={`flow-val ${loadAlarm ? "val-alarm" : "val-load"}`} x="272" y="240" textAnchor="middle">{loadVal}</text>
    </svg>
  );
}
```

Примечание: узел батареи и в неактивном состоянии остаётся мшистым (`disc-batt`) — батарея всегда «есть»; серым (`disc-off`) гаснут только солнце без выработки, сеть без потока и нагрузка в аварии. Это соответствует финальным макетам (v19: заряжающаяся батарея — цветная без свечения; глухие узлы — серые).

- [ ] **Step 5: CSS.** В `web/app/globals.css` после блока `.home-card-link` (≈строка 195) добавить:

```css
/* ---- Карточка «поток энергии» на обзоре ---- */
.home-card-link-wrap { display: block; color: inherit; text-decoration: none; cursor: pointer; }
.home-card-link-wrap:hover .home-card { outline: 1px solid var(--ink-soft); }
.flow-svg { display: block; width: 100%; height: auto; }
.flow-line { fill: none; stroke-width: 2; stroke-dasharray: 3 5; animation: flow-march 0.9s linear infinite; }
.flow-line.boost { stroke-width: 2.5; }
.flow-line-idle { fill: none; stroke-width: 2; stroke-dasharray: 2 4; stroke: var(--paper-2); }
@keyframes flow-march { to { stroke-dashoffset: -16; } }
@media (prefers-reduced-motion: reduce) { .flow-line { animation: none; } }
.flow-sun { stroke: var(--sun); }
.flow-grid { stroke: var(--plum); }
.flow-moss { stroke: var(--moss); }
.flow-slate { stroke: var(--slate); }
.flow-brick { stroke: var(--brick); }
.flow-disc { stroke-width: 1.5; }
.disc-sun { fill: var(--sun); stroke: var(--sun-deep); }
.disc-grid { fill: var(--plum); stroke: var(--plum-deep); }
.disc-batt { fill: var(--moss); stroke: var(--moss-deep); }
.disc-load { fill: var(--slate); stroke: var(--slate-deep); }
.disc-alarm { fill: var(--brick); stroke: var(--brick-deep); }
.disc-off { fill: var(--paper-2); stroke: var(--hairline); }
.flow-icon { stroke: var(--paper-0); stroke-width: 2; fill: none; }
.flow-icon.thin { stroke-width: 1.7; }
.flow-icon-fill { fill: var(--paper-0); stroke: none; }
.flow-inv, .flow-inv-bypass, .flow-inv-fault { stroke: var(--ink); }
.flow-inv .flow-inv-body, .flow-inv-bypass .flow-inv-body, .flow-inv-fault .flow-inv-body { fill: var(--card); }
.flow-inv-bypass { stroke: var(--sun-deep); }
.flow-inv-fault { stroke: var(--brick); }
.flow-inv-fault .flow-inv-body { fill: #f1e4e0; }
.flow-fault-mark { font-size: 12px; font-weight: 700; fill: var(--paper-0); }
.flow-lab { font-size: 10px; fill: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.05em; }
.flow-lab.on { fill: var(--ink); font-weight: 700; }
.flow-lab.alarm { fill: var(--brick-deep); font-weight: 700; }
.flow-val { font-size: 13px; font-weight: 700; }
.val-sun { fill: var(--sun-deep); }
.val-grid { fill: var(--ink-faint); }
.val-batt { fill: var(--moss-deep); }
.val-load { fill: var(--slate-deep); }
.val-alarm { fill: var(--brick-deep); }
.warnchip { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700;
  letter-spacing: 0.04em; text-transform: uppercase; padding: 1px 7px; border-radius: 5px; }
.warnchip.amber { color: var(--sun-deep); border: 1px solid var(--sun); background: #f0e7d6; }
.warnchip.brick { color: var(--brick-deep); border: 1px solid var(--brick); background: #f1e4e0; }
.card-head .warnchip { order: 1; } /* hairline (::after, order 0) остаётся перед чипом */
```

Активная сеть отдаёт значение цветом `--ink-faint`, когда 0 Вт, — если сеть активна, перекрыть не нужно: `val-grid` оставлен приглушённым намеренно только для 0; при `gridActive` использовать `val-grid-on { fill: var(--plum-deep); }`? — НЕТ: упрощение — цвет значения сети всегда `var(--plum-deep)`, кроме «немає» (кирпич) и нуля. Правка: заменить `.val-grid { fill: var(--ink-faint); }` на `.val-grid { fill: var(--plum-deep); }` и в компоненте для `mainsW === 0 && !f.gridAbsent` использовать класс `val-off` (`.val-off { fill: var(--ink-faint); }` добавить в CSS). В компоненте: `const gridValClass = f.gridAbsent ? "val-alarm" : mainsW > 0 ? "val-grid" : "val-off";` и подставить его.

- [ ] **Step 6: Тесты зелёные** — `npm test -w @sweethome/web -- --testPathPattern InverterFlow` → PASS; `npm run typecheck -w @sweethome/web` → чисто.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(web): add InverterFlow energy-flow diagram component"`

---

### Task 3: Страница обзора — карточка с диаграммой, чипы, Link-обёртка

**Files:**
- Modify: `web/app/(app)/page.tsx` (полная замена тела карточки)
- Modify: `web/app/(app)/page.test.tsx`

**Interfaces:**
- Consumes: `InverterFlow`, `flowState`, `WarnChip` из Task 2; `MetaProvider`/`useMeta` из `@/lib/meta`; `ApiMeta.pvPeakW` из Task 1; `renderWithProviders` c `withMeta: true` + `buildMeta("admin", { pvPeakW: 5160 })`.
- Produces: страница `/` с кликабельной карточкой-диаграммой.

- [ ] **Step 1: Обновить тесты страницы** — `web/app/(app)/page.test.tsx`. Сохраняются кейсы: «connecting до снапшота», «не Panel», «ведёт на /inverter». Меняются/добавляются:

```tsx
it("renders the flow card: badge-free header, node values from the snapshot", async () => {
  const status = buildStatus({
    batteryCapacity: 87, acOutputActivePower: 350, pvPower: 280, mainsPower: 0, batteryPower: 120,
  });
  await renderWithProviders(<HomePage />, {
    snapshot: buildSnapshot({ status }),
    withMeta: true,
    meta: buildMeta("admin", { pvPeakW: 5160 }),
  });
  expect(document.querySelector(".flow-svg")).toBeInTheDocument();
  expect(screen.getByText(/5% · 280/)).toBeInTheDocument();   // солнце: 280/5160 ≈ 5%
  expect(screen.getByText(/87% · \+120/)).toBeInTheDocument(); // батарея
  expect(document.querySelector(".mode-badge")).not.toBeInTheDocument(); // бейджа больше нет
});

it("whole card is a link to /inverter (no separate 'open' link)", async () => {
  await renderWithProviders(<HomePage />, { snapshot: buildSnapshot(), withMeta: true });
  const link = screen.getByRole("link");
  expect(link).toHaveAttribute("href", "/inverter");
  expect(link.querySelector("section.card.home-card")).toBeInTheDocument();
});

it("bypass shows the amber chip in the header", async () => {
  await renderWithProviders(<HomePage />, {
    snapshot: buildSnapshot({ mode: "Bypass", status: buildStatus({ outputLoadPercent: 107 }) }),
    withMeta: true,
  });
  const t = DICTS.uk;
  const chip = screen.getByText(t.flowChipBypass);
  expect(chip.closest(".warnchip")).toHaveClass("amber");
});

it("fault with the Overload bit shows the brick overload chip", async () => {
  await renderWithProviders(<HomePage />, {
    snapshot: buildSnapshot({ mode: "Fault", warnings: { active: ["Overload"], raw: "" } }),
    withMeta: true,
  });
  const t = DICTS.uk;
  const chip = screen.getByText(t.flowChipOverload);
  expect(chip.closest(".warnchip")).toHaveClass("brick");
});
```

Старые ассерты про `home-card-rows`/значения-строки удалить; регресс-гард «не Panel» переписать на новую разметку (селекторы `.panel`, `.panel-toggle`, `.hidden` — те же ожидания absent; карточка теперь внутри `a`). Импорт `buildMeta` добавить из test-utils.

- [ ] **Step 2: Убедиться, что падают** — `npm test -w @sweethome/web -- --testPathPattern 'app/\(app\)/page.test'` → FAIL.

- [ ] **Step 3: Переписать `web/app/(app)/page.tsx`:**

```tsx
"use client";

import Link from "next/link";
import { useSnapshot } from "@/lib/snapshot";
import { MetaProvider, useMeta } from "@/lib/meta";
import { useT, useDocTitle } from "@/lib/i18n";
import { InverterFlow, WarnChip, flowState } from "@/components/InverterFlow";

function InverterCard() {
  const t = useT();
  const { snapshot } = useSnapshot();
  const meta = useMeta();
  const f = snapshot ? flowState(snapshot) : null;

  // Обзор = статус с одного взгляда: карточка всегда видна, вся площадь — ссылка
  // в раздел инвертора; бейджа источника нет — активные источники показывает
  // свечение на диаграмме, особые режимы — чип в шапке.
  return (
    <Link href="/inverter" className="home-card-link-wrap">
      <section className="card home-card">
        <div className="card-head">
          <span className="card-title">{t.navInverter}</span>
          {f?.bypass && <WarnChip tone="amber" label={t.flowChipBypass} />}
          {f?.fault && (
            <WarnChip tone="brick" label={f.overloadFault ? t.flowChipOverload : t.flowChipFault} />
          )}
        </div>
        {!snapshot?.status ? (
          <p className="muted">{t.connecting}</p>
        ) : (
          <InverterFlow snapshot={snapshot} pvPeakW={meta?.pvPeakW} />
        )}
      </section>
    </Link>
  );
}

export default function HomePage() {
  useDocTitle("title");
  return (
    <main className="grid home-grid">
      <MetaProvider>
        <InverterCard />
      </MetaProvider>
    </main>
  );
}
```

- [ ] **Step 4: Тесты зелёные** — `npm test -w @sweethome/web` (весь воркспейс — соседние страницы не должны сломаться) и `npm run typecheck -w @sweethome/web` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(web): energy-flow card on the home overview"`

---

### Task 4: Полный прогон, dev-смоук, финал

**Files:** нет новых.

- [ ] **Step 1: Полный прогон** — `npm run build && npm run check && npm test` из корня → всё зелёное.

- [ ] **Step 2: Dev-смоук** — `npm run dev` в фоне; открыть `http://localhost:3001` (mock-транспорт даёт живые данные): на `/` карточка-диаграмма, штрихи текут, активные узлы светятся, клик по карточке ведёт в `/inverter`. Погасить dev-процессы. (Playwright не запускать; браузером смотрит пользователь.)

- [ ] **Step 3: Сообщить пользователю** — предложить мерж (только после явного «да») и деплой; напомнить про ручной шаг на Pi: добавить `INVERTER_PV_PEAK_W=5160` в `/home/pi/sweethome/server/.env` (deploy.sh файл не трогает) до/сразу после деплоя.

## Self-Review (выполнен)

- Spec coverage: §2 (Link-обёртка, шапка+чип, SVG-структура) — Task 2/3; §3 (правило свечения, направление штрихов, reduced-motion) — Task 2; §4 (форматы подписей, «немає», fallback без пика/паспорта) — Task 2; §5 (байпас/перегруз/авария/нет сети, «було N») — Task 2/3; §6 (конфиг+meta+fake-gateway+ручной шаг на Pi) — Task 1 и Task 4 Step 3; §7 (границы файлов, тесты) — соблюдены.
- Placeholder scan: Task 1 Step 5 содержит каркас теста с комментарием-инструкцией «по образцу соседних» — сознательно: харнесс роутер-тестов уже существует в файле, копировать его в план дословно = дублировать 40 строк контекстного сетапа; исполнителю дан точный критерий (env до сборки deps, две проверки).
- Type consistency: `flowState`/`pctLabel`/`WarnChip`/`InverterFlow` — сигнатуры совпадают между Task 2 (определение) и Task 3 (использование); `ApiMeta.pvPeakW?` (Task 1) ↔ `meta?.pvPeakW` (Task 3); дата-атрибуты тестов соответствуют разметке компонента.
