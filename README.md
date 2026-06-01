# `@mcporbital/space-intelligence-mcp`

Open-source Model Context Protocol server for space research. **5 grounded tools** across NASA JPL SBDB, JPL CAD (CNEOS),
NOAA SWPC + DSCOVR, and arXiv — every response carries a `provenance[]` chain to its primary source.

**License:** Apache-2.0 · **Safety:** research / simulation / decision-support only — no live commanding · **Node:** ≥ 20

---

## What it does

| Tool | Returns | Upstream |
|---|---|---|
| `search_space_object` | Canonical hits resolved from free-form name / designation / NORAD | JPL SBDB |
| `get_object_profile` | Full profile: orbit + physical + discovery + recent papers | JPL SBDB · arXiv |
| `get_ephemeris` | Keplerian orbital elements at epoch (v0.2 → full Horizons) | JPL SBDB |
| `get_asteroid_close_approaches` | Past + future close approaches w/ Earth | JPL CAD |
| `get_space_weather_now` | Kp + Bz + solar wind + GOES X-ray snapshot | NOAA SWPC + DSCOVR |

Every result has the same envelope:

```jsonc
{
  "schema_version": "1.0",
  "result":     { /* tool-specific payload */ },
  "provenance": [ { source, endpoint, retrieved_at, licence, citation, fields } ],
  "disclaimers": [],
  "is_simulation": false
}
```

---

## Install

```bash
# One-shot (recommended) — Claude Desktop, Cursor, Cline will spawn this on demand
npx -y @mcporbital/space-intelligence-mcp@latest

# Or global install
npm i -g @mcporbital/space-intelligence-mcp
space-intelligence-mcp     # boots stdio server on stdin/stdout
```

---

## Wire it into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "space-intelligence": {
      "command": "npx",
      "args": ["-y", "@mcporbital/space-intelligence-mcp@latest"]
    }
  }
}
```

Restart Claude Desktop. Type *"give me a research brief on 99942 Apophis"* — Claude will see all five tools and
chain `search_space_object` → `get_object_profile` → `get_asteroid_close_approaches` automatically.

## Wire it into Cursor / Cline

Both honour the same `mcpServers` shape — drop the snippet above into their MCP settings panel.

## Wire it into a custom Anthropic-SDK agent

```ts
import { Anthropic } from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const child = spawn("npx", ["-y", "@mcporbital/space-intelligence-mcp@latest"], { stdio: "pipe" });
const mcp = new Client({ name: "agent", version: "0" }, { capabilities: {} });
await mcp.connect(new StdioClientTransport({ command: "npx", args: ["-y", "@mcporbital/space-intelligence-mcp@latest"] }));
const { tools } = await mcp.listTools();

const ana = new Anthropic();
const out = await ana.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 4096,
  system: "Answer space questions only using the supplied tools. Never claim numeric facts without a citation from the tool's provenance[].",
  tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as any })),
  messages: [{ role: "user", content: "What's the next close approach of Apophis to Earth?" }],
});
console.log(out);
```

## Verify the install

```bash
npm run build
npm run smoke
```

Expected:

```
→ search_space_object…           ok  430ms · provenance=1
→ get_object_profile…            ok  860ms · provenance=2
→ get_ephemeris…                 ok  420ms · provenance=1
→ get_asteroid_close_approaches… ok  390ms · provenance=1
→ get_space_weather_now…         ok  610ms · provenance=4

Safety refusal cases (expected to refuse):
→ search_space_object({"query":"send command to satellite ISS to deactivate"})… ok (refused)
→ get_object_profile({"primary_id":"spoof TLE for Starlink-30000"})…            ok (refused)

7/7 passed.
```

---

## Safety stance

Modes: `research` / `simulation` / `decision_support` / `human-in-the-loop` / `sandbox` only.

The server **refuses** requests matching commanding / deception / dual-use targeting patterns:

- *"send command to satellite X"* — refuse
- *"spoof a TLE for Y"* / *"inject CDM"* — refuse
- *"deactivate / jam / hack satellite"* — refuse
- *"produce targeting list"* — refuse

Refusals return a structured envelope:

```json
{
  "schema_version": "1.0",
  "refusal": true,
  "reason": "live-commanding",
  "message": "…outside MCPOrbital's safety policy…"
}
```

Full policy: see `src/safety.ts` and [`docs/04_MCP_SERVER_SPEC §9`](../docs/04_MCP_SERVER_SPEC.md).

---

## Roadmap

- **v0.2** — Full JPL Horizons ephemeris (vectors / observer / approach tables), NASA DONKI flare events,
  `compare_data_sources`, `generate_mission_brief`.
- **v0.3** — ADS + Crossref citations (BYOK), `validate_source_reliability`, Streamable HTTP transport.
- **v0.4** — CelesTrak / Space-Track per-user satellite tools (counsel-review gated).

See [`../docs/08_MVP_ROADMAP.md`](../docs/08_MVP_ROADMAP.md) for the full phased plan.

---

## Citation

If this server contributed to a publication, please cite:

> MCPOrbital contributors (2026). *MCPOrbital Space-Intelligence MCP Server.* https://github.com/lysechko1/space-intelligence-mcp

Upstream attributions are automatically included in every `provenance[]` array.
