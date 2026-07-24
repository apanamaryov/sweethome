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
