# Пользователи и роли (auth v2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить авторизацию «один пароль» на модель «пользователи + роли (admin/viewer)» с хранением в `data/auth.db`, форсом смены пароля при первом входе и CRUD пользователей для админа.

**Architecture:** Новый серверный модуль `server/src/auth/` (`hash.ts` — scrypt, `db.ts` — `AuthDb` поверх `node:sqlite`, `policy.ts` — чистая функция прав, `service.ts` — сервис сессий, рефактор из `auth.ts`). Express получает middleware `requireAuth`/`requireAdmin` и гейт форса смены пароля; страничные редиректы учитывают роль. `shared` отдаёт типы ролей; web — поля username/роль-навигацию/страницы `change-password` и `users`.

**Tech Stack:** TypeScript, Node ≥ 24 (встроенные `node:sqlite` и `node:crypto` — БЕЗ новых npm-зависимостей), Express, ws, Next.js (App Router, static export). Спека: `docs/superpowers/specs/2026-07-24-auth-users-roles-design.md`.

## Global Constraints

- Node **≥ 24** (встроенный `node:sqlite`); никаких новых npm-пакетов — только `node:crypto` и `node:sqlite`.
- Монорепо npm-workspaces; порядок сборки строго **shared → server → web** (`server`/`web` импортируют `@inverter/shared` из собранного `dist/`).
- Ровно две роли: **`admin`** (полный доступ) и **`viewer`** (только страницы `/` и `/stats`).
- Сид-пользователи при пустой БД: **`admin`/`admin`** (role admin) и **`user`/`user`** (role viewer), оба `must_change_password=1`.
- Минимальная длина нового пароля при смене/создании — **6 символов**.
- Масштабирование значений — делением (`/10`, `/100`), не умножением (не относится к auth, но общий закон репо).
- Ветка **`feature/auth-users-roles`** (уже создана). Не коммитить в `main`.
- Коммиты **без** `Co-Authored-By` (правило владельца).
- Каждый серверный assert-тест — раздел в `server/scripts/selfcheck-auth.ts`, запуск `cd server && npx tsx scripts/selfcheck-auth.ts`.

## File Structure

- `shared/src/auth.ts` **(создать)** — `Role`, `SessionUser`, `PublicUser`.
- `shared/src/index.ts` **(изменить)** — реэкспорт `./auth`.
- `shared/src/api.ts` **(изменить)** — `ApiMeta`: убрать `authEnabled`, добавить `session: SessionUser`.
- `server/src/auth/hash.ts` **(создать)** — scrypt хеш/проверка + валидация пароля.
- `server/src/auth/policy.ts` **(создать)** — чистая `canAccess(role, required)`.
- `server/src/auth/db.ts` **(создать)** — `AuthDb` (schema, user CRUD, seed, sessions).
- `server/src/auth/service.ts` **(создать)** — `Auth` (рефактор из `auth.ts`) + `tokenFromCookieHeader`.
- `server/src/auth.ts` **(удалить)** — переехал в `auth/service.ts`.
- `server/src/server.ts` **(изменить)** — middleware, гейты, роуты `me`/`change-password`/`users`, `meta.session`.
- `server/src/config.ts` **(изменить)** — убрать `auth.password`/open-mode.
- `server/scripts/selfcheck-auth.ts` **(создать)** — assert-тесты ядра.
- `server/scripts/reset-password.ts` **(создать)** — CLI сброса пароля.
- `server/package.json` **(изменить)** — `check` включает `selfcheck-auth`.
- `web/app/login/page.tsx` **(изменить)** — поле username.
- `web/app/change-password/page.tsx` **(создать)** — форма смены.
- `web/app/(app)/users/page.tsx` **(создать)** — CRUD-UI (admin).
- `web/app/(app)/layout.tsx` **(изменить)** — навигация по роли, logout всегда.
- `web/lib/api.ts` **(изменить)** — обработка `403 must_change_password`.
- `web/lib/i18n/dict.ts` **(изменить)** — строки UA/RU/EN.
- `.env.example`, `README.md`, `CLAUDE.md` **(изменить)** — документация.

---

### Task 1: shared — типы ролей и `ApiMeta.session`

**Files:**
- Create: `shared/src/auth.ts`
- Modify: `shared/src/index.ts`, `shared/src/api.ts:31-39`

**Interfaces:**
- Produces: `Role = "admin" | "viewer"`; `SessionUser { username: string; role: Role; mustChangePassword: boolean }`; `PublicUser { id: number; username: string; role: Role; mustChangePassword: boolean; createdAt: number }`; `ApiMeta.session: SessionUser` (поле `authEnabled` удалено).

- [ ] **Step 1: Создать `shared/src/auth.ts`**

```ts
/** Роли пользователей. admin — полный доступ; viewer — только Обзор и Статистика. */
export type Role = "admin" | "viewer";

/** Текущий пользователь сессии (в /api/meta и /api/me). */
export interface SessionUser {
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

/** Запись пользователя для admin-UI (без хеша пароля). */
export interface PublicUser {
  id: number;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  createdAt: number;
}
```

- [ ] **Step 2: Реэкспорт в `shared/src/index.ts`**

```ts
export * from "./types";
export * from "./api";
export * from "./auth";
```

- [ ] **Step 3: Обновить `ApiMeta` в `shared/src/api.ts`**

Заменить блок `export interface ApiMeta { ... }` (строки 31-39) на:

```ts
import type { SessionUser } from "./auth";

/** Ответ GET /api/meta. */
export interface ApiMeta {
  session: SessionUser;
  allowControl: boolean;
  outputSourcePriority: Record<number, string>;
  chargerSourcePriority: Record<number, string>;
  maxChargingCurrent: number[];
  maxAcChargingCurrent: number[];
}
```

- [ ] **Step 4: Собрать shared, проверить типы**

Run: `cd /home/alexey/work/rancho/inverter-monitor && npm run build -w shared`
Expected: сборка без ошибок; `shared/dist/auth.d.ts` создан.

- [ ] **Step 5: Commit**

```bash
git add shared/src/auth.ts shared/src/index.ts shared/src/api.ts
git commit -m "feat(shared): типы Role/SessionUser/PublicUser + meta.session"
```

---

### Task 2: Хеширование паролей (scrypt) + каркас selfcheck-auth

**Files:**
- Create: `server/src/auth/hash.ts`, `server/scripts/selfcheck-auth.ts`
- Modify: `server/package.json` (скрипт `check`)

**Interfaces:**
- Produces: `hashPassword(password: string): string` (формат `"scrypt$<saltHex>$<hashHex>"`); `verifyPassword(password: string, stored: string): boolean`; `MIN_PASSWORD_LEN = 6`; `validatePassword(password: string): void` (бросает `Error` при длине < 6).

- [ ] **Step 1: Написать раздел теста в новом `server/scripts/selfcheck-auth.ts`**

```ts
import assert from "assert";
import { hashPassword, verifyPassword, validatePassword } from "../src/auth/hash";

// ---------- 1. Хеширование паролей (scrypt) ----------
const h = hashPassword("s3cret");
assert.ok(h.startsWith("scrypt$"), "hash format has scrypt prefix");
assert.notStrictEqual(h, hashPassword("s3cret"), "разные соли → разные хеши");
assert.ok(verifyPassword("s3cret", h), "верный пароль проходит");
assert.ok(!verifyPassword("wrong", h), "неверный пароль отклонён");
assert.ok(!verifyPassword("s3cret", "garbage"), "битый формат хеша → false, без throw");
assert.throws(() => validatePassword("12345"), "пароль < 6 отклонён");
assert.doesNotThrow(() => validatePassword("123456"), "пароль ровно 6 ок");

console.log("selfcheck-auth: OK");
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd /home/alexey/work/rancho/inverter-monitor/server && npx tsx scripts/selfcheck-auth.ts`
Expected: FAIL — `Cannot find module '../src/auth/hash'`.

- [ ] **Step 3: Реализовать `server/src/auth/hash.ts`**

```ts
import crypto from "crypto";

/** Минимальная длина пароля при смене/создании. */
export const MIN_PASSWORD_LEN = 6;

const KEYLEN = 32;
const SALT_BYTES = 16;

/** Хеш пароля scrypt в формате "scrypt$<saltHex>$<hashHex>". */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Проверка пароля против сохранённого хеша. Битый формат → false (без throw). */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length !== KEYLEN) return false;
  const actual = crypto.scryptSync(password, salt, KEYLEN);
  return crypto.timingSafeEqual(actual, expected);
}

/** Валидация нового пароля. Бросает Error при нарушении политики. */
export function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `cd /home/alexey/work/rancho/inverter-monitor/server && npx tsx scripts/selfcheck-auth.ts`
Expected: `selfcheck-auth: OK`.

- [ ] **Step 5: Включить selfcheck-auth в `server/package.json`**

Заменить строку скрипта `check` на:

```json
"check": "tsx scripts/selfcheck.ts && tsx scripts/selfcheck-stats.ts && tsx scripts/selfcheck-auth.ts",
```

- [ ] **Step 6: Commit**

```bash
git add server/src/auth/hash.ts server/scripts/selfcheck-auth.ts server/package.json
git commit -m "feat(server/auth): scrypt-хеширование паролей + selfcheck-auth"
```

---

### Task 3: `AuthDb` — схема, пользователи, сидинг, сессии

**Files:**
- Create: `server/src/auth/db.ts`
- Modify: `server/scripts/selfcheck-auth.ts` (добавить разделы)

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword` из `auth/hash`; `Role`, `PublicUser` из `@inverter/shared`.
- Produces:
  - `normalizeUsername(raw: string): string` — trim+lowercase, валидирует `^[a-z0-9_-]{1,32}$`, иначе throw.
  - `interface UserRow { id: number; username: string; password_hash: string; role: Role; must_change_password: number; created_at: number; updated_at: number }`
  - `interface SessionInfo { userId: number; username: string; role: Role; mustChangePassword: boolean; expiresAt: number }`
  - `class AuthDb`:
    - `constructor(file: string)`
    - `seedDefaults(now: number): void`
    - `listUsers(): PublicUser[]`
    - `getByUsername(username: string): UserRow | null`
    - `getById(id: number): UserRow | null`
    - `createUser(username: string, password: string, role: Role, mustChange: boolean, now: number): PublicUser`
    - `updateRole(id: number, role: Role, now: number): void`
    - `setPassword(id: number, password: string, mustChange: boolean, now: number): void`
    - `deleteUser(id: number): void`
    - `countAdmins(): number`
    - `createSession(tokenHash: string, userId: number, expiresAt: number, now: number): void`
    - `getSession(tokenHash: string): SessionInfo | null`
    - `deleteSession(tokenHash: string): void`
    - `deleteSessionsForUser(userId: number, exceptTokenHash: string | null): void`
    - `pruneExpired(now: number): void`
    - `close(): void`

- [ ] **Step 1: Добавить разделы теста в `server/scripts/selfcheck-auth.ts`**

Добавить импорт вверху файла и разделы 2–4 перед строкой `console.log("selfcheck-auth: OK")`:

```ts
import { AuthDb, normalizeUsername } from "../src/auth/db";

// ---------- 2. normalizeUsername ----------
assert.strictEqual(normalizeUsername("  Admin "), "admin", "trim + lowercase");
assert.throws(() => normalizeUsername("bad name"), "пробел запрещён");
assert.throws(() => normalizeUsername(""), "пустой запрещён");
assert.throws(() => normalizeUsername("a".repeat(33)), "длиннее 32 запрещён");

// ---------- 3. Сидинг и user CRUD ----------
const T = 1_700_000_000_000;
const adb = new AuthDb(":memory:");
adb.seedDefaults(T);
adb.seedDefaults(T); // идемпотентность
let users = adb.listUsers();
assert.strictEqual(users.length, 2, "сид создаёт ровно 2 пользователей");
assert.deepStrictEqual(
  users.map((u) => [u.username, u.role, u.mustChangePassword]).sort(),
  [["admin", "admin", true], ["user", "viewer", true]].sort(),
  "admin/admin(admin) + user/viewer, оба must_change"
);
assert.strictEqual(adb.countAdmins(), 1, "один админ после сида");

const created = adb.createUser("bob", "bobpass1", "viewer", true, T);
assert.strictEqual(created.username, "bob");
assert.strictEqual(adb.listUsers().length, 3);
assert.ok(!("password_hash" in (created as object)), "PublicUser без хеша");

const bob = adb.getByUsername("bob")!;
assert.ok(bob, "getByUsername находит");
adb.setPassword(bob.id, "newbobpass", false, T);
assert.strictEqual(adb.getById(bob.id)!.must_change_password, 0, "setPassword сбрасывает must_change");

adb.updateRole(bob.id, "admin", T);
assert.strictEqual(adb.countAdmins(), 2, "updateRole повышает до admin");
adb.deleteUser(bob.id);
assert.strictEqual(adb.listUsers().length, 2, "deleteUser удаляет");

// ---------- 4. Сессии (JOIN на users, каскад) ----------
const admin = adb.getByUsername("admin")!;
adb.createSession("hashA", admin.id, T + 1000, T);
const s = adb.getSession("hashA")!;
assert.strictEqual(s.username, "admin");
assert.strictEqual(s.role, "admin");
assert.strictEqual(s.mustChangePassword, true);
adb.createSession("hashB", admin.id, T + 1000, T);
adb.deleteSessionsForUser(admin.id, "hashA");
assert.ok(adb.getSession("hashA"), "текущая сессия остаётся");
assert.ok(!adb.getSession("hashB"), "прочие сессии удалены");
adb.pruneExpired(T + 2000);
assert.ok(!adb.getSession("hashA"), "истёкшая сессия убрана prune");
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd /home/alexey/work/rancho/inverter-monitor/server && npx tsx scripts/selfcheck-auth.ts`
Expected: FAIL — `Cannot find module '../src/auth/db'`.

- [ ] **Step 3: Реализовать `server/src/auth/db.ts`**

```ts
import { DatabaseSync, StatementSync } from "node:sqlite";
import type { Role, PublicUser } from "@inverter/shared";
import { hashPassword } from "./hash";

const USERNAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Нормализация имени пользователя: trim + lowercase; валидирует формат. */
export function normalizeUsername(raw: string): string {
  const u = String(raw ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(u)) {
    throw new Error("Username must be 1..32 chars of a-z, 0-9, '_' or '-'");
  }
  return u;
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  must_change_password: number;
  created_at: number;
  updated_at: number;
}

export interface SessionInfo {
  userId: number;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  expiresAt: number;
}

export class AuthDb {
  private db: DatabaseSync;
  private q: Record<string, StatementSync> = {};

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','viewer')),
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `);
  }

  private prep(sql: string): StatementSync {
    return (this.q[sql] ??= this.db.prepare(sql));
  }

  /** Создаёт admin/admin и user/user при пустой таблице (идемпотентно). */
  seedDefaults(now: number): void {
    const n = this.prep("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    if (Number(n.n) > 0) return;
    this.createUser("admin", "admin", "admin", true, now);
    this.createUser("user", "user", "viewer", true, now);
  }

  private toPublic(r: UserRow): PublicUser {
    return {
      id: r.id,
      username: r.username,
      role: r.role,
      mustChangePassword: !!r.must_change_password,
      createdAt: r.created_at,
    };
  }

  listUsers(): PublicUser[] {
    const rows = this.prep(
      "SELECT * FROM users ORDER BY id"
    ).all() as unknown as UserRow[];
    return rows.map((r) => this.toPublic(r));
  }

  getByUsername(username: string): UserRow | null {
    return (this.prep("SELECT * FROM users WHERE username = ?").get(username) as
      | UserRow
      | undefined) ?? null;
  }

  getById(id: number): UserRow | null {
    return (this.prep("SELECT * FROM users WHERE id = ?").get(id) as
      | UserRow
      | undefined) ?? null;
  }

  createUser(username: string, password: string, role: Role, mustChange: boolean, now: number): PublicUser {
    const uname = normalizeUsername(username);
    const info = this.prep(
      `INSERT INTO users (username, password_hash, role, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(uname, hashPassword(password), role, mustChange ? 1 : 0, now, now);
    return this.toPublic(this.getById(Number(info.lastInsertRowid))!);
  }

  updateRole(id: number, role: Role, now: number): void {
    this.prep("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(role, now, id);
  }

  setPassword(id: number, password: string, mustChange: boolean, now: number): void {
    this.prep(
      "UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?"
    ).run(hashPassword(password), mustChange ? 1 : 0, now, id);
  }

  deleteUser(id: number): void {
    this.prep("DELETE FROM users WHERE id = ?").run(id);
  }

  countAdmins(): number {
    const r = this.prep("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number };
    return Number(r.n);
  }

  createSession(tokenHash: string, userId: number, expiresAt: number, now: number): void {
    this.prep(
      "INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
    ).run(tokenHash, userId, expiresAt, now);
  }

  getSession(tokenHash: string): SessionInfo | null {
    const r = this.prep(
      `SELECT s.user_id AS userId, s.expires_at AS expiresAt,
              u.username AS username, u.role AS role, u.must_change_password AS mcp
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    ).get(tokenHash) as
      | { userId: number; expiresAt: number; username: string; role: Role; mcp: number }
      | undefined;
    if (!r) return null;
    return {
      userId: Number(r.userId),
      username: r.username,
      role: r.role,
      mustChangePassword: !!r.mcp,
      expiresAt: Number(r.expiresAt),
    };
  }

  deleteSession(tokenHash: string): void {
    this.prep("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteSessionsForUser(userId: number, exceptTokenHash: string | null): void {
    if (exceptTokenHash) {
      this.prep("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, exceptTokenHash);
    } else {
      this.prep("DELETE FROM sessions WHERE user_id = ?").run(userId);
    }
  }

  pruneExpired(now: number): void {
    this.prep("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `cd /home/alexey/work/rancho/inverter-monitor/server && npx tsx scripts/selfcheck-auth.ts`
Expected: `selfcheck-auth: OK`.

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/db.ts server/scripts/selfcheck-auth.ts
git commit -m "feat(server/auth): AuthDb — пользователи, сидинг, сессии на node:sqlite"
```

---

### Task 4: `policy.ts` + сервис `Auth` (рефактор из `auth.ts`)

**Files:**
- Create: `server/src/auth/policy.ts`, `server/src/auth/service.ts`
- Delete: `server/src/auth.ts`
- Modify: `server/scripts/selfcheck-auth.ts` (разделы 5–6)

**Interfaces:**
- Consumes: `AuthDb`, `SessionInfo` из `auth/db`; `verifyPassword`, `validatePassword` из `auth/hash`; `SessionUser`, `Role` из `@inverter/shared`.
- Produces:
  - `type Access = "public" | "auth" | "admin"`; `canAccess(role: Role | null, required: Access): boolean` (в `policy.ts`).
  - `class Auth`:
    - `constructor(dataDir: string, ttlDays: number)` — открывает `<dataDir>/auth.db`, вызывает `seedDefaults`.
    - `readonly db: AuthDb`
    - `login(username: string, password: string, ip: string): { token: string; user: SessionUser } | null` (бросает `Error & { code: 429; retryMinutes }` при блокировке)
    - `verify(token: string | null): (SessionInfo & { tokenHash: string }) | null`
    - `logout(token: string | null): void`
    - `changePassword(token: string, currentPassword: string, newPassword: string): void` (бросает `Error` при неверном текущем/слабом новом)
    - `cookie(token: string): string`, `clearCookie(): string`
  - `tokenFromCookieHeader(header: string | undefined): string | null` (перенос без изменений).

- [ ] **Step 1: Добавить разделы 5–6 в `server/scripts/selfcheck-auth.ts`**

Добавить импорт и разделы перед `console.log("selfcheck-auth: OK")`:

```ts
import { canAccess } from "../src/auth/policy";
import { Auth } from "../src/auth/service";
import fs from "fs";
import os from "os";
import path from "path";

// ---------- 5. Матрица прав (чистая функция) ----------
assert.ok(canAccess(null, "public"), "public доступен без сессии");
assert.ok(!canAccess(null, "auth"), "auth недоступен без сессии");
assert.ok(!canAccess(null, "admin"), "admin недоступен без сессии");
assert.ok(canAccess("viewer", "auth"), "viewer видит auth-зону");
assert.ok(!canAccess("viewer", "admin"), "viewer НЕ видит admin-зону");
assert.ok(canAccess("admin", "auth"), "admin видит auth-зону");
assert.ok(canAccess("admin", "admin"), "admin видит admin-зону");

// ---------- 6. Auth: login / change-password / brute-force ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "authtest-"));
const auth = new Auth(tmp, 30);
assert.strictEqual(auth.login("admin", "wrong", "1.1.1.1"), null, "неверный пароль → null");
const ok = auth.login("admin", "admin", "1.1.1.1")!;
assert.ok(ok && ok.token, "верный логин выдаёт токен");
assert.strictEqual(ok.user.role, "admin");
assert.strictEqual(ok.user.mustChangePassword, true);
const v = auth.verify(ok.token)!;
assert.strictEqual(v.username, "admin", "verify возвращает пользователя");
// смена пароля снимает must_change и меняет пароль
auth.changePassword(ok.token, "admin", "admin123");
assert.strictEqual(auth.verify(ok.token)!.mustChangePassword, false, "must_change снят");
assert.strictEqual(auth.login("admin", "admin", "2.2.2.2"), null, "старый пароль больше не работает");
assert.ok(auth.login("admin", "admin123", "2.2.2.2"), "новый пароль работает");
assert.throws(() => auth.changePassword(ok.token, "admin123", "123"), "слабый новый пароль отклонён");
// brute-force: 5 промахов с одного IP → 429
for (let i = 0; i < 5; i++) auth.login("admin", "x", "9.9.9.9");
assert.throws(() => auth.login("admin", "admin123", "9.9.9.9"), /retry/i, "блокировка по IP");
auth.db.close();
fs.rmSync(tmp, { recursive: true, force: true });
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd /home/alexey/work/rancho/inverter-monitor/server && npx tsx scripts/selfcheck-auth.ts`
Expected: FAIL — `Cannot find module '../src/auth/policy'`.

- [ ] **Step 3: Реализовать `server/src/auth/policy.ts`**

```ts
import type { Role } from "@inverter/shared";

/** Уровень доступа эндпоинта/страницы. */
export type Access = "public" | "auth" | "admin";

/** Разрешён ли доступ роли `role` (null = нет сессии) к зоне `required`. */
export function canAccess(role: Role | null, required: Access): boolean {
  if (required === "public") return true;
  if (role === null) return false;
  if (required === "auth") return true;
  return role === "admin";
}
```

- [ ] **Step 4: Реализовать `server/src/auth/service.ts`** (перенос из `auth.ts` + БД)

```ts
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { SessionUser } from "@inverter/shared";
import { AuthDb, SessionInfo } from "./db";
import { verifyPassword, validatePassword } from "./hash";

/**
 * Сессионная авторизация с пользователями и ролями (см. auth/db.ts).
 * - Пароли — scrypt в auth.db; сессии — sha256(token) в auth.db.
 * - Анти-brute-force: 5 неверных попыток с одного IP → блок на 10 минут.
 * - TLS обеспечивает reverse proxy (Caddy на Pi).
 */

const COOKIE_NAME = "inv_session";
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const LOCK_MS = 10 * 60_000;

interface FailState {
  count: number;
  first: number;
  lockedUntil: number;
}

export class Auth {
  readonly db: AuthDb;
  private ttlMs: number;
  private fails = new Map<string, FailState>();

  constructor(dataDir: string, ttlDays: number) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new AuthDb(path.join(dataDir, "auth.db"));
    this.db.seedDefaults(Date.now());
    this.ttlMs = Math.max(1, ttlDays) * 24 * 3600_000;
  }

  /** Проверить учётные данные и создать сессию. null при неверных; throw 429 при блоке. */
  login(username: string, password: string, ip: string): { token: string; user: SessionUser } | null {
    const now = Date.now();
    const f = this.fails.get(ip);
    if (f && f.lockedUntil > now) {
      const minutes = Math.ceil((f.lockedUntil - now) / 60_000);
      const err = new Error(`Too many attempts — retry in ${minutes} min`) as Error & {
        code?: number;
        retryMinutes?: number;
      };
      err.code = 429;
      err.retryMinutes = minutes;
      throw err;
    }

    const row = this.db.getByUsername(String(username ?? "").trim().toLowerCase());
    const good = !!row && verifyPassword(password, row.password_hash);
    if (!good) {
      const cur: FailState =
        f && now - f.first < FAIL_WINDOW_MS ? f : { count: 0, first: now, lockedUntil: 0 };
      cur.count++;
      if (cur.count >= FAIL_LIMIT) {
        cur.lockedUntil = now + LOCK_MS;
        cur.count = 0;
        cur.first = now;
      }
      this.fails.set(ip, cur);
      return null;
    }

    this.fails.delete(ip);
    const token = crypto.randomBytes(32).toString("hex");
    this.db.pruneExpired(now);
    this.db.createSession(hashToken(token), row!.id, now + this.ttlMs, now);
    return {
      token,
      user: { username: row!.username, role: row!.role, mustChangePassword: !!row!.must_change_password },
    };
  }

  /** Данные сессии (+ tokenHash для инвалидации), либо null. */
  verify(token: string | null): (SessionInfo & { tokenHash: string }) | null {
    if (!token) return null;
    const h = hashToken(token);
    const s = this.db.getSession(h);
    if (!s || s.expiresAt <= Date.now()) return null;
    return { ...s, tokenHash: h };
  }

  logout(token: string | null): void {
    if (!token) return;
    this.db.deleteSession(hashToken(token));
  }

  /** Сменить свой пароль. Бросает при неверном текущем / слабом новом. */
  changePassword(token: string, currentPassword: string, newPassword: string): void {
    const s = this.verify(token);
    if (!s) throw new Error("Not authenticated");
    const row = this.db.getById(s.userId);
    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      throw new Error("Current password is incorrect");
    }
    validatePassword(newPassword);
    if (newPassword === currentPassword) throw new Error("New password must differ");
    this.db.setPassword(row.id, newPassword, false, Date.now());
    this.db.deleteSessionsForUser(row.id, s.tokenHash); // разлогинить прочие устройства
  }

  cookie(token: string): string {
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.ttlMs / 1000)}`;
  }

  clearCookie(): string {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
}

export function tokenFromCookieHeader(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      const v = part.slice(eq + 1).trim();
      return v || null;
    }
  }
  return null;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
```

- [ ] **Step 5: Удалить старый `server/src/auth.ts`**

Run: `cd /home/alexey/work/rancho/inverter-monitor && git rm server/src/auth.ts`
(Импорт `../auth` в `server.ts` чинится в Task 6; сборка server временно сломана — это ожидаемо между задачами. selfcheck-auth от сборки не зависит.)

- [ ] **Step 6: Запустить тест — убедиться, что проходит**

Run: `cd /home/alexey/work/rancho/inverter-monitor/server && npx tsx scripts/selfcheck-auth.ts`
Expected: `selfcheck-auth: OK`.

- [ ] **Step 7: Commit**

```bash
git add server/src/auth/policy.ts server/src/auth/service.ts server/scripts/selfcheck-auth.ts
git commit -m "feat(server/auth): сервис Auth поверх БД + чистая функция прав; удалён старый auth.ts"
```

---

### Task 5: `config.ts` — убрать пароль/open-mode

**Files:**
- Modify: `server/src/config.ts:26-30,78-81`, `.env.example`

**Interfaces:**
- Produces: `Config.auth: { sessionTtlDays: number }` (поле `password` удалено).

- [ ] **Step 1: Обновить тип и загрузку в `server/src/config.ts`**

Заменить блок интерфейса (строки 26-30):

```ts
  /** Web/API authentication (всегда включена). */
  auth: {
    sessionTtlDays: number;
  };
```

Заменить блок в `loadConfig` (строки 78-81):

```ts
    auth: {
      sessionTtlDays: envInt("AUTH_SESSION_TTL_DAYS", 30),
    },
```

- [ ] **Step 2: Обновить `.env.example`**

Найти строку с `AUTH_PASSWORD` и заменить весь блок auth на:

```
# --- Авторизация (всегда включена) ---
# Пользователи и пароли хранятся в data/auth.db. При первом старте создаются
# admin/admin и user/user — оба обязаны сменить пароль при первом входе.
# Забыли пароль: cd server && npx tsx scripts/reset-password.ts <username> <newpass>
AUTH_SESSION_TTL_DAYS=30
```

- [ ] **Step 3: Проверить, что нет других ссылок на `cfg.auth.password`**

Run: `cd /home/alexey/work/rancho/inverter-monitor && grep -rn "auth.password\|AUTH_PASSWORD" server/src`
Expected: пусто (единственная ссылка была в `server.ts`, чинится в Task 6).

- [ ] **Step 4: Commit**

```bash
git add server/src/config.ts .env.example
git commit -m "refactor(config): убрать AUTH_PASSWORD/open-mode — auth всегда включена"
```

---

### Task 6: `server.ts` — middleware, гейты, login(username)/me/change-password/meta

**Files:**
- Modify: `server/src/server.ts` (импорты, `createServer`, гейты страниц, login/logout, meta, новые роуты me/change-password)

**Interfaces:**
- Consumes: `Auth`, `tokenFromCookieHeader` из `./auth/service`; `canAccess` из `./auth/policy`; `SessionInfo` из `./auth/db`.
- Produces: Express-приложение, где `req.user?: SessionInfo & { tokenHash: string }` установлено после auth-гейта; ответ `/api/meta` содержит `session`.

- [ ] **Step 1: Обновить импорты в `server/src/server.ts`**

Заменить строку `import { Auth, tokenFromCookieHeader } from "./auth";` на:

```ts
import { Auth, tokenFromCookieHeader } from "./auth/service";
import { canAccess } from "./auth/policy";
import type { SessionInfo } from "./auth/db";
```

Добавить augmentation типа `express.Request` сразу после импортов:

```ts
declare module "express-serve-static-core" {
  interface Request {
    user?: SessionInfo & { tokenHash: string };
  }
}
```

- [ ] **Step 2: Заменить создание Auth и страничный гейт (строки 32-47)**

Заменить блок от `const auth = new Auth(...)` до `app.use(express.static(...))` включительно на:

```ts
  const auth = new Auth(cfg.dataDir, cfg.auth.sessionTtlDays);
  const reqToken = (req: express.Request) => tokenFromCookieHeader(req.headers.cookie);

  // Страничные редиректы: без сессии → /login; must_change → /change-password;
  // admin-страницы для viewer → /. Статика (css/js/страницы) отдаётся свободно —
  // данные защищены на уровне /api.
  const ADMIN_PAGES = new Set(["/settings", "/diagnostics", "/users"]);
  app.get(
    ["/", "/index.html", "/settings", "/diagnostics", "/stats", "/users", "/change-password"],
    (req, res, next) => {
      const u = auth.verify(reqToken(req));
      if (!u) return res.redirect("/login");
      if (u.mustChangePassword) {
        return req.path === "/change-password" ? next() : res.redirect("/change-password");
      }
      if (ADMIN_PAGES.has(req.path) && u.role !== "admin") return res.redirect("/");
      next();
    }
  );

  // Статика Next.js (web/out); extensions отдаёт /settings как settings.html.
  const publicDir = path.join(__dirname, "..", "..", "web", "out");
  app.use(express.static(publicDir, { extensions: ["html"] }));
```

- [ ] **Step 3: Заменить `/api/login` (строки 49-71)**

```ts
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ ok: false, error: "username and password must be strings" });
    }
    try {
      const result = auth.login(username, password, req.socket.remoteAddress ?? "unknown");
      if (!result) {
        return res.status(401).json({ ok: false, code: "bad_password", error: "Wrong credentials" });
      }
      res.setHeader("Set-Cookie", auth.cookie(result.token));
      res.json({ ok: true, role: result.user.role, mustChangePassword: result.user.mustChangePassword });
    } catch (e) {
      const err = e as Error & { code?: number; retryMinutes?: number };
      if (err.code === 429) {
        return res
          .status(429)
          .json({ ok: false, code: "rate_limited", minutes: err.retryMinutes, error: err.message });
      }
      res.status(400).json({ ok: false, error: err.message });
    }
  });
```

(`/api/logout` строки 73-77 оставить без изменений.)

- [ ] **Step 4: Заменить auth-гейт `/api` (строки 79-83) на трёхступенчатый + me/change-password**

Заменить блок:

```ts
  // Everything else under /api requires a session.
  app.use("/api", (req, res, next) => {
    if (auth.verifyToken(reqToken(req))) return next();
    res.status(401).json({ ok: false, error: "Unauthorized" });
  });
```

на:

```ts
  // Зона авторизации: любой валидный пользователь.
  app.use("/api", (req, res, next) => {
    const u = auth.verify(reqToken(req));
    if (!u) return res.status(401).json({ ok: false, error: "Unauthorized" });
    req.user = u;
    next();
  });

  // Доступны даже при must_change (иначе смену пароля не выполнить).
  app.get("/api/me", (req, res) => {
    const u = req.user!;
    res.json({ username: u.username, role: u.role, mustChangePassword: u.mustChangePassword });
  });

  app.post("/api/change-password", (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body ?? {};
      if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
        return res.status(400).json({ ok: false, error: "currentPassword and newPassword required" });
      }
      auth.changePassword(reqToken(req)!, currentPassword, newPassword);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  // Форс смены пароля: до смены всё остальное под /api закрыто.
  app.use("/api", (req, res, next) => {
    if (req.user!.mustChangePassword) {
      return res.status(403).json({ ok: false, code: "must_change_password", error: "Password change required" });
    }
    next();
  });

  // Admin-only зона.
  app.use(
    ["/api/control", "/api/lock", "/api/raw", "/api/baseline", "/api/baseline/recapture", "/api/users"],
    (req, res, next) => {
      if (!canAccess(req.user!.role, "admin")) {
        return res.status(403).json({ ok: false, code: "forbidden", error: "Admins only" });
      }
      next();
    }
  );
```

- [ ] **Step 5: Обновить `/api/meta` (строки 89-98) — заменить `authEnabled` на `session`**

```ts
  app.get("/api/meta", (req, res) => {
    const u = req.user!;
    res.json({
      session: { username: u.username, role: u.role, mustChangePassword: u.mustChangePassword },
      allowControl: cfg.allowControl,
      outputSourcePriority: OUTPUT_SOURCE_PRIORITY,
      chargerSourcePriority: CHARGER_SOURCE_PRIORITY,
      maxChargingCurrent: ALLOWED_MAX_CHARGE_CURRENT,
      maxAcChargingCurrent: ALLOWED_MAX_AC_CHARGE_CURRENT,
    });
  });
```

- [ ] **Step 6: Обновить WS-гейт (строки 282-288) — `verify` вместо `verifyToken`**

```ts
  wss.on("connection", (ws, req) => {
    if (!auth.verify(tokenFromCookieHeader(req.headers.cookie))) {
      ws.close(4401, "Unauthorized");
      return;
    }
    ws.send(JSON.stringify({ type: "snapshot", data: inverter.getSnapshot() }));
  });
```

- [ ] **Step 7: Собрать server, проверить типы**

Run: `cd /home/alexey/work/rancho/inverter-monitor && npm run build -w shared && npm run build -w server`
Expected: сборка без ошибок.

- [ ] **Step 8: Smoke-тест обвязки на mock-транспорте**

```bash
cd /home/alexey/work/rancho/inverter-monitor/server
rm -rf /tmp/auth-smoke && DATA_DIR=/tmp/auth-smoke INVERTER_TRANSPORT=mock PORT=3999 node ../server/dist/index.js &
sleep 2
# 1) без сессии /api/meta → 401
curl -s -o /dev/null -w "meta_noauth=%{http_code}\n" http://localhost:3999/api/meta
# 2) логин admin/admin
curl -s -c /tmp/cj -X POST -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}' http://localhost:3999/api/login
# 3) с сессией, но must_change → /api/snapshot 403 must_change_password
curl -s -b /tmp/cj -o /dev/null -w "snapshot_mustchange=%{http_code}\n" http://localhost:3999/api/snapshot
# 4) смена пароля
curl -s -b /tmp/cj -X POST -H 'Content-Type: application/json' -d '{"currentPassword":"admin","newPassword":"admin123"}' http://localhost:3999/api/change-password
# 5) теперь snapshot 200
curl -s -b /tmp/cj -o /dev/null -w "snapshot_after=%{http_code}\n" http://localhost:3999/api/snapshot
kill %1
```
Expected: `meta_noauth=401`, строка `{"ok":true,...}` на логине, `snapshot_mustchange=403`, `{"ok":true}` на смене, `snapshot_after=200`.

- [ ] **Step 9: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): middleware ролей, форс смены пароля, login по username, meta.session"
```

---

### Task 7: `server.ts` — CRUD пользователей `/api/users`

**Files:**
- Modify: `server/src/server.ts` (добавить роуты после admin-гейта)

**Interfaces:**
- Consumes: `auth.db` (`AuthDb`), `normalizeUsername` из `./auth/db`, `validatePassword` из `./auth/hash`.
- Produces: REST `/api/users` (GET/POST), `/api/users/:id` (PATCH/DELETE), `/api/users/:id/reset-password` (POST).

- [ ] **Step 1: Добавить импорты в `server/src/server.ts`**

К существующим импортам auth добавить:

```ts
import { normalizeUsername } from "./auth/db";
import { validatePassword } from "./auth/hash";
```

- [ ] **Step 2: Добавить роуты `/api/users` (после admin-гейта, до `/api/health`)**

```ts
  app.get("/api/users", (_req, res) => {
    res.json(auth.db.listUsers());
  });

  app.post("/api/users", (req, res) => {
    try {
      const { username, role, password } = req.body ?? {};
      if (role !== "admin" && role !== "viewer") {
        return res.status(400).json({ ok: false, error: "role must be admin or viewer" });
      }
      if (typeof password !== "string") {
        return res.status(400).json({ ok: false, error: "password required" });
      }
      validatePassword(password);
      const uname = normalizeUsername(String(username ?? ""));
      if (auth.db.getByUsername(uname)) {
        return res.status(409).json({ ok: false, code: "exists", error: "Username already exists" });
      }
      const user = auth.db.createUser(uname, password, role, true, Date.now());
      res.json({ ok: true, user });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.patch("/api/users/:id", (req, res) => {
    try {
      const id = Number(req.params.id);
      const { role } = req.body ?? {};
      if (role !== "admin" && role !== "viewer") {
        return res.status(400).json({ ok: false, error: "role must be admin or viewer" });
      }
      const target = auth.db.getById(id);
      if (!target) return res.status(404).json({ ok: false, error: "User not found" });
      // Нельзя понизить последнего админа.
      if (target.role === "admin" && role === "viewer" && auth.db.countAdmins() <= 1) {
        return res.status(409).json({ ok: false, code: "last_admin", error: "Cannot demote the last admin" });
      }
      auth.db.updateRole(id, role, Date.now());
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/users/:id/reset-password", (req, res) => {
    try {
      const id = Number(req.params.id);
      const { newPassword } = req.body ?? {};
      if (typeof newPassword !== "string") {
        return res.status(400).json({ ok: false, error: "newPassword required" });
      }
      validatePassword(newPassword);
      const target = auth.db.getById(id);
      if (!target) return res.status(404).json({ ok: false, error: "User not found" });
      auth.db.setPassword(id, newPassword, true, Date.now());
      auth.db.deleteSessionsForUser(id, null); // разлогинить пользователя
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.delete("/api/users/:id", (req, res) => {
    try {
      const id = Number(req.params.id);
      const target = auth.db.getById(id);
      if (!target) return res.status(404).json({ ok: false, error: "User not found" });
      if (id === req.user!.userId) {
        return res.status(409).json({ ok: false, code: "self_delete", error: "Cannot delete yourself" });
      }
      if (target.role === "admin" && auth.db.countAdmins() <= 1) {
        return res.status(409).json({ ok: false, code: "last_admin", error: "Cannot delete the last admin" });
      }
      auth.db.deleteUser(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });
```

- [ ] **Step 3: Собрать server**

Run: `cd /home/alexey/work/rancho/inverter-monitor && npm run build -w server`
Expected: без ошибок.

- [ ] **Step 4: Smoke-тест CRUD (admin-сессия после смены пароля)**

```bash
cd /home/alexey/work/rancho/inverter-monitor/server
rm -rf /tmp/auth-smoke2 && DATA_DIR=/tmp/auth-smoke2 INVERTER_TRANSPORT=mock PORT=3998 node dist/index.js &
sleep 2
curl -s -c /tmp/cj2 -X POST -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}' http://localhost:3998/api/login >/dev/null
curl -s -b /tmp/cj2 -X POST -H 'Content-Type: application/json' -d '{"currentPassword":"admin","newPassword":"admin123"}' http://localhost:3998/api/change-password >/dev/null
echo "-- список:"; curl -s -b /tmp/cj2 http://localhost:3998/api/users
echo "-- создать bob:"; curl -s -b /tmp/cj2 -X POST -H 'Content-Type: application/json' -d '{"username":"bob","role":"viewer","password":"bobpass1"}' http://localhost:3998/api/users
echo "-- удалить последнего админа (admin id=1) → 409:"; curl -s -b /tmp/cj2 -X DELETE http://localhost:3998/api/users/1
# viewer не может дёргать /api/users → 403
curl -s -c /tmp/cj3 -X POST -H 'Content-Type: application/json' -d '{"username":"bob","password":"bobpass1"}' http://localhost:3998/api/login >/dev/null
curl -s -b /tmp/cj3 -X POST -H 'Content-Type: application/json' -d '{"currentPassword":"bobpass1","newPassword":"bobpass2"}' http://localhost:3998/api/change-password >/dev/null
echo "-- bob(viewer) GET /api/users → 403:"; curl -s -b /tmp/cj3 -o /dev/null -w "%{http_code}\n" http://localhost:3998/api/users
kill %1
```
Expected: список из 2, `{"ok":true,"user":{...bob...}}`, `{"ok":false,"code":"last_admin",...}`, `403`.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): CRUD пользователей /api/users с защитой последнего админа"
```

---

### Task 8: web — i18n-строки, login по username, обработка 403

**Files:**
- Modify: `web/lib/i18n/dict.ts`, `web/lib/api.ts`, `web/app/login/page.tsx`

**Interfaces:**
- Consumes: `ApiMeta.session` (Task 1).
- Produces: i18n-ключи `loginUsername`, `changePwTitle`, `changePwCurrent`, `changePwNew`, `changePwSubmit`, `changePwMismatch`, `changePwNote`, `navUsers`, `usersTitle`, `usersAdd`, `usersRole`, `usersRoleAdmin`, `usersRoleViewer`, `usersResetPw`, `usersDelete`, `usersMustChange`, `usersCreatedAt`, `usersConfirmDelete` (все три языка UA/RU/EN); `handle403` в `lib/api.ts`.

- [ ] **Step 1: Добавить ключи в `web/lib/i18n/dict.ts`**

В объект каждого языка (`uk`, `ru`, `en`) добавить ключи. Для `uk`:

```ts
    loginUsername: "Ім'я користувача",
    changePwTitle: "Зміна пароля",
    changePwCurrent: "Поточний пароль",
    changePwNew: "Новий пароль",
    changePwSubmit: "Змінити пароль",
    changePwMismatch: "Пароль замалий (мінімум 6 символів)",
    changePwNote: "Змініть тимчасовий пароль, щоб продовжити.",
    navUsers: "Користувачі",
    usersTitle: "Користувачі",
    usersAdd: "Додати користувача",
    usersRole: "Роль",
    usersRoleAdmin: "Адміністратор",
    usersRoleViewer: "Перегляд",
    usersResetPw: "Скинути пароль",
    usersDelete: "Видалити",
    usersMustChange: "потрібна зміна пароля",
    usersCreatedAt: "Створено",
    usersConfirmDelete: "Видалити користувача?",
```

Для `ru`:

```ts
    loginUsername: "Имя пользователя",
    changePwTitle: "Смена пароля",
    changePwCurrent: "Текущий пароль",
    changePwNew: "Новый пароль",
    changePwSubmit: "Сменить пароль",
    changePwMismatch: "Пароль слишком короткий (минимум 6 символов)",
    changePwNote: "Смените временный пароль, чтобы продолжить.",
    navUsers: "Пользователи",
    usersTitle: "Пользователи",
    usersAdd: "Добавить пользователя",
    usersRole: "Роль",
    usersRoleAdmin: "Администратор",
    usersRoleViewer: "Просмотр",
    usersResetPw: "Сбросить пароль",
    usersDelete: "Удалить",
    usersMustChange: "требуется смена пароля",
    usersCreatedAt: "Создан",
    usersConfirmDelete: "Удалить пользователя?",
```

Для `en`:

```ts
    loginUsername: "Username",
    changePwTitle: "Change password",
    changePwCurrent: "Current password",
    changePwNew: "New password",
    changePwSubmit: "Change password",
    changePwMismatch: "Password too short (minimum 6 characters)",
    changePwNote: "Change your temporary password to continue.",
    navUsers: "Users",
    usersTitle: "Users",
    usersAdd: "Add user",
    usersRole: "Role",
    usersRoleAdmin: "Admin",
    usersRoleViewer: "Viewer",
    usersResetPw: "Reset password",
    usersDelete: "Delete",
    usersMustChange: "password change required",
    usersCreatedAt: "Created",
    usersConfirmDelete: "Delete user?",
```

- [ ] **Step 2: Добавить `handle403` в `web/lib/api.ts`**

В `postJson` и `getJson` после проверки 401 добавить обработку 403 must_change. Заменить содержимое `web/lib/api.ts` на:

```ts
export function redirectToLogin(): void {
  window.location.href = "/login";
}

/** 403 с кодом must_change_password уводит на смену пароля. Возвращает true, если обработал. */
async function redirectIfMustChange(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const data = await res.clone().json();
    if (data?.code === "must_change_password") {
      window.location.href = "/change-password";
      return true;
    }
  } catch {}
  return false;
}

/** POST JSON. 401 → /login; 403 must_change → /change-password. */
export async function postJson(path: string, body: unknown): Promise<Response> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("Unauthorized");
  }
  if (await redirectIfMustChange(res)) throw new Error("Password change required");
  return res;
}

/** GET JSON. 401 → /login; 403 must_change → /change-password; иначе не-2xx бросает. */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("Unauthorized");
  }
  if (await redirectIfMustChange(res)) throw new Error("Password change required");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function wsUrl(): string {
  if (process.env.NODE_ENV === "development") return "ws://localhost:3000/ws";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}
```

- [ ] **Step 3: Добавить поле username в `web/app/login/page.tsx`**

Заменить состояние и submit: добавить `const [user, setUser] = useState("");`, в body логина передавать `{ username: user, password: pw }`, и обработать `mustChangePassword` в ответе. Заменить функцию `submit` и форму:

```tsx
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password: pw }),
      });
      const data = await res.json();
      if (data.ok) {
        window.location.href = data.mustChangePassword ? "/change-password" : "/";
        return;
      }
      let msg: string = data.error || t.toastError;
      if (data.code === "bad_password") msg = t.badPassword;
      else if (data.code === "rate_limited") msg = t.tooMany.replace("{m}", String(data.minutes ?? "?"));
      setErr(msg);
    } catch (ex) {
      setErr(t.toastNetErr + (ex as Error).message);
    }
  };
```

В форме добавить поле username перед полем пароля:

```tsx
        <form className="row" onSubmit={submit}>
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder={t.loginUsername}
            autoComplete="username"
            autoFocus
          />
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={t.loginPassword}
            autoComplete="current-password"
          />
          <button className="apply" type="submit">
            {t.loginSubmit}
          </button>
        </form>
```

(Убрать `autoFocus` со старого поля пароля — он переехал на username.)

- [ ] **Step 4: Typecheck web**

Run: `cd /home/alexey/work/rancho/inverter-monitor && npm run build -w shared && npm run typecheck -w web`
Expected: без ошибок (все три языка dict имеют одинаковый набор ключей).

- [ ] **Step 5: Commit**

```bash
git add web/lib/i18n/dict.ts web/lib/api.ts "web/app/login/page.tsx"
git commit -m "feat(web): вход по username, i18n-строки auth, редирект на смену пароля при 403"
```

---

### Task 9: web — страница `/change-password`

**Files:**
- Create: `web/app/change-password/page.tsx`

**Interfaces:**
- Consumes: `postJson` из `@/lib/api`; i18n-ключи из Task 8.

- [ ] **Step 1: Создать `web/app/change-password/page.tsx`**

```tsx
"use client";

import { FormEvent, useState } from "react";
import { useT, useDocTitle } from "@/lib/i18n";
import { LangSwitch } from "@/components/LangSwitch";

export default function ChangePasswordPage() {
  const t = useT();
  useDocTitle("changePwTitle");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (next.length < 6) {
      setErr(t.changePwMismatch);
      return;
    }
    try {
      const res = await fetch("/api/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (data.ok) {
        window.location.href = "/";
        return;
      }
      setErr(data.error || t.toastError);
    } catch (ex) {
      setErr(t.toastNetErr + (ex as Error).message);
    }
  };

  return (
    <div className="login-wrap">
      <div className="modal-box login-box">
        <h1 className="login-title">{t.changePwTitle}</h1>
        <p className="note">{t.changePwNote}</p>
        <form className="row" onSubmit={submit}>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder={t.changePwCurrent}
            autoComplete="current-password"
            autoFocus
          />
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder={t.changePwNew}
            autoComplete="new-password"
          />
          <button className="apply" type="submit">
            {t.changePwSubmit}
          </button>
        </form>
        {err && <p className="login-err">{err}</p>}
        <LangSwitch />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + build web (страница попадает в static export)**

Run: `cd /home/alexey/work/rancho/inverter-monitor && npm run typecheck -w web && npm run build -w web`
Expected: без ошибок; в `web/out/` появляется `change-password.html`.

- [ ] **Step 3: Commit**

```bash
git add "web/app/change-password/page.tsx"
git commit -m "feat(web): страница смены пароля /change-password"
```

---

### Task 10: web — навигация по роли + logout всегда

**Files:**
- Modify: `web/app/(app)/layout.tsx` (`NavTabs`, `Footer`)

**Interfaces:**
- Consumes: `useMeta()` → `ApiMeta` с `session.role`.

- [ ] **Step 1: Обновить `NavTabs` в `web/app/(app)/layout.tsx`** — фильтр табов по роли + клиентский guard

Заменить функцию `NavTabs` на:

```tsx
function NavTabs() {
  const t = useT();
  const meta = useMeta();
  const pathname = usePathname();
  const isAdmin = meta?.session.role === "admin";

  // Клиентский guard: viewer, попавший на admin-страницу, уводится на дашборд
  // (сервер тоже редиректит — это подстраховка для SPA-навигации).
  useEffect(() => {
    if (!meta) return;
    const adminPaths = ["/settings", "/diagnostics", "/users"];
    if (!isAdmin && adminPaths.includes(pathname)) window.location.href = "/";
  }, [meta, isAdmin, pathname]);

  const tabs = [
    { href: "/", label: t.navDashboard, admin: false },
    { href: "/stats", label: t.navStats, admin: false },
    { href: "/settings", label: t.navSettings, admin: true },
    { href: "/diagnostics", label: t.navDiagnostics, admin: true },
    { href: "/users", label: t.navUsers, admin: true },
  ].filter((tab) => !tab.admin || isAdmin);

  return (
    <nav className="nav-tabs">
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={pathname === tab.href ? "active" : ""}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
```

Добавить `useEffect` в импорт React вверху файла: `import { ReactNode, useEffect } from "react";`

- [ ] **Step 2: Обновить `Footer`** — logout показывать всегда (поля `authEnabled` больше нет)

В функции `Footer` заменить `{meta?.authEnabled && (` на `{meta && (`:

```tsx
        {meta && (
          <a href="#" className="logout" onClick={logout}>
            {t.logout}
          </a>
        )}
```

- [ ] **Step 3: Typecheck web**

Run: `cd /home/alexey/work/rancho/inverter-monitor && npm run typecheck -w web`
Expected: без ошибок (не осталось ссылок на `meta.authEnabled`).

- [ ] **Step 4: Commit**

```bash
git add "web/app/(app)/layout.tsx"
git commit -m "feat(web): навигация по роли (admin/viewer), logout всегда виден"
```

---

### Task 11: web — страница `/users` (admin CRUD)

**Files:**
- Create: `web/app/(app)/users/page.tsx`

**Interfaces:**
- Consumes: `getJson`, `postJson` из `@/lib/api`; `PublicUser`, `Role` из `@inverter/shared`; `useToast` из `@/lib/toast`; i18n из Task 8.

- [ ] **Step 1: Создать `web/app/(app)/users/page.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicUser, Role } from "@inverter/shared";
import { getJson, postJson } from "@/lib/api";
import { useT, useDocTitle } from "@/lib/i18n";
import { useToast } from "@/lib/toast";

export default function UsersPage() {
  const t = useT();
  useDocTitle("usersTitle");
  const toast = useToast();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [uname, setUname] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [pw, setPw] = useState("");

  const reload = useCallback(async () => {
    try {
      setUsers(await getJson<PublicUser[]>("/api/users"));
    } catch (e) {
      toast((e as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    reload();
  }, [reload]);

  const add = async () => {
    try {
      const res = await postJson("/api/users", { username: uname, role, password: pw });
      const data = await res.json();
      if (!data.ok) return toast(data.error || t.toastError);
      setUname("");
      setPw("");
      setRole("viewer");
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const changeRole = async (u: PublicUser, next: Role) => {
    try {
      const res = await postJson(`/api/users/${u.id}`, { role: next });
      // postJson шлёт POST; для PATCH используем fetch напрямую ниже — см. примечание.
      const data = await res.json();
      if (!data.ok) return toast(data.error || t.toastError);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const resetPw = async (u: PublicUser) => {
    const np = window.prompt(t.usersResetPw + " — " + u.username);
    if (!np) return;
    try {
      const res = await postJson(`/api/users/${u.id}/reset-password`, { newPassword: np });
      const data = await res.json();
      if (!data.ok) return toast(data.error || t.toastError);
      toast("OK");
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const del = async (u: PublicUser) => {
    if (!window.confirm(t.usersConfirmDelete + " " + u.username)) return;
    try {
      const res = await fetch(`/api/users/${u.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) return toast(data.error || t.toastError);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <main className="grid">
      <section className="panel">
        <h2>{t.usersTitle}</h2>
        <div className="table-scroll">
          <table className="users-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t.loginUsername}</th>
                <th>{t.usersRole}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td>
                    {u.username}
                    {u.mustChangePassword ? <span className="note"> ({t.usersMustChange})</span> : null}
                  </td>
                  <td>
                    <select value={u.role} onChange={(e) => changeRole(u, e.target.value as Role)}>
                      <option value="admin">{t.usersRoleAdmin}</option>
                      <option value="viewer">{t.usersRoleViewer}</option>
                    </select>
                  </td>
                  <td className="row">
                    <button onClick={() => resetPw(u)}>{t.usersResetPw}</button>
                    <button onClick={() => del(u)}>{t.usersDelete}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>{t.usersAdd}</h2>
        <div className="row">
          <input value={uname} onChange={(e) => setUname(e.target.value)} placeholder={t.loginUsername} />
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={t.changePwNew}
            autoComplete="new-password"
          />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">{t.usersRoleAdmin}</option>
            <option value="viewer">{t.usersRoleViewer}</option>
          </select>
          <button className="apply" onClick={add}>
            {t.usersAdd}
          </button>
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Заменить PATCH-заглушку на настоящий PATCH**

В функции `changeRole` заменить вызов `postJson` на прямой `fetch` с методом PATCH (у `postJson` метод жёстко POST):

```tsx
  const changeRole = async (u: PublicUser, next: Role) => {
    if (next === u.role) return;
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: next }),
      });
      const data = await res.json();
      if (!data.ok) return toast(data.error || t.toastError);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
```

- [ ] **Step 3: Проверить сигнатуру `useToast`**

Run: `cd /home/alexey/work/rancho/inverter-monitor && grep -n "export function useToast\|toast(" web/lib/toast.tsx | head`
Expected: увидеть сигнатуру. Если `useToast()` возвращает объект/иную форму — привести вызовы `toast(...)` к фактическому API (напр. `toast.show(msg)`); поправить все вызовы в файле соответственно.

- [ ] **Step 4: Typecheck + build web**

Run: `cd /home/alexey/work/rancho/inverter-monitor && npm run typecheck -w web && npm run build -w web`
Expected: без ошибок; в `web/out/` появляется `users.html`.

- [ ] **Step 5: Commit**

```bash
git add "web/app/(app)/users/page.tsx"
git commit -m "feat(web): страница управления пользователями /users (admin)"
```

---

### Task 12: CLI сброса пароля + документация

**Files:**
- Create: `server/scripts/reset-password.ts`
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `AuthDb` из `../src/auth/db`.

- [ ] **Step 1: Создать `server/scripts/reset-password.ts`**

```ts
import path from "path";
import { AuthDb } from "../src/auth/db";

/**
 * Сброс пароля пользователя из CLI (для забытого пароля админа).
 * Usage: DATA_DIR=data npx tsx scripts/reset-password.ts <username> <newpass>
 * Ставит пароль и включает must_change_password (пользователь сменит при входе).
 */
function main(): void {
  const [username, newpass] = process.argv.slice(2);
  if (!username || !newpass) {
    console.error("Usage: npx tsx scripts/reset-password.ts <username> <newpass>");
    process.exit(1);
  }
  if (newpass.length < 6) {
    console.error("Password must be at least 6 characters");
    process.exit(1);
  }
  const dataDir = process.env.DATA_DIR || "data";
  const db = new AuthDb(path.join(dataDir, "auth.db"));
  const user = db.getByUsername(username.trim().toLowerCase());
  if (!user) {
    console.error(`User not found: ${username}`);
    process.exit(1);
  }
  db.setPassword(user.id, newpass, true, Date.now());
  db.deleteSessionsForUser(user.id, null);
  db.close();
  console.log(`Password reset for ${user.username}; must change on next login.`);
}

main();
```

- [ ] **Step 2: Проверить работу CLI**

```bash
cd /home/alexey/work/rancho/inverter-monitor/server
rm -rf /tmp/auth-cli && mkdir -p /tmp/auth-cli
# засеять БД разовым стартом
DATA_DIR=/tmp/auth-cli INVERTER_TRANSPORT=mock PORT=3997 node dist/index.js & sleep 2; kill %1
DATA_DIR=/tmp/auth-cli npx tsx scripts/reset-password.ts admin newadminpw
```
Expected: `Password reset for admin; must change on next login.`

- [ ] **Step 3: Обновить `README.md`** (секция авторизации)

Заменить описание одиночного `AUTH_PASSWORD` на модель пользователей/ролей. Добавить (на украинском, в тон README):

```markdown
## Авторизація

Застосунок вимагає входу. Користувачі та паролі зберігаються в `data/auth.db`.

- Дві ролі: **admin** (повний доступ) і **viewer** (лише «Огляд» і «Статистика»).
- При першому старті створюються **admin/admin** і **user/user** — обидва мають
  змінити пароль при першому вході.
- Адміністратор керує користувачами на сторінці **«Користувачі»** (створення,
  зміна ролі, скидання пароля, видалення). Останнього адміністратора видалити
  або понизити не можна.
- Забули пароль: `cd server && DATA_DIR=data npx tsx scripts/reset-password.ts <username> <newpass>`.

TLS забезпечує reverse proxy (Caddy). `AUTH_SESSION_TTL_DAYS` — час життя сесії (дні).
```

- [ ] **Step 4: Обновить `CLAUDE.md`** (секция про безопасность / архитектуру)

В раздел архитектуры server добавить пункт про `src/auth/`:

```markdown
### Авторизація (`server/src/auth/`)
- `hash.ts` — scrypt-хешування паролів (вбудований `crypto`, без залежностей).
- `db.ts` — `AuthDb` на `node:sqlite` (`data/auth.db`): користувачі + сесії, сидинг
  admin/user при порожній БД.
- `policy.ts` — чиста `canAccess(role, required)` (тестується selfcheck-auth).
- `service.ts` — клас `Auth`: логін/сесії/зміна пароля, анти-brute-force по IP.
- Дві ролі: `admin` (усе) / `viewer` (лише `/` і `/stats`). Обмеження — і на
  сервері (middleware 403 + редиректи сторінок), і в UI (навігація за роллю).
- Форс зміни пароля: `must_change_password=1` блокує весь `/api` крім
  `me`/`change-password`/`logout`, доки пароль не змінено.
- Тести — `scripts/selfcheck-auth.ts` (входить у `npm run check -w server`).
```

- [ ] **Step 5: Commit**

```bash
git add server/scripts/reset-password.ts README.md CLAUDE.md
git commit -m "feat(server): CLI reset-password + документація авторизації"
```

---

### Task 13: Финальная проверка — check + build целиком

**Files:** нет (проверочная задача)

- [ ] **Step 1: Полный `npm run check` из корня**

Run: `cd /home/alexey/work/rancho/inverter-monitor && npm run check`
Expected: `selfcheck` OK, `selfcheck-stats` OK, `selfcheck-auth: OK`, web typecheck без ошибок.

- [ ] **Step 2: Полная сборка**

Run: `cd /home/alexey/work/rancho/inverter-monitor && npm run build`
Expected: shared → server → web собираются без ошибок; в `web/out/` есть `login.html`, `change-password.html`, `users.html`, `index.html`, `stats.html`, `settings.html`, `diagnostics.html`.

- [ ] **Step 3: Интеграционный smoke — весь флоу на mock**

```bash
cd /home/alexey/work/rancho/inverter-monitor/server
rm -rf /tmp/auth-final && DATA_DIR=/tmp/auth-final INVERTER_TRANSPORT=mock PORT=3996 node dist/index.js & sleep 2
echo "1. viewer-флоу:"
curl -s -c /tmp/v -X POST -H 'Content-Type: application/json' -d '{"username":"user","password":"user"}' http://localhost:3996/api/login
curl -s -b /tmp/v -X POST -H 'Content-Type: application/json' -d '{"currentPassword":"user","newPassword":"viewer1"}' http://localhost:3996/api/change-password >/dev/null
echo "viewer snapshot:"; curl -s -b /tmp/v -o /dev/null -w "%{http_code}\n" http://localhost:3996/api/snapshot   # 200
echo "viewer control:"; curl -s -b /tmp/v -o /dev/null -w "%{http_code}\n" -X POST -H 'Content-Type: application/json' -d '{"type":"maxChargingCurrent","value":40}' http://localhost:3996/api/control  # 403
echo "viewer users:"; curl -s -b /tmp/v -o /dev/null -w "%{http_code}\n" http://localhost:3996/api/users  # 403
kill %1
```
Expected: логин ok+mustChange, `viewer snapshot: 200`, `viewer control: 403`, `viewer users: 403`.

- [ ] **Step 4: Финальный статус (без коммита — изменений быть не должно)**

Run: `cd /home/alexey/work/rancho/inverter-monitor && git status --short`
Expected: чисто (всё уже закоммичено предыдущими задачами).

---

## Self-Review

**Spec coverage:**
- Хранилище auth.db (спека §Хранилище) → Task 3.
- scrypt-пароли (§Хеширование) → Task 2.
- Сидинг admin/user, must_change (§Сидинг) → Task 3.
- Матрица доступа server-side (§Матрица) → Task 4 (policy) + Task 6 (middleware).
- Форс смены пароля (§Первый вход) → Task 6 (gating) + Task 9 (страница) + Task 8 (login redirect).
- CRUD пользователей + инварианты (§CRUD) → Task 3 (countAdmins/операции) + Task 7 (роуты/инварианты) + Task 11 (UI).
- Контракт shared (§Контракт) → Task 1.
- Навигация по роли (§Веб) → Task 10.
- Конфиг/совместимость (§Конфигурация) → Task 5 + Task 12 (CLI).
- Безопасность (§Безопасность) → Task 4 (сессии/brute-force/каскад).
- Тестирование (§Тестирование) → selfcheck-auth в Tasks 2–4, включён в check в Task 2; финал в Task 13.

**Placeholder scan:** прямых TODO/TBD нет. Task 11 Step 3 — не заглушка, а явная сверка API `useToast` с указанием, как поправить вызовы (сигнатура toast.tsx не читалась при написании плана — единственная точка, требующая проверки при исполнении).

**Type consistency:** `SessionUser`/`PublicUser`/`Role` (Task 1) используются согласованно; `AuthDb` методы (Task 3) вызываются с теми же сигнатурами в `service.ts` (Task 4) и роутах (Task 7); `canAccess(role, required)` (Task 4) — та же сигнатура в middleware (Task 6). Ответ `/api/meta.session` (Task 6) соответствует `ApiMeta.session` (Task 1) и чтению `meta.session.role` (Task 10/11).
