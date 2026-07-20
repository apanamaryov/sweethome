# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## О проекте

`inverter-monitor` — локальный мониторинг и управление гибридным инвертором **SK-5500P-48L**
(семейство Voltronic / SmartESS) напрямую по serial/USB-HID, без облака SmartESS. Работает на
Raspberry Pi (обычно `pi@192.168.1.112`).

Полное функциональное описание, API, конфигурация, траблшутинг — в `README.md` (подробный,
поддерживай его при изменениях фич). Этот файл — только про архитектуру и рабочий процесс.

## Команды (из корня репозитория)

```bash
npm install        # ставит зависимости всех воркспейсов разом (это монорепо)
npm run dev        # server :3000 (форсит INVERTER_TRANSPORT=mock) + web :3001 (Next.js HMR, проксирует /api на :3000)
npm run build      # СТРОГО в порядке shared → server → web
npm run check      # selfcheck протокола (server) + typecheck (web)
./deploy.sh        # локальная сборка → rsync на Pi → npm ci → рестарт systemd → health-check
```

- **Единственный «тест» — `server/scripts/selfcheck.ts`** (запускается как `npm run check -w server`, а также `cd server && npx tsx scripts/selfcheck.ts`). Это не typecheck: он через `assert` сверяет эталонные CRC, раундтрип кадров и позиционный маппинг парсеров PI30. Джестов/витестов нет. **После правок в `server/src/protocol/*` обязательно гоняй selfcheck.**
- `npm run check` для сервера — это selfcheck, а НЕ проверка типов. Типы сервера проверяются только сборкой (`tsc` в `npm run build`). Веб проверяется отдельно (`tsc --noEmit`).
- Деплой на дев-Pi — можно; учитывай, что `deploy.sh` пересобирает всё локально, заливает артефакты и **рестартует живой systemd-сервис** на Pi. Параметры: `PI_HOST=pi@… SSH_KEY=~/.ssh/… ./deploy.sh`.
- Node: root `engines` — **≥ 20**, `server` `engines` — **≥ 18** (заявленный минимум). Сам Pi сейчас на **Node 24** (Raspberry Pi OS Trixie, arm64). Держи server-код в рамках заявленного `>=18`, если сознательно не поднимаешь `engines`.

## Архитектура

Монорепо на npm workspaces: `shared/`, `server/`, `web/`. Порядок сборки не случаен — `server` и `web` импортируют `@inverter/shared` из его **собранного `dist/`**, поэтому shared всегда собирается первым.

### `shared/` — контракт между сервером и вебом
`@inverter/shared` — единственный источник правды и для типов данных (`Snapshot`, `InverterStatus`, `InverterRatedInfo`, `Baseline` и т.д. в `types.ts`), и для **whitelist-контракта управления** (`api.ts`: тип `ControlType`, карты `OUTPUT_SOURCE_PRIORITY`/`CHARGER_SOURCE_PRIORITY`, массивы допустимых токов, `ApiMeta`). И сервер, и веб тянут значения отсюда — не дублируй enum'ы на стороне.

**Добавление новой управляющей команды** трогает несколько файлов согласованно: `shared/src/api.ts` (в `ControlType` + при необходимости в `ApiMeta`) → `server/src/protocol/pi30.ts` (билдер команды + ветка в `buildControlCommand`) → `server/src/server.ts` (`CONTROL_TYPES`) → `web/` (UI). Пропустишь один — рассинхрон.

### `server/` — слои снизу вверх
1. **`src/protocol/`** — протокол **PI30** (текстовый, семейство Voltronic).
   - `crc.ts` — **CRC-16/XMODEM с квирком Voltronic**: байт CRC, совпавший с управляющим (`0x28 '('`, `0x0d`, `0x0a`), инкрементируется на 1. Плюс `buildFrame`/`parseFrame`/`buildResponse`. `parseFrame` в порядке исключения принимает `ACK`/`NAK` без валидного CRC (некоторые прошивки их портят на коротких ответах).
   - `pi30.ts` — парсеры ответов (`QPIGS` статус, `QPIRI` номиналы/настройки, `QMOD`, `QPIWS`, `QFLAG`, `QID`) и билдеры сеттеров (`POP`/`PCP`/`MCHGC`/`MUCHGC`/`PBCV`/`PBDV`). Парсеры **позиционные** (поля по индексу) и всегда сохраняют `raw` — у клонов Voltronic порядок/единицы полей плавают, `raw` подстраховывает.
2. **`src/transport/`** — общий интерфейс `Transport` + три реализации: `serial` (`serialport`), `hid` (`node-hid`, мост Cypress VID `0x0665`/PID `0x5161`), `mock` (демо-данные). `serialport`/`node-hid` — **optionalDependencies**: код проверяет `isAvailable()`, чтобы работать даже без нативных модулей. `detect.ts` строит упорядоченный список кандидатов; mock всегда добавляется последним, чтобы приложение никогда не «умирало». Onboard-UART'ы Pi (ttyAMA0/ttyS0/serial*) отфильтровываются — только USB-serial, если явно не задан `INVERTER_SERIAL_DEVICE`.
3. **`src/inverter.ts`** — ядро. **Вся работа с транспортом сериализована через одну очередь-промис (`enqueue`)** — UART один, параллельных обращений быть не должно. Здесь: поллинг по таймеру (`QPIGS`/`QMOD` каждый цикл, настройки/флаги/предупреждения раз в ~6 циклов и всегда на первом цикле после коннекта), автопереподключение (после 3 подряд ошибок — сброс транспорта и повторный detect), **захват baseline** (один раз на устройство, ключ — серийник из `QID`, сохраняется на диск), блокировка записи.
4. **`src/server.ts`** — Express (REST под `/api` + раздача статики `web/out`) и WebSocket (`/ws`, push каждого `Snapshot`). `Inverter` — `EventEmitter`, сервер и MQTT подписаны на событие `"snapshot"`. Центральный объект данных — `Snapshot`, он же уходит по WS и лежит в `/api/snapshot`.
5. **`src/mqtt.ts`** — публикация в MQTT с автодискавери Home Assistant (по умолчанию выключено, `MQTT_URL` пуст).
6. **`src/config.ts`** — вся конфигурация только из env (см. `.env.example`), нигде больше `process.env` не читается.

### Модель безопасности записи (ключевой замысел — не ломать)
Принцип «читаем, но не перезаписываем, пока не нужно». При правках путей управления сохраняй все гейты:
- Поллинг/коннект шлют **только read-команды**. Ничего не пишется автоматически.
- `ALLOW_CONTROL=false` — необратимый режим только-чтение (разблокировать нельзя). `STARTUP_LOCKED` — старт в locked. `AUTO_RELOCK` — авто-возврат блокировки после каждой успешной записи.
- `/api/raw` пропускает `Q*`-команды всегда, но любую не-query команду гейтит теми же проверками, что и `control()` — иначе это была бы дыра в обход блокировки.
- MQTT-управление (`MQTT_ENABLE_CONTROL=true`) намеренно обходит UI-блокировку через `opts.bypassLock` — сам этот флаг и есть осознанная авторизация; он не трогает UI-lock.
- Все сеттеры проходят whitelist + валидацию значений; инвертор отвечает `ACK`/`NAK`.

### `web/` — Next.js (App Router)
- **Прод = статический экспорт** (`output: "export"` в `next.config.ts`) в `web/out/`, который раздаёт сам Express. **Dev** = `next dev -p 3001` + rewrites `/api/*` → `http://localhost:3000` (см. `next.config.ts`). Отсюда же `web/lib/api.ts::wsUrl()` разводит dev (`ws://localhost:3000`) и прод.
- Роут-группа `app/(app)/` — авторизованная оболочка (дашборд, settings, diagnostics); `app/login/` открыта. Сервер редиректит страничные маршруты на `/login` при отсутствии сессии, но статику (css/js/страница логина) отдаёт свободно — в ней нет данных.
- Данные в UI — `web/lib/snapshot.tsx` (подписка на WS с реконнектом и пометкой stale), `meta.tsx` (справочники управления с ретраем), `format.ts`, `toast.tsx`.
- **i18n** (`web/lib/i18n/`): типизированный словарь UA/RU/EN. Стартовый язык жёстко `uk`, чтобы совпасть с SSG-пререндером (иначе hydration mismatch); реальный выбор подхватывается из `localStorage` уже после маунта.

## Деплой на Pi (важные детали)
- Сборка **целиком локальная**; Pi только `npm ci -w server --omit=dev` + рестарт systemd. Pi ничего не компилирует.
- На Pi конфиг и данные лежат под `server/` (`server/.env`, `server/data/{baseline.json,sessions.json}`); systemd-юнит имеет `WorkingDirectory=…/server`. В `deploy.sh` есть одноразовая безопасная миграция со старой раскладки (`data/`→`server/data/`, `.env`→`server/.env`).
- `systemctl enable` (автозапуск после ребута Pi) — разовая ручная операция, `deploy.sh` его не делает.

## Git-workflow
- Репозиторий: `git@github.com:apanamaryov/sweethome.git` (remote `origin`, ветка по умолчанию `main`).
- Новые изменения — через feature-ветки и PR, не коммитить напрямую в `main`.
- В `main` не мержить без явного подтверждения пользователя.
- Секреты (`server/.env`, реальные пароли/данные Pi) в репозиторий не попадают — они вне git и в `.gitignore`.
