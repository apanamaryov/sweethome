import { DatabaseSync, StatementSync } from "node:sqlite";
import type { Role, PublicUser, TokenScope, PublicApiToken } from "@sweethome/inverter-shared";
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

  // ---- API-токены (Bearer) ----

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
      | {
          id: number; name: string; prefix: string; scopes: string;
          created_at: number; last_used_at: number | null; expires_at: number | null;
        }
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

  close(): void {
    this.db.close();
  }
}
