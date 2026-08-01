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

/** Уровень доступа эндпоинта/страницы. */
export type Access = "public" | "auth" | "admin";

/** Разрешён ли доступ роли `role` (null = нет сессии) к зоне `required`. */
export function canAccess(role: Role | null, required: Access): boolean {
  if (required === "public") return true;
  if (role === null) return false;
  if (required === "auth") return true;
  return role === "admin";
}
