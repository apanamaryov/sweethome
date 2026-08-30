import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpSessionContext, ModuleMcpProvider } from "@sweethome/home-mcp";
import { localIso } from "@sweethome/home-mcp";
import { describeSnapshot, DRYER_INSTRUCTIONS, registerDryerTools, type DryerMcpDeps } from "./tools";

export type { DryerMcpDeps } from "./tools";

/** Инструменты, ресурсы и подсказка сушилки для общего /mcp хоста. Набор зависит от прав сессии. */
export function createDryerMcpProvider(deps: DryerMcpDeps): ModuleMcpProvider {
  return {
    instructions: DRYER_INSTRUCTIONS,
    register(server: McpServer, ctx: McpSessionContext) {
      registerDryerTools(server, { ...deps, ctx });

      server.registerResource("dryer-state", "dryer://state", { title: "Dryer state", mimeType: "application/json" }, async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(deps.dryer.snapshot()) }],
      }));

      server.registerResource("dryer-recent-runs", "dryer://runs/recent", { title: "Recent runs", mimeType: "application/json" }, async (uri) => {
        const now = (deps.now ?? (() => Date.now()))();
        const runs = deps.store.listRuns(now - 90 * 86_400_000, now + 1).slice(0, 20);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ runs }) }] };
      });

      server.registerPrompt(
        "dryer-report",
        { title: "How did the last run go", description: "Report on the most recent drying run: warm-up time, how excess fell, how it ended, restarts and faults." },
        () => {
          const snap = deps.dryer.snapshot();
          const last = deps.store.listRuns(0, (deps.now ?? (() => Date.now()))() + 1)[0];
          const text =
            `Сейчас: ${describeSnapshot(snap)}.\n` +
            (last
              ? `Последняя сушка #${last.id} началась ${localIso(last.startedAt)}. Вызови dryer_get_run_chart с runId=${last.id}, ` +
                "расскажи, сколько длился разогрев, как падал избыток влажности, чем закончилась сушка, были ли перезапуски и ошибки, " +
                "и всё ли выглядит нормально. Отвечай по-русски, коротко."
              : "Сушек ещё не было.");
          return { messages: [{ role: "user", content: { type: "text", text } }] };
        }
      );
    },
  };
}
