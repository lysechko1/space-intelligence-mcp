/**
 * Streamable HTTP transport for @cosmx/space-intelligence-mcp.
 *
 * Boots a Node HTTP server that speaks the MCP Streamable HTTP protocol on
 * `POST /mcp`. Clients (claude.ai with managed MCP, Cursor remote, Cline,
 * custom Anthropic-SDK agents) connect to a URL instead of spawning a stdio
 * subprocess — no local Node, no clone, no build.
 *
 * Mode is stateful by default (a per-session id is generated on initialize and
 * carried in the `Mcp-Session-Id` header by spec). Pass `--stateless` for the
 * simpler stateless variant.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOLS } from "./tools.js";
import { REFUSAL_MESSAGE } from "./safety.js";
import { installTls } from "./setup-tls.js";

const NAME = "@cosmx/space-intelligence-mcp";
const VERSION = "0.1.0";

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = zodFieldToSchema(v);
      if (!(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault)) required.push(k);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  return zodFieldToSchema(schema);
}
function zodFieldToSchema(v: z.ZodTypeAny): Record<string, unknown> {
  let inner = v;
  if (inner instanceof z.ZodOptional) inner = inner.unwrap();
  if (inner instanceof z.ZodDefault) inner = inner._def.innerType;
  const description = (v.description ?? (inner.description as string | undefined)) || undefined;
  if (inner instanceof z.ZodString) return { type: "string", description };
  if (inner instanceof z.ZodNumber) return { type: "number", description };
  if (inner instanceof z.ZodBoolean) return { type: "boolean", description };
  if (inner instanceof z.ZodArray) return { type: "array", items: zodFieldToSchema(inner._def.type), description };
  if (inner instanceof z.ZodEnum) return { type: "string", enum: inner.options, description };
  if (inner instanceof z.ZodObject) return { ...zodToJsonSchema(inner), description };
  return { description };
}

function buildServer(): Server {
  const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
    try {
      const parsed = tool.inputSchema.parse(rawArgs ?? {});
      const out = await (tool.handler as (a: unknown) => Promise<unknown>)(parsed);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    } catch (err: unknown) {
      const e = err as Error & { refusal?: boolean; reason?: string; issues?: unknown };
      if (e?.refusal) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: JSON.stringify({
              schema_version: "1.0",
              refusal: true,
              reason: e.reason ?? "policy",
              message: REFUSAL_MESSAGE,
            }, null, 2),
          }],
        };
      }
      const msg = err instanceof z.ZodError
        ? `Invalid arguments: ${JSON.stringify(err.issues)}`
        : (err instanceof Error ? err.message : "internal error");
      return { isError: true, content: [{ type: "text", text: msg }] };
    }
  });

  return server;
}

export type HttpOptions = {
  port: number;
  host: string;
  stateless: boolean;
  allowOrigins?: string[];
};

/**
 * Stateful sessions are tracked here so subsequent calls within a session reuse
 * the same Server+Transport pair.
 */
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

export async function startHttp(opts: HttpOptions): Promise<void> {
  await installTls();

  const allowedOrigins = new Set(opts.allowOrigins ?? ["*"]);
  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    } else if (allowedOrigins.has("*")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  };

  const httpServer = createServer(async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Health endpoint for uptime probes / curl smoke
    if (url.pathname === "/health" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        name: NAME,
        version: VERSION,
        tools: TOOLS.length,
        sessions: sessions.size,
        transport: "streamable-http",
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Root: tiny landing
    if (url.pathname === "/" && req.method === "GET") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        `${NAME} v${VERSION} · Streamable HTTP\n\n` +
        `POST /mcp        — MCP Streamable HTTP endpoint\n` +
        `GET  /health     — server health\n` +
        `Tools advertised: ${TOOLS.map((t) => t.name).join(", ")}\n`,
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      res.statusCode = 404;
      res.end("Not Found. See / for endpoint list.");
      return;
    }

    // Read body (small JSON-RPC payloads only)
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = undefined;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        res.statusCode = 400;
        res.end("Invalid JSON body");
        return;
      }
    }

    try {
      if (opts.stateless) {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = buildServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } else {
        await handleStateful(req, res, body);
      }
    } catch (err) {
      process.stderr.write(`[cosmx-mcp http] error: ${(err as Error).stack ?? err}\n`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal server error");
      } else {
        res.end();
      }
    }
  });

  httpServer.listen(opts.port, opts.host, () => {
    const url = `http://${opts.host}:${opts.port}/mcp`;
    process.stderr.write(`[cosmx-mcp] ${NAME} v${VERSION} listening on ${url}\n`);
    process.stderr.write(`[cosmx-mcp] mode: ${opts.stateless ? "stateless" : "stateful"} · tools: ${TOOLS.length}\n`);
    process.stderr.write(`[cosmx-mcp] health: http://${opts.host}:${opts.port}/health\n`);
  });

  async function handleStateful(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sid = (req.headers["mcp-session-id"] as string | undefined) ?? "";

    // Reuse existing session if known
    if (sid && sessions.has(sid)) {
      await sessions.get(sid)!.transport.handleRequest(req, res, body);
      return;
    }

    // Otherwise spin up a new session+server. SDK assigns sessionId during
    // handleRequest (on the initialize call) — register AFTER the call returns.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const server = buildServer();
    await server.connect(transport);

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    await transport.handleRequest(req, res, body);

    if (transport.sessionId) {
      sessions.set(transport.sessionId, { transport, server });
    }
  }

  process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
  process.on("SIGINT", () => httpServer.close(() => process.exit(0)));
}
