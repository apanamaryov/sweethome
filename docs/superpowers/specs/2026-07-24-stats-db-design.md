# Статистика и история телеметрии: SQLite (node:sqlite)

Дата: 2026-07-24. Статус: одобрено владельцем (дизайн-сессия).

## Цель

Демон копит историю телеметрии инвертора и показывает статистику в web UI:
графики телеметрии с зумом, суточные итоги энергии, журнал событий, экспорт CSV.
Хранилище — SQLite через встроенный `node:sqlite` (ноль новых нативных
зависимостей — критично для appliance на Pi).

## Требования (зафиксированы с владельцем)

- Хранить: сырую телеметрию, поминутные агрегаты, суточные итоги, журнал событий.
- Смотреть: новая страница «Статистика» в существующем web UI (+ доступна через rancho.network).
- Retention ярусами: сырьё 30 дней, поминутки 2 года, суточные итоги и события — бессрочно.
- Экспорт сырых/поминутных данных в CSV.
- База не должна заметно изнашивать SD-карту и не имеет права ронять мониторинг.

## Решения и их цена

- **Драйвер: `node:sqlite`** (выбран против `better-sqlite3`): встроен в Node,
  ничего не качается install-скриптами при `npm ci` на Pi.
  Цена: `engines.node` поднимается до **">=24"** в корне и в `server`
  (на Pi уже Node 24; локальную машину владелец разово обновляет с 20 на 24 LTS;
  `>=24` вместо `>=22.5` — чтобы не зависеть от статуса флага
  `--experimental-sqlite` в ветке 22.x и совпадать мажором с Pi).
- **Щадящий режим записи**: WAL, `synchronous=NORMAL`, буферизация снапшотов
  в памяти и флаш одной транзакцией раз в 60 с (~12 строк). Потеря при обесточке —
  максимум минута сырья, приемлемо.
- **Без VACUUM**: после retention-удалений страницы переиспользуются,
  файл выходит на плато ~150–300 МБ.

## Архитектура

Новый изолированный модуль `server/src/stats/`, подключение по образцу `mqtt.ts` —
подписка на событие `"snapshot"` у `Inverter`; ядро (`inverter.ts`) не меняется.

- `stats/db.ts` — открытие `<dataDir>/stats.db`, миграции через `PRAGMA user_version`,
  прагмы (WAL и т.д.), prepared statements. Единственное место, где живёт SQL схемы.
- `stats/recorder.ts` — буфер снапшотов, флаш, свёртки по watermark, деривация
  событий, retention. Публичный интерфейс: `start(inverter)`, `stop()`,
  методы выборки для API (`querySeries`, `queryDaily`, `queryEvents`, `exportCsv`).
- Роуты `/api/stats/*` — в `server.ts` рядом с остальным API, за той же сессионной авторизацией.

## Схема БД

Все `ts` — unix-время в **миллисекундах, UTC** (`INTEGER`). Суточные границы —
по **локальному TZ малины** (Europe/Kyiv), ключ дня — `TEXT 'YYYY-MM-DD'`.

### `samples` — сырьё, 30 дней

`ts INTEGER PRIMARY KEY` + `mode TEXT` (DeviceMode строкой) + все 20 числовых полей `InverterStatus`
(`gridVoltage`, `gridFrequency`, `mainsPower`, `inverterPower`, `acOutputVoltage`,
`acOutputFrequency`, `acOutputActivePower`, `acOutputApparentPower`,
`outputLoadPercent`, `batteryVoltage`, `batteryPower`, `batteryChargingCurrent`,
`batteryDischargeCurrent`, `batteryCapacity`, `pvInputVoltage`, `pvInputCurrent`,
`pvPower`, `pvChargingPower`, `dcdcTemperature`, `heatSinkTemperature`) как `REAL`.
Строка `raw` (дамп регистров) НЕ хранится. Снапшоты с `status=null` не пишутся.

### `samples_minute` — поминутки, 2 года

`ts INTEGER PRIMARY KEY` (начало минуты) + `sample_count INTEGER` +
avg/min/max (`<field>_avg`, `<field>_min`, `<field>_max`, `REAL`) для 10 величин:
`pvPower`, `acOutputActivePower`, `mainsPower`, `batteryPower`, `batteryVoltage`,
`batteryCapacity`, `gridVoltage`, `outputLoadPercent`, `dcdcTemperature`,
`heatSinkTemperature` — плюс интегралы энергии `REAL` (Вт·ч за минуту):
`pv_wh`, `load_wh`, `grid_wh` (из `mainsPower > 0`), `batt_charge_wh`,
`batt_discharge_wh` (знаковые части `batteryPower`).

### `daily` — суточные итоги, бессрочно

`day TEXT PRIMARY KEY` ('YYYY-MM-DD', локальный TZ), `pv_wh`, `load_wh`, `grid_wh`,
`batt_charge_wh`, `batt_discharge_wh` (`REAL`), `soc_min`, `soc_max` (`REAL`),
`grid_loss_count INTEGER`, `sample_count INTEGER`.

### `events` — журнал, бессрочно

`id INTEGER PRIMARY KEY AUTOINCREMENT`, `ts INTEGER` (индекс), `type TEXT`,
`detail TEXT` (JSON). Типы: `mode-change`, `grid-loss`, `grid-restore`,
`fault-set`, `fault-clear`, `warning-set`, `warning-clear`, `conn-lost`,
`conn-restored`, `device-changed`.

### `meta` — key/value

Watermark'и свёрток (`minute_rollup_ts`, `daily_rollup_day`), `device_id`,
версия схемы дублируется в `PRAGMA user_version`.

## Поток данных

1. Подписка на `"snapshot"` (5 с) → снапшот в память.
2. Раз в 60 с — одна транзакция: INSERT пачки в `samples` + накопленные события.
3. Там же — **поминутная свёртка SQL-ом по watermark**: `INSERT OR REPLACE INTO
   samples_minute SELECT …` из `samples` за минуты, полностью прошедшие после
   `minute_rollup_ts`. Энергия: `sum(P) * POLL_INTERVAL / 3600` (нет данных —
   энергия честно не насчитывается; допущение фиксированного Δt задокументировать).
4. При смене локальных суток (и на старте) — **суточная свёртка** из
   `samples_minute` за завершённые дни после `daily_rollup_day`.
5. Watermark-подход делает свёртки crash-safe: после рестарта всё пропущенное
   досчитывается из сырья.

**События** — деривация из сравнения соседних снапшотов в recorder:
смена `mode`; сеть есть/нет по порогу `gridVoltage > 100 В` (переходы →
`grid-loss`/`grid-restore`); диффы множеств битов fault/warning;
`connected` флаг; смена `deviceId` → `device-changed` (данные продолжаются
в той же базе).

**Retention** — раз в сутки (и на старте): `DELETE FROM samples WHERE ts < now-30д`,
`DELETE FROM samples_minute WHERE ts < now-2г`.

## Конфигурация (env, через `config.ts`)

- `STATS_ENABLED` — default `true`.
- `STATS_RAW_DAYS` — default `30`.
- `STATS_MINUTE_DAYS` — default `730`.

Путь к базе — `<dataDir>/stats.db` (рядом с `baseline.json`), отдельная
переменная пути не нужна.

## API (все — за существующей авторизацией)

- `GET /api/stats/series?fields=a,b&from=<ms|ISO>&to=…&res=auto|raw|minute`
  → `[{ t, <field>… }]`. `res=auto`: диапазон ≤ ~6 ч — сырьё, длиннее — поминутки
  (avg). Ответ ≤ ~2000 точек (при превышении — прореживание на сервере).
  Whitelist имён полей — от схемы, чужие имена → 400.
- `GET /api/stats/daily?from=YYYY-MM-DD&to=…` → строки `daily`.
- `GET /api/stats/events?from&to&type&limit` → журнал, новые сверху, пагинация limit/offset.
- `GET /api/stats/export.csv?from&to&res=raw|minute` → потоковый CSV
  (заголовок = имена колонок).
- Ошибки: база недоступна → `503` со стабильным JSON `{ error }`.

## Web UI — страница `app/(app)/stats` («Статистика»)

- Пункт в навигации рядом с дашбордом. Все строки — в словарь i18n UA/RU/EN.
- Переключатель периода: день / неделя / месяц + стрелки назад-вперёд.
- Графики на **uPlot** (единственная новая зависимость веба, ~45 КБ, canvas;
  обернуть в маленький React-компонент): мощности (PV/нагрузка/сеть/батарея),
  SOC + напряжение батареи, температуры.
- Суточные итоги: столбиковая диаграмма кВт·ч + таблица.
- Журнал событий: таблица с фильтром по типу; имена битов fault/warning
  локализуются существующими ключами `dict.warnings`.
- Кнопка «Экспорт CSV» за выбранный период.

## Отказоустойчивость

- Не открылась/испортилась база на старте → демон работает без статистики:
  ошибка в лог, `/api/stats/*` → 503. Статистика никогда не роняет мониторинг.
- Ошибка флаша → лог, буфер удерживается до следующей попытки
  (с потолком размера буфера ~10 мин, дальше старьё выбрасывается).
- Mock в dev пишет статистику как обычно (удобно для разработки UI);
  база в dev локальная, с Pi не пересекается.
- Скачки часов: Δt не участвует (фиксированный шаг интеграции), «минуты в будущем»
  не сворачиваются до своего окончания по текущим часам.

## Тестирование

- Расширить `server/scripts/selfcheck.ts` блоком stats (в духе проекта, без джестов):
  база `:memory:`, синтетическая последовательность снапшотов через recorder,
  assert'ы: значения поминутной свёртки (avg/min/max, Вт·ч), суточные итоги,
  retention-удаление, генерация событий (`grid-loss`, `mode-change`, диффы warning).
- Веб — `tsc --noEmit` как сейчас.

## Вне скоупа

- Grafana/внешняя визуализация, выгрузка в HA поверх существующего MQTT.
- Взвешенная интеграция энергии по реальному Δt между снапшотами.
- Сравнение периодов, прогнозы, тарифы/деньги.

## Деплой

- `deploy.sh` менять не нужно (нет новых нативных зависимостей; `data/` уже
  переживает деплой). На Pi база появится сама при первом старте.
- Прод-веб пересобирается как обычно (`npm run build`), uPlot попадает в бандл.
