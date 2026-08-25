import { render, screen, act } from "@testing-library/react";
import { useExpandable } from "./useExpandable";

function Probe() {
  const { expanded, toggle } = useExpandable();
  return (
    <button onClick={toggle}>{expanded ? "увеличено" : "обычный размер"}</button>
  );
}

describe("useExpandable", () => {
  it("переключает размер по клику и сворачивает по Esc", () => {
    render(<Probe />);
    expect(screen.getByText("обычный размер")).toBeInTheDocument();

    act(() => { screen.getByRole("button").click(); });
    expect(screen.getByText("увеличено")).toBeInTheDocument();

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(screen.getByText("обычный размер")).toBeInTheDocument();
  });

  it("не держит обработчик клавиш, пока картинка не увеличена", () => {
    // Слушатель на всё окно ради выключенной функции — лишний, и его легко
    // забыть снять: пусть он существует ровно столько, сколько увеличение.
    const add = jest.spyOn(window, "addEventListener");
    render(<Probe />);
    expect(add.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(0);

    act(() => { screen.getByRole("button").click(); });
    expect(add.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);

    const remove = jest.spyOn(window, "removeEventListener");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(remove.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);

    add.mockRestore();
    remove.mockRestore();
  });
});
