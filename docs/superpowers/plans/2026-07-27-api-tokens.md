# API-токены (Bearer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать машинным клиентам (в первую очередь будущему MCP-серверу) доступ к `/api` и `/ws` по долгоживущим токенам `Authorization: Bearer`, со скоупами и управлением из UI.

**Architecture:** Токены живут в существующей `auth.db` рядом с сессиями: новая таблица `api_tokens`, в БД — только `sha256` значения. Middleware `/api` пробует cookie, затем Bearer, и заполняет `req.user` (как раньше) плюс новый `req.auth` с видом авторизации и скоупами. Мутирующие роуты дополнительно требуют скоуп `write`, а `/api/users` и `/api/tokens` по токену закрыты полностью.

**Tech Stack:** TypeScript, Express 4, `node:sqlite` (встроенный, Node ≥ 24), jest + supertest, Next.js 15 (страница `/users`).

## Global Constraints

- Node ≥ 24 (встроенный `node:sqlite`), TypeScript strict.
- Формат токена — `inv_<base64url(32 байта)>`; в БД только `sha256(token)`; значение показывается один раз.
- Схема БД дополняется через `CREATE TABLE IF NOT EXISTS` — механизма миграций у `AuthDb` нет и он не заводится.
- Комментарии в коде — русские, как в существующем `server/src/auth/*`.
- Тесты лежат рядом с исходниками (`*.test.ts`), запускаются `npm test -w server` и `npm test -w web`.
- Изменения в `web/lib/i18n/dict.ts` вносятся сразу в три языка: `uk`, `ru`, `en`.
- Существующее поведение cookie-сессий не меняется ни в одном сценарии.

---

### Task 1: Таблица `api_tokens` и методы `AuthDb`

**Files:**
- Modify: `shared/src/auth.ts` (добавить типы токенов)
- Modify: `server/src/auth/db.ts` (таблица + методы)
- Test: `server/src/auth/db.test.ts` (дописать describe-блок)

**Interfaces:**
- Consumes: `AuthDb`, `Role`, `PublicUser` (существуют).
- Produces: типы `TokenScope`, `PublicApiToken`, `TokenInfo`; методы `AuthDb.createToken`, `getToken`, `listTokens`, `deleteToken`, `touchToken`, `pruneExpiredTokens`.

- [ ] **Step 1: Написать типы в `shared/src/auth.ts`**

Дописать в конец файла:

```ts
/** Скоупы API-токенов: read — чтение, write — управляющие записи. */
export type TokenScope = "read" | "write";

/** Запись токена для admin-UI (без самого значения токена). */
export interface PublicApiToken {
  id: number;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

/** Ответ POST /api/tokens: значение токена отдаётся ровно один раз. */
export interface CreatedApiToken {
  ok: true;
  token: string;
  record: PublicApiToken;
}

/** Ответ GET /api/me. */
export interface MeResponse extends SessionUser {
  auth: "session" | "token";
  scopes: TokenScope[];
}
```

- [ ] **Step 2: Написать падающий тест на методы БД**

Дописать в конец `server/src/auth/db.test.ts` (файл уже создаёт `AuthDb` во временном каталоге — используй ту же обвязку, что в существующих тестах этого файла):

```ts
describe("AuthDb — api_tokens", () => {
  it("creates a token row and reads it back by hash", () => {
    const db = freshDb();
    const user = db.createUser("bot", "secret1", "admin", false, 1000);
    const rec = db.createToken("mcp laptop", "hash-1", "inv_abcd", user.id, ["read", "write"], 1000, null);

    expect(rec).toMatchObject({
      name: "mcp laptop",
      prefix: "inv_abcd",
      scopes: ["read", "write"],
      createdAt: 1000,
      lastUsedAt: null,
      expiresAt: null,
    });

    const info = db.getToken("hash-1");
    expect(info).toMatchObject({
      tokenId: rec.id,
      name: "mcp laptop",
      userId: user.id,
      username: "bot",
      role: "admin",
      mustChangePassword: false,
      scopes: ["read", "write"],
      expiresAt: null,
    });
    expect(db.getToken("nope")).toBeNull();
    db.close();
  });

  it("lists tokens, deletes them, and cascades on user deletion", () => {
    const db = freshDb();
    const user = db.createUser("bot", "secret1", "admin", false, 1000);
    const a = db.createToken("a", "hash-a", "inv_a", user.id, ["read"], 1000, null);
    db.createToken("b", "hash-b", "inv_b", user.id, ["read"], 2000, 9999);

    expect(db.listTokens().map((t) => t.name)).toEqual(["a", "b"]);

    db.deleteToken(a.id);
    expect(db.listTokens().map((t) => t.name)).toEqual(["b"]);

    db.deleteUser(user.id);
    expect(db.listTokens()).toEqual([]);
    db.close();
  });

  it("touches last_used_at and prunes expired tokens", () => {
    const db = freshDb();
    const user = db.createUser("bot", "secret1", "viewer", false, 1000);
    db.createToken("live", "hash-live", "inv_l", user.id, ["read"], 1000, null);
    db.createToken("dead", "hash-dead", "inv_d", user.id, ["read"], 1000, 5000);

    db.touchToken("hash-live", 7000);
    expect(db.getToken("hash-live")!.lastUsedAt).toBe(7000);

    db.pruneExpiredTokens(6000);
    expect(db.listTokens().map((t) => t.name)).toEqual(["live"]);
    db.close();
  });
});
```

Если в файле ещё нет хелпера `freshDb()`, добавь его рядом с существующей обвязкой:

```ts
function freshDb(): AuthDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "authdb-tokens-"));
  return new AuthDb(path.join(dir, "auth.db"));
}
```

- [ ] **Step 3: Запустить тест — убедиться, что падает**

Run: `npm test -w server -- src/auth/db.test.ts -t "api_tokens"`
Expected: FAIL — `db.createToken is not a function`.

- [ ] **Step 4: Реализовать таблицу и методы в `server/src/auth/db.ts`**

Импорт дополнить типами: `import type { Role, PublicUser, TokenScope, PublicApiToken } from "@inverter/shared";`

В конструкторе, внутри существующего `this.db.exec(\`…\`)`, дописать после блока `sessions`:

```sql
      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        prefix TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
```

Рядом с `SessionInfo` добавить тип и хелпер:

```ts
/** Строка api_tokens, соединённая с владельцем — то, что нужно middleware. */
export interface TokenInfo {
  tokenId: number;
  name: string;
  userId: number;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  scopes: TokenScope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

const parseScopes = (csv: string): TokenScope[] =>
  csv.split(",").map((s) => s.trim()).filter((s): s is TokenScope => s === "read" || s === "write");
```

Методы класса `AuthDb` (дописать перед `close()`):

```ts
  createToken(
    name: string,
    tokenHash: string,
    prefix: string,
    userId: number,
    scopes: TokenScope[],
    now: number,
    expiresAt: number | null
  ): PublicApiToken {
    const info = this.prep(
      `INSERT INTO api_tokens (name, token_hash, prefix, user_id, scopes, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(name, tokenHash, prefix, userId, scopes.join(","), now, expiresAt);
    return this.getTokenById(Number(info.lastInsertRowid))!;
  }

  getTokenById(id: number): PublicApiToken | null {
    const r = this.prep("SELECT * FROM api_tokens WHERE id = ?").get(id) as
      | { id: number; name: string; prefix: string; scopes: string; created_at: number; last_used_at: number | null; expires_at: number | null }
      | undefined;
    if (!r) return null;
    return {
      id: Number(r.id),
      name: r.name,
      prefix: r.prefix,
      scopes: parseScopes(r.scopes),
      createdAt: Number(r.created_at),
      lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
      expiresAt: r.expires_at === null ? null : Number(r.expires_at),
    };
  }

  /** Токен + владелец по sha256(token). Срок годности проверяет вызывающий (Auth). */
  getToken(tokenHash: string): TokenInfo | null {
    const r = this.prep(
      `SELECT t.id AS tokenId, t.name AS name, t.scopes AS scopes, t.created_at AS createdAt,
              t.last_used_at AS lastUsedAt, t.expires_at AS expiresAt,
              u.id AS userId, u.username AS username, u.role AS role, u.must_change_password AS mcp
       FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`
    ).get(tokenHash) as
      | {
          tokenId: number; name: string; scopes: string; createdAt: number;
          lastUsedAt: number | null; expiresAt: number | null;
          userId: number; username: string; role: Role; mcp: number;
        }
      | undefined;
    if (!r) return null;
    return {
      tokenId: Number(r.tokenId),
      name: r.name,
      userId: Number(r.userId),
      username: r.username,
      role: r.role,
      mustChangePassword: !!r.mcp,
      scopes: parseScopes(r.scopes),
      createdAt: Number(r.createdAt),
      lastUsedAt: r.lastUsedAt === null ? null : Number(r.lastUsedAt),
      expiresAt: r.expiresAt === null ? null : Number(r.expiresAt),
    };
  }

  listTokens(): PublicApiToken[] {
    const rows = this.prep("SELECT id FROM api_tokens ORDER BY id").all() as unknown as Array<{ id: number }>;
    return rows.map((r) => this.getTokenById(Number(r.id))!);
  }

  deleteToken(id: number): void {
    this.prep("DELETE FROM api_tokens WHERE id = ?").run(id);
  }

  touchToken(tokenHash: string, now: number): void {
    this.prep("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?").run(now, tokenHash);
  }

  pruneExpiredTokens(now: number): void {
    this.prep("DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
  }
```

- [ ] **Step 5: Запустить тесты — убедиться, что проходят**

Run: `npm test -w server -- src/auth/db.test.ts`
Expected: PASS (включая существующие тесты файла).

- [ ] **Step 6: Коммит**

```bash
git add shared/src/auth.ts server/src/auth/db.ts server/src/auth/db.test.ts
git commit -m "feat(auth): таблица api_tokens и методы AuthDb"
```

---

### Task 2: Выдача и проверка токенов в `Auth`

**Files:**
- Modify: `server/src/auth/service.ts`
- Test: `server/src/auth/tokens.test.ts` (создать)

**Interfaces:**
- Consumes: `AuthDb.createToken/getToken/listTokens/deleteToken/touchToken/pruneExpiredTokens`, `TokenInfo`, `TokenScope`, `PublicApiToken`.
- Produces: `Auth.issueToken(name, userId, scopes, expiresInDays?) → { token, record }`, `Auth.verifyToken(raw) → TokenInfo | null`, `Auth.listTokens()`, `Auth.revokeToken(id)`, экспорт `bearerFromHeader(header?) → string | null`.

- [ ] **Step 1: Написать падающий тест `server/src/auth/tokens.test.ts`**

```ts
import fs from "fs";
import os from "os";
import path from "path";
import { Auth, bearerFromHeader } from "./service";

function freshAuth(): { auth: Auth; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-tokens-"));
  return { auth: new Auth(dir, 30), dir };
}

describe("bearerFromHeader", () => {
  it("extracts the token from a Bearer header and ignores anything else", () => {
    expect(bearerFromHeader("Bearer inv_abc")).toBe("inv_abc");
    expect(bearerFromHeader("bearer inv_abc")).toBe("inv_abc");
    expect(bearerFromHeader("Basic inv_abc")).toBeNull();
    expect(bearerFromHeader(undefined)).toBeNull();
    expect(bearerFromHeader("Bearer   ")).toBeNull();
  });
});

describe("Auth — API tokens", () => {
  let auth: Auth;
  let dir: string;

  beforeEach(() => {
    ({ auth, dir } = freshAuth());
  });

  afterEach(() => {
    auth.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function adminId(): number {
    const u = auth.db.getByUsername("admin")!;
    auth.db.setPassword(u.id, "secret1", false, Date.now()); // снять форс смены пароля
    return u.id;
  }

  it("issues a token that verifies, carries scopes and is stored hashed", () => {
    const id = adminId();
    const { token, record } = auth.issueToken("laptop", id, ["read", "write"]);

    expect(token.startsWith("inv_")).toBe(true);
    expect(record.prefix).toBe(token.slice(0, 12));
    expect(record.scopes).toEqual(["read", "write"]);

    const info = auth.verifyToken(token)!;
    expect(info.username).toBe("admin");
    expect(info.role).toBe("admin");
    expect(info.scopes).toEqual(["read", "write"]);

    // в БД лежит хеш, а не значение
    expect(auth.db.getToken(token)).toBeNull();
  });

  it("rejects unknown, malformed and expired tokens", () => {
    const id = adminId();
    expect(auth.verifyToken(null)).toBeNull();
    expect(auth.verifyToken("garbage")).toBeNull();
    expect(auth.verifyToken("inv_nonexistent")).toBeNull();

    const { token } = auth.issueToken("short-lived", id, ["read"], -1); // истёк вчера
    expect(auth.verifyToken(token)).toBeNull();
  });

  it("rejects a token whose owner must change the password", () => {
    const u = auth.db.getByUsername("user")!; // сидируется с must_change_password = 1
    const { token } = auth.issueToken("viewer bot", u.id, ["read"]);
    expect(auth.verifyToken(token)).toBeNull();
  });

  it("updates last_used_at at most once a minute", () => {
    const id = adminId();
    const { token, record } = auth.issueToken("laptop", id, ["read"]);

    const t0 = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(t0);
    auth.verifyToken(token);
    const first = auth.db.getTokenById(record.id)!.lastUsedAt;
    expect(first).toBe(t0);

    jest.spyOn(Date, "now").mockReturnValue(t0 + 30_000); // < минуты — не трогаем
    auth.verifyToken(token);
    expect(auth.db.getTokenById(record.id)!.lastUsedAt).toBe(first);

    jest.spyOn(Date, "now").mockReturnValue(t0 + 61_000); // > минуты — обновляем
    auth.verifyToken(token);
    expect(auth.db.getTokenById(record.id)!.lastUsedAt).toBe(t0 + 61_000);

    jest.restoreAllMocks();
  });

  it("lists and revokes tokens", () => {
    const id = adminId();
    const { token } = auth.issueToken("a", id, ["read"]);
    auth.issueToken("b", id, ["read", "write"]);

    expect(auth.listTokens().map((t) => t.name)).toEqual(["a", "b"]);

    auth.revokeToken(auth.listTokens()[0].id);
    expect(auth.listTokens().map((t) => t.name)).toEqual(["b"]);
    expect(auth.verifyToken(token)).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w server -- src/auth/tokens.test.ts`
Expected: FAIL — `bearerFromHeader is not exported` / `auth.issueToken is not a function`.

- [ ] **Step 3: Реализовать в `server/src/auth/service.ts`**

Дополнить импорт: `import { AuthDb, SessionInfo, TokenInfo } from "./db";` и `import type { SessionUser, TokenScope, PublicApiToken } from "@inverter/shared";`

Рядом с существующими константами:

```ts
const TOKEN_PREFIX = "inv_";
/** Не чаще раза в минуту обновляем last_used_at — щадим SD-карту Pi. */
const TOUCH_INTERVAL_MS = 60_000;
```

Методы класса `Auth` (дописать после `changePassword`):

```ts
  /**
   * Выдать API-токен. Значение возвращается один раз — в БД только sha256.
   * `expiresInDays` не задан → бессрочный.
   */
  issueToken(
    name: string,
    userId: number,
    scopes: TokenScope[],
    expiresInDays?: number
  ): { token: string; record: PublicApiToken } {
    const clean = String(name ?? "").trim();
    if (!clean || clean.length > 64) throw new Error("Token name must be 1..64 characters");
    if (!scopes.length || scopes.some((s) => s !== "read" && s !== "write")) {
      throw new Error("scopes must be a non-empty subset of read, write");
    }
    if (!this.db.getById(userId)) throw new Error("User not found");

    const now = Date.now();
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
    const expiresAt =
      expiresInDays === undefined ? null : now + Math.trunc(expiresInDays) * 24 * 3600_000;
    this.db.pruneExpiredTokens(now);
    const record = this.db.createToken(
      clean,
      hashToken(token),
      token.slice(0, 12),
      userId,
      scopes,
      now,
      expiresAt
    );
    return { token, record };
  }

  /**
   * Проверить Bearer-токен. null — нет такого, истёк, либо владельцу навязана
   * смена пароля (иначе токен обходил бы форс). Побочно обновляет last_used_at.
   */
  verifyToken(raw: string | null): TokenInfo | null {
    if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null;
    const hash = hashToken(raw);
    const info = this.db.getToken(hash);
    if (!info) return null;
    const now = Date.now();
    if (info.expiresAt !== null && info.expiresAt <= now) return null;
    if (info.mustChangePassword) return null;
    if (info.lastUsedAt === null || now - info.lastUsedAt >= TOUCH_INTERVAL_MS) {
      this.db.touchToken(hash, now);
    }
    return info;
  }

  listTokens(): PublicApiToken[] {
    return this.db.listTokens();
  }

  revokeToken(id: number): void {
    this.db.deleteToken(id);
  }
```

Экспортируемая функция рядом с `tokenFromCookieHeader`:

```ts
/** Значение токена из заголовка "Authorization: Bearer <token>". */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `npm test -w server -- src/auth/tokens.test.ts`
Expected: PASS (5 тестов в двух describe).

- [ ] **Step 5: Коммит**

```bash
git add server/src/auth/service.ts server/src/auth/tokens.test.ts
git commit -m "feat(auth): выдача, проверка и отзыв API-токенов"
```

---

### Task 3: Bearer в middleware `/api`, `req.auth`, скоуп `write`

**Files:**
- Modify: `server/src/server.ts:23-27` (declare module), `:96-140` (middleware), `:105-108` (`/api/me`), роуты `control`/`lock`/`raw`/`baseline/recapture`
- Test: `server/src/server.http.test.ts` (дописать describe-блок)

**Interfaces:**
- Consumes: `Auth.verifyToken`, `bearerFromHeader`, `TokenScope`.
- Produces: `req.auth: { kind: "session" | "token"; scopes: TokenScope[]; tokenName?: string }`; `GET /api/me` отдаёт `MeResponse`; 403 с `code: "scope_required"` при нехватке скоупа.

- [ ] **Step 1: Написать падающий тест**

Дописать в `server/src/server.http.test.ts` внутри существующего `describe("server.ts (HTTP integration via supertest)")`:

```ts
  /** Выдать токен напрямую через Auth того же auth.db, который использует сервер. */
  function issue(scopes: Array<"read" | "write">, username = "admin"): string {
    const { Auth } = require("./auth/service") as typeof import("./auth/service");
    const a = new Auth(tmp, 30);
    const u = a.db.getByUsername(username)!;
    a.db.setPassword(u.id, "secret1", false, Date.now()); // снять форс смены пароля
    const { token } = a.issueToken(`test-${scopes.join("-")}`, u.id, scopes);
    a.db.close();
    return token;
  }

  describe("Bearer tokens", () => {
    it("accepts a valid token on read endpoints and reports auth kind in /api/me", async () => {
      const token = issue(["read"]);
      const res = await request(server).get("/api/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ username: "admin", role: "admin", auth: "token", scopes: ["read"] });

      const snap = await request(server).get("/api/snapshot").set("Authorization", `Bearer ${token}`);
      expect(snap.status).toBe(200);
    });

    it("reports session auth with full scopes for cookie logins", async () => {
      const cookie = await loginAsAdmin();
      const res = await request(server).get("/api/me").set("Cookie", cookie);
      expect(res.body).toMatchObject({ auth: "session", scopes: ["read", "write"] });
    });

    it("rejects a missing or bogus token with 401", async () => {
      expect((await request(server).get("/api/snapshot")).status).toBe(401);
      const res = await request(server).get("/api/snapshot").set("Authorization", "Bearer inv_nope");
      expect(res.status).toBe(401);
    });

    it("refuses writes for a read-only token but allows preview", async () => {
      const token = issue(["read"]);

      const lock = await request(server)
        .post("/api/lock")
        .set("Authorization", `Bearer ${token}`)
        .send({ locked: false });
      expect(lock.status).toBe(403);
      expect(lock.body.code).toBe("scope_required");

      const write = await request(server)
        .post("/api/control")
        .set("Authorization", `Bearer ${token}`)
        .send({ type: "chargerSourcePriority", value: 3 });
      expect(write.status).toBe(403);

      const preview = await request(server)
        .post("/api/control")
        .set("Authorization", `Bearer ${token}`)
        .send({ type: "chargerSourcePriority", value: 3, preview: true });
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ ok: true, preview: true, register: 331 });

      const rawRead = await request(server)
        .post("/api/raw")
        .set("Authorization", `Bearer ${token}`)
        .send({ command: "R 201 1" });
      expect(rawRead.status).toBe(200);

      const rawWrite = await request(server)
        .post("/api/raw")
        .set("Authorization", `Bearer ${token}`)
        .send({ command: "W 331 3" });
      expect(rawWrite.status).toBe(403);
      expect(rawWrite.body.code).toBe("scope_required");
    });

    it("allows writes for a write-scoped token once unlocked", async () => {
      const token = issue(["read", "write"]);
      const unlock = await request(server)
        .post("/api/lock")
        .set("Authorization", `Bearer ${token}`)
        .send({ locked: false });
      expect(unlock.status).toBe(200);
      expect(unlock.body.locked).toBe(false);
    });

    it("never lets a token reach user or token management", async () => {
      const token = issue(["read", "write"]);
      for (const path of ["/api/users", "/api/tokens"]) {
        const res = await request(server).get(path).set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("session_required");
      }
    });
  });
```

Если в файле ещё нет `loginAsAdmin()`, добавь рядом с существующим `loginAs`:

```ts
  async function loginAsAdmin(): Promise<string> {
    const cookie = await loginAs("admin", "admin");
    await request(server)
      .post("/api/change-password")
      .set("Cookie", cookie)
      .send({ currentPassword: "admin", newPassword: "secret1" });
    return cookie;
  }
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w server -- src/server.http.test.ts -t "Bearer tokens"`
Expected: FAIL — `/api/me` не содержит `auth`, Bearer даёт 401.

- [ ] **Step 3: Реализовать авторизацию по токену в `server/src/server.ts`**

Дополнить импорты:

```ts
import { Auth, tokenFromCookieHeader, bearerFromHeader } from "./auth/service";
import type { TokenScope } from "@inverter/shared";
```

Заменить блок `declare module` (строки 23–27) на:

```ts
/** Контекст авторизации запроса: сессия из UI или API-токен. */
export interface AuthContext {
  kind: "session" | "token";
  scopes: TokenScope[];
  tokenName?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionInfo & { tokenHash?: string };
    auth?: AuthContext;
  }
}
```

Заменить middleware зоны авторизации (строки 96–102) на:

```ts
  // Зона авторизации: cookie-сессия из UI либо API-токен (Authorization: Bearer).
  const SESSION_SCOPES: TokenScope[] = ["read", "write"];
  app.use("/api", (req, res, next) => {
    const s = auth.verify(reqToken(req));
    if (s) {
      req.user = s;
      req.auth = { kind: "session", scopes: SESSION_SCOPES };
      return next();
    }
    const t = auth.verifyToken(bearerFromHeader(req.headers.authorization));
    if (t) {
      req.user = {
        userId: t.userId,
        username: t.username,
        role: t.role,
        mustChangePassword: false, // verifyToken уже отсёк владельцев под форсом
        expiresAt: t.expiresAt ?? Number.MAX_SAFE_INTEGER,
      };
      req.auth = { kind: "token", scopes: t.scopes, tokenName: t.name };
      return next();
    }
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  });
```

Обновить `/api/me`:

```ts
  app.get("/api/me", (req, res) => {
    const u = req.user!;
    res.json({
      username: u.username,
      role: u.role,
      mustChangePassword: u.mustChangePassword,
      auth: req.auth!.kind,
      scopes: req.auth!.scopes,
    });
  });
```

Сразу после admin-only зоны (после блока со строкой 132–140) добавить запрет токенов на управление доступами и хелпер скоупа:

```ts
  // Управление пользователями и токенами — только из UI-сессии, никогда по токену.
  app.use(["/api/users", "/api/tokens"], (req, res, next) => {
    if (req.auth?.kind === "token") {
      return res
        .status(403)
        .json({ ok: false, code: "session_required", error: "Not available for API tokens" });
    }
    next();
  });

  /** Скоуп write обязателен для токенов; cookie-сессия из UI им обладает всегда. */
  const denyWithoutWrite = (req: express.Request, res: express.Response): boolean => {
    if (req.auth?.kind === "token" && !req.auth.scopes.includes("write")) {
      res.status(403).json({ ok: false, code: "scope_required", error: "Token lacks the 'write' scope" });
      return true;
    }
    return false;
  };
```

В роуте `POST /api/control` — проверка перед выполнением (preview проходит без скоупа, это чтение):

```ts
  app.post("/api/control", async (req, res) => {
    try {
      const { type, value, preview } = req.body ?? {};
      if (!CONTROL_TYPES.includes(type)) {
        return res.status(400).json({ ok: false, error: `Unknown control type: ${type}` });
      }
      const numValue = Number(value);
      if (!Number.isFinite(numValue)) {
        return res.status(400).json({ ok: false, error: "value must be a number" });
      }
      if (preview === true) {
        return res.json({ ok: true, preview: true, ...(await inverter.previewControl(type as ControlType, numValue)) });
      }
      if (denyWithoutWrite(req, res)) return;
      const result = await inverter.control(type as ControlType, numValue);
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });
```

В `POST /api/lock` и `POST /api/baseline/recapture` — первой строкой тела `try`: `if (denyWithoutWrite(req, res)) return;`

В `POST /api/raw` — только для команд записи:

```ts
      if (/^\s*W/i.test(command) && denyWithoutWrite(req, res)) return;
```

(поставить сразу после проверки `typeof command !== "string"`).

- [ ] **Step 4: Реализовать `Inverter.previewControl`**

В `server/src/inverter.ts` дописать метод рядом с `control()`:

```ts
  /**
   * Что будет записано командой control() — без записи. Доступно и при
   * включённой блокировке: это чтение.
   */
  async previewControl(
    type: ControlType,
    value: number
  ): Promise<{ register: number; rawValue: number; label: string; currentValue: number | null; baselineValue: number | null }> {
    const w = buildControlWrite(type, value);
    let currentValue: number | null = null;
    try {
      const regs = await this.readBlock(w.register, 1);
      currentValue = regs.get(w.register) ?? null;
    } catch {
      /* связи нет — отдаём то, что знаем */
    }
    const base = this.baseline?.info as Record<string, number> | undefined;
    return {
      register: w.register,
      rawValue: w.rawValue,
      label: w.label,
      currentValue,
      baselineValue: base && typeof base[type] === "number" ? base[type] : null,
    };
  }
```

Если поле baseline в классе называется иначе — используй существующее приватное поле, которое возвращает `getBaseline()`.

- [ ] **Step 5: Запустить тесты**

Run: `npm test -w server -- src/server.http.test.ts`
Expected: PASS — новые тесты и все существующие (сессионные сценарии не менялись).

- [ ] **Step 6: Коммит**

```bash
git add server/src/server.ts server/src/inverter.ts server/src/server.http.test.ts
git commit -m "feat(api): авторизация по Bearer-токену, скоуп write и preview для control"
```

---

### Task 4: Эндпоинты `/api/tokens`

**Files:**
- Modify: `server/src/server.ts` (роуты + admin-зона)
- Test: `server/src/server.http.test.ts` (дописать describe-блок)

**Interfaces:**
- Consumes: `Auth.issueToken/listTokens/revokeToken`, `denyWithoutWrite` не нужен (только сессия).
- Produces: `GET /api/tokens` → `PublicApiToken[]`; `POST /api/tokens` → `CreatedApiToken`; `DELETE /api/tokens/:id` → `{ ok: true }`.

- [ ] **Step 1: Написать падающий тест**

```ts
  describe("/api/tokens", () => {
    it("creates, lists and revokes tokens from an admin session", async () => {
      const cookie = await loginAsAdmin();

      const created = await request(server)
        .post("/api/tokens")
        .set("Cookie", cookie)
        .send({ name: "mcp", scopes: ["read", "write"], expiresInDays: 30 });
      expect(created.status).toBe(200);
      expect(created.body.token).toMatch(/^inv_/);
      expect(created.body.record).toMatchObject({ name: "mcp", scopes: ["read", "write"] });
      expect(created.body.record.expiresAt).toBeGreaterThan(Date.now());

      const list = await request(server).get("/api/tokens").set("Cookie", cookie);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].token).toBeUndefined(); // значение не хранится и не отдаётся
      expect(list.body[0].prefix).toBe(created.body.token.slice(0, 12));

      const del = await request(server)
        .delete(`/api/tokens/${created.body.record.id}`)
        .set("Cookie", cookie);
      expect(del.status).toBe(200);
      expect((await request(server).get("/api/tokens").set("Cookie", cookie)).body).toEqual([]);

      // отозванный токен больше не работает
      const after = await request(server)
        .get("/api/snapshot")
        .set("Authorization", `Bearer ${created.body.token}`);
      expect(after.status).toBe(401);
    });

    it("validates the payload", async () => {
      const cookie = await loginAsAdmin();
      const noName = await request(server).post("/api/tokens").set("Cookie", cookie).send({ scopes: ["read"] });
      expect(noName.status).toBe(400);

      const badScope = await request(server)
        .post("/api/tokens")
        .set("Cookie", cookie)
        .send({ name: "x", scopes: ["admin"] });
      expect(badScope.status).toBe(400);
    });

    it("is admin-only", async () => {
      const cookie = await loginAs("user", "user");
      await request(server)
        .post("/api/change-password")
        .set("Cookie", cookie)
        .send({ currentPassword: "user", newPassword: "secret1" });
      const res = await request(server).get("/api/tokens").set("Cookie", cookie);
      expect(res.status).toBe(403);
    });
  });
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w server -- src/server.http.test.ts -t "/api/tokens"`
Expected: FAIL — 404 на несуществующих роутах.

- [ ] **Step 3: Добавить `/api/tokens` в admin-зону**

В `server/src/server.ts` в списке путей admin-only middleware (строка 133) добавить `"/api/tokens"`:

```ts
    ["/api/control", "/api/lock", "/api/raw", "/api/baseline", "/api/baseline/recapture", "/api/users", "/api/tokens"],
```

- [ ] **Step 4: Реализовать роуты**

Дописать после блока роутов `/api/users`:

```ts
  app.get("/api/tokens", (_req, res) => {
    res.json(auth.listTokens());
  });

  app.post("/api/tokens", (req, res) => {
    try {
      const { name, scopes, expiresInDays } = req.body ?? {};
      if (!Array.isArray(scopes)) {
        return res.status(400).json({ ok: false, error: "scopes must be an array" });
      }
      const days =
        expiresInDays === undefined || expiresInDays === null ? undefined : Number(expiresInDays);
      if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
        return res.status(400).json({ ok: false, error: "expiresInDays must be a positive number" });
      }
      const { token, record } = auth.issueToken(String(name ?? ""), req.user!.userId, scopes, days);
      res.json({ ok: true, token, record });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.delete("/api/tokens/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad id" });
    auth.revokeToken(id);
    res.json({ ok: true });
  });
```

- [ ] **Step 5: Запустить тесты**

Run: `npm test -w server -- src/server.http.test.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add server/src/server.ts server/src/server.http.test.ts
git commit -m "feat(api): эндпоинты выдачи, списка и отзыва API-токенов"
```

---

### Task 5: Bearer в WebSocket-рукопожатии

**Files:**
- Modify: `server/src/server.ts:439-446` (обработчик `wss.on("connection")`)
- Test: `server/src/server.http.test.ts` (дописать в существующий блок про WS)

**Interfaces:**
- Consumes: `Auth.verifyToken`, `bearerFromHeader`.
- Produces: WS-подключение принимается при валидном `Authorization: Bearer`.

- [ ] **Step 1: Написать падающий тест**

```ts
  it("accepts a WebSocket handshake authorized by a Bearer token", async () => {
    const token = issue(["read"]);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as import("net").AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const first = await new Promise<string>((resolve, reject) => {
      ws.on("message", (d) => resolve(String(d)));
      ws.on("close", (code) => reject(new Error(`closed ${code}`)));
      ws.on("error", reject);
    });
    expect(JSON.parse(first).type).toBe("snapshot");
    ws.close();
  });

  it("rejects a WebSocket handshake with a bogus Bearer token", async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as import("net").AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: "Bearer inv_nope" },
    });
    const code = await new Promise<number>((resolve, reject) => {
      ws.on("close", resolve);
      ws.on("error", reject);
    });
    expect(code).toBe(4401);
  });
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm test -w server -- src/server.http.test.ts -t "WebSocket handshake authorized"`
Expected: FAIL — соединение закрывается с 4401.

- [ ] **Step 3: Реализовать**

Заменить тело `wss.on("connection", …)`:

```ts
  wss.on("connection", (ws, req) => {
    const s = auth.verify(tokenFromCookieHeader(req.headers.cookie));
    const authorized =
      (s && !s.mustChangePassword) || !!auth.verifyToken(bearerFromHeader(req.headers.authorization));
    if (!authorized) {
      ws.close(4401, "Unauthorized");
      return;
    }
    ws.send(JSON.stringify({ type: "snapshot", data: inverter.getSnapshot() }));
  });
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test -w server -- src/server.http.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add server/src/server.ts server/src/server.http.test.ts
git commit -m "feat(ws): авторизация WebSocket по Bearer-токену"
```

---

### Task 6: CLI-скрипт выдачи токена

**Files:**
- Create: `server/scripts/issue-token.ts`

**Interfaces:**
- Consumes: `Auth` из `../src/auth/service`.
- Produces: команда `DATA_DIR=data npx tsx scripts/issue-token.ts <name> [--write] [--days N] [--user admin]`.

- [ ] **Step 1: Написать скрипт**

```ts
import { Auth } from "../src/auth/service";
import type { TokenScope } from "@inverter/shared";

/**
 * Выдача API-токена из CLI (первый токен для MCP, когда UI ещё не под рукой).
 * Usage: DATA_DIR=data npx tsx scripts/issue-token.ts <name> [--write] [--days N] [--user admin]
 * Значение токена печатается один раз — в БД хранится только его sha256.
 */
function main(): void {
  const argv = process.argv.slice(2);
  const name = argv.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error("Usage: npx tsx scripts/issue-token.ts <name> [--write] [--days N] [--user admin]");
    process.exit(1);
  }
  const scopes: TokenScope[] = argv.includes("--write") ? ["read", "write"] : ["read"];
  const daysArg = argv.indexOf("--days");
  const days = daysArg === -1 ? undefined : Number(argv[daysArg + 1]);
  if (daysArg !== -1 && (!Number.isFinite(days) || (days as number) <= 0)) {
    console.error("--days expects a positive number");
    process.exit(1);
  }
  const userArg = argv.indexOf("--user");
  const username = userArg === -1 ? "admin" : String(argv[userArg + 1] ?? "");

  const auth = new Auth(process.env.DATA_DIR || "data", 30);
  const user = auth.db.getByUsername(username.trim().toLowerCase());
  if (!user) {
    console.error(`User not found: ${username}`);
    process.exit(1);
  }
  if (user.must_change_password) {
    console.error(
      `User ${user.username} must change the password first — tokens of such users are rejected.`
    );
    process.exit(1);
  }
  const { token, record } = auth.issueToken(name, user.id, scopes, days);
  auth.db.close();

  console.log(`Token "${record.name}" for ${user.username} (${scopes.join(", ")}):`);
  console.log(token);
  console.log(record.expiresAt ? `Expires: ${new Date(record.expiresAt).toISOString()}` : "Never expires.");
  console.log("Store it now — it is not recoverable.");
}

main();
```

- [ ] **Step 2: Проверить вручную на временном каталоге**

```bash
cd server
DATA_DIR=$(mktemp -d) npx tsx scripts/issue-token.ts smoke --write --days 7
```
Expected: печатается `inv_…`, строка `Expires: …`. (Свежая БД сидирует admin с `must_change_password=1`, поэтому скрипт откажет — это ожидаемое поведение; для проверки успешного пути используй каталог, где пароль admin уже сменён, либо временно сбрось форс через `scripts/reset-password.ts` и повторный логин.)

- [ ] **Step 3: Коммит**

```bash
git add server/scripts/issue-token.ts
git commit -m "feat(cli): скрипт выдачи API-токена"
```

---

### Task 7: Секция «API-токены» на странице `/users`

**Files:**
- Create: `web/components/TokensPanel.tsx`
- Modify: `web/app/(app)/users/page.tsx` (подключить панель), `web/lib/i18n/dict.ts` (ключи для uk/ru/en)
- Test: `web/components/TokensPanel.test.tsx`

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/tokens`, типы `PublicApiToken`, `TokenScope`, хелперы `getJson`/`postJson`, хук `useT`, `useToast`.
- Produces: React-компонент `TokensPanel` (default export отсутствует — именованный экспорт `TokensPanel`).

- [ ] **Step 1: Добавить ключи в `web/lib/i18n/dict.ts`**

В объект `uk` (рядом с блоком `users*`, строки 82–91):

```ts
  tokensTitle: "API-токени",
  tokensName: "Назва",
  tokensAdd: "Створити токен",
  tokensScopes: "Права",
  tokensScopeRead: "Тільки читання",
  tokensScopeWrite: "Читання та запис",
  tokensDays: "Днів дії (порожньо — безстроково)",
  tokensCreated: "Створено",
  tokensLastUsed: "Востаннє",
  tokensNeverUsed: "не використовувався",
  tokensExpires: "Діє до",
  tokensNever: "безстроково",
  tokensRevoke: "Відкликати",
  tokensConfirmRevoke: "Відкликати токен?",
  tokensCopyHint: "Скопіюй значення зараз — воно більше не буде показане:",
  tokensEmpty: "Токенів ще немає",
```

В `ru`:

```ts
  tokensTitle: "API-токены",
  tokensName: "Название",
  tokensAdd: "Создать токен",
  tokensScopes: "Права",
  tokensScopeRead: "Только чтение",
  tokensScopeWrite: "Чтение и запись",
  tokensDays: "Дней действия (пусто — бессрочно)",
  tokensCreated: "Создан",
  tokensLastUsed: "Последний раз",
  tokensNeverUsed: "не использовался",
  tokensExpires: "Действует до",
  tokensNever: "бессрочно",
  tokensRevoke: "Отозвать",
  tokensConfirmRevoke: "Отозвать токен?",
  tokensCopyHint: "Скопируй значение сейчас — больше оно не будет показано:",
  tokensEmpty: "Токенов пока нет",
```

В `en`:

```ts
  tokensTitle: "API tokens",
  tokensName: "Name",
  tokensAdd: "Create token",
  tokensScopes: "Scopes",
  tokensScopeRead: "Read only",
  tokensScopeWrite: "Read and write",
  tokensDays: "Valid for, days (empty = forever)",
  tokensCreated: "Created",
  tokensLastUsed: "Last used",
  tokensNeverUsed: "never used",
  tokensExpires: "Expires",
  tokensNever: "never",
  tokensRevoke: "Revoke",
  tokensConfirmRevoke: "Revoke this token?",
  tokensCopyHint: "Copy the value now — it will not be shown again:",
  tokensEmpty: "No tokens yet",
```

- [ ] **Step 2: Написать падающий тест `web/components/TokensPanel.test.tsx`**

```tsx
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PublicApiToken } from "@inverter/shared";
import { renderWithProviders, restoreLocation } from "@/test-utils/renderWithProviders";
import { DICTS } from "@/lib/i18n/dict";
import { TokensPanel } from "./TokensPanel";

const t = DICTS.uk;

const TOKENS: PublicApiToken[] = [
  { id: 1, name: "mcp", prefix: "inv_abcdefgh", scopes: ["read", "write"], createdAt: 1_700_000_000_000, lastUsedAt: null, expiresAt: null },
];

function jsonOk(body: unknown) {
  return { ok: true, json: async () => body };
}

let confirmSpy: jest.SpyInstance;

beforeEach(() => {
  confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  restoreLocation();
  confirmSpy.mockRestore();
});

async function render(fetchImpl: jest.Mock) {
  global.fetch = fetchImpl as unknown as typeof fetch;
  return renderWithProviders(<TokensPanel />, { withSnapshot: false, withMeta: false });
}

describe("TokensPanel", () => {
  it("lists tokens with prefix, scopes and 'never used' marker", async () => {
    await render(jest.fn().mockResolvedValue(jsonOk(TOKENS)));

    expect(await screen.findByText("mcp")).toBeInTheDocument();
    expect(screen.getByText("inv_abcdefgh")).toBeInTheDocument();
    expect(screen.getByText(t.tokensNeverUsed)).toBeInTheDocument();
    expect(screen.getByText(t.tokensNever)).toBeInTheDocument();
  });

  it("shows the created token value exactly once", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonOk([]))                                            // первичная загрузка
      .mockResolvedValueOnce(jsonOk({ ok: true, token: "inv_secret", record: TOKENS[0] })) // POST
      .mockResolvedValueOnce(jsonOk(TOKENS));                                       // перезагрузка списка
    await render(fetchMock);

    await screen.findByText(t.tokensEmpty);
    await userEvent.type(screen.getByPlaceholderText(t.tokensName), "mcp");
    await userEvent.click(screen.getByRole("button", { name: t.tokensAdd }));

    expect(await screen.findByText("inv_secret")).toBeInTheDocument();
    expect(screen.getByText(t.tokensCopyHint)).toBeInTheDocument();

    const [, postCall] = fetchMock.mock.calls;
    expect(postCall[0]).toBe("/api/tokens");
    expect(JSON.parse(postCall[1].body)).toMatchObject({ name: "mcp", scopes: ["read"] });
  });

  it("revokes a token after confirmation", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonOk(TOKENS))
      .mockResolvedValueOnce(jsonOk({ ok: true }))
      .mockResolvedValueOnce(jsonOk([]));
    await render(fetchMock);

    const row = (await screen.findByText("mcp")).closest<HTMLElement>(".token-card")!;
    await userEvent.click(within(row).getByRole("button", { name: t.tokensRevoke }));

    await waitFor(() => expect(fetchMock.mock.calls[1][0]).toBe("/api/tokens/1"));
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
    expect(await screen.findByText(t.tokensEmpty)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Запустить тест — убедиться, что падает**

Run: `npm test -w web -- components/TokensPanel.test.tsx`
Expected: FAIL — модуль `./TokensPanel` не найден.

- [ ] **Step 4: Реализовать `web/components/TokensPanel.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicApiToken, TokenScope } from "@inverter/shared";
import { getJson, postJson } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useToast } from "@/lib/toast";

/** Секция управления API-токенами на странице /users (только admin). */
export function TokensPanel() {
  const t = useT();
  const { toast } = useToast();
  const [tokens, setTokens] = useState<PublicApiToken[]>([]);
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState("");
  const [issued, setIssued] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setTokens(await getJson<PublicApiToken[]>("/api/tokens"));
    } catch (e) {
      toast((e as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    reload();
  }, [reload]);

  const create = async () => {
    try {
      const scopes: TokenScope[] = write ? ["read", "write"] : ["read"];
      const body: { name: string; scopes: TokenScope[]; expiresInDays?: number } = { name, scopes };
      if (days.trim()) body.expiresInDays = Number(days);
      const data = await (await postJson("/api/tokens", body)).json();
      if (!data.ok) return toast(data.error || t.toastError);
      setIssued(data.token);
      setName("");
      setDays("");
      setWrite(false);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const revoke = async (tok: PublicApiToken) => {
    if (!window.confirm(t.tokensConfirmRevoke + " " + tok.name)) return;
    try {
      const res = await fetch(`/api/tokens/${tok.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) return toast(data.error || t.toastError);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const stamp = (ms: number | null, fallback: string) =>
    ms === null ? fallback : new Date(ms).toLocaleString(t.langLocale);

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">{t.tokensTitle}</span>
      </div>

      {issued ? (
        <div className="token-issued">
          <p className="note">{t.tokensCopyHint}</p>
          <code>{issued}</code>
        </div>
      ) : null}

      <div className="tokens-list">
        {tokens.length === 0 ? (
          <p className="note">{t.tokensEmpty}</p>
        ) : (
          tokens.map((tok) => (
            <div className="token-card" key={tok.id}>
              <div className="token-card-head">
                <span className="token-name">{tok.name}</span>
                <code className="token-prefix">{tok.prefix}</code>
              </div>
              <div className="token-meta">
                <span>{tok.scopes.includes("write") ? t.tokensScopeWrite : t.tokensScopeRead}</span>
                <span>{t.tokensCreated}: {stamp(tok.createdAt, "—")}</span>
                <span>{t.tokensLastUsed}: {stamp(tok.lastUsedAt, t.tokensNeverUsed)}</span>
                <span>{t.tokensExpires}: {stamp(tok.expiresAt, t.tokensNever)}</span>
              </div>
              <div className="token-card-actions">
                <button className="btn-danger" onClick={() => revoke(tok)}>{t.tokensRevoke}</button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="tokens-add">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.tokensName} />
        <input
          value={days}
          onChange={(e) => setDays(e.target.value)}
          placeholder={t.tokensDays}
          inputMode="numeric"
        />
        <label className="token-scope">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
          <span>{t.tokensScopeWrite}</span>
        </label>
        <button className="apply" onClick={create}>{t.tokensAdd}</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Подключить панель на странице `/users`**

В `web/app/(app)/users/page.tsx` добавить импорт `import { TokensPanel } from "@/components/TokensPanel";` и вставить `<TokensPanel />` последним элементом внутри `<main className="grid">`, после секции добавления пользователя.

- [ ] **Step 6: Запустить тесты и типизацию**

Run: `npm test -w web -- components/TokensPanel.test.tsx app/\(app\)/users` затем `npm run typecheck -w web`
Expected: PASS обоих.

- [ ] **Step 7: Стили**

В общий css (тот же файл, где живут `.user-card`/`.users-add` — найди его через `grep -rn "users-add" web/`) добавить правила по образцу пользовательских карточек:

```css
.token-card { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; }
.token-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.token-name { font-weight: 600; }
.token-prefix { opacity: .7; }
.token-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: .85em; opacity: .8; }
.token-card-actions { display: flex; justify-content: flex-end; }
.tokens-list { display: flex; flex-direction: column; gap: 8px; }
.tokens-add { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
.token-issued code { display: block; word-break: break-all; padding: 8px; border-radius: 8px; background: var(--bg-2, rgba(127,127,127,.12)); }
.token-scope { display: flex; align-items: center; gap: 6px; }
```

Если имена CSS-переменных в проекте другие — используй существующие (посмотри соседние правила в том же файле).

- [ ] **Step 8: Коммит**

```bash
git add web/components/TokensPanel.tsx web/components/TokensPanel.test.tsx web/app/\(app\)/users/page.tsx web/lib/i18n/dict.ts web/app/globals.css
git commit -m "feat(web): управление API-токенами на странице пользователей"
```

---

### Task 8: Документация токенов

**Files:**
- Modify: `README.md` (раздел «Authentication»), `server/.env.example` (ничего не добавляется — проверить и убедиться), `CLAUDE.md` (раздел «Авторизация»)

**Interfaces:**
- Consumes: поведение из задач 1–7.
- Produces: описание токенов для пользователя и для Claude Code.

- [ ] **Step 1: Дописать в README раздел про токены**

Внутри `### 🔑 Authentication` после списка про роли добавить:

```markdown
**API tokens.** Machine clients (the MCP server, scripts) authenticate with
`Authorization: Bearer inv_…` instead of a session cookie. An admin issues them on the
**Users** page or from the Pi:

```bash
cd server && DATA_DIR=data npx tsx scripts/issue-token.ts "mcp laptop" --write --days 90
```

A token inherits its owner's role and carries scopes: `read` (everything the role may
read) and optionally `write` (control, lock, raw writes, baseline recapture). Tokens are
stored as sha256 — the value is shown exactly once. Tokens can never reach `/api/users`
or `/api/tokens`: managing access requires a UI session.
```

- [ ] **Step 2: Дописать в CLAUDE.md**

В раздел «Авторизация (`server/src/auth/`)» добавить пункт:

```markdown
- **API-токены** (`api_tokens` в `auth.db`): `Authorization: Bearer inv_…`, sha256 в БД,
  скоупы `read`/`write`. Middleware `/api` пробует cookie, затем Bearer; `req.auth`
  несёт `kind`/`scopes`. Мутирующие роуты требуют скоуп `write` (кроме
  `POST /api/control` с `preview: true` — это чтение). `/api/users` и `/api/tokens` по
  токену закрыты. Токен владельца под форсом смены пароля отклоняется.
```

- [ ] **Step 3: Прогнать полный набор проверок**

Run: `npm run check` (из корня — jest сервера и typecheck веба), затем `npm test -w web`
Expected: PASS всё.

- [ ] **Step 4: Коммит**

```bash
git add README.md CLAUDE.md
git commit -m "docs: API-токены в README и CLAUDE.md"
```
