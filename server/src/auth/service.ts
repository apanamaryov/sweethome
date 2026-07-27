import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { SessionUser, TokenScope, PublicApiToken } from "@inverter/shared";
import { AuthDb, SessionInfo, TokenInfo } from "./db";
import { verifyPassword, validatePassword } from "./hash";

/**
 * Сессионная авторизация с пользователями и ролями (см. auth/db.ts).
 * - Пароли — scrypt в auth.db; сессии — sha256(token) в auth.db.
 * - Анти-brute-force: 5 неверных попыток с одного IP → блок на 10 минут.
 * - TLS обеспечивает reverse proxy (Caddy на Pi).
 */

const COOKIE_NAME = "inv_session";
const TOKEN_PREFIX = "inv_";
/** Не чаще раза в минуту обновляем last_used_at — щадим SD-карту Pi. */
const TOUCH_INTERVAL_MS = 60_000;
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

  cookie(token: string, secure: boolean): string {
    const base = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.ttlMs / 1000)}`;
    return secure ? `${base}; Secure` : base;
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

/** Значение токена из заголовка "Authorization: Bearer <token>". */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
