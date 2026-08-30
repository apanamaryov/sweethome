import { render, screen, act } from "@testing-library/react";
import { DICTS } from "@/lib/i18n/dict";
import { buildDryerSnapshot, buildNode, buildRun, NOW } from "@/test-utils/dryer";
import DryerCard from "./DryerCard";

const t = DICTS.uk;

function mockState(body: unknown, status = 200) {
  global.fetch = jest.fn(() => Promise.resolve({ ok: status < 400, status, json: async () => body } as Response)) as unknown as typeof fetch;
}

describe("DryerCard", () => {
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));

  it("вся карточка — ссылка на /dryer; в простое чип «Простой»", async () => {
    mockState(buildDryerSnapshot());
    render(<DryerCard />);
    await act(async () => {});
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/dryer");
    expect(link.querySelector("section.card.home-card")).toBeInTheDocument();
    expect(screen.getByText(t.dryerStateIdle)).toBeInTheDocument();
  });

  it("во время сушки: температура → уставка, время из предела, пресет, избыток", async () => {
    mockState(buildDryerSnapshot({ node: buildNode({ state: "drying", chamber: { temp: 58.2, rh: 42 }, excess: 6.2 }), run: buildRun() }));
    render(<DryerCard />);
    await act(async () => {});
    expect(screen.getByText(/58\.2 → 60/)).toBeInTheDocument();
    expect(screen.getByText(/3:12 .* 14:00/)).toBeInTheDocument();
    expect(screen.getByText("Яблоки")).toBeInTheDocument();
    expect(screen.getByText(/6\.2/)).toBeInTheDocument();
  });

  it("последнее непрочитанное событие показывается; ошибка запроса — «Нет связи», не падение", async () => {
    mockState(buildDryerSnapshot({ events: [{ id: 1, ts: NOW, runId: null, kind: "node_offline", text: "Нет связи с сушилкой", seen: false }] }));
    render(<DryerCard />);
    await act(async () => {});
    expect(screen.getByText("Нет связи с сушилкой")).toBeInTheDocument();
    mockState({ ok: false }, 500);
    render(<DryerCard />);
    await act(async () => {});
    expect(screen.getAllByText(t.dryerStateOffline).length).toBeGreaterThan(0);
  });
});
