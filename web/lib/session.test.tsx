import { render, screen, act } from "@testing-library/react";
import type { SessionUser } from "@sweethome/inverter-shared";
import { SessionProvider, useSession } from "./session";

function TestConsumer() {
  const session = useSession();
  return (
    <div>
      <span data-testid="role">{session ? session.role : "loading"}</span>
      <span data-testid="username">{session ? session.username : ""}</span>
    </div>
  );
}

function makeSession(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    username: "admin",
    role: "admin",
    mustChangePassword: false,
    ...overrides,
  };
}

/** Прогоняет ожидающие микрозадачи (резолвы fetch/json), не трогая fake-таймеры. */
async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

const originalLocation = window.location;

function setLocation(overrides: Partial<Location>): void {
  Object.defineProperty(window, "location", {
    writable: true,
    configurable: true,
    value: { href: "", protocol: "http:", host: "localhost:3000", ...overrides },
  });
}

function restoreLocation(): void {
  Object.defineProperty(window, "location", {
    writable: true,
    configurable: true,
    value: originalLocation,
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  setLocation({});
});

afterEach(() => {
  jest.useRealTimers();
  restoreLocation();
});

describe("SessionProvider", () => {
  it("exposes the loaded session (username/role/mustChangePassword) after a successful fetch", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => makeSession({ username: "bob", role: "viewer" }),
    });

    render(
      <SessionProvider>
        <TestConsumer />
      </SessionProvider>
    );
    await act(async () => flushMicrotasks());

    expect(global.fetch).toHaveBeenCalledWith("/api/me");
    expect(screen.getByTestId("role")).toHaveTextContent("viewer");
    expect(screen.getByTestId("username")).toHaveTextContent("bob");
  });

  it("retries 5s after a failed fetch (network error), then exposes the session on the successful retry", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => makeSession() });
    global.fetch = fetchMock;

    render(
      <SessionProvider>
        <TestConsumer />
      </SessionProvider>
    );
    await act(async () => flushMicrotasks());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("role")).toHaveTextContent("loading");

    // до истечения 5с ретрая быть не должно
    await act(async () => {
      await jest.advanceTimersByTimeAsync(4999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("role")).toHaveTextContent("admin");
  });

  it("keeps retrying every 5s across multiple consecutive failures", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => makeSession() });
    global.fetch = fetchMock;

    render(
      <SessionProvider>
        <TestConsumer />
      </SessionProvider>
    );
    await act(async () => flushMicrotasks());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("role")).toHaveTextContent("loading");

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("role")).toHaveTextContent("admin");
  });

  it("treats a non-ok HTTP response (e.g. 500) as a failure and retries the same way", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ status: 500, ok: false })
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => makeSession() });
    global.fetch = fetchMock;

    render(
      <SessionProvider>
        <TestConsumer />
      </SessionProvider>
    );
    await act(async () => flushMicrotasks());
    expect(screen.getByTestId("role")).toHaveTextContent("loading");

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("role")).toHaveTextContent("admin");
  });

  it("redirects to /login on 401 and never sets the session, without scheduling a retry", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 401, ok: false });
    global.fetch = fetchMock;

    render(
      <SessionProvider>
        <TestConsumer />
      </SessionProvider>
    );
    await act(async () => flushMicrotasks());

    expect(window.location.href).toBe("/login");
    expect(screen.getByTestId("role")).toHaveTextContent("loading");

    await act(async () => {
      await jest.advanceTimersByTimeAsync(10000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // без ретрая — редирект уже произошёл
  });

  it("does not apply a late successful fetch after the provider has unmounted (cancelled guard)", async () => {
    const fetchMock = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ status: 200, ok: true, json: async () => makeSession() }), 100)
        )
    );
    global.fetch = fetchMock;

    const { unmount } = render(
      <SessionProvider>
        <TestConsumer />
      </SessionProvider>
    );
    unmount();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(200);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
