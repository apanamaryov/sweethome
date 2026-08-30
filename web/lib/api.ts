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

/** JSON-запрос любым методом. 401 → /login; 403 must_change → /change-password. Не-2xx НЕ бросает — решает вызывающий. */
export async function sendJson(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("Unauthorized");
  }
  if (await redirectIfMustChange(res)) throw new Error("Password change required");
  return res;
}

export function wsUrl(module: string): string {
  if (process.env.NODE_ENV === "development") return `ws://localhost:3000/ws/${module}`;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/${module}`;
}
