import { render, screen, act } from "@testing-library/react";
import Hls from "hls.js";
import ArchivePlayer from "./ArchivePlayer";

/**
 * Подставной hls.js: минимум методов, которые трогает ArchivePlayer, плюс
 * возможность извне дёрнуть сохранённый обработчик ошибки — так тест проверяет
 * реакцию компонента на фатальную ошибку без реальной сети и настоящего видео.
 */
jest.mock("hls.js", () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: "hlsError" };
    static last: FakeHls | null = null;
    errorHandler: ((event: string, data: { fatal: boolean; details: string }) => void) | null = null;
    constructor() {
      FakeHls.last = this;
    }
    on(event: string, cb: (event: string, data: { fatal: boolean; details: string }) => void): void {
      if (event === FakeHls.Events.ERROR) this.errorHandler = cb;
    }
    loadSource(): void {}
    attachMedia(): void {}
    destroy(): void {}
  }
  return { __esModule: true, default: FakeHls };
});

type FakeHlsStatic = {
  last: { errorHandler: ((event: string, data: { fatal: boolean; details: string }) => void) | null } | null;
};
const FakeHls = Hls as unknown as FakeHlsStatic;

describe("ArchivePlayer", () => {
  it("фатальная ошибка hls.js показывается пользователю, а не чёрным прямоугольником, и гаснет когда видео реально пошло", () => {
    render(
      <ArchivePlayer cam="drive" fromMs={0} toMs={1000} spans={[]} playlistStartMs={null} seekToMs={null} />
    );

    act(() => {
      // Нефатальные hls.js лечит сам — компонент обязан молчать про них; здесь
      // сразу проверяем именно тот случай, после которого сам не восстановится.
      FakeHls.last!.errorHandler?.("hlsError", { fatal: true, details: "networkError" });
    });
    expect(screen.getByText(/playback failed/)).toBeInTheDocument();

    const video = document.querySelector("video")!;
    act(() => {
      video.dispatchEvent(new Event("playing"));
    });
    expect(screen.queryByText(/playback failed/)).not.toBeInTheDocument();
  });

  it("перемотка ставит позицию в шкале плейлиста, а не запрошенных суток", () => {
    // Сегмент начался за 30 секунд до полуночи: плейлист стартует с него, а
    // полосы ленты подрезаны по полуночи. Без поправки на playlistStartMs плеер
    // встал бы на 30 секунд раньше запрошенного момента.
    const midnight = new Date(2026, 7, 24, 0, 0, 0).getTime();
    const segStart = midnight - 30_000;
    render(
      <ArchivePlayer
        cam="drive"
        fromMs={midnight}
        toMs={midnight + 86_400_000}
        spans={[{ startMs: midnight, endMs: segStart + 120_000 }]}
        playlistStartMs={segStart}
        seekToMs={midnight + 10_000}
      />
    );

    const video = document.querySelector("video")!;
    expect(video.currentTime).toBe(40); // (10 с после полуночи) + (30 с «хвоста»)
  });

  it("ошибка воспроизведения у <video> показывается пользователю, а не чёрным прямоугольником", () => {
    render(
      <ArchivePlayer cam="drive" fromMs={0} toMs={1000} spans={[]} playlistStartMs={null} seekToMs={null} />
    );

    const video = document.querySelector("video")!;
    act(() => {
      video.dispatchEvent(new Event("error"));
    });
    expect(screen.getByText(/playback failed/)).toBeInTheDocument();
  });
});
