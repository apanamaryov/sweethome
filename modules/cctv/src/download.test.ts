import { downloadFileName } from "./download";

describe("downloadFileName", () => {
  it("составляет имя из камеры и времени", () => {
    expect(downloadFileName("drive", Date.UTC(2026, 7, 24, 10, 5, 0))).toMatch(/^drive_20260824_\d{6}\.mp4$/);
  });
});
