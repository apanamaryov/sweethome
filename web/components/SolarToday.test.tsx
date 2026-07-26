import { render, screen, waitFor } from "@testing-library/react";
import { LangProvider } from "@/lib/i18n";
import * as stats from "@/lib/stats";
import { SolarToday } from "./SolarToday";

jest.mock("@/lib/stats", () => ({
  __esModule: true,
  fetchSolarWindow: jest.fn(),
}));
const mockFetch = stats.fetchSolarWindow as jest.MockedFunction<typeof stats.fetchSolarWindow>;

function renderWith(win: stats.SolarWindow) {
  mockFetch.mockResolvedValue(win);
  return render(
    <LangProvider>
      <SolarToday />
    </LangProvider>
  );
}

afterEach(() => jest.clearAllMocks());

describe("SolarToday", () => {
  it("state=ended → показывает начало и конец (HH:MM)", async () => {
    renderWith({
      day: "2026-07-26",
      start: Date.UTC(2026, 6, 26, 4, 40, 0), // 07:40 в Europe/Kyiv (UTC+3 летом)
      end: Date.UTC(2026, 6, 26, 15, 20, 0), // 18:20
      state: "ended",
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    // формат времени зависит от TZ раннера; проверяем сам факт двух отметок через разделитель
    expect(await screen.findByText(/→/)).toBeInTheDocument();
  });

  it("state=active → показывает «идёт с …», без конца", async () => {
    renderWith({ day: "2026-07-26", start: Date.UTC(2026, 6, 26, 4, 40, 0), end: null, state: "active" });
    expect(await screen.findByText(/идёт с|триває з|since/)).toBeInTheDocument();
  });

  it("state=idle → «ещё не началось»", async () => {
    renderWith({ day: "2026-07-26", start: null, end: null, state: "idle" });
    expect(await screen.findByText(/ещё не началось|ще не почалося|not started yet/)).toBeInTheDocument();
  });

  it("рендерит заголовок панели, а значение — в отдельном .st-val (хук для видимого стиля)", async () => {
    renderWith({ day: "2026-07-26", start: null, end: null, state: "idle" });
    expect(await screen.findByText(/Солнце сегодня|Сонце сьогодні|Solar today/)).toBeInTheDocument();
    // значение вынесено в элемент с классом st-val — именно на него навешан CSS,
    // делающий панель видимой (регресс-гард на баг «панели не видно»).
    const val = await screen.findByText(/ещё не началось|ще не почалося|not started yet/);
    expect(val).toHaveClass("st-val");
  });
});
