/**
 * Programmatic CA-bundle loader for the standalone MCP server.
 *
 * Side-effect import: replaces undici's global dispatcher with one that trusts
 * the Mozilla CA roots vendored at `<package-root>/ca-bundle.pem`. This avoids
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` against JPL endpoints on developer
 * machines with stale system CA stores (e.g. some macOS installations).
 *
 * Falls back silently when undici or the bundle are unavailable — the server
 * keeps working with the default Node TLS trust store, which is correct on
 * Linux / Docker / Vercel.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Look for ca-bundle.pem in package root (one level above dist/) and one above
// (when running from source via tsx/ts-node).
const CANDIDATES = [
  resolve(HERE, "..", "ca-bundle.pem"),       // ../ from dist/ → package root
  resolve(HERE, "..", "..", "ca-bundle.pem"), // ../../ from src/ → package root
];

let _installed = false;

export async function installTls(): Promise<void> {
  if (_installed) return;
  const path = CANDIDATES.find((p) => existsSync(p));
  if (!path) return;
  try {
    // Dynamic import keeps the module optional — if undici isn't installed
    // (Node ≥20.2 has it as a builtin), this just no-ops.
    const undici = await import("undici").catch(() => null);
    if (!undici || !undici.Agent || !undici.setGlobalDispatcher) return;
    const ca = readFileSync(path, "utf8");
    undici.setGlobalDispatcher(
      new undici.Agent({
        connect: { ca },
        connectTimeout: 10_000,
        headersTimeout: 12_000,
        bodyTimeout: 20_000,
      }),
    );
    _installed = true;
  } catch {
    /* leave default TLS trust */
  }
}
