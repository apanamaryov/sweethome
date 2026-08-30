import { render, screen, act, fireEvent } from "@testing-library/react";
import { DICTS } from "@/lib/i18n/dict";
import { NOW } from "@/test-utils/dryer";
import HistoryPage from "./page";

const t = DICTS.uk;
jest.mock("@/components/dryer/RunChart", () => ({ __esModule: true, default: ({ run }: { run: { id: number } }) => <div data-testid="chart" data-run={run.id} /> }));

const RUNS = [
  { id: 9, startedAt: NOW - 86_400_000, endedAt: NOW - 86_400_000 + 9 * 3600_000 + 40 * 60_000, presetName: "Груши", setpoint: 60, maxMinutes: 960, startedBy: "ui:alex", endReason: "autostop", restarts: 1, autostopEnabled: true },
  { id: 8, startedAt: NOW - 2 * 86_400_000, endedAt: NOW - 2 * 86_400_000 + 3600_000, presetName: null, setpoint: 45, maxMinutes: 120, startedBy: "button", endReason: "fault:sensor", restarts: 0, autostopEnabled: true },
];

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  global.fetch = jest.fn((url: string) =>
    Promise.resolve({ ok: true, status: 200, json: async () => (url.includes("/runs?") ? { runs: RUNS } : {}) } as Response)
  ) as unknown as typeof fetch;
});

describe("история сушек", () => {
  it("таблица: пресет, длительность, причина (с расшифровкой ошибки), перезапуски; клик открывает график", async () => {
    render(<HistoryPage />);
    await act(async () => {});
    expect(screen.getByText("Груши")).toBeInTheDocument();
    expect(screen.getByText("9:40")).toBeInTheDocument();
    expect(screen.getByText(t.dryerEndAutostop)).toBeInTheDocument();
    expect(screen.getByText(`${t.dryerEndFault}: ${t.dryerFaultSensor}`)).toBeInTheDocument();
    expect(screen.getByText(t.dryerCustom)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Груши"));
    expect(screen.getByTestId("chart")).toHaveAttribute("data-run", "9");
  });

  it("пустой период — подпись, график не рисуем", async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ runs: [] }) } as Response)) as unknown as typeof fetch;
    render(<HistoryPage />);
    await act(async () => {});
    expect(screen.getByText(t.dryerHistoryEmpty)).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
  });
});
