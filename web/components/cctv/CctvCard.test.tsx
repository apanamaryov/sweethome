import { render, screen, waitFor } from "@testing-library/react";
import CctvCard from "./CctvCard";
import * as api from "@/lib/cctv";

jest.mock("@/lib/cctv", () => ({
  ...jest.requireActual("@/lib/cctv"),
  fetchCameras: jest.fn(),
  fetchStorage: jest.fn(),
}));

const mocked = api as jest.Mocked<typeof api>;

describe("CctvCard", () => {
  it("показывает, что запись идёт, и глубину архива", async () => {
    mocked.fetchCameras.mockResolvedValue([
      { id: "drive", name: "drive", recording: true, lastSegmentMs: 1, restarts: 0 },
      { id: "yard", name: "yard", recording: true, lastSegmentMs: 1, restarts: 0 },
    ]);
    mocked.fetchStorage.mockResolvedValue({
      available: true, usedBytes: 250 * 1024 ** 3, quotaBytes: 500 * 1024 ** 3,
      depthDays: 32, oldestMs: 1, newestMs: 2,
    });

    render(<CctvCard />);
    // Точный вариант из брифа (screen.getByText(/2/)) падает с "Found multiple
    // elements": "2" совпадает и со счётчиком записи (2 / 2), и с "32" глубины
    // архива (число тоже содержит цифру 2). Сужаем паттерн, чтобы проверять
    // именно счётчик записи — суть проверки (что видно "2 из 2" и "32") та же.
    await waitFor(() => expect(screen.getByText(/2 \/ 2/)).toBeInTheDocument());
    expect(screen.getByText(/32/)).toBeInTheDocument();
  });

  it("предупреждает, когда камера не пишет", async () => {
    mocked.fetchCameras.mockResolvedValue([
      { id: "drive", name: "drive", recording: false, lastSegmentMs: null, restarts: 3, lastError: "нет связи" },
    ]);
    mocked.fetchStorage.mockResolvedValue({
      available: true, usedBytes: 0, quotaBytes: 500 * 1024 ** 3, depthDays: null, oldestMs: null, newestMs: null,
    });

    render(<CctvCard />);
    await waitFor(() => expect(screen.getByTestId("cctv-card-warn")).toBeInTheDocument());
  });

  it("сообщает о недоступном хранилище", async () => {
    mocked.fetchCameras.mockResolvedValue([]);
    mocked.fetchStorage.mockResolvedValue({
      available: false, usedBytes: 0, quotaBytes: 500 * 1024 ** 3, depthDays: null, oldestMs: null, newestMs: null,
    });

    render(<CctvCard />);
    await waitFor(() => expect(screen.getByTestId("cctv-card-warn")).toBeInTheDocument());
  });
});
