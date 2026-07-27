# MCP-сервер для inverter-monitor

Дата: 2026-07-27. Статус: одобрено владельцем (дизайн-сессия).

## Цель

Дать LLM-агентам (Claude Code, Claude Desktop и любому другому MCP-клиенту) полноценный
доступ к инвертору: смотреть живое состояние, копаться в истории, диагностировать связь
и — под явными гейтами — менять настройки. Всё через один протокол, без выдумывания
curl-обвязок вокруг `/api`.

Максимально полное покрытие означает две вещи: **полное покрытие функциональности сервиса**
(всё, что умеет UI, кроме управления доступами) и **полное покрытие возможностей самого
MCP** (tools, resources с подписками, prompts, completions, logging).

## Требования (зафиксированы с владельцем)

- **Два транспорта, одно ядро.** stdio-бинарь для локального клиента и HTTP-эндпоинт
  `/mcp` на самом сервисе. Логика инструментов пишется один раз.
- **Авторизация — API-токены** (`Authorization: Bearer`), новая сущность рядом с
  существующими сессиями. Выдача через API, страницу «Users» и CLI-скрипт.
- **Запись разрешена**, но под всеми существующими гейтами плюс скоуп токена.
- **Управление пользователями и токенами через MCP недоступно** — агенту не нужно,
  цена ошибки высокая.

## Архитектура

### Новый workspace `@inverter/mcp`

Монорепо получает четвёртый воркспейс `mcp/`. Порядок сборки: **shared → mcp → server → web**
(`server` импортирует `@inverter/mcp` из его собранного `dist/`, как сейчас импортирует
`@inverter/shared`).

```
mcp/
├── package.json          # deps: @modelcontextprotocol/sdk ^1.29, zod ^4, @inverter/shared, ws
├── tsconfig.json         # module/moduleResolution: node16 (см. ниже), эмит — CommonJS
└── src/
    ├── index.ts          # публичный API пакета: buildMcpServer, createHttpGateway, типы
    ├── server.ts         # buildMcpServer(gateway, ctx) — регистрация tools/resources/prompts
    ├── gateway/
    │   ├── types.ts      # интерфейс InverterGateway
    │   └── http.ts       # HttpGateway: REST /api/* + WS /ws под Bearer
    ├── tools/            # по файлу на группу: read.ts, stats.ts, control.ts, diag.ts
    ├── resources.ts      # ресурсы и шаблоны
    ├── prompts.ts        # промпты и completions
    ├── format.ts         # человекочитаемые резюме к structuredContent
    ├── time.ts           # разбор времени: ISO / unix ms / "-24h" / "today"
    ├── downsample.ts     # прореживание рядов
    └── bin/stdio.ts      # bin "inverter-mcp"
```

**Про `moduleResolution: node16`.** SDK 1.29 публикуется как dual-пакет: `exports` с
условием `require` → `dist/cjs`, и внутри `dist/cjs/package.json` лежит
`{"type":"commonjs"}`. Проверено — `require('@modelcontextprotocol/sdk/server/mcp.js')`
из CommonJS работает. Но TypeScript с текущим для проекта `moduleResolution: "node"`
(node10) не умеет читать `exports` и subpath-импорты SDK не разрешит. Поэтому у `mcp/`
свой tsconfig с `module: "node16"`; поскольку в `mcp/package.json` нет `"type": "module"`,
эмит остаётся CommonJS и `server` подключает пакет обычным `require`. Tsconfig'и
`shared`/`server`/`web` не трогаем.

Публичный API `@inverter/mcp` **не экспонирует типы SDK наружу** (только собственные
интерфейсы и `express.RequestHandler`), чтобы `server` с его node10-резолюцией не
спотыкался о типы из `exports`; `skipLibCheck: true` в сервере уже включён и служит
вторым поясом безопасности.

### `InverterGateway` — единственная граница между ядром и сервисом

```ts
export interface InverterGateway {
  snapshot(): Promise<Snapshot>;
  meta(): Promise<ApiMeta>;
  baseline(): Promise<Baseline | null>;
  control(type: ControlType, value: number, opts?: { preview?: boolean }): Promise<ControlResponse>;
  setLock(locked: boolean): Promise<{ locked: boolean }>;
  recaptureBaseline(): Promise<Baseline>;
  raw(command: string): Promise<string>;
  stats: {
    series(q): Promise<SeriesResult>;
    daily(from: string, to: string): Promise<DailyRow[]>;
    energy(from: number, to: number, bucket: "hour" | "day"): Promise<EnergyBucket[]>;
    events(q): Promise<StatsEventRow[]>;
    solarWindow(day?: string): Promise<SolarWindowResult>;
    exportCsv(q): Promise<{ csv: string; truncated: boolean }>;   // жёсткий предел 5 МБ
  } | null;                                   // null, если статистика выключена
  onSnapshot(cb: (s: Snapshot) => void): () => void;   // для подписок на ресурсы
  capabilities(): Promise<GatewayCapabilities>;        // { role, scopes, allowControl, statsEnabled }
}
```

Ядро (`buildMcpServer`) не знает ни про HTTP, ни про SQLite, ни про Modbus — только про
этот интерфейс. Отсюда же берётся тестируемость: в юнит-тестах подставляется фейковый
gateway.

Две реализации:

| Реализация | Где | Как работает |
|---|---|---|
| `HttpGateway` | `mcp/src/gateway/http.ts` | `fetch` на `/api/*` с `Authorization: Bearer`, подписка — WS `/ws` с тем же заголовком и авто-реконнектом |
| `LocalGateway` | `server/src/mcp/local-gateway.ts` | Прямые вызовы `Inverter` и `StatsDb`, без HTTP-хопа; `onSnapshot` — подписка на событие `"snapshot"` |

### Транспорты

**stdio** (`mcp/src/bin/stdio.ts`, bin `inverter-mcp`): читает env, создаёт `HttpGateway`,
запрашивает `capabilities()`, строит сервер, подключает `StdioServerTransport`. При
недоступном сервисе не падает молча — отдаёт понятную ошибку на первом же вызове
инструмента (адрес, причина, подсказка проверить `INVERTER_MCP_URL`/токен).

**HTTP** (`server/src/mcp/http.ts`): `POST/GET/DELETE /mcp` на
`StreamableHTTPServerTransport` с сессиями по заголовку `Mcp-Session-Id`. Экземпляр
`McpServer` создаётся **на сессию** — потому что набор инструментов зависит от прав
предъявленного токена. Авторизация — тот же middleware, что и у `/api`, но сессионные
cookie здесь тоже принимаются (удобно для отладки из браузера с активным логином).
Сессии живут в `Map`, удаляются по `transport.onclose`; лимит — 8 одновременных
(Pi 3B), при переполнении — 503 с внятным текстом.

Оба входа отдают серверу имя `inverter-monitor` и версию из `mcp/package.json`.

## Поверхность MCP

### Tools

Имена — snake_case, без префикса (имя сервера и так показывается клиентом). Каждый
инструмент отдаёт `structuredContent` по zod-`outputSchema` **и** короткий
человекочитаемый текст: агенту — данные, пользователю в UI клиента — читаемая строка.

**Чтение** (`readOnlyHint: true`, доступны любой роли):

| Tool | Вход | Результат |
|---|---|---|
| `get_snapshot` | `sections?: ("connection"\|"status"\|"settings"\|"flags"\|"warnings"\|"baseline")[]` | Срез `Snapshot`; текст — `Mode: Battery · SOC 72% · PV 1.24 kW · Load 430 W · Grid 232.7 V/50.0 Hz · 3 s ago` |
| `get_settings_diff` | — | Все поля `InverterRatedInfo` и флаги: `current`, `baseline`, `drifted`, человекочитаемое значение для кодированных полей |
| `get_alarms` | — | `{ active: [{ bit, name, kind: "fault"\|"warning" }], raw }` |
| `get_meta` | — | Карты значений, допустимые токи, `allowControl`, роль и скоупы текущего токена |
| `get_health` | — | `{ serviceReachable, connected, transport, mock, snapshotAgeMs, lastError }` |
| `read_registers` | `address: 0..65535`, `count: 1..32` | `[{ address, value, hex }]` — через `raw("R …")` |

**Статистика** (`readOnlyHint: true`; при `STATS_ENABLED=false` эти инструменты не
регистрируются вовсе — `gateway.stats === null`):

| Tool | Вход | Результат |
|---|---|---|
| `get_series` | `fields: GaugeField[]`, `from`, `to`, `res?: auto\|raw\|minute`, `maxPoints?: 1..5000 = 500` | Ряды; при прореживании — `{ downsampled: true, sourcePoints, points }` |
| `get_daily` | `from`, `to` (день) | Строки `daily` + окно солнца |
| `get_energy` | `from`, `to`, `bucket: hour\|day` | `EnergyBucket[]` |
| `get_events` | `from?`, `to?`, `type?`, `limit? ≤ 500 = 100`, `offset?` | Журнал событий |
| `get_solar_window` | `day?` | `{ day, start, end, state }` |
| `summarize_period` | `from`, `to` | Одним вызовом: выработка PV, потребление нагрузки, взято из сети, заряд/разряд батареи (кВт·ч), min/max SOC, число и типы аварийных событий, окна солнца по дням |
| `export_csv` | `from`, `to`, `res: raw\|minute` | `resource_link` на CSV-ресурс — тело качается через `resources/read`, а не вываливается в контекст |

**Запись** (`destructiveHint: true`, `readOnlyHint: false`; регистрируются, только если
у токена роль `admin` и скоуп `write`):

| Tool | Вход | Поведение |
|---|---|---|
| `set_control` | `type: ControlType`, `value: number`, `preview?: boolean` | При `preview` — что именно запишется: регистр, raw-значение, текущее и baseline-значение; записи нет. Реальная запись требует снятого lock — иначе ошибка с подсказкой вызвать `set_lock` |
| `set_lock` | `locked: boolean` | Снять/поставить блокировку записи |
| `recapture_baseline` | — | Перечитать настройки и перезаписать baseline |
| `write_register` | `address`, `value`, `preview?: boolean` | Сырое `W` под теми же гейтами, что `/api/raw`. `preview` реализован без записи: читает текущее значение регистра (`R`) и показывает «было → станет» |

`preview` для `set_control` нельзя посчитать на стороне клиента: маппинг
`ControlType → (регистр, масштаб, валидация)` живёт в `server/src/protocol/smg.ts`
(`buildControlWrite`) и наружу не выставлен. Поэтому `POST /api/control` получает
необязательное поле `preview: true`, при котором вызывается новый метод
`Inverter.previewControl(type, value)` — строит команду и читает текущее значение,
ничего не записывая. Preview разрешён и при включённом lock: это чтение.

### Resources

| URI | Тип | Содержимое |
|---|---|---|
| `inverter://snapshot` | `application/json` | Полный снапшот. **Subscribable**: `gateway.onSnapshot` → `notifications/resources/updated`, не чаще одного уведомления в 5 с |
| `inverter://settings` | `application/json` | Текущие настройки и флаги |
| `inverter://baseline` | `application/json` | Baseline «как нашли» |
| `inverter://alarms` | `application/json` | Активные fault/warning |
| `inverter://events/recent` | `application/json` | Последние 100 событий |
| `inverter://registers/map` | `text/markdown` | Карта регистров SMG II: адрес, ключ, единица, масштаб, доступ, примечания |
| `inverter://docs/control-contract` | `text/markdown` | Whitelist управляющих команд, допустимые значения, чем опасна каждая настройка |
| `inverter://stats/daily/{day}` | `application/json` | Шаблон: сводка за день |
| `inverter://stats/export/{res}/{from}/{to}.csv` | `text/csv` | Шаблон: выгрузка (сюда указывает `resource_link` из `export_csv`) |

Ресурсы, зависящие от статистики (`events/recent`, оба шаблона `stats/*`), при
`STATS_ENABLED=false` не регистрируются — так же, как статистические инструменты.
CSV-ресурс отдаёт не более 5 МБ; при упоре в предел — ошибка с подсказкой сузить
диапазон или взять `res=minute`, а не молча обрезанный файл.

Два документационных ресурса — то, чего у агента нет ниоткуда: без карты регистров
`read_registers` бесполезен, без контракта управления агент не понимает, чем
`batteryRechargeVoltage` отличается от `batteryRedischargeVoltage` и почему их нельзя
крутить наугад.

**Источник карты регистров.** Сейчас соответствие «адрес → смысл» зашито внутри
`decodeStatus`/`decodeSettings` и в виде структурированных данных не существует.
Заводим `shared/src/registers.ts` с таблицей
`REGISTER_DOCS: Array<{ addr, key, name, unit, scale, access, notes? }>` — это справочные
данные устройства, а в `shared` такие справочники уже живут (`OUTPUT_SOURCE_PRIORITY`
и прочие карты значений). Плюсы: доступна обоим транспортам без сетевого вызова, не
требует нового эндпоинта. Риск рассинхрона с декодерами снимается тестом в `server`:
каждый адрес из `REGISTER_DOCS` обязан попадать в один из блоков
`STATUS_BLOCKS`/`ALARM_BLOCKS`/`SETTINGS_BLOCKS`, и каждое поле `InverterStatus` /
`InverterRatedInfo` обязано иметь запись с таким `key`.

### Prompts и completions

| Prompt | Аргументы | Что делает |
|---|---|---|
| `diagnose-connection` | — | Чеклист разбора «демо-данные / нет связи»: транспорт, `lastError`, возраст снапшота, Modbus ID, уровни RS232 — по материалу README |
| `daily-report` | `day` (с completion по дням, за которые есть данные) | Отчёт за день: генерация, потребление, доля сети, окно солнца, события |
| `battery-health-check` | — | Сверяет SOC, напряжения и токи с настройками и типом батареи, ищет аномалии (например, `batteryUnderVoltage` выше `socLowCutoff`-логики) |
| `plan-setting-change` | `type` (completion по `ControlType`) | Читает текущее значение и baseline, объясняет риск, предлагает порядок действий. Ничего не пишет |

Completions регистрируются для аргумента `day` (список дней из `daily`) и для `type`
(из `ControlType`).

### Ошибки, лимиты, логирование

- Ошибки инструментов возвращаются как `isError: true` с человекочитаемым текстом
  плюс `structuredContent.error` — агент должен уметь их прочитать, а не получить
  обрыв протокола.
- Ряды прореживаются равномерной выборкой с обязательным сохранением первой и
  последней точки; факт прореживания всегда виден в ответе. Молчаливого усечения нет
  нигде: `get_events` при упоре в `limit` отдаёт `truncated: true`.
- Включена MCP-возможность `logging`: ошибки gateway и записи в инвертор уходят
  клиенту через `notifications/message` на уровне `info`/`error`.
- Время в аргументах принимается в трёх формах: unix ms, ISO 8601 и относительное
  (`now`, `-24h`, `-7d`, `today`, `yesterday`). Разбор — чистая функция `mcp/src/time.ts`.

## Авторизация: API-токены

### Схема

Новая таблица в `data/auth.db`, создаётся тем же `CREATE TABLE IF NOT EXISTS`, что и
существующие (миграции у `AuthDb` нет и не заводим):

```sql
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  prefix TEXT NOT NULL,                -- первые 8 символов, для отображения в списке
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,                -- csv: "read" | "read,write"
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER                   -- NULL = бессрочно
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
```

Формат токена — `inv_<base64url(32 случайных байта)>`. В БД хранится только
`sha256(token)`: 256 бит энтропии не нуждаются в scrypt (в отличие от паролей, где
scrypt защищает от перебора слабых значений). Значение показывается **один раз** при
создании.

### Проверка

Middleware `/api` пробует cookie, затем `Authorization: Bearer` — дальше по коду ничего
не меняется, `req.user` заполняется как раньше, плюс поле `scopes`.

- Токен наследует роль своего пользователя.
- Если у пользователя стоит `must_change_password` — токен отклоняется (иначе это обход
  форса смены пароля).
- Просроченный токен (`expires_at <= now`) — 401.
- Скоуп `write` обязателен для `POST /api/control` (кроме `preview`), `POST /api/lock`,
  `POST /api/raw` с командой `W`, `POST /api/baseline/recapture`. Для cookie-сессий из
  UI правила не меняются.
- `/api/users` и `/api/tokens` по токену недоступны в принципе — управление доступами
  только из UI-сессии.
- `last_used_at` обновляется не чаще раза в минуту на токен (щадим SD-карту).
- `GET /api/me` дополняется полями `auth: "session" | "token"` и `scopes: string[]` —
  иначе stdio-вход не сможет узнать свои права и правильно собрать набор инструментов.
  Для cookie-сессий `scopes` — полный набор, доступный роли.

### Выдача и отзыв

- `GET /api/tokens` — список (`id`, `name`, `prefix`, `scopes`, `createdAt`,
  `lastUsedAt`, `expiresAt`), admin, только сессия.
- `POST /api/tokens` — `{ name, scopes: ["read"] | ["read","write"], expiresInDays? }`,
  в ответ единожды отдаёт значение токена.
- `DELETE /api/tokens/:id` — отзыв.
- `server/scripts/issue-token.ts <name> [--write] [--days N] [--user admin]` — первая
  выдача по SSH, по образцу существующего `reset-password.ts`.
- UI: секция «API-токены» на странице `/users` (admin) — таблица, форма создания,
  одноразовый показ значения с кнопкой копирования, отзыв. Строки в `dict.ts` для UA/RU/EN.

### WebSocket

`/ws` дополнительно принимает `Authorization: Bearer` в handshake (сейчас только cookie).
Без этого `HttpGateway` не сможет подписываться на снапшоты, и ресурс
`inverter://snapshot` в stdio-режиме останется без live-обновлений.

## Модель безопасности записи

Ни один существующий гейт не ослабляется; порядок проверок при записи через MCP:

1. `ALLOW_CONTROL=false` — записи нет вообще, необратимо.
2. Роль токена — `admin`.
3. Скоуп токена — `write`.
4. Write-lock снят (`set_lock`), после успешной записи `AUTO_RELOCK` возвращает его —
   ровно как в UI.
5. Whitelist регистров и валидация значений в `buildControlWrite` — существующие.

Плюс два новых слоя:

- **Инструменты записи не появляются в `tools/list`** без нужных прав. Агент не видит
  того, чего ему нельзя, и не тратит попытки на 403.
- **`INVERTER_MCP_READ_ONLY=true`** у stdio-входа локально сужает права даже для
  write-токена — удобно, когда один и тот же токен используется в разных клиентах.

## Аудит записей

Сейчас события выводятся только из диффа снапшотов, явных записей в журнале нет —
непонятно, кто и когда менял настройку. Добавляем:

- `Inverter.control()` и `Inverter.rawQuery()` принимают `opts.source?: string` и после
  успешной записи испускают событие `"write"` с `{ type, value, register, rawValue, source }`.
- `StatsRecorder` подписывается на `"write"` и пишет строку в `events` с типом `control`.
- Источник проставляют вызывающие: `server.ts` — `ui:<username>` для cookie-сессии и
  `token:<name>` для Bearer; `mqtt.ts` — `mqtt`.
- В UI на `/stats` тип `control` добавляется в фильтр журнала и в `evText` с
  переводами UA/RU/EN.

Так путь MCP-записи становится видимым в том же журнале, что и остальная жизнь
устройства, — и заодно закрывается давняя дыра в наблюдаемости UI-записей.

## Конфигурация

Сервер (`server/src/config.ts`, `.env.example`):

| Переменная | Default | Смысл |
|---|---|---|
| `MCP_ENABLED` | `true` | Включает эндпоинт `/mcp` |
| `MCP_MAX_SESSIONS` | `8` | Предел одновременных MCP-сессий (Pi 3B) |

stdio-вход (`mcp/`):

| Переменная | Default | Смысл |
|---|---|---|
| `INVERTER_MCP_URL` | `http://localhost:3000` | Адрес сервиса |
| `INVERTER_MCP_TOKEN` | — | Обязателен |
| `INVERTER_MCP_TIMEOUT_MS` | `10000` | Таймаут запросов к сервису |
| `INVERTER_MCP_READ_ONLY` | `false` | Локально скрыть инструменты записи |

## Развязка модулей

- `mcp/src/server.ts` знает только `InverterGateway` — ни `fetch`, ни `express`, ни
  `node:sqlite`.
- `mcp/src/time.ts`, `downsample.ts`, `format.ts` — чистые функции без побочных эффектов,
  тестируются в отрыве.
- `server/src/mcp/` — единственное место, где MCP встречается с Express и `Inverter`.
- `shared/src/registers.ts` и `shared/src/settings.ts` (чистая `diffSettings`) — данные
  и логика без зависимостей.

**Почему `web` не переводится на `diffSettings`.** Таблица настроек в
`web/app/(app)/settings/page.tsx` показывает подмножество полей с локализованными
метками и своим рендером; общая часть — тривиальное сравнение чисел. Переводить UI на
общую функцию значило бы перекраивать i18n ради нескольких строк, поэтому осознанно
не трогаем: расхождение логики здесь отсутствует, дублируется только оператор `!==`.

## Тесты

Jest, файлы рядом с исходниками — как принято в проекте.

**`mcp/`** (новый jest-проект в воркспейсе, входит в корневой `npm test`):

- `src/time.test.ts` — разбор `now`/`-24h`/`today`/ISO/ms, границы и мусор на входе.
- `src/downsample.test.ts` — сохранение первой/последней точки, отсутствие прореживания
  ниже порога, ровные границы.
- `src/tools/*.test.ts` — на фейковом gateway: форма `structuredContent`, текстовые
  резюме, обработка ошибок gateway, `preview` не пишет.
- `src/server.test.ts` — видимость инструментов: viewer не видит write-инструменты,
  admin без скоупа `write` не видит, `stats === null` убирает статистические
  инструменты, `INVERTER_MCP_READ_ONLY` скрывает запись.
- `src/integration.test.ts` — настоящий MCP-клиент через `InMemoryTransport`:
  `tools/list`, `tools/call`, `resources/read`, `resources/subscribe` (приходит
  `updated` после снапшота), `prompts/get`, `completion/complete`.

**`server/`**:

- `src/auth/tokens.test.ts` — генерация и хеширование, скоупы, срок годности,
  `last_used_at` не чаще минуты, каскадное удаление вместе с пользователем.
- `src/server.http.test.ts` (расширение) — доступ по Bearer, 401 на неверный/просроченный,
  403 без скоупа `write`, запрет `/api/tokens` и `/api/users` по токену, блокировка
  токена при `must_change_password`, `preview` работает при включённом lock.
- `src/mcp/http.test.ts` — supertest: `initialize` → `tools/list` → `tools/call` через
  `/mcp`, переиспользование `Mcp-Session-Id`, 401 без авторизации, 503 при переполнении
  сессий, `MCP_ENABLED=false` → 404.
- `src/protocol/registers.test.ts` — согласованность `REGISTER_DOCS` с блоками чтения и
  с полями `InverterStatus`/`InverterRatedInfo`.
- `src/stats/recorder.test.ts` (расширение) — событие `control` пишется по `"write"`.

**`web/`**: `app/(app)/users/page.test.tsx` — секция токенов (создание, одноразовый
показ, отзыв); `app/(app)/stats/page.test.tsx` — новый тип события в фильтре и журнале.

## Сборка и развёртывание

- Корневой `package.json`: `mcp` в `workspaces`, порядок в `build` — shared → mcp →
  server → web; `test` и `check` включают `mcp`.
- `deploy.sh`: заливает `mcp/dist` и `mcp/package.json`; на Pi —
  `npm ci -w server -w mcp --omit=dev` (SDK и zod нужны в проде, потому что `/mcp`
  живёт внутри сервера).
- Схема `auth.db` дополняется на месте при старте (`CREATE TABLE IF NOT EXISTS`),
  каталог `data/` `deploy.sh` не трогает.
- SDK тянет собственные зависимости (в их числе `express ^5`, `hono`, `ajv`, `jose`) —
  это несколько лишних мегабайт в `node_modules` на Pi. Конфликта с нашим `express 4`
  нет: `StreamableHTTPServerTransport.handleRequest(req, res, parsedBody)` работает с
  голыми `IncomingMessage`/`ServerResponse`, а свой express SDK использует только внутри
  необязательных хелперов, которые мы не подключаем.
- Дефолты (`MCP_ENABLED=true`) означают, что после деплоя `/mcp` доступен сразу, но
  без валидного токена он отвечает 401 — как и весь `/api`.

## Документация

- **README** — раздел «MCP»: что умеет, как выдать токен, конфиг Claude Code / Desktop
  для stdio (`command: node`, `args: [".../mcp/dist/bin/stdio.js"]`, env с URL и токеном),
  подключение к `/mcp` по URL, таблица инструментов, оговорка про запись.
- **CLAUDE.md** — новый слой в архитектуре, правило синхронизации: добавление
  control-типа теперь трогает `shared/api.ts` → `smg.ts` → `server.ts` → `web/` → **и
  MCP-инструмент с его тестом**.
- **`server/.env.example`** — новые переменные.

## Порядок работ

1. **Токены**: `api_tokens` в `AuthDb`, Bearer в middleware `/api` и в WS, скоупы на
   мутирующих роутах, `/api/tokens`, CLI-скрипт, секция в UI, тесты.
2. **Ядро `@inverter/mcp`**: workspace, `InverterGateway`, инструменты, ресурсы,
   промпты, `HttpGateway`, stdio-бинарь, тесты (в том числе через `InMemoryTransport`).
3. **Встраивание в сервер**: `LocalGateway`, `/mcp` на `StreamableHTTPServerTransport`,
   `previewControl`, событие `"write"` и аудит, тесты.
4. **Документация и деплой**: README, CLAUDE.md, `.env.example`, `deploy.sh`, проверка
   на Pi живым клиентом.

## Явно вне рамок (YAGNI)

- **Управление пользователями и токенами через MCP** — сознательно нет.
- **OAuth 2.1 для `/mcp`** (то, что предлагает спецификация MCP для удалённых серверов) —
  для домашнего сервиса в LAN статических Bearer-токенов достаточно; OAuth потянул бы
  за собой authorization server, которого у нас нет.
- **Elicitation** (запрос подтверждения у пользователя из инструмента) — клиенты и так
  спрашивают разрешение на вызов инструмента, второй слой подтверждений избыточен.
- **Sampling** (сервер просит модель у клиента) — сценария нет.
- **Experimental tasks API** SDK — нестабилен, наши операции короткие.
- **Публикация `@inverter/mcp` в npm** — пакет приватный, подключается путём к файлу.
- **MCP-доступ к логам systemd и рестарту сервиса** — это администрирование Pi, не
  предметная область инвертора.
