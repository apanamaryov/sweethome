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

/** Подставной SourceBuffer — только то, что нужно компоненту и тестам. */
class FakeSourceBuffer {
  updating = false;
  constructor(public mime: string) {}
  appendBuffer(): void {}
  remove(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

/**
 * Подставной MediaSource. sourceopenCallback хранит последний зарегистрированный колбэк
 * напрямую (а не удаляет его сам при removeEventListener) — так тест "опоздавшего" события
 * может дёрнуть его руками, как это выглядело бы при настоящей гонке, а removedEvents
 * отдельно фиксирует, что компонент действительно позвал removeEventListener при
 * размонтировании (React 19 не ругается предупреждением на setState после unmount — это
 * молчаливый no-op, — поэтому единственный наблюдаемый в тесте признак того, что слушатель
 * снят, это сам факт вызова removeEventListener, а не отсутствие консольного шума).
 */
class FakeMediaSource {
  static isTypeSupported = () => true;
  static last: FakeMediaSource | null = null;
  static lastAddedMime: string | null = null;
  readyState = "closed";
  sourceopenCallback: (() => void) | null = null;
  removedEvents: string[] = [];
  constructor() {
    FakeMediaSource.last = this;
  }
  addEventListener(ev: string, cb: () => void): void {
    if (ev === "sourceopen") this.sourceopenCallback = cb;
  }
  removeEventListener(ev: string): void {
    this.removedEvents.push(ev);
  }
  addSourceBuffer(mime: string): FakeSourceBuffer {
    FakeMediaSource.lastAddedMime = mime;
    return new FakeSourceBuffer(mime);
  }
  endOfStream(): void {}
}

describe("LivePlayer", () => {
  const origWs = global.WebSocket;
  const origMse = (global as { MediaSource?: unknown }).MediaSource;
  const origPlay = window.HTMLMediaElement.prototype.play;

  beforeEach(() => {
    (global as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    (global as unknown as { MediaSource: unknown }).MediaSource = FakeMediaSource;
    FakeMediaSource.last = null;
    FakeMediaSource.lastAddedMime = null;
    (global.URL as unknown as { createObjectURL: unknown }).createObjectURL = () => "blob:fake";
    // jsdom не реализует revokeObjectURL — подставляем его, чтобы тест проверял
    // поведение компонента, а не терпимость try/catch к отсутствующему в среде API.
    (global.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
    // jsdom не реализует HTMLMediaElement.play() — без стаба он логирует "not implemented"
    // в консоль и возвращает undefined вместо промиса. В настоящих браузерах play() всегда
    // возвращает промис — подставляем реалистичное поведение, а не терпим шум в выводе теста.
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  });

  afterEach(() => {
    (global as unknown as { WebSocket: unknown }).WebSocket = origWs;
    (global as unknown as { MediaSource: unknown }).MediaSource = origMse;
    delete (global as { ManagedMediaSource?: unknown }).ManagedMediaSource;
    window.HTMLMediaElement.prototype.play = origPlay;
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

  it("кодек, присланный сервером, применяется вместо зашитого в коде", () => {
    render(<LivePlayer cam="drive" label="Въезд" />);
    act(() => {
      FakeWebSocket.last!.onopen?.();
      // Ответ сервера приходит раньше, чем срабатывает sourceopen, — ровно тот порядок,
      // из-за которого зашитое значение раньше всегда побеждало настоящее.
      FakeWebSocket.last!.onmessage?.({
        data: JSON.stringify({ type: "ready", cam: "drive", mime: 'video/mp4; codecs="avc1.640028"' }),
      });
      FakeMediaSource.last!.sourceopenCallback?.();
    });
    expect(FakeMediaSource.lastAddedMime).toBe('video/mp4; codecs="avc1.640028"');
  });

  it("ошибка воспроизведения у <video> показывается пользователю, а не чёрным квадратом", () => {
    const { container } = render(<LivePlayer cam="drive" label="Въезд" />);
    act(() => {
      FakeWebSocket.last!.onopen?.();
    });
    const video = container.querySelector("video")!;
    act(() => {
      video.dispatchEvent(new Event("error"));
    });
    expect(screen.getByText(/playback failed/)).toBeInTheDocument();
  });

  it("опоздавший sourceopen после размонтирования не трогает состояние компонента", () => {
    const { unmount } = render(<LivePlayer cam="drive" label="Въезд" />);
    act(() => {
      FakeWebSocket.last!.onopen?.();
    });
    const ms = FakeMediaSource.last!;
    unmount();
    // Клинап должен отписаться от sourceopen — это единственный наблюдаемый в тесте след
    // того, что слушатель снят (в React 19 setState после unmount — молчаливый no-op без
    // предупреждения, так что проверять "нет warning" здесь бессмысленно).
    expect(ms.removedEvents).toContain("sourceopen");
    // "Опоздавшее" событие — как если бы браузер всё же дёрнул колбэк уже после
    // размонтирования (например, событие было в полёте до вызова removeEventListener) —
    // компонент не должен упасть даже в этом случае, благодаря флагу cancelled.
    expect(() => {
      act(() => {
        ms.sourceopenCallback?.();
      });
    }).not.toThrow();
  });

  it("ошибка воспроизведения переживает следующий пришедший кадр и гаснет только когда видео реально пошло", () => {
    const { container } = render(<LivePlayer cam="drive" label="Въезд" />);
    act(() => {
      FakeWebSocket.last!.onopen?.();
    });
    const video = container.querySelector("video")!;
    act(() => {
      video.dispatchEvent(new Event("error"));
    });
    expect(screen.getByText(/playback failed/)).toBeInTheDocument();

    // Сервер продолжает слать сегменты независимо от того, смог ли браузер декодировать
    // предыдущий, — раньше это гасило плашку через один кадр, и зритель дальше смотрел
    // на чёрный прямоугольник без объяснений.
    act(() => {
      FakeWebSocket.last!.onmessage?.({ data: new ArrayBuffer(0) });
    });
    expect(screen.getByText(/playback failed/)).toBeInTheDocument();

    // А вот когда видео реально пошло — плашка обязана исчезнуть.
    act(() => {
      video.dispatchEvent(new Event("playing"));
    });
    expect(screen.queryByText(/playback failed/)).not.toBeInTheDocument();
  });
  // На iPhone обычного MediaSource нет вовсе: Apple даёт только ManagedMediaSource
  // и только с iOS 17.1. Без этих двух тестов страница живого просмотра падала
  // целиком с «Application error», потому что new MediaSource() бросал ReferenceError.
  it("без поддержки MediaSource показывает сообщение, а не падает", () => {
    delete (global as { MediaSource?: unknown }).MediaSource;
    delete (global as { ManagedMediaSource?: unknown }).ManagedMediaSource;

    expect(() => render(<LivePlayer cam="drive" label="Въезд" />)).not.toThrow();
    expect(screen.getByText(/не підтримується/i)).toBeInTheDocument();
  });

  it("использует ManagedMediaSource, когда обычного MediaSource нет (iPhone)", () => {
    delete (global as { MediaSource?: unknown }).MediaSource;
    (global as unknown as { ManagedMediaSource: unknown }).ManagedMediaSource = FakeMediaSource;

    render(<LivePlayer cam="drive" label="Въезд" />);
    act(() => {
      FakeWebSocket.last!.onopen?.();
      FakeWebSocket.last!.onmessage?.({
        data: JSON.stringify({ type: "ready", cam: "drive", mime: 'video/mp4; codecs="avc1.4d0032"' }),
      });
      FakeMediaSource.last!.sourceopenCallback?.();
    });

    expect(FakeMediaSource.last).not.toBeNull();
    expect(FakeMediaSource.lastAddedMime).toBe('video/mp4; codecs="avc1.4d0032"');
  });

  it("клик по картинке разворачивает её и сворачивает обратно", () => {
    // На десктопе кадр 1920×2160 в обычном размере вписан в окно; разглядеть
    // его крупно можно кликом — как и в архиве, чтобы жест был один и тот же.
    render(<LivePlayer cam="drive" label="Въезд" />);

    const wrap = document.querySelector(".cctv-live")!;
    const video = document.querySelector("video")!;
    expect(wrap.className).not.toContain("cctv-expanded");

    act(() => { video.click(); });
    expect(wrap.className).toContain("cctv-expanded");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(wrap.className).not.toContain("cctv-expanded");
  });

});
