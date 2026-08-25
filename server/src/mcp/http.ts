import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildHomeMcpServer, isMcpCapable, type ModuleMcpProvider } from "@sweethome/home-mcp";
import type { HomeModule } from "@sweethome/shared/module";
import "@sweethome/shared/module"; // augments express-serve-static-core with req.user/req.auth

const { version } = require("../../package.json") as { version: string };

/**
 * SDK принимает голые node-объекты запроса/ответа. Express их и расширяет, но
 * наш `req.auth` (контекст авторизации) конфликтует по типу с `auth?: AuthInfo`
 * из SDK, поэтому приведение делается явно и в одном месте.
 */
const nodeReq = (req: express.Request) => req as unknown as IncomingMessage;
const nodeRes = (res: express.Response) => res as unknown as ServerResponse<IncomingMessage>;

export interface McpMountDeps {
  /** Модули дома; инструменты берутся у тех, кто их отдаёт. */
  modules: HomeModule[];
  /** Тот же гейт авторизации, что у /api: заполняет req.user и req.auth. */
  authenticate: express.RequestHandler;
  enabled: boolean;
  maxSessions: number;
}

/**
 * Монтирует /mcp на Streamable HTTP — один эндпоинт на весь дом.
 *
 * Живёт в хосте, а не в модуле: адрес общий, авторизация общая, а инструменты
 * приносят сами модули (см. ModuleMcpProvider). McpServer создаётся на сессию,
 * потому что набор инструментов зависит от прав предъявленного токена.
 */
export function mountMcp(app: express.Application, deps: McpMountDeps): void {
  if (!deps.enabled) return;

  const providers: ModuleMcpProvider[] = deps.modules.filter(isMcpCapable).map((m) => m.mcp);
  if (providers.length === 0) return;

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const handle: express.RequestHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(nodeReq(req), nodeRes(res), req.body);
      return;
    }

    if (sessionId) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found — reinitialize" },
        id: null,
      });
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: Mcp-Session-Id required" },
        id: null,
      });
      return;
    }

    // Pi 3B — не сервер приложений: держим потолок сессий низким и говорим об этом прямо.
    if (sessions.size >= deps.maxSessions) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Too many MCP sessions (limit ${deps.maxSessions}); close an existing one or raise MCP_MAX_SESSIONS`,
        },
        id: null,
      });
      return;
    }

    const user = req.user!;
    const auth = req.auth!;
    const server = buildHomeMcpServer({
      providers,
      ctx: {
        role: user.role,
        scopes: auth.scopes,
        username: user.username,
        source: auth.kind === "token" ? `token:${auth.tokenName ?? "?"}` : `ui:${user.username}`,
      },
      version,
    });

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string): void => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      void server.close();
    };

    await server.connect(transport);
    await transport.handleRequest(nodeReq(req), nodeRes(res), req.body);
  };

  app.post("/mcp", deps.authenticate, handle);
  app.get("/mcp", deps.authenticate, handle);
  app.delete("/mcp", deps.authenticate, handle);
}
