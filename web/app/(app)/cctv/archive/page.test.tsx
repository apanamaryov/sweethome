import { render, screen, act, waitFor } from "@testing-library/react";
import ArchivePage from "./page";

// Подставной hls.js — настоящий здесь не нужен: проверяется поведение страницы,
// а не воспроизведение (оно покрыто тестами самого плеера).
jest.mock("hls.js", () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
    on(): void {}
    loadSource(): void {}
    attachMedia(): void {}
    destroy(): void {}
  }
  return { __esModule: true, default: FakeHls };
});

const DAY = new Date(2026, 7, 25, 12, 0, 0);
const midnight = new Date(2026, 7, 25, 0, 0, 0).getTime();

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(DAY);
  global.fetch = jest.fn((url: string) => {
    if (url.includes("/cameras")) return jsonOk({ cameras: [{ id: "drive", name: "Въезд", recording: true }] });
    // Запись за все сутки — чтобы любая перемотка попадала в отснятое.
    return jsonOk({ spans: [{ startMs: midnight, endMs: midnight + 86_400_000 }], marks: [], segments: 10 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("страница архива", () => {
  it("увеличенная картинка остаётся увеличенной после перемотки", async () => {
    // Перемотка пересоздаёт плеер (иначе воспроизведение не поднимается),
    // поэтому увеличением владеет страница, а не плеер: иначе картинка
    // схлопывалась бы обратно на каждом переходе.
    render(<ArchivePage />);
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());

    act(() => { document.querySelector("video")!.click(); });
    expect(document.querySelector(".cctv-archive-player")!.className).toContain("cctv-expanded");

    act(() => { screen.getByLabelText("+1 min").click(); });

    await waitFor(() =>
      expect(document.querySelector(".cctv-archive-player")!.className).toContain("cctv-expanded")
    );
  });
});
