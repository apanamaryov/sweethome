import { render, screen, act, waitFor } from "@testing-library/react";
import React from "react";
import CctvPage from "./page";

/**
 * Плеер подменён: настоящему нужен MediaSource, которого в jsdom нет, а
 * проверяется здесь обвязка страницы — кто владеет звуком и что в строке камер.
 * Звук «есть» только у drive — как на реальных камерах.
 */
jest.mock("@/components/cctv/LivePlayer", () => ({
  __esModule: true,
  default: ({
    cam,
    muted,
    onAudioAvailable,
  }: {
    cam: string;
    muted?: boolean;
    onAudioAvailable?: (has: boolean) => void;
  }) => {
    React.useEffect(() => {
      onAudioAvailable?.(cam === "drive");
    }, [cam, onAudioAvailable]);
    return <video data-testid="live" data-cam={cam} muted={muted} />;
  },
}));

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

const CAMS = [
  { id: "drive", name: "drive", recording: true, lastSegmentMs: 1, restarts: 0, hasAudio: true, recordsAudio: true },
  { id: "terrace", name: "terrace", recording: true, lastSegmentMs: 1, restarts: 0, hasAudio: false, recordsAudio: false },
];

beforeEach(() => {
  global.fetch = jest.fn(() => jsonOk({ cameras: CAMS })) as unknown as typeof fetch;
});

describe("страница живого просмотра", () => {
  it("архив открывается иконкой из строки камер, а не ссылкой внизу", async () => {
    render(<CctvPage />);
    const link = await screen.findByLabelText(/архів|архив|archive/i);
    expect(link).toHaveAttribute("href", "/cctv/archive");
    // Текстовой ссылки под плеером больше нет — она переехала в строку.
    expect(screen.queryByRole("link", { name: /відкрити архів|открыть архив|open archive/i })).toBe(link);
  });

  it("кнопка звука живёт в строке камер и глушит плеер", async () => {
    render(<CctvPage />);
    // muted у медиаэлемента — свойство, а не атрибут: React ставит именно его.
    const video = (await screen.findByTestId("live")) as HTMLVideoElement;
    expect(video.muted).toBe(true); // по умолчанию тихо

    const button = await screen.findByLabelText(/звук/i);
    act(() => {
      button.click();
    });
    expect((screen.getByTestId("live") as HTMLVideoElement).muted).toBe(false);
  });

  it("у камеры без звука кнопки нет", async () => {
    // Кнопка, которая ничего не делает, хуже, чем её отсутствие.
    render(<CctvPage />);
    await screen.findByLabelText(/звук/i);

    act(() => {
      screen.getByRole("button", { name: "terrace" }).click();
    });
    await waitFor(() => expect(screen.queryByLabelText(/звук/i)).not.toBeInTheDocument());
  });

  it("подсвечивает выбранную камеру — подписи под картинкой больше нет", async () => {
    render(<CctvPage />);
    const drive = await screen.findByRole("button", { name: "drive" });
    expect(drive).toHaveClass("active");
    expect(screen.getByRole("button", { name: "terrace" })).not.toHaveClass("active");

    act(() => {
      screen.getByRole("button", { name: "terrace" }).click();
    });
    expect(screen.getByRole("button", { name: "terrace" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "drive" })).not.toHaveClass("active");
  });

});
