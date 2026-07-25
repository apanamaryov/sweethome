import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider, useToast } from "./toast";

function TestConsumer() {
  const { toast } = useToast();
  return (
    <div>
      <button onClick={() => toast("Hello", "ok")}>show-ok</button>
      <button onClick={() => toast("Bad thing", "bad")}>show-bad</button>
      <button onClick={() => toast("Plain message")}>show-plain</button>
    </div>
  );
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("ToastProvider", () => {
  it("renders nothing before any toast is triggered", () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("adding a toast renders its message with the ok kind class", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    await user.click(screen.getByText("show-ok"));

    const el = screen.getByText("Hello");
    expect(el).toHaveClass("toast", "ok");
  });

  it("adding an error toast uses the bad kind class", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    await user.click(screen.getByText("show-bad"));

    expect(screen.getByText("Bad thing")).toHaveClass("toast", "bad");
  });

  it("a toast with no kind still renders (empty kind class)", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    await user.click(screen.getByText("show-plain"));

    expect(screen.getByText("Plain message")).toHaveClass("toast");
  });

  it("auto-dismisses the toast 3200ms after it was shown", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    await user.click(screen.getByText("show-ok"));
    expect(screen.getByText("Hello")).toBeInTheDocument();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3199);
    });
    expect(screen.getByText("Hello")).toBeInTheDocument();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByText("Hello")).toBeNull();
  });

  it("a second toast() call replaces the message and restarts the auto-dismiss timer", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    await user.click(screen.getByText("show-ok"));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    await user.click(screen.getByText("show-bad"));
    expect(screen.queryByText("Hello")).toBeNull();

    // 4000мс от первого тоста, но только 2000 от второго - второй ещё должен быть виден
    // (подтверждает, что новый toast() перезапускает таймер, а не наследует старый дедлайн)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("Bad thing")).toBeInTheDocument();

    // добираем до 3200мс от второго тоста
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1200);
    });
    expect(screen.queryByText("Bad thing")).toBeNull();
  });

  // NB: в текущем toast.tsx у тоста нет onClick/кнопки ручного закрытия - только
  // авто-скрытие по таймеру 3200мс (см. web/lib/toast.tsx). Кейс из брифа "закрытие по
  // клику" в реальном коде не реализован, поэтому не тестируется - см. отклонение в отчёте.
});
