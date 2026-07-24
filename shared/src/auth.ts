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
