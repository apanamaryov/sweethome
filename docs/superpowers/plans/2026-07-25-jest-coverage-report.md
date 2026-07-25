# Coverage report — jest unit testing (Task 21, final)

Дата: 2026-07-26 (прогон под Node 24, `nvm`/PATH-префикс `v24.11.0`).

## Итоги прогона

Корневой `npm test` (= `npm test -w server && npm test -w web`):

| Workspace | Suites | Tests |
|---|---|---|
| server | 17 | 239 |
| web | 21 | 157 |
| **Итого** | **38** | **396** |

Все зелёные, 0 падений. Server suite: ~8.6–9.0 с; web suite: ~2.7–3.3 с.

Тесты гоняются под **Node 24** (обязателен встроенный `node:sqlite` для `server/src/stats/*` и
`server/src/auth/db.ts`). Корневой `npm test` из корня репозитория запускает **оба** воркспейса
последовательно (server, затем web).

## Coverage — server (`npm run test:coverage -w server`)

Headline (`All files`): **80.94% stmts / 68.14% branch / 86.44% funcs / 81.04% lines**.

| Файл/директория | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| server/src (root files) | 64.38 | 52.41 | 69.66 | 64.58 |
| — config.ts | 100 | 100 | 100 | 100 |
| — inverter.ts | 89.63 | 77.21 | 96.55 | 89.18 |
| — mqtt.ts | 80.2 | 69.6 | 70.58 | 83.14 |
| — **server.ts** | **37.41** | **21.71** | **40** | **37.63** |
| — store.ts | 100 | 85.71 | 100 | 100 |
| server/src/auth | 96.25 | 86.17 | 100 | 96.22 |
| server/src/protocol | 93.75 | 87.65 | 100 | 93.33 |
| server/src/stats | 92.73 | 86.82 | 93.87 | 92.92 |
| server/src/transport | 94.87 | 75 | 94.73 | 95.1 |
| shared/src (api.ts, auth.ts) | 100 | 100 | 100 | 100 |

**Заметно ниже остального: `server/src/server.ts` (37% stmts/lines, 22% branch).**
`server.http.test.ts` (Task 11) целенаправленно тестирует только гейты авторизации
(логин/сессии/must-change-password/role-403/lockout/WS-auth) — это осознанный охват
для этой задачи. Тела остальных роутов (`/api/control`, `/api/users` CRUD,
`/api/stats/*`, `/api/raw`, `/api/baseline*`, `/api/lock`) не покрыты HTTP-интеграционными
тестами; их бизнес-логика (валидация, whitelist, вызовы в `inverter.ts`/`stats/db.ts`)
покрыта отдельно юнит-тестами нижних слоёв. Это не баг, а сознательная граница объёма
задач 1–15 (спека фокусировалась на протоколе/stats/auth-flow, не на full route-body
HTTP coverage для `server.ts`).

## Coverage — web (`npm run test:coverage -w web`)

Headline (`All files`): **90.98% stmts / 77.71% branch / 90.85% funcs / 92.64% lines**.

| Файл/директория | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| app/layout.tsx (root, не `(app)`) | 0 | 100 | 0 | 0 |
| app/(app)/layout.tsx + page.tsx | 100 | 96.29–100 | 100 | 100 |
| app/(app)/diagnostics/page.tsx | 100 | 100 | 100 | 100 |
| app/(app)/settings/page.tsx | 82.35 | 75.29 | 81.81 | 84.26 |
| app/(app)/stats/page.tsx | 80.35 | 51.35 | 88.23 | 80.41 |
| app/(app)/users/page.tsx | 88.05 | 41.17 | 92.85 | 91.66 |
| app/change-password/page.tsx | 100 | 83.33 | 100 | 100 |
| app/login/page.tsx | 100 | 90.9 | 100 | 100 |
| components/* | 96.72 | 92.15 | 95.23 | 100 |
| lib/* | 97.24 | 94.11 | 91.42 | 99.16 |
| lib/i18n/* | 100 | 100 | 91.66 | 100 |

**Заметно ниже остального:**
- `app/layout.tsx` (0%) — root Next.js layout (простая html/body-обёртка + провайдеры),
  не рендерится юнит-тестами (нет отдельного теста на него; покрыт косвенно через
  `app/(app)/layout.test.tsx`, который монтирует внутреннюю раскладку).
- `app/(app)/stats/page.tsx` (51% branch) — карта строковых лейблов по типу события
  (~12 веток `switch`) спот-чекнута одним кейсом; остальные — тривиальное форматирование
  строк, риск низкий.
- `app/(app)/users/page.tsx` (41% branch) — периферийные ветки форм (валидация/edge-состояния),
  не все пройдены явно.
- `app/(app)/settings/page.tsx` (75% branch, строки 55-57, 95-97, 179-180, 194, 203-205,
  263, 273-282, 292) — включает недостижимую через UI ветку `toastLockFirst` (см. ниже).

## Известные ограничения (собраны по всем задачам 1–20)

- **web/app: settings/users не гейтятся по роли внутри компонента** — гард viewer живёт в
  `app/(app)/layout.tsx` (протестирован там же, `layout.test.tsx`). Страницы `settings`/`users`
  рендерятся свободно; данные защищены на уровне `/api` (403 на сервере). Это архитектурное
  решение проекта (см. CLAUDE.md: «Ограничения — и на сервере … и в UI»), не пробел в тестах.
- **`toastLockFirst`** — dead-code-ветка в `settings/page.tsx`, недостижима через UI-флоу,
  оставлена непокрытой намеренно.
- **`stats/page.tsx` event-type label switch** — спот-чек 1 из ~12 веток; остальные — простое
  форматирование строк без бизнес-логики, риск регрессии низкий.
- **`ToastProvider`'s 3200ms auto-dismiss таймер** не имеет cleanup при unmount — это code
  smell в приложении (потенциальная утечка таймера при быстром размонтировании), не пробел
  в тестах; за пределами объёма задачи.
- **`mqtt.ts`: `HaMqtt.stop()`** и edge-кейс смены устройства в `recorder.ts` (строки
  159/173-185) — покрыты частично, см. per-task заметки в спеке (`docs/superpowers/plans/
  2026-07-25-jest-unit-testing.md`); coverage-таблица выше показывает `mqtt.ts` 80.2%
  stmts / 69.6% branch, `stats/recorder.ts` 93.49% stmts / 88.37% branch — не критично
  низкое, но ниже соседних модулей auth/protocol.
- **`server/src/server.ts`** (37% stmts) — см. раздел выше: гейты авторизации покрыты
  через `server.http.test.ts`, но не тела бизнес-роутов. Отмечено явно как самая низкая
  точка coverage во всём монорепо.
- **Coverage-исключения** (заданы в `server/jest.config.cjs` и `web/jest.config.mjs`):
  `index.ts`-энтрипоинты, `*.d.ts`, чистые `types.ts` — не инструментируются намеренно
  (нет исполняемой логики).

## Как запускать

```bash
# из корня репозитория, под Node 24 (не меняя глобальный nvm default):
PATH=$HOME/.nvm/versions/node/v24.11.0/bin:$PATH npm test
PATH=$HOME/.nvm/versions/node/v24.11.0/bin:$PATH npm run test:coverage
```

HTML-отчёты — в `server/coverage/` и `web/coverage/` (оба в `.gitignore`, не коммитятся).
