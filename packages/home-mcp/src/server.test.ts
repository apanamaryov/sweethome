import { buildHomeMcpServer } from "./server";
import type { McpSessionContext, ModuleMcpProvider } from "./types";
import { isMcpCapable } from "./types";

const CTX: McpSessionContext = {
  role: "admin",
  scopes: ["read", "write"],
  username: "alex",
  source: "token:laptop",
};

describe("buildHomeMcpServer", () => {
  it("собирает инструкции из модулей — агент читает их до первого вызова", () => {
    const providers: ModuleMcpProvider[] = [
      { instructions: "Inverter: reads are safe.", register: () => {} },
      { instructions: "Cameras: read-only.", register: () => {} },
    ];
    const server = buildHomeMcpServer({ providers, ctx: CTX, version: "1.2.3" });

    // Инструкции лежат в опциях сервера — читаем их оттуда, а не из приватных полей.
    const instructions = (server.server as unknown as { _instructions?: string })._instructions ?? "";
    expect(instructions).toContain("Inverter: reads are safe.");
    expect(instructions).toContain("Cameras: read-only.");
  });

  it("передаёт модулям права сессии, а не сервера", () => {
    const seen: McpSessionContext[] = [];
    buildHomeMcpServer({
      providers: [{ register: (_s, ctx) => void seen.push(ctx) }],
      ctx: CTX,
      version: "1",
    });
    expect(seen).toEqual([CTX]);
  });

  it("закрытие сессии снимает всё, что завели модули", async () => {
    // Модуль мог подписаться на снапшоты или открыть шлюз: без этой очистки
    // слушатели переживают сессию и копятся с каждой новой.
    const stopped: string[] = [];
    const server = buildHomeMcpServer({
      providers: [
        { register: () => () => void stopped.push("inverter") },
        { register: () => () => void stopped.push("cctv") },
      ],
      ctx: CTX,
      version: "1",
    });

    await server.close();
    expect(stopped).toEqual(["inverter", "cctv"]);
  });

  it("упавшая очистка одного модуля не мешает остальным и самой сессии", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const stopped: string[] = [];
    const server = buildHomeMcpServer({
      providers: [
        {
          register: () => () => {
            throw new Error("boom");
          },
        },
        { register: () => () => void stopped.push("cctv") },
      ],
      ctx: CTX,
      version: "1",
    });

    await expect(server.close()).resolves.toBeUndefined();
    expect(stopped).toEqual(["cctv"]);
    warn.mockRestore();
  });
});

describe("isMcpCapable", () => {
  it("отличает модуль с инструментами от модуля без них", () => {
    expect(isMcpCapable({ id: "cctv", mcp: { register: () => {} } })).toBe(true);
    expect(isMcpCapable({ id: "heating" })).toBe(false);
    // Половинчатая заглушка — не повод звать register: она его не имеет.
    expect(isMcpCapable({ id: "x", mcp: {} })).toBe(false);
  });
});
