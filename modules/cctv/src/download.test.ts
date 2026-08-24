import { buildConcatList, concatArgs, downloadFileName } from "./download";
import type { SegmentRow } from "./index/db";

const seg = (id: number, path: string): SegmentRow => ({
  id, cam: "drive", initId: 1, path, startMs: id * 60_000, durMs: 60_000, bytes: 10,
});

describe("buildConcatList", () => {
  it("собирает список для concat-демуксера с абсолютными путями", () => {
    const list = buildConcatList([seg(1, "drive/a.m4s"), seg(2, "drive/b.m4s")], "/st");
    expect(list).toBe("file '/st/drive/a.m4s'\nfile '/st/drive/b.m4s'\n");
  });

  it("первым идёт init-сегмент, без него склейка не воспроизводится", () => {
    const list = buildConcatList([seg(1, "drive/a.m4s")], "/st", "drive/init_run1.mp4");
    expect(list.split("\n")[0]).toBe("file '/st/drive/init_run1.mp4'");
  });

  it("экранирует одинарную кавычку в пути", () => {
    const list = buildConcatList([seg(1, "drive/it's.m4s")], "/st");
    expect(list).toContain(`file '/st/drive/it'\\''s.m4s'`);
  });

  it("на пустом списке отдаёт пустую строку", () => {
    expect(buildConcatList([], "/st")).toBe("");
  });
});

describe("concatArgs", () => {
  const args = concatArgs({ listPath: "/tmp/list.txt" });

  it("использует concat-демуксер и не перекодирует", () => {
    expect(args.join(" ")).toContain("-f concat");
    expect(args.join(" ")).toContain("-safe 0");
    expect(args.join(" ")).toContain("-c copy");
  });

  it("отдаёт результат в stdout как fragmented mp4", () => {
    expect(args[args.length - 1]).toBe("pipe:1");
    expect(args.join(" ")).toContain("-movflags");
  });
});

describe("downloadFileName", () => {
  it("составляет имя из камеры и времени", () => {
    expect(downloadFileName("drive", Date.UTC(2026, 7, 24, 10, 5, 0))).toMatch(/^drive_20260824_\d{6}\.mp4$/);
  });
});
