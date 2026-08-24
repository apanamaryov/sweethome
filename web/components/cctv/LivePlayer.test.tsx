import { render, screen, act } from "@testing-library/react";
import LivePlayer from "./LivePlayer";

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  readyState = 1;
  binaryType = "";
  constructor(public url: string) {
    FakeWebSocket.last = this;
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

describe("LivePlayer", () => {
  const origWs = global.WebSocket;
  const origMse = (global as { MediaSource?: unknown }).MediaSource;

  beforeEach(() => {
    (global as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    (global as unknown as { MediaSource: unknown }).MediaSource = class {
      static isTypeSupported = () => true;
      readyState = "closed";
      addEventListener(_e: string, cb: () => void) {
        setTimeout(cb, 0);
      }
      addSourceBuffer() {
        return { appendBuffer: () => {}, addEventListener: () => {}, updating: false };
      }
      endOfStream() {}
    };
    (global.URL as unknown as { createObjectURL: unknown }).createObjectURL = () => "blob:fake";
    // jsdom не реализует revokeObjectURL — подставляем его, чтобы тест проверял
    // поведение компонента, а не терпимость try/catch к отсутствующему в среде API.
    (global.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
  });

  afterEach(() => {
    (global as unknown as { WebSocket: unknown }).WebSocket = origWs;
    (global as unknown as { MediaSource: unknown }).MediaSource = origMse;
  });

  it("показывает подпись камеры", () => {
    render(<LivePlayer cam="drive" label="Въезд" />);
    expect(screen.getByText("Въезд")).toBeInTheDocument();
  });

  it("подключается к своему адресу и подписывается на камеру", () => {
    render(<LivePlayer cam="drive" label="Въезд" />);
    act(() => {
      FakeWebSocket.last!.onopen?.();
    });
    expect(FakeWebSocket.last!.url).toContain("/ws/cctv");
    expect(JSON.parse(FakeWebSocket.last!.sent[0])).toEqual({ type: "subscribe", cam: "drive" });
  });

  it("сообщение об ошибке показывается пользователю, а не молчит", () => {
    render(<LivePlayer cam="drive" label="Въезд" />);
    act(() => {
      FakeWebSocket.last!.onopen?.();
      FakeWebSocket.last!.onmessage?.({
        data: JSON.stringify({ type: "error", cam: "drive", error: "нет связи" }),
      });
    });
    expect(screen.getByText(/нет связи/)).toBeInTheDocument();
  });

  it("закрывает соединение при размонтировании — иначе ffmpeg на малине живёт зря", () => {
    const { unmount } = render(<LivePlayer cam="drive" label="Въезд" />);
    act(() => {
      FakeWebSocket.last!.onopen?.();
    });
    unmount();
    expect(FakeWebSocket.last!.closed).toBe(true);
  });
});
