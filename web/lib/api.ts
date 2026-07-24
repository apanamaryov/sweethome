export function redirectToLogin(): void {
  window.location.href = "/login";
}

/** POST JSON. При 401 уводит на /login и бросает. Ответ разбирает вызывающий. */
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
  return res;
}

/** GET JSON. При 401 уводит на /login и бросает; при не-2xx бросает. */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function wsUrl(): string {
  if (process.env.NODE_ENV === "development") return "ws://localhost:3000/ws";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}
