import { act, render, screen } from "@testing-library/react";
import { FakeWebSocket, installFakeWebSocket, flushMicrotasks, jsonResponse } from "@/test-utils/renderWithProviders";
import { buildDryerSnapshot, buildNode } from "@/test-utils/dryer";
import { DryerProvider, useDryer } from "./dryer-state";

function Probe() {
  const { snapshot, error } = useDryer();
  return <div data-testid="probe">{error ?? snapshot?.node.state ?? "none"}</div>;
}

beforeEach(() => installFakeWebSocket());

describe("DryerProvider", () => {
  it("первый снапшот по HTTP, дальше по WS без обёртки", async () => {
    global.fetch = jest.fn(() => Promise.resolve(jsonResponse(200, buildDryerSnapshot()))) as unknown as typeof fetch;
    render(<DryerProvider><Probe /></DryerProvider>);
    await act(() => flushMicrotasks());
    expect(screen.getByTestId("probe")).toHaveTextContent("idle");
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onopen?.();
      ws.onmessage?.({ data: JSON.stringify(buildDryerSnapshot({ node: buildNode({ state: "drying" }) })) });
    });
    expect(screen.getByTestId("probe")).toHaveTextContent("drying");
  });

  it("ошибка HTTP показывается текстом сервера, а не кодом", async () => {
    global.fetch = jest.fn(() => Promise.resolve(jsonResponse(500, { ok: false, error: "boom" }))) as unknown as typeof fetch;
    render(<DryerProvider><Probe /></DryerProvider>);
    await act(() => flushMicrotasks());
    expect(screen.getByTestId("probe")).toHaveTextContent("boom");
  });
});
