# Дизайн: пользователи и роли (auth v2)

**Дата:** 2026-07-24
**Статус:** утверждён (брейншторминг)
**Ветка:** `feature/auth-users-roles`

## Цель

Заменить текущую авторизацию «один пароль на всё приложение» (`AUTH_PASSWORD`)
на модель **пользователи + роли** с хранением в базе.

Требования владельца:

1. Два стартовых пользователя: `admin` и `user`.
2. Дефолтные пароли: `admin` и `user` соответственно.
3. При первом входе — форс смены пароля.
4. Пользователи и пароли хранятся в базе.
5. `admin` может всё; `user` (роль `viewer`) — только страницы «Обзор» и «Статистика».

Утверждённые решения брейншторминга:

- Хранилище — **отдельный файл `data/auth.db`** (не общая `stats.db`): авторизация
  не должна зависеть от `STATS_ENABLED`.
- Ограничение роли — **server-side (403) + скрытие в UI**, не только UI.
- **CRUD пользователей** доступен админу (страница + API).
- Две фиксированные роли: **`admin` / `viewer`**.
- Старый режим «авторизация выключена» (пустой `AUTH_PASSWORD`) **удаляется**;
  авторизация включена всегда. Обоснование: сервис опубликован в интернет
  (`rancho.network`).

## Текущее состояние (что меняем)

- `server/src/auth.ts` — класс `Auth`: один `AUTH_PASSWORD` (sha256 в памяти),
  сессии в `data/sessions.json` (sha256 токена), anti-brute-force по IP,
  cookie `inv_session` HttpOnly. Роли/пользователей нет; `auth.enabled` завязан
  на наличие `AUTH_PASSWORD`.
- `server/src/server.ts` — гейты: страничные маршруты редиректят на `/login`
  без сессии; всё `/api/*` (кроме `login`/`logout`) требует сессию; WS `/ws`
  проверяет токен. `/api/meta` отдаёт `authEnabled`.
- `server/src/config.ts` — `auth: { password, sessionTtlDays }`.
- `web/` — страница `/login` (только поле пароля); роут-группа `app/(app)/`
  (Обзор `/`, Статистика `/stats`, Настройки `/settings`, Диагностика
  `/diagnostics`); навигация `NavTabs` (4 фиксированных таба); logout во
  `Footer` показывается при `meta.authEnabled`.
- База: SQLite через встроенный `node:sqlite` уже используется в `stats/db.ts`
  (паттерн для `auth/db.ts`).

**Проверенная матрица вызовов API по страницам** (определяет права `viewer`):

- Обзор `/`: `/api/snapshot` + WS `/ws` + `/api/meta` (всё через `app/(app)/layout.tsx`).
- Статистика `/stats`: `/api/stats/{series,daily,events,energy,export.csv}`.
- Настройки `/settings`: `/api/baseline/recapture`, `/api/control`, `/api/lock` (write).
- Диагностика `/diagnostics`: `/api/raw` (write).

## Архитектура

### Хранилище — `server/src/auth/db.ts` (класс `AuthDb`)

Встроенный `node:sqlite`, файл `<dataDir>/auth.db`, без нативных зависимостей
(паттерн `stats/db.ts`). Схема:

```sql
CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY,
  username              TEXT UNIQUE NOT NULL,   -- нормализован: lowercase, [a-z0-9_-], 1..32
  password_hash         TEXT NOT NULL,          -- формат "scrypt$<saltHex>$<hashHex>"
  role                  TEXT NOT NULL CHECK(role IN ('admin','viewer')),
  must_change_password  INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,                 -- sha256(token), как сейчас
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
```

Методы `AuthDb` (набросок): `listUsers()`, `getUserByUsername()`, `getUserById()`,
`createUser()`, `updateRole()`, `setPassword()`, `deleteUser()`, `countAdmins()`,
`createSession()`, `getSession()` (JOIN users → возвращает роль/флаг),
`deleteSession()`, `deleteSessionsForUser(exceptTokenHash?)`, `pruneExpired()`.

Включить `PRAGMA foreign_keys = ON` (для каскада сессий).

### Хеширование паролей

Встроенный `crypto.scryptSync` (без внешних зависимостей). Соль на пользователя
(16 байт), формат хранения `scrypt$<saltHex>$<hashHex>`. Проверка —
`crypto.timingSafeEqual`. Причина отказа от текущего голого `sha256`: пароли
теперь хранятся постоянно, сервис доступен из интернета.

### Сервис сессий — `server/src/auth/service.ts` (рефактор `auth.ts`)

Класс `Auth` теперь поверх `AuthDb`:

- `login(username, password, ip)` → при успехе создаёт сессию, возвращает
  `{ token, user: SessionUser }`; при неверных данных — `null`; при блокировке —
  `Error(code=429)`.
- `verify(token)` → `SessionUser | null` (вместо текущего `boolean`).
- `logout(token)`, `cookie(token)`, `clearCookie()` — как сейчас.
- `changePassword(userId, currentPassword, newPassword, currentTokenHash)` —
  проверяет текущий, ставит новый scrypt-хеш, `must_change=0`, удаляет прочие
  сессии этого пользователя (кроме текущей).
- Anti-brute-force по IP сохраняется (перенос текущей логики).

**Сидинг** (в конструкторе/init, идемпотентно): если `users` пуста → создать
`admin`/`admin` (role `admin`) и `user`/`user` (role `viewer`), оба с
`must_change_password=1`. Только если таблица пуста — удалённые не воскресают.

### Матрица доступа (middleware в `server.ts`)

`requireAuth` кладёт `req.user: SessionUser`; `requireAdmin` — 403 для не-админа.

| Эндпоинт | Без сессии | viewer | admin |
|---|---|---|---|
| `POST /api/login`, статика, `/login`, `/change-password` | ✅ | ✅ | ✅ |
| `GET /api/me`, `POST /api/logout`, `POST /api/change-password` | ❌ 401 | ✅ | ✅ |
| `GET /api/snapshot`, `/api/meta`, `/api/health`, WS `/ws` | ❌ | ✅ | ✅ |
| `GET /api/stats/*` (series/daily/events/energy/export.csv) | ❌ | ✅ | ✅ |
| `POST /api/control`, `/api/lock`, `/api/raw`, `/api/baseline/recapture`; `GET /api/baseline` | ❌ | ❌ 403 | ✅ |
| `/api/users*` (CRUD) | ❌ | ❌ 403 | ✅ |

`GET /api/baseline` отнесён к admin (данные страницы Настройки / drift). Если при
имплементации выяснится, что baseline нужен Обзору — понизить до `requireAuth`.

**Страничные редирект-гейты** (расширение текущего обработчика в `server.ts`):

- `/settings`, `/diagnostics`, `/users`: нет сессии → `/login`; viewer → `/`.
- `/`, `/stats`: нет сессии → `/login`.
- Особый случай `must_change_password=1` — см. ниже.

### Форс смены пароля при первом входе

Состояние `must_change_password=1` у сид-пользователей и у созданных админом.

1. `POST /api/login {username, password}` → сессия + cookie; ответ
   `{ ok:true, mustChangePassword:boolean, role }`.
2. Пока `must_change_password=1`:
   - API: разрешены только `/api/me`, `/api/change-password`, `/api/logout`;
     остальные `/api/*` → `403 { code:"must_change_password" }`.
   - Страничные маршруты (кроме `/change-password`) → redirect `/change-password`.
3. Маршрут `/change-password` (web) — простая форма (как `/login`), открыт при
   наличии любой сессии.
4. `POST /api/change-password {currentPassword, newPassword}` → проверка текущего,
   новый scrypt-хеш, `must_change=0`, инвалидация прочих сессий. Валидация нового
   пароля: длина ≥ 6, `≠` текущему. Ответ `{ ok:true }` → фронт редиректит на `/`.

### CRUD пользователей (admin) — API + страница `/users`

API (все `requireAdmin`):

- `GET /api/users` → `PublicUser[]` (без хешей: id, username, role,
  mustChangePassword, createdAt).
- `POST /api/users {username, role, password}` → создать, `must_change_password=1`.
  Валидация username (нормализация + уникальность), role ∈ {admin,viewer},
  пароль длиной ≥ 6.
- `PATCH /api/users/:id {role}` → сменить роль.
- `POST /api/users/:id/reset-password {newPassword}` → сброс, `must_change=1`,
  удалить сессии этого пользователя.
- `DELETE /api/users/:id` → удалить (каскадно чистит сессии).

**Инварианты** (иначе self-lockout):

- Всегда остаётся ≥ 1 пользователь с ролью `admin`: нельзя удалить последнего
  админа и нельзя понизить последнего админа до viewer → `409 { code:"last_admin" }`.
- Само-удаление запрещено (`DELETE` своего id) → `409 { code:"self_delete" }`.

### Контракт `shared/`

`shared/src/types.ts` (или новый `auth.ts`):

```ts
export type Role = "admin" | "viewer";
export interface SessionUser { username: string; role: Role; mustChangePassword: boolean; }
export interface PublicUser { id: number; username: string; role: Role; mustChangePassword: boolean; createdAt: number; }
```

`/api/meta` расширяется полем `session: SessionUser` — `MetaProvider` уже грузится
в `app/(app)/layout.tsx`, поэтому фронт из meta строит навигацию и клиентские
гейты. Поле `authEnabled` удаляется (auth всегда включён) либо фиксируется `true`
для обратной совместимости фронта; выбираем **удалить** и заменить на `session`.

### Веб (`web/`)

- `app/login/page.tsx` — добавить поле `username` (сейчас только пароль).
- Новый `app/change-password/page.tsx` — форма current/new (вне `(app)`-оболочки).
- Новый `app/(app)/users/page.tsx` — таблица + форма создания + reset/delete/роль
  (admin-only; viewer сюда не попадёт — сервер редиректит).
- `app/(app)/layout.tsx::NavTabs` — табы по роли: admin — все 5; viewer — Обзор +
  Статистика. Клиентский guard дублирует серверный.
- `lib/api.ts` — обработать `403 { code:"must_change_password" }` → redirect
  `/change-password` (аналогично текущему 401 → `/login`).

### Конфигурация (`config.ts`)

- Удалить `auth.password` и всю open-mode-логику.
- Оставить `AUTH_SESSION_TTL_DAYS`.
- `auth.db` — в `dataDir`.
- Забытый пароль: CLI-скрипт `server/scripts/reset-password.ts <username> <newpass>`
  (ставит scrypt-хеш, `must_change=1`).

### Совместимость / деплой

- `auth.db` создаётся и сидится автоматически при старте. `deploy.sh` не трогает
  `data/` — файл появится на Pi сам.
- Старый `sessions.json` больше не используется (можно оставить лежать; все текущие
  сессии станут недействительны — разовый разлогин, приемлемо).
- `AUTH_PASSWORD` в `.env` на Pi игнорируется (можно вывести варнинг при старте,
  если задан).

### Безопасность

scrypt + timing-safe; сессии привязаны к `user_id`, каскадно чистятся при
удалении пользователя и при смене/сбросе пароля; anti-brute-force по IP
сохраняется; cookie HttpOnly / SameSite=Lax (TLS терминирует Caddy на Pi).

## Тестирование

Новый `server/scripts/selfcheck-auth.ts` (assert-стиль, как `selfcheck-stats.ts`),
включается в `npm run check -w server`:

- scrypt round-trip (verify правильного/неправильного пароля, разные соли).
- Сидинг: пустая БД → ровно admin+user с нужными ролями и `must_change=1`;
  повторный init не дублирует.
- Флоу смены пароля: `must_change` сбрасывается, старый пароль перестаёт работать,
  прочие сессии инвалидируются.
- Инвариант «≥ 1 admin»: нельзя удалить/понизить последнего админа.
- Чистые функции прав (роль × эндпоинт → allow/deny) — таблица из матрицы выше.

Плюс web typecheck (`npm run check` в корне гоняет и server-selfcheck, и web tsc).

## Затрагиваемые файлы (ориентир)

- Новое: `server/src/auth/db.ts`, `server/src/auth/service.ts` (рефактор из
  `auth.ts`), `server/scripts/selfcheck-auth.ts`, `server/scripts/reset-password.ts`,
  `web/app/change-password/page.tsx`, `web/app/(app)/users/page.tsx`.
- Правки: `server/src/server.ts` (middleware, роуты users, гейты), `config.ts`,
  `shared/src/types.ts` + `index.ts`, `shared/src/api.ts` (ApiMeta),
  `web/app/login/page.tsx`, `web/app/(app)/layout.tsx`, `web/lib/api.ts`,
  `web/lib/meta.tsx`, `web/lib/i18n/dict.ts` (строки UA/RU/EN), `README.md`,
  `.env.example`, `CLAUDE.md` (модель безопасности).

## Явные не-цели (YAGNI)

- Гранулярные права (только 2 роли).
- Восстановление пароля по email / self-service reset (только CLI + админский reset).
- Secure-cookie/CSRF-токены сверх текущего (за доверенным прокси; при желании —
  отдельная задача).
- Аудит-лог действий пользователей.
