# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## О проекте

`inverter-monitor` — локальный мониторинг и управление гибридным инвертором **SK-5500P-48L**
(семейство **ISolar/EASUN SMG II**) по **Modbus RTU через RS232**, без облака SmartESS.
Работает на Raspberry Pi.

Полное функциональное описание, API, конфигурация, траблшутинг — в `README.md` (подробный,
англоязычный, поддерживай его при изменениях фич). Этот файл — только про архитектуру и
рабочий процесс.

## Команды (из корня репозитория)

```bash
npm install        # ставит зависимости всех воркспейсов разом (это монорепо)
npm run dev        # server :3000 (форсит INVERTER_TRANSPORT=mock) + web :3001 (Next.js HMR, проксирует /api на :3000)
npm run build      # СТРОГО в порядке shared → server → web
npm run check      # jest: протокол + stats + auth + auth-http (server) + typecheck (web)
./deploy.sh        # локальная сборка → rsync на Pi → npm ci → рестарт systemd → health-check
```

- **`npm run check -w server` (= `npm test -w server`) гоняет jest**: протокол (`src/protocol/modbus.test.ts`, `smg.test.ts`), SQLite-статистика (`src/stats/db.test.ts`), хеши/роли/флоу авторизации (`src/auth/hash.test.ts`, `policy.test.ts`, `db.test.ts`, `service.test.ts`) и авторизация сквозь реальный `createServer` по HTTP (`src/server.http.test.ts`: гейты, роли, форс смены пароля). Ни один из них — не typecheck.
- **Тесты лежат рядом с исходниками** (`*.test.ts`) — миграция с четырёх ручных `assert`-скриптов `scripts/selfcheck*.ts` на jest завершена. Протокольные тесты сверяют **эталонные Modbus-кадры, снятые с живого инвертора** (запрос `01 03 00 C9 00 01 54 34` → ответ `01 03 02 00 03 F8 45` и др.), CRC-16/Modbus, декодеры регистров и билдеры сеттеров. **После правок в `server/src/protocol/*` обязательно гоняй `npm test -w server`.**
- **`src/stats/db.test.ts`** аналогично проверяет схему/свёртки/retention SQLite-статистики (`src/stats/db.ts`, `recorder.ts`). **После правок в `server/src/stats/*` обязательно гоняй тесты.**
- `npm run check` для сервера — это jest, а НЕ проверка типов. Типы сервера проверяются только сборкой (`tsc` в `npm run build`). Веб проверяется отдельно (`tsc --noEmit`).
- Деплой на Pi — `PI_HOST=pi@… SSH_KEY=~/.ssh/… ./deploy.sh`; учитывай, что скрипт пересобирает всё локально, заливает артефакты и **рестартует живой systemd-сервис** на Pi. Конкретный адрес/ключ — вне репозитория (локальное окружение владельца).
- Node: root `engines` и `server` `engines` — оба **≥ 24** (нужен встроенный `node:sqlite` для статистики). Сам Pi уже на **Node 24** (Raspberry Pi OS Trixie, arm64) — совпадает с заявленным минимумом.

## Протокол (важно: Modbus, НЕ PI30)

Инвертор говорит **Modbus RTU: 9600 бод 8N1, slave id 1** (настройка №25 «Modbus ID» в меню).
Историческая справка: изначально проект был написан под Voltronic PI30 (QPIGS/CRC-XMODEM) —
это оказалось ошибкой, инвертор на PI30 не отвечает вообще; 2026-07-23 протокольный слой
переписан на Modbus. Карта регистров — из **syssi/esphome-smg-ii** (проверена на живом
устройстве):

- **Статус**: 201 режим (0..6), 202 сеть В ×0.1, 203 Гц ×0.01, 210/212/213/214 выход,
  215 батарея В ×0.1, 217 мощность батареи (±), 219/220/223/224 PV, 225 нагрузка %,
  226/227 температуры, 229 SOC, 232 ток батареи ×0.1 (+заряд/−разряд).
- **Аварии**: 100–101 fault (32 бита), 108–109 warning (32 бита) — списки битов в `smg.ts`.
- **Настройки**: 300–343 (301 приоритет выхода, 331 приоритет заряда, 332/333 токи ×0.1,
  324/325/326/327/329 пороги напряжений ×0.1, 341–343 SOC-пороги), 643 номинал Вт.
- **Запись — ТОЛЬКО function 0x10** (Write Multiple Registers) — устройство не понимает 0x06.
- **Пейсинг**: между командами нужна пауза (~120 мс, esphome использует 200 мс) — реализована
  в очереди `Inverter.enqueue`.
- Инвертор отвечает **только на 9600** (на 2400/4800/19200 молчит).

## Архитектура

Монорепо на npm workspaces: `shared/`, `server/`, `web/`. Порядок сборки не случаен — `server` и `web` импортируют `@inverter/shared` из его **собранного `dist/`**, поэтому shared всегда собирается первым.

### `shared/` — контракт между сервером и вебом
`@inverter/shared` — единственный источник правды и для типов данных (`Snapshot`, `InverterStatus`, `InverterRatedInfo`, `Baseline` и т.д. в `types.ts`), и для **whitelist-контракта управления** (`api.ts`: тип `ControlType`, карты `OUTPUT_SOURCE_PRIORITY`/`CHARGER_SOURCE_PRIORITY`, массивы допустимых токов, `ApiMeta`). И сервер, и веб тянут значения отсюда — не дублируй enum'ы на стороне.

**Добавление новой управляющей команды** трогает несколько файлов согласованно: `shared/src/api.ts` (в `ControlType` + при необходимости в `ApiMeta`) → `server/src/protocol/smg.ts` (ветка в `buildControlWrite`: регистр + масштаб + валидация) → `server/src/server.ts` (`CONTROL_TYPES`) → `web/` (UI). Пропустишь один — рассинхрон.

### `server/` — слои снизу вверх
1. **`src/protocol/`** — Modbus RTU + карта SMG II.
   - `modbus.ts` — CRC-16/Modbus (poly 0xA001, init 0xFFFF, LE в кадре), `buildReadRequest`/`buildWriteRequest` (fn 0x03/0x10), `parseReadResponse`/`parseWriteResponse`, `expectedResponseLength`, `ModbusError` с кодом исключения, `toSigned` (S_WORD).
   - `smg.ts` — блоки чтения (`STATUS_BLOCKS`/`ALARM_BLOCKS`/`SETTINGS_BLOCKS` — только документированные диапазоны, без «дыр»), декодеры (`decodeStatus`/`decodeSettings`/`decodeFlags`/`decodeAlarms`/`decodeMode`), сеттеры (`buildControlWrite`). **Масштабирование — делением** (`/10`, `/100`), не умножением на 0.1 — иначе float-хвосты (232.70000000000002) ломают jest-тесты и UI.
2. **`src/transport/`** — общий интерфейс `Transport` + две реализации: `serial` (`serialport`, optionalDependency c `isAvailable()`-проверкой) и `mock` (**полноценный эмулятор Modbus-slave**: отвечает на fn 0x03 из внутренней карты регистров с правдоподобной динамикой, принимает записи fn 0x10). `transact(frame, timeout, expectedLen)` — чтение завершается по накоплению `expectedLen` байт ЛИБО по кадру-исключению (5 байт, бит 0x80 у функции). `detect.ts`: mock всегда последним; onboard-UART'ы Pi отфильтровываются — только USB-serial, если явно не задан `INVERTER_SERIAL_DEVICE`.
3. **`src/inverter.ts`** — ядро. **Вся работа с транспортом сериализована через одну очередь-промис (`enqueue`) с пейсингом 120 мс** между командами. Поллинг: статус+аварии каждый цикл (7 блоковых чтений), настройки раз в ~6 циклов и всегда на первом цикле после коннекта; probe при коннекте — чтение регистра 201 с валидацией режима; автопереподключение после 3 подряд ошибок; **захват baseline** (один раз на устройство, сохраняется на диск); блокировка записи. `rawQuery` понимает текстовые команды `"R <адрес> [количество]"` (всегда) и `"W <адрес> <значение>"` (под теми же гейтами, что `control()`).
3½. **`src/stats/`** — статистика в SQLite через встроенный `node:sqlite` (Node ≥ 24, нативных
   зависимостей нет). `db.ts` — схема (samples 30 дней / samples_minute 2 года / daily+events
   бессрочно), свёртки по watermark, retention; `recorder.ts` — подписка на `"snapshot"`,
   буфер с флашем раз в 60 с (щадит SD), деривация событий из диффа снапшотов (смена режима,
   потеря/возврат сети, аварии, связь, device-changed). **Окно солнечного дня** (начало/конец
   устойчивой выработки PV) считается отдельно — ретроспективно из поминутного ряда
   `samples_minute` в `db.ts` (`computeSolarWindow` в `solar.ts` + `querySolarWindow`),
   хранится в `daily` (`solar_start_ts`/`solar_end_ts`) и отдаётся эндпоинтом
   `/api/stats/solar-window`. Никогда не пишет в инвертор. Тесты —
   `src/stats/db.test.ts`, `src/stats/solar.test.ts` (jest, входит в `npm run check -w server`).
4. **`src/server.ts`** — Express (REST под `/api` + раздача статики `web/out`) и WebSocket (`/ws`, push каждого `Snapshot`). `Inverter` — `EventEmitter`, сервер и MQTT подписаны на событие `"snapshot"`.
5. **`src/mqtt.ts`** — публикация в MQTT с автодискавери Home Assistant (по умолчанию выключено, `MQTT_URL` пуст).
6. **`src/config.ts`** — вся конфигурация только из env (см. `.env.example`): `INVERTER_BAUD` default **9600**, `MODBUS_SLAVE_ID` default 1, transport `auto|serial|mock`.

### Модель безопасности записи (ключевой замысел — не ломать)
Принцип «читаем, но не перезаписываем, пока не нужно». При правках путей управления сохраняй все гейты:
- Поллинг/коннект шлют **только чтение (fn 0x03)**. Ничего не пишется автоматически.
- `ALLOW_CONTROL=false` — необратимый режим только-чтение (разблокировать нельзя). `STARTUP_LOCKED` — старт в locked. `AUTO_RELOCK` — авто-возврат блокировки после каждой успешной записи.
- `/api/raw`: `R`-команды всегда, `W`-команды гейтятся теми же проверками, что и `control()` — иначе это была бы дыра в обход блокировки.
- MQTT-управление (`MQTT_ENABLE_CONTROL=true`) намеренно обходит UI-блокировку через `opts.bypassLock` — сам этот флаг и есть осознанная авторизация; он не трогает UI-lock.
- Все сеттеры проходят whitelist регистров + валидацию значений; ошибка записи = Modbus-исключение от инвертора.

### Авторизация (`server/src/auth/`)
- `hash.ts` — scrypt-хеширование паролей (встроенный `crypto`, без зависимостей).
- `db.ts` — `AuthDb` на `node:sqlite` (`data/auth.db`): пользователи + сессии, сидинг
  admin/user при пустой БД.
- `policy.ts` — чистая `canAccess(role, required)` (тестируется `policy.test.ts`).
- `service.ts` — класс `Auth`: логин/сессии/смена пароля, анти-brute-force по IP.
- Две роли: `admin` (всё) / `viewer` (только `/` и `/stats`). Ограничения — и на
  сервере (middleware 403 + редиректы страниц), и в UI (навигация по роли).
- Форс смены пароля: `must_change_password=1` блокирует весь `/api` кроме
  `me`/`change-password`/`logout`, пока пароль не изменён.
- **API-токены** (таблица `api_tokens` в `auth.db`, `Authorization: Bearer inv_…`, sha256
  в БД, скоупы `read`/`write`): middleware `/api` пробует cookie, затем Bearer и кладёт в
  `req.auth` поля `kind`/`scopes`/`tokenName`. Мутирующие роуты (`control`, `lock`,
  `raw` с `W`, `baseline/recapture`) требуют скоуп `write` — кроме `POST /api/control`
  с `preview: true`, это чтение (`Inverter.previewControl`). `/api/users` и `/api/tokens`
  по токену закрыты (`code: session_required`) — управление доступами только из UI-сессии.
  Токен владельца под форсом смены пароля отклоняется. Выдача: UI на `/users`,
  `POST /api/tokens` или `scripts/issue-token.ts`. `/ws` принимает тот же Bearer.
- Тесты — `hash.test.ts`, `policy.test.ts`, `db.test.ts`, `service.test.ts`, `tokens.test.ts` (jest, входят в `npm run check -w server`); HTTP-флоу — `src/server.http.test.ts`.

### `web/` — Next.js (App Router)
- **Прод = статический экспорт** (`output: "export"` в `next.config.ts`) в `web/out/`, который раздаёт сам Express. **Dev** = `next dev -p 3001` + rewrites `/api/*` → `http://localhost:3000` (см. `next.config.ts`). Отсюда же `web/lib/api.ts::wsUrl()` разводит dev (`ws://localhost:3000`) и прод.
- Роут-группа `app/(app)/` — авторизованная оболочка (дашборд, `stats`, `settings`, `diagnostics`, `users`); `app/login/` и `app/change-password/` открыты. Навигация и доступ зависят от роли (см. «Авторизация»): viewer видит только дашборд и `stats`. Сервер редиректит страничные маршруты (`/login` без сессии; `/change-password` при форсе смены пароля; `/` для viewer на admin-страницах), но статику (css/js/страницы) отдаёт свободно — данные защищены на уровне `/api`.
- Данные в UI — `web/lib/snapshot.tsx` (подписка на WS с реконнектом и пометкой stale), `meta.tsx` (справочники управления с ретраем; несёт текущего юзера/роль в `ApiMeta.session`), `stats.ts` (клиент `/api/stats/*`), `format.ts`, `toast.tsx`.
- **i18n** (`web/lib/i18n/`): типизированный словарь UA/RU/EN. Стартовый язык жёстко `uk`, чтобы совпасть с SSG-пререндером (иначе hydration mismatch); реальный выбор подхватывается из `localStorage` уже после маунта. Словарь локализует и **имена битов fault/warning** (английские строки из `smg.ts` — это ключи `dict.warnings`), и **флаги-переключатели** (ключи `lcdHome`/`ecoMode`/… из `FLAG_DEFS`) — при изменении строк в `smg.ts` синхронизируй `dict.ts`.

## Железо (контекст для отладки связи)
- Цепь: RS232-порт инвертора (RJ45) → штатный кабель донгла DB9↔RJ45 (RJ45 1→DB9 2 = TX инвертора, 2→3 = RX, 8→5 = GND; null-modem НЕ нужен) → USB-RS232 адаптер (FTDI FT231X, **настоящие RS232-уровни ±12 В**) → USB Pi.
- ⚠️ USB-TTL-свистки (часто продаются как «USB-RS232» на CH340) с инвертором физически несовместимы — порт откроется, но обмен молчит. Проверка: на TX адаптера в покое должно быть **−5…−12 В**.
- В типичной инсталляции USB-B порт инвертора занят BMS батареи — путь через RS232.

## Деплой на Pi (важные детали)
- Сборка **целиком локальная**; Pi только `npm ci -w server --omit=dev` + рестарт systemd. Pi ничего не компилирует.
- На Pi конфиг и данные лежат под `server/` (`server/.env`, `server/data/{baseline.json, auth.db, stats.db}`); systemd-юнит имеет `WorkingDirectory=…/server`. `auth.db`/`stats.db` создаются автоматически при первом старте; `deploy.sh` каталог `data/` не трогает.
- `systemctl enable` (автозапуск после ребута Pi) — разовая ручная операция, `deploy.sh` его не делает.

## Git-workflow
- Репозиторий: `git@github.com:apanamaryov/sweethome.git` (remote `origin`, ветка по умолчанию `main`).
- Новые изменения — через feature-ветки и PR, не коммитить напрямую в `main`.
- В `main` не мержить без явного подтверждения пользователя.
- Секреты (`server/.env`, реальные пароли/данные Pi) в репозиторий не попадают — они вне git и в `.gitignore`.
