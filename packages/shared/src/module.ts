import type { Application, Request, RequestHandler, Response, Router } from "express";
import type { WebSocket } from "ws";
import { canAccess } from "./auth";
import type { Role, TokenScope } from "./auth";

/** Контекст авторизации запроса: сессия из UI или API-токен. */
export interface AuthContext {
  kind: "session" | "token";
  scopes: TokenScope[];
  tokenName?: string;
}

/** Личность запроса — форма SessionInfo из auth-БД хоста. */
export interface RequestIdentity {
  userId: number;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  expiresAt: number;
  tokenHash?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: RequestIdentity;
    auth?: AuthContext;
  }
}

export interface ModuleHealth {
  ok: boolean;
  details?: Record<string, unknown>;
}

/** Контракт подсистемы дома. Хост монтирует apiRouter на /api/<id> и ws на /ws/<id>. */
export interface HomeModule {
  id: string;
  apiRouter: Router;
  ws?: { onConnection(ws: WebSocket): void };
  /** Спец-маршруты вне /api/<id> (например /mcp у инвертора); ctx.authenticate — общий гейт хоста. */
  attachHttp?(app: Application, ctx: { authenticate: RequestHandler }): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): ModuleHealth;
}

/** Кто именно пишет — попадает в журнал событий (тип `control`). */
export const writeSource = (req: Request): string =>
  req.auth?.kind === "token" ? `token:${req.auth.tokenName ?? "?"}` : `ui:${req.user?.username ?? "?"}`;

/** Скоуп write обязателен для токенов; cookie-сессия из UI им обладает всегда. */
export const denyWithoutWrite = (req: Request, res: Response): boolean => {
  if (req.auth?.kind === "token" && !req.auth.scopes.includes("write")) {
    res.status(403).json({ ok: false, code: "scope_required", error: "Token lacks the 'write' scope" });
    return true;
  }
  return false;
};

/** Гейт admin-роли для модульных маршрутов. */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!canAccess(req.user?.role ?? null, "admin")) {
    return res.status(403).json({ ok: false, code: "forbidden", error: "Admins only" });
  }
  next();
};
