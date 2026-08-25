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
    static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
    static last: FakeHls | null = null;
    static lastUrl: string | null = null;
    errorHandler: ((event: string, data: { fatal: boolean; details: string }) => void) | null = null;
    constructor() {
      FakeHls.last = this;
    }
    on(event: string, cb: (event: string, data: { fatal: boolean; details: string }) => void): void {
      if (event === FakeHls.Events.ERROR) this.errorHandler = cb;
    }
    loadSource(url: string): void {
      FakeHls.lastUrl = url;
    }
    attachMedia(): void {}
    destroy(): void {}
  }
  return { __esModule: true, default: FakeHls };
});

type FakeHlsStatic = {
  last: { errorHandler: ((event: string, data: { fatal: boolean; details: string }) => void) | null } | null;
  lastUrl: string | null;
};
const FakeHls = Hls as unknown as FakeHlsStatic;

describe("ArchivePlayer", () => {
  it("фатальная ошибка hls.js показывается пользователю, а не чёрным прямоугольником, и гаснет когда видео реально пошло", () => {
    render(
      <ArchivePlayer cam="drive" startMs={0} toMs={1000} locale="ru-RU" />
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

  it("перемотка запрашивает плейлист с нужного момента, а не двигает позицию", () => {
    // Сдвиг позиции внутри длинного плейлиста на наших записях останавливает
    // воспроизведение намертво (проверено на устройстве и на самой малине),
    // поэтому перемотка — это новый источник, начинающийся с нужной точки.
    const midnight = new Date(2026, 7, 24, 0, 0, 0).getTime();
    const { rerender } = render(
      <ArchivePlayer cam="drive" startMs={midnight} toMs={midnight + 86_400_000} locale="ru-RU" />
    );
    expect(FakeHls.lastUrl).toContain(`from=${midnight}`);

    const seek = midnight + 3_600_000;
    rerender(<ArchivePlayer cam="drive" startMs={seek} toMs={midnight + 86_400_000} locale="ru-RU" />);
    expect(FakeHls.lastUrl).toContain(`from=${seek}`);
  });

  it("сообщает позицию в реальном времени, а не в шкале плеера", () => {
    const midnight = new Date(2026, 7, 24, 0, 0, 0).getTime();
    const start = midnight + 3_600_000;
    const seen: number[] = [];
    render(
      <ArchivePlayer
        cam="drive"
        startMs={start}
        toMs={midnight + 86_400_000}
        locale="ru-RU"
        onPositionMs={(ms) => seen.push(ms)}
      />
    );

    const video = document.querySelector("video")!;
    Object.defineProperty(video, "currentTime", { value: 42, configurable: true });
    act(() => {
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(seen).toContain(start + 42_000);
  });

  it("ошибка воспроизведения у <video> показывается пользователю, а не чёрным прямоугольником", () => {
    render(
      <ArchivePlayer cam="drive" startMs={0} toMs={1000} locale="ru-RU" />
    );

    const video = document.querySelector("video")!;
    act(() => {
      video.dispatchEvent(new Event("error"));
    });
    expect(screen.getByText(/playback failed/)).toBeInTheDocument();
  });
  it("кнопки перемотки просят новый момент в реальном времени, а не двигают позицию плеера", () => {
    // Ползунок самого плеера убран намеренно: перемотка внутри плейлиста
    // на этих записях останавливает воспроизведение насовсем.
    const start = new Date(2026, 7, 25, 4, 0, 0).getTime();
    const asked: number[] = [];
    render(
      <ArchivePlayer
        cam="drive"
        startMs={start}
        toMs={start + 3_600_000}
        locale="ru-RU"
        onSeekRequest={(ms) => asked.push(ms)}
      />
    );

    expect(document.querySelector("video")!.hasAttribute("controls")).toBe(false);

    act(() => {
      screen.getByLabelText("+10 s").click();
    });
    expect(asked).toEqual([start + 10_000]);
  });

  it("показывает реальное время кадра, а не ноль от начала плейлиста", () => {
    const start = new Date(2026, 7, 25, 4, 0, 0).getTime();
    render(
      <ArchivePlayer cam="drive" startMs={start} toMs={start + 3_600_000} locale="ru-RU" />
    );

    const video = document.querySelector("video")!;
    Object.defineProperty(video, "currentTime", { value: 90, configurable: true });
    act(() => {
      video.dispatchEvent(new Event("timeupdate"));
    });

    // 04:00:00 + 90 секунд
    expect(screen.getByText(/4:01:30|04:01:30/)).toBeInTheDocument();
  });

});
