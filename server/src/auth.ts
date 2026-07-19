import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Минимальная сессионная авторизация для веб-интерфейса/API.
 *
 * - Один пароль на приложение (AUTH_PASSWORD); пусто = авторизация выключена.
 * - Успешный вход выдаёт случайный токен в HttpOnly-cookie; на диске хранится
 *   только SHA-256 токена (data/sessions.json), так что утечка файла не даёт
 *   готовых cookie.
 * - Анти-brute-force: после 5 неверных паролей с одного IP — блок на 10 минут.
 * - Для доступа извне НАСТОЯТЕЛЬНО рекомендуется TLS (reverse proxy), иначе
 *   пароль и cookie ходят открытым текстом.
 */

const COOKIE_NAME = "inv_session";
const MAX_SESSIONS = 20; // максимум одновременных устройств; старые вытесняются
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const LOCK_MS = 10 * 60_000;

interface FailState {
  count: number;
  first: number;
  lockedUntil: number;
}

export class Auth {
  readonly enabled: boolean;
  private passwordHash: Buffer | null;
  private ttlMs: number;
  private file: string;
  private sessions = new Map<string, number>(); // sha256(token) -> expiry (ms)
  private fails = new Map<string, FailState>();

  constructor(dataDir: string, password: string | null, ttlDays: number) {
    this.enabled = !!password;
    this.passwordHash = password ? sha256(password) : null;
    this.ttlMs = Math.max(1, ttlDays) * 24 * 3600_000;
    this.file = path.join(dataDir, "sessions.json");
    if (this.enabled) this.load();
  }

  private load(): void {
    try {
      const obj = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, number>;
      const now = Date.now();
      for (const [h, exp] of Object.entries(obj)) {
        if (typeof exp === "number" && exp > now) this.sessions.set(h, exp);
      }
    } catch {
      /* файла ещё нет — ок */
    }
  }

  private save(): void {
    try {
      const obj: Record<string, number> = {};
      for (const [h, exp] of this.sessions) obj[h] = exp;
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error("[inverter-monitor] failed to persist sessions:", (e as Error).message);
    }
  }

  /**
   * Проверить пароль и создать сессию.
   * Возвращает токен, null при неверном пароле; бросает Error с code=429 при
   * блокировке по IP.
   */
  login(password: string, ip: string): string | null {
    if (!this.enabled || !this.passwordHash) throw new Error("Auth is disabled");
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

    if (!crypto.timingSafeEqual(sha256(password), this.passwordHash)) {
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
    this.sessions.set(hashToken(token), now + this.ttlMs);
    this.prune();
    this.save();
    return token;
  }

  private prune(): void {
    const now = Date.now();
    for (const [h, exp] of this.sessions) {
      if (exp <= now) this.sessions.delete(h);
    }
    while (this.sessions.size > MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestExp = Infinity;
      for (const [h, exp] of this.sessions) {
        if (exp < oldestExp) {
          oldestExp = exp;
          oldestKey = h;
        }
      }
      if (!oldestKey) break;
      this.sessions.delete(oldestKey);
    }
  }

  /** true, если токен валиден (или авторизация выключена целиком). */
  verifyToken(token: string | null): boolean {
    if (!this.enabled) return true;
    if (!token) return false;
    const exp = this.sessions.get(hashToken(token));
    return exp !== undefined && exp > Date.now();
  }

  logout(token: string | null): void {
    if (!token) return;
    if (this.sessions.delete(hashToken(token))) this.save();
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

function sha256(s: string): Buffer {
  return crypto.createHash("sha256").update(s).digest();
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
