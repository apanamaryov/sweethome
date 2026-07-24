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
