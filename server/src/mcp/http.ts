import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "@sweethome/inverter-mcp";
import type { Inverter } from "../inverter";
import type { Config } from "../config";
import type { StatsRecorder } from "../stats/recorder";
import { createLocalGateway } from "./local-gateway";

const { version } = require("../../package.json") as { version: string };

/**
 * SDK принимает голые node-объекты запроса/ответа. Express их и расширяет, но
 * наш `req.auth` (контекст авторизации) конфликтует по типу с `auth?: AuthInfo`
 * из SDK, поэтому приведение делается явно и в одном месте.
 */
const nodeReq = (req: express.Request) => req as unknown as IncomingMessage;
const nodeRes = (res: express.Response) => res as unknown as ServerResponse<IncomingMessage>;

export interface McpMountDeps {
  inverter: Inverter;
  cfg: Config;
  stats: StatsRecorder | null;
  /** Тот же гейт авторизации, что у /api: заполняет req.user и req.auth. */
  authenticate: express.RequestHandler;
}

/**
 * Монтирует /mcp на Streamable HTTP. McpServer создаётся на сессию, потому что
 * набор инструментов зависит от прав предъявленного токена.
 */
export function mountMcp(app: express.Express, deps: McpMountDeps): void {
  const { inverter, cfg, stats } = deps;
  if (!cfg.mcp.enabled) return;

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
    if (sessions.size >= cfg.mcp.maxSessions) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Too many MCP sessions (limit ${cfg.mcp.maxSessions}); close an existing one or raise MCP_MAX_SESSIONS`,
        },
        id: null,
      });
      return;
    }

    const user = req.user!;
    const auth = req.auth!;
    const gateway = createLocalGateway(
      inverter,
      cfg,
      stats,
      {
        role: user.role,
        scopes: auth.scopes,
        allowControl: cfg.allowControl,
        statsEnabled: stats !== null,
      },
      auth.kind === "token" ? `token:${auth.tokenName ?? "?"}` : `ui:${user.username}`
    );

    const server = buildMcpServer({ gateway, version });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string): void => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      gateway.close();
      void server.close();
    };

    await server.connect(transport);
    await transport.handleRequest(nodeReq(req), nodeRes(res), req.body);
  };

  app.post("/mcp", deps.authenticate, handle);
  app.get("/mcp", deps.authenticate, handle);
  app.delete("/mcp", deps.authenticate, handle);
}
