import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { DICTS } from "@/lib/i18n/dict";
import { buildDryerSnapshot, buildNode, buildRun, NOW } from "@/test-utils/dryer";
import type { DryerSnapshot } from "@sweethome/dryer-shared";
import DryerPage from "./page";

const t = DICTS.uk;
let snapshot: DryerSnapshot | null = null;
let error: string | null = null;
let role: "admin" | "viewer" | null = "admin";
const refresh = jest.fn();

jest.mock("@/lib/dryer-state", () => ({ useDryer: () => ({ snapshot, error, refresh }) }));
jest.mock("@/lib/session", () => ({ useSession: () => (role ? { username: "u", role, mustChangePassword: false } : null) }));
jest.mock("@/components/dryer/RunChart", () => ({ __esModule: true, default: () => <div data-testid="chart" /> }));
jest.mock("@/lib/dryer", () => ({
  ...jest.requireActual("@/lib/dryer"),
  fetchPresets: jest.fn(async () => [
    { id: 1, name: "Яблоки", group: "fruit", setpoint: 60, maxMinutes: 840, autostop: true, sort: 1 },
    { id: 2, name: "Морковь", group: "vegetable", setpoint: 52, maxMinutes: 600, autostop: true, sort: 2 },
  ]),
  startRun: jest.fn(async () => buildDryerSnapshot()),
  stopRun: jest.fn(async () => buildDryerSnapshot()),
  markEventSeen: jest.fn(async () => {}),
}));

beforeEach(() => {
  snapshot = buildDryerSnapshot();
  error = null;
  role = "admin";
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});

const renderPage = async () => {
  render(<DryerPage />);
  await act(async () => {});
};

describe("страница сушилки — состояния экрана (спека §9)", () => {
  it("снапшота нет → «Загрузка…», никаких нулей", async () => {
    snapshot = null;
    await renderPage();
    expect(screen.getByText(t.connecting)).toBeInTheDocument();
    expect(screen.queryByText(/0\.0/)).not.toBeInTheDocument();
  });

  it("ошибка GET /state → красная строка с текстом, остальное не рисуем", async () => {
    snapshot = null;
    error = "HTTP 500";
    await renderPage();
    expect(screen.getByText(/HTTP 500/)).toHaveClass("banner");
    expect(screen.queryByText(t.dryerStart)).not.toBeInTheDocument();
  });

  it("простой: пресеты по группам и «Старт»; клик по пресету и старту зовёт startRun", async () => {
    await renderPage();
    expect(screen.getByText(t.dryerGroupFruit)).toBeInTheDocument();
    expect(screen.getByText(t.dryerGroupVegetable)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Яблоки"));
    fireEvent.click(screen.getByRole("button", { name: t.dryerStart }));
    const { startRun } = jest.requireMock("@/lib/dryer");
    await waitFor(() => expect(startRun).toHaveBeenCalledWith({ presetId: 1 }));
    expect(refresh).toHaveBeenCalled();
  });

  it("нода офлайн без сушки: «Нет связи», старт заблокирован", async () => {
    snapshot = buildDryerSnapshot({ node: buildNode({ online: false }) });
    await renderPage();
    expect(screen.getAllByText(t.dryerStateOffline).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t.dryerOfflineIdle).length).toBeGreaterThan(0); // плашка статуса + подпись у «Старт»
    expect(screen.getByRole("button", { name: t.dryerStart })).toBeDisabled();
  });

  it("нода офлайн во время сушки: янтарная плашка с временем таймера, «Стоп» активен", async () => {
    const run = buildRun();
    snapshot = buildDryerSnapshot({ node: buildNode({ online: false, state: "drying" }), run });
    await renderPage();
    const banner = screen.getByText(new RegExp(t.dryerOfflineRunning));
    expect(banner).toHaveClass("amber");
    const deadline = new Date(run.startedAt + run.maxMinutes * 60_000).toLocaleTimeString(t.langLocale);
    expect(banner).toHaveTextContent(deadline);
    expect(screen.getByRole("button", { name: t.dryerStop })).toBeEnabled();
    expect(screen.getByText(new RegExp(t.dryerStopWhenBack))).toBeInTheDocument();
  });

  it("fault: красная плашка с расшифровкой, «Старт» скрыт, есть «Сбросить ошибку»", async () => {
    snapshot = buildDryerSnapshot({ node: buildNode({ state: "fault", stopReason: "fault:exhaust" }) });
    await renderPage();
    expect(screen.getByText(t.dryerFaultExhaust)).toHaveClass("brick");
    expect(screen.queryByRole("button", { name: t.dryerStart })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t.dryerResetFault }));
    const { stopRun } = jest.requireMock("@/lib/dryer");
    await waitFor(() => expect(stopRun).toHaveBeenCalled());
  });

  it("сушка идёт: прошло/предел, автостоп-строка, пресет; кнопка → «Запущена кнопкой»; перезапуски", async () => {
    snapshot = buildDryerSnapshot({
      node: buildNode({ state: "drying", chamber: { temp: 58.2, rh: 42.1 }, excess: 6.2, heaterDuty: 71, runElapsed: 11520 }),
      run: buildRun({ startedBy: "button", presetName: null, restarts: 2 }),
    });
    await renderPage();
    expect(screen.getByText("58.2")).toBeInTheDocument();
    expect(screen.getByText(/3:12/)).toBeInTheDocument();
    expect(screen.getByText(/14:00/)).toBeInTheDocument();
    expect(screen.getByText(/избыток 6\.2, ждём ниже 3/)).toBeInTheDocument();
    expect(screen.getByText(t.dryerStartedByButton)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${t.dryerRestarts}: 2`))).toBeInTheDocument();
    expect(screen.getByTestId("chart")).toBeInTheDocument();
  });

  it("автостоп выключен / дыры в данных — отдельные подписи", async () => {
    snapshot = buildDryerSnapshot({
      node: buildNode({ state: "drying" }),
      run: buildRun({ autostopEnabled: false, autostop: { enabled: false, belowSince: null, gaps: false, reason: "x" } }),
    });
    await renderPage();
    expect(screen.getByText(t.dryerAutostopOff)).toBeInTheDocument();
    snapshot = buildDryerSnapshot({
      node: buildNode({ state: "drying" }),
      run: buildRun({ autostop: { enabled: true, belowSince: null, gaps: true, reason: "x" } }),
    });
    await renderPage();
    expect(screen.getByText(t.dryerAutostopGaps)).toBeInTheDocument();
  });

  it("cooldown: строка остывания с температурой пластины", async () => {
    snapshot = buildDryerSnapshot({ node: buildNode({ state: "cooldown", plateTemp: 68 }) });
    await renderPage();
    expect(screen.getByText(new RegExp(`${t.dryerCooldownInfo} 68`))).toBeInTheDocument();
  });

  it("null показывается как «—», влажность при null скрыта", async () => {
    snapshot = buildDryerSnapshot({ node: buildNode({ chamber: { temp: null, rh: null }, excess: null }) });
    await renderPage();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText(/% RH/)).not.toBeInTheDocument();
  });

  it("viewer: контролы disabled и строка «Только просмотр»; роль не загрузилась — то же", async () => {
    role = "viewer";
    await renderPage();
    expect(screen.getByText(t.dryerViewerOnly)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.dryerStart })).toBeDisabled();
    role = null;
    await renderPage();
    expect(screen.getAllByText(t.dryerViewerOnly).length).toBeGreaterThan(0);
  });

  it("график остаётся после остановки — до следующего старта (спека §9)", async () => {
    snapshot = buildDryerSnapshot({ node: buildNode({ state: "drying" }), run: buildRun() });
    const { rerender } = render(<DryerPage />);
    await act(async () => {});
    expect(screen.getByTestId("chart")).toBeInTheDocument();
    snapshot = buildDryerSnapshot({ node: buildNode({ state: "cooldown" }), run: null });
    rerender(<DryerPage />);
    await act(async () => {});
    expect(screen.getByTestId("chart")).toBeInTheDocument();
  });

  it("viewer: поля «своих параметров» тоже заблокированы", async () => {
    const { rerender } = render(<DryerPage />); // сначала админ — иначе панель не открыть
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: t.dryerCustom }));
    expect(screen.getByLabelText(t.dryerSetpoint)).toBeEnabled();
    role = "viewer";
    rerender(<DryerPage />);
    await act(async () => {});
    expect(screen.getByLabelText(t.dryerSetpoint)).toBeDisabled();
    expect(screen.getByLabelText(t.dryerMaxHours)).toBeDisabled();
    expect(screen.getByLabelText(t.dryerAutostop)).toBeDisabled();
  });

  it("события: непрочитанные сверху, крестик зовёт markEventSeen и refresh", async () => {
    snapshot = buildDryerSnapshot({
      events: [{ id: 5, ts: NOW - 1000, runId: 1, kind: "run_done", text: "Сушка «Груши» завершена автостопом за 9 ч 40 м", seen: false }],
    });
    await renderPage();
    expect(screen.getByText(/Сушка «Груши»/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(t.dryerMarkSeen));
    const { markEventSeen } = jest.requireMock("@/lib/dryer");
    await waitFor(() => expect(markEventSeen).toHaveBeenCalledWith(5));
  });
});
