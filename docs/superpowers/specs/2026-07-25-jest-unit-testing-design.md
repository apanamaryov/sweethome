# Дизайн: покрытие inverter-monitor unit-тестами (jest)

Дата: 2026-07-25
Статус: одобрен, готов к плану реализации

## Цель

Покрыть монорепо `inverter-monitor` (`shared/`, `server/`, `web/`) unit-тестами
на **jest** — максимально по всем содержательным модулям. Существующие 4
`selfcheck`-скрипта (`assert` через `tsx`) мигрировать в jest-тесты и удалить.
Coverage собирается и показывается, но **без падающих порогов** (thresholds).

Решения по scope (согласованы с владельцем):
- Scope: **весь монорепо** (server + shared + web), стремление к максимальному
  покрытию всех содержательных файлов.
- Selfcheck: **мигрировать в jest**, старые скрипты удалить, `npm run check`
  переопределить на jest.
- Coverage: **прагматично, без жёстких thresholds** — отчёт есть, CI не падает
  из-за цифры покрытия.

## Технический контекст (проверено на месте)

- `shared` и `server` — **CommonJS** (`tsconfig`: `module: "commonjs"`,
  `moduleResolution: "node"`). ESM-настройки jest НЕ нужны — ts-jest работает
  из коробки.
- **Node 24** доступен через nvm (`.nvmrc` = 24, установлен `v24.11.0`).
  `node:sqlite` работает **без флага** (только experimental-warning). Значит
  тесты `stats/db` и `auth/db` реальны на `:memory:`-БД. Тесты гоняются под
  Node 24 (`nvm use`).
- `@inverter/shared` импортируется по имени пакета из **собранного `dist/`**.
  В тестах замапим на исходники (`shared/src/index.ts`) через `moduleNameMapper`
  — не требует пре-сборки.
- `web` — Next 15 (App Router, `output: "export"`) + React 19 → `next/jest`
  (SWC-трансформер) + `jsdom` + Testing Library.
- `serialport` — optionalDependency, в тестах мокается (не ставится реально).
- jest пока не установлен ни в одном воркспейсе.

## Архитектура тестов

### Организация: per-workspace (не корневой `projects`)

Стек server (node, ts-jest, Node 24, node:sqlite) и web (jsdom, next/jest, SWC)
радикально разный — чистое разделение по воркспейсам надёжнее, чем два
трансформера в одном конфиге, и совпадает с конвенцией репо (`-w server`/`-w web`).

- **server**: `server/jest.config.cjs` — `ts-jest`, `testEnvironment: node`,
  `roots: ["<rootDir>/src", "<rootDir>/../shared/src"]` (тесты `shared` живут
  рядом с исходниками shared и гоняются из server-конфига),
  `moduleNameMapper: { "^@inverter/shared$": "<rootDir>/../shared/src/index.ts" }`.
- **web**: `web/jest.config.ts` через `next/jest`, `testEnvironment: jsdom`,
  `setupFilesAfterEnv` с `@testing-library/jest-dom` и `jest-canvas-mock`.
- **корень**: `npm test` = `npm test -w server && npm test -w web`;
  `npm run check` → `npm test -w server` (замена selfcheck; типы по-прежнему
  проверяются сборкой). `npm run test:coverage` — агрегированный отчёт.

### Расположение тестов

Рядом с исходниками: `*.test.ts` / `*.test.tsx` в тех же папках, что и код
(`server/src/protocol/modbus.test.ts`, `web/components/BatteryRing.test.tsx`).
Эталонные Modbus-кадры и общие фикстуры — в `server/src/__fixtures__/` при
необходимости переиспользования.

## Что покрываем и чем мокаем

### shared
- `api.ts` — карты `OUTPUT_SOURCE_PRIORITY`/`CHARGER_SOURCE_PRIORITY`,
  массивы допустимых токов, `ControlType`, `ApiMeta`. Чистые данные/инварианты.
- `auth.ts` — типы/хелперы ролей.
- `types.ts`, `index.ts` — только типы/реэкспорт, из coverage исключаются.

### server/protocol (чистые функции — ядро надёжности)
- `modbus.ts` — `crc16`, `buildReadRequest`, `buildWriteRequest`,
  `parseReadResponse`, `parseWriteResponse`, `expectedResponseLength`,
  `ModbusError`, `toSigned`. Переносим **эталонные кадры из `selfcheck.ts`**.
- `smg.ts` — `decodeStatus`, `decodeSettings`, `decodeFlags`, `decodeAlarms`,
  `decodeMode`, `buildControlWrite`, блоки чтения. Масштабирование делением
  (проверяем отсутствие float-хвостов). Валидация whitelist/значений сеттеров.

### server/transport
- `mock.ts` — эмулятор Modbus-slave: ответы на fn 0x03 из карты регистров,
  приём fn 0x10, exception-кадры (бит 0x80), завершение `transact` по
  `expectedLen`/исключению.
- `serial.ts` — мок `serialport` (optional dep): открытие/закрытие, `transact`,
  таймауты, `isAvailable()`.
- `detect.ts` — мок env + serialport: порядок (mock последним), фильтрация
  onboard-UART Pi, приоритет `INVERTER_SERIAL_DEVICE`.

### server/stats
- `db.ts` — на `:memory:`: схема (samples/samples_minute/daily/events),
  свёртки по watermark, retention (30 дней / 2 года / бессрочно). Логика из
  `selfcheck-stats.ts`.
- `recorder.ts` — деривация событий из диффа снапшотов (смена режима,
  потеря/возврат сети, аварии, связь, старт/стоп зарядки от солнца по
  гистерезису Шмитта), буфер и флаш раз в 60 с через **fake timers**. Никогда
  не пишет в инвертор — проверяем.

### server/auth
- `hash.ts` — scrypt: хеш/verify, разные соли, неверный пароль.
- `policy.ts` — `canAccess(role, required)` — таблица истинности admin/viewer.
- `db.ts` — `AuthDb` на `:memory:`: сидинг admin/user, CRUD пользователей,
  сессии. Логика из `selfcheck-auth.ts`.
- `service.ts` — `Auth`: логин/сессии/смена пароля, anti-brute-force по IP
  (lockout — через fake timers), `must_change_password`-гейт.

### server (ядро и wiring)
- `config.ts` — парсинг env: дефолты (`INVERTER_BAUD` 9600, `MODBUS_SLAVE_ID` 1,
  transport `auto`), флаги `ALLOW_CONTROL`/`STARTUP_LOCKED`/`AUTO_RELOCK`.
- `store.ts` — baseline: чтение/запись на диск через мок `fs`.
- `mqtt.ts` — мок `mqtt`-клиента: топики публикации, HA-автодискавери, gate
  `MQTT_ENABLE_CONTROL`/`bypassLock`.
- `inverter.ts` — ядро на **mock-транспорте** + fake timers: сериализация
  очереди `enqueue` с пейсингом 120 мс, поллинг (статус/аварии каждый цикл,
  настройки раз в ~6 циклов), probe при коннекте, автопереподключение после
  3 ошибок, захват baseline один раз, гейты записи (`ALLOW_CONTROL`,
  `STARTUP_LOCKED`, `AUTO_RELOCK`), `rawQuery` (`R`/`W` под гейтами),
  события `EventEmitter`.
- `server.ts` — Express REST (`/api`) + WS (`/ws`) + auth-гейты через
  **supertest** + `ws`-клиент: роли (admin/viewer 403/редиректы), форс смены
  пароля, lockout по IP. Логика из `selfcheck-auth-http.ts`.

### web/lib
- `format.ts` — форматтеры значений.
- `i18n/` — словарь UA/RU/EN (инварианты ключей), провайдер `index.tsx`
  (стартовый `uk`, подхват из localStorage).
- `api.ts` — `wsUrl()` dev/prod, базовые вызовы (мок `fetch`).
- `stats.ts` — клиент `/api/stats/*` (мок `fetch`).
- `snapshot.tsx` — подписка на WS с реконнектом и пометкой stale (мок WS).
- `meta.tsx` — справочники управления с ретраем, сессия/роль (мок `fetch`).
- `toast.tsx` — очередь тостов.

### web/components (RTL)
- `BatteryRing`, `Panel`, `ConfirmDialog`, `LangSwitch` — рендер/пропсы/события.
- `TimeChart` — RTL + `jest-canvas-mock` (uplot рисует в canvas).

### web/app (RTL с мок-контекстами) — последняя фаза, повышенный риск
- Страницы `(app)/*` (дашборд, stats, settings, diagnostics, users),
  `login`, `change-password`. `'use client'` + контексты (i18n, snapshot, meta,
  toast) мокаются через тестовые провайдеры. Риск хрупкости из-за App Router —
  покрываем по возможности, при чрезмерной сложности отдельных страниц
  фиксируем как известное ограничение в итоговом отчёте.

## Миграция selfcheck

| Скрипт | Куда мигрирует |
|--------|----------------|
| `scripts/selfcheck.ts` (протокол, 204) | `src/protocol/modbus.test.ts` + `src/protocol/smg.test.ts` |
| `scripts/selfcheck-stats.ts` (274) | `src/stats/db.test.ts` (+ `recorder.test.ts`) |
| `scripts/selfcheck-auth.ts` (106) | `src/auth/*.test.ts` |
| `scripts/selfcheck-auth-http.ts` (141) | `src/server.http.test.ts` |

- Эталонные кадры и assert-инварианты сохраняются 1:1 (это снятые с живого
  устройства данные — не переписывать значения).
- После миграции: удалить `scripts/selfcheck*.ts`, переопределить
  `server/package.json` `check` → jest.
- `scripts/reset-password.ts` — **оставить** (CLI-утилита, не тест).
- Обновить упоминания selfcheck в `CLAUDE.md` и `README.md` (раздел про `check`
  и «основной тест»).

## Coverage

- `collectCoverageFrom`:
  - server: `src/**/*.ts` минус `src/index.ts`, `src/**/types.ts`, `*.d.ts`.
  - shared: `src/api.ts`, `src/auth.ts` (типы-only файлы исключены).
  - web: `lib/**`, `components/**`, `app/**` минус `*.d.ts`, layout-обёртки при
    отсутствии логики.
- Репортеры: `text` + `html`. **`coverageThreshold` не задаём.**

## Зависимости к установке

- **server** (devDeps): `jest`, `ts-jest`, `@types/jest`, `supertest`,
  `@types/supertest`.
- **web** (devDeps): `jest`, `jest-environment-jsdom`, `@testing-library/react`,
  `@testing-library/jest-dom`, `@testing-library/user-event`,
  `jest-canvas-mock`, `@types/jest`. (`next/jest` идёт с `next`.)

## Принятые технические решения

- `ts-jest` (не `@swc/jest`) для server/shared — проще для CommonJS, надёжнее.
- Per-workspace конфиги (не корневой `projects`).
- Тесты `shared` гоняются из server-конфига (`roots` включает `shared/src`).
- Тесты web/app-страниц — последней фазой из-за риска хрупкости App Router.
- Прогон под Node 24 (обязателен для `node:sqlite`).

## Фазы реализации

1. Инфраструктура server+shared (установка, `jest.config.cjs`, sanity-тест).
2. `protocol/` + миграция `selfcheck.ts`.
3. `transport/` (mock, serial, detect).
4. `stats/` + миграция `selfcheck-stats.ts`.
5. `auth/` + `server.ts`/HTTP (supertest) + миграция `selfcheck-auth*.ts`.
6. `config`, `store`, `mqtt`, `inverter` (ядро).
7. Инфраструктура web (next/jest, jsdom, RTL, canvas-мок).
8. `web/lib` + `web/components`.
9. `web/app` страницы.
10. Финал: удалить старые selfcheck, переопределить `check`, обновить доки,
    прогнать полный coverage.

## Вне scope

- E2E/интеграционные тесты через реальный serialport или живой инвертор.
- Playwright/браузерные тесты UI (только unit/компонентные через RTL).
- `scripts/reset-password.ts` (CLI-утилита).
- Достижение конкретной цифры coverage (нет thresholds).
