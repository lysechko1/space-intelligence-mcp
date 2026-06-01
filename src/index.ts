#!/usr/bin/env node
/**
 * @mcporbital/space-intelligence-mcp — stdio entry.
 *
 * Boots an MCP server with 5 tools, advertising them via the standard
 * `tools/list` + `tools/call` protocol. Designed for Claude Desktop, Cursor,
 * Cline, OpenClaw, and any custom MCP-aware agent loop.
 *
 *   Apache-2.0 — research / simulation / decision-support only.
 *   No live spacecraft commanding. Provenance always-on.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOLS } from "./tools.js";
import { REFUSAL_MESSAGE } from "./safety.js";
import { installTls } from "./setup-tls.js";

const NAME = "@mcporbital/space-intelligence-mcp";
const VERSION = "0.1.0";

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Minimal, dependency-free converter for the shapes we use. Returns an
  // OpenAPI-style JSON Schema object suitable for MCP `inputSchema`.
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
  if (inner instanceof z.ZodArray) {
    return { type: "array", items: zodFieldToSchema(inner._def.type), description };
  }
  if (inner instanceof z.ZodEnum) {
    return { type: "string", enum: inner.options, description };
  }
  if (inner instanceof z.ZodObject) return { ...zodToJsonSchema(inner), description };
  return { description };
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let http = false;
  let port = 8765;
  let host = "127.0.0.1";
  let stateless = false;
  let allowOrigins: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--http") http = true;
    else if (a === "--port" && args[i + 1]) { port = parseInt(args[++i], 10); }
    else if (a.startsWith("--port=")) port = parseInt(a.slice(7), 10);
    else if (a === "--host" && args[i + 1]) host = args[++i];
    else if (a.startsWith("--host=")) host = a.slice(7);
    else if (a === "--stateless") stateless = true;
    else if (a === "--allow-origin" && args[i + 1]) allowOrigins = (allowOrigins ?? []).concat(args[++i]);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
  }
  return { http, port, host, stateless, allowOrigins };
}

const USAGE = `\
${"@mcporbital/space-intelligence-mcp"}

Usage:
  space-intelligence-mcp                   stdio (default — for Claude Desktop / Cursor / Cline)
  space-intelligence-mcp --http            Streamable HTTP on 127.0.0.1:8765
  space-intelligence-mcp --http --port=N --host=0.0.0.0
  space-intelligence-mcp --http --stateless
  space-intelligence-mcp --http --allow-origin https://claude.ai

Flags:
  --http              Switch to Streamable HTTP transport
  --port N            Port for HTTP mode (default 8765)
  --host H            Bind host for HTTP mode (default 127.0.0.1)
  --stateless         Per-request transport — no session memory
  --allow-origin URL  CORS allowlist entry; repeatable; defaults to "*"
  --help, -h          This message

Apache-2.0 — research / simulation / decision-support only. No live commanding.
`;

async function mainStdio() {
  const server = new Server(
    { name: NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Advertise tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  // Dispatch tool calls
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
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
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  schema_version: "1.0",
                  refusal: true,
                  reason: e.reason ?? "policy",
                  message: REFUSAL_MESSAGE,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const msg = err instanceof z.ZodError
        ? `Invalid arguments: ${JSON.stringify(err.issues)}`
        : (err instanceof Error ? err.message : "internal error");
      return { isError: true, content: [{ type: "text", text: msg }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio servers stay alive until the host closes the pipe; nothing else to do here
  process.stderr.write(`[mcporbital-mcp] ${NAME} v${VERSION} — ${TOOLS.length} tools advertised\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  // Trust bundled Mozilla CA roots on developer Macs with stale CA stores.
  await installTls();
  if (args.http) {
    const { startHttp } = await import("./http.js");
    await startHttp({
      port: args.port,
      host: args.host,
      stateless: args.stateless,
      allowOrigins: args.allowOrigins,
    });
    return; // server keeps the process alive
  }
  await mainStdio();
}

main().catch((err) => {
  process.stderr.write(`[mcporbital-mcp] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
