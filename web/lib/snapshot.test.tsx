import { render, screen, act } from "@testing-library/react";
import type { Snapshot } from "@inverter/shared";
import { SnapshotProvider, useSnapshot } from "./snapshot";

/**
 * Фейковый WebSocket: конструктор + сеттеры onopen/onmessage/onclose/onerror,
 * все созданные экземпляры собираются в static instances для инспекции в тестах.
 * Реальный jsdom не реализует WebSocket, поэтому подменяем глобальный конструктор целиком.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closeCalls++;
  }
}

function TestConsumer() {
  const { snapshot, stale } = useSnapshot();
  return (
    <div>
      <span data-testid="mode">{snapshot ? snapshot.mode : "none"}</span>
      <span data-testid="stale">{String(stale)}</span>
    </div>
  );
}

function makeSnapshot(mode: Snapshot["mode"] = "Line"): Snapshot {
  return {
    timestamp: Date.now(),
    connection: {
      connected: true,
      transport: "mock",
      device: null,
      deviceId: null,
      mock: true,
      lastError: null,
    },
    control: { allowControl: true, locked: false },
    mode,
    status: null,
    info: null,
    flags: null,
    warnings: null,
    baseline: null,
  };
}

/** Прогоняет ожидающие микрозадачи (резолвы fetch/json), не трогая fake-таймеры. */
async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

const originalLocation = window.location;

/** Заменяет window.location упрощённым мок-объектом без реальной навигации jsdom. */
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

const realWebSocket = (global as unknown as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  jest.useFakeTimers();
  FakeWebSocket.instances = [];
  (global as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  setLocation({});
  // Начальный HTTP GET /api/snapshot по умолчанию молча падает (см. .catch(() => {}) в
  // snapshot.tsx), чтобы тесты сами контролировали, откуда придёт первый снапшот (HTTP или WS).
  global.fetch = jest.fn().mockRejectedValue(new Error("no initial http snapshot"));
});

afterEach(() => {
  jest.useRealTimers();
  restoreLocation();
  (global as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
});

describe("SnapshotProvider", () => {
  it("opens a WebSocket to wsUrl() on mount", async () => {
    render(
      <SnapshotProvider>
        <TestConsumer />
      </SnapshotProvider>
    );
    await act(async () => flushMicrotasks());

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toMatch(/\/ws$/);
  });

  it("loads the first snapshot via HTTP GET /api/snapshot on mount", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => makeSnapshot("Bypass"),
    });

    render(
      <SnapshotProvider>
        <TestConsumer />
      </SnapshotProvider>
    );
    await act(async () => flushMicrotasks());

    expect(screen.getByTestId("mode")).toHaveTextContent("Bypass");
    expect(screen.getByTestId("stale")).toHaveTextContent("false");
  });

  it("updates the exposed snapshot when a snapshot message arrives over the socket", async () => {
    render(
      <SnapshotProvider>
        <TestConsumer />
      </SnapshotProvider>
    );
    await act(async () => flushMicrotasks());

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({ type: "snapshot", data: makeSnapshot("Battery") }),
      });
    });

    expect(screen.getByTestId("mode")).toHaveTextContent("Battery");
    expect(screen.getByTestId("stale")).toHaveTextContent("false");
  });

  it("ignores non-snapshot and malformed messages", async () => {
    render(
      <SnapshotProvider>
        <TestConsumer />
      </SnapshotProvider>
    );
    await act(async () => flushMicrotasks());

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "ping" }) });
    });
    expect(screen.getByTestId("mode")).toHaveTextContent("none");

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({ data: "not json" });
    });
    expect(screen.getByTestId("mode")).toHaveTextContent("none");
  });

  it("marks stale 15s after the last snapshot with no follow-up message", async () => {
    render(
      <SnapshotProvider>
        <TestConsumer />
      </SnapshotProvider>
    );
    await act(async () => flushMicrotasks());

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({ type: "snapshot", data: makeSnapshot() }),
      });
    });
    expect(screen.getByTestId("stale")).toHaveTextContent("false");

    await act(async () => {
      await jest.advanceTimersByTimeAsync(14999);
    });
    expect(screen.getByTestId("stale")).toHaveTextContent("false");

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByTestId("stale")).toHaveTextContent("true");
  });

  it("a fresh snapshot before 15s resets the stale timer", async () => {
    render(
      <SnapshotProvider>
        <TestConsumer />
      </SnapshotProvider>
    );
    await act(async () => flushMicrotasks());

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({ type: "snapshot", data: makeSnapshot() }),
      });
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByTestId("stale")).toHaveTextContent("false");

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({ type: "snapshot", data: makeSnapshot() }),
      });
    });

    // 20с от первого снапшота, но только 10с от второго - ещё не stale
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByTestId("stale")).toHaveTextContent("false");

    // 15с от второго снапшота - теперь stale
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByTestId("stale")).toHaveTextContent("true");
  });

  it("reconnects with backoff after the socket closes on a non-auth code, without redirecting", async () => {
    render(
      <SnapshotProvider>
        <TestConsumer />
      </SnapshotProvider>
    );
    await act(async () => flushMicrotasks());
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => {
      FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    });

    // до истечения ~1000мс первого реконнекта быть не должно
    await act(async () => {
      await jest.advanceTimersByTimeAsync(999);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(window.location.href).toBe("");
  });

  it("a 4401 close code redirects to /login instead of reconnecting", async () => {
    render(
      <SnapshotProvider>
        <TestConsumer />
      </SnapshotProvider>
    );
    await act(async () => flushMicrotasks());

    act(() => {
      FakeWebSocket.instances[0].onclose?.({ code: 4401 });
    });

    expect(window.location.href).toBe("/login");

    await act(async () => {
      await jest.advanceTimersByTimeAsync(20000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1); // реконнекта не было
  });

  it("closes the socket and clears timers on unmount (no leaked reconnect)", async () => {
    const { unmount } = render(
      <SnapshotProvider>
        <TestConsumer />
      </SnapshotProvider>
    );
    await act(async () => flushMicrotasks());

    const inst = FakeWebSocket.instances[0];
    unmount();
    expect(inst.closeCalls).toBe(1);

    // Даже если "сервер" теперь закроет соединение постфактум - реконнекта после unmount быть не должно
    // (эффект гейтит это через локальный `closed`).
    act(() => {
      inst.onclose?.({ code: 1006 });
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
