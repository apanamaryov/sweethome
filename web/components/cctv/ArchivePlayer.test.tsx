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
    render(<ArchivePlayer cam="drive" fromMs={0} toMs={1000} spans={[]} seekToMs={null} />);

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

  it("ошибка воспроизведения у <video> показывается пользователю, а не чёрным прямоугольником", () => {
    render(<ArchivePlayer cam="drive" fromMs={0} toMs={1000} spans={[]} seekToMs={null} />);

    const video = document.querySelector("video")!;
    act(() => {
      video.dispatchEvent(new Event("error"));
    });
    expect(screen.getByText(/playback failed/)).toBeInTheDocument();
  });
});
