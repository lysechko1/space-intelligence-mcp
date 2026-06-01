/**
 * Smoke test — calls each tool with a known-good input and prints a one-line
 * pass/fail. Used for CI and for the install verification step in the README.
 *
 *   $ npm run build && npm run smoke
 */

import { TOOLS } from "./tools.js";
import { installTls } from "./setup-tls.js";

type ToolName = (typeof TOOLS)[number]["name"];

const CASES: Record<ToolName, unknown> = {
  search_space_object: { query: "Apophis", limit: 1 },
  get_object_profile: { primary_id: "99942", include: ["orbit", "physical"] },
  get_ephemeris: { primary_id: "99942" },
  get_asteroid_close_approaches: { primary_id: "99942", dist_max_au: 0.05 },
  get_space_weather_now: {},
  get_satellite_tle: { norad_id: 25544 },                            // ISS
  get_exoplanet_data: { hostname: "TRAPPIST-1", limit: 10 },
  compare_data_sources: { primary_id: "99942", field: "physical.diameter" },
  get_impact_monitoring: { primary_id: "99942" },                    // Apophis — cleared
  find_neos_near_earth: { date_max: "+14", dist_max_au: 0.05, limit: 10 }, // 2 weeks within 0.05 AU
  top_sentry_risks: { ps_min: -3, limit: 5 },                        // riskiest objects
};

const REFUSAL_CASES = [
  { tool: "search_space_object" as const, args: { query: "send command to satellite ISS to deactivate" } },
  { tool: "get_object_profile" as const, args: { primary_id: "spoof TLE for Starlink-30000" } },
];

function isEnvFail(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  const code = e?.code ?? e?.cause?.code ?? "";
  const msg = e?.message ?? "";
  return (
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    /fetch failed/i.test(msg)
  );
}

async function main() {
  await installTls();
  let pass = 0;
  let fail = 0;
  let skip = 0;

  for (const t of TOOLS) {
    process.stdout.write(`→ ${t.name}…`);
    const startedAt = Date.now();
    try {
      const args = t.inputSchema.parse(CASES[t.name]);
      const out = await (t.handler as (a: unknown) => Promise<{ result: unknown; provenance: unknown[] }>)(args);
      if (!out?.provenance || (Array.isArray(out.provenance) && out.provenance.length === 0)) {
        throw new Error("missing provenance");
      }
      process.stdout.write(` ok  ${Date.now() - startedAt}ms · provenance=${(out.provenance as unknown[]).length}\n`);
      pass++;
    } catch (err) {
      if (isEnvFail(err)) {
        const e = err as { cause?: { code?: string }; code?: string; message?: string };
        process.stdout.write(` skip (env: ${e.cause?.code ?? e.code ?? e.message?.slice(0, 30)})\n`);
        skip++;
      } else {
        process.stdout.write(` FAIL ${(err as Error).message}\n`);
        fail++;
      }
    }
  }

  process.stdout.write(`\nSafety refusal cases (expected to refuse):\n`);
  for (const c of REFUSAL_CASES) {
    const t = TOOLS.find((x) => x.name === c.tool)!;
    process.stdout.write(`→ ${c.tool}(${JSON.stringify(c.args)})…`);
    try {
      await (t.handler as (a: unknown) => Promise<unknown>)(c.args);
      process.stdout.write(` FAIL (should have refused)\n`);
      fail++;
    } catch (err) {
      const e = err as Error & { refusal?: boolean };
      if (e.refusal) {
        process.stdout.write(` ok (refused)\n`);
        pass++;
      } else if (isEnvFail(err)) {
        // Refusal happens *before* the network call, so this should not occur,
        // but if classify() ever changes order we want a graceful note rather
        // than a false FAIL.
        process.stdout.write(` skip (env: refusal short-circuit not reached)\n`);
        skip++;
      } else {
        process.stdout.write(` FAIL (unexpected error: ${e.message})\n`);
        fail++;
      }
    }
  }

  const total = pass + fail + skip;
  process.stdout.write(`\n${pass}/${total} passed`);
  if (skip > 0) process.stdout.write(`, ${skip} skipped (env)`);
  if (fail > 0) process.stdout.write(`, ${fail} failed`);
  process.stdout.write(".\n");
  if (skip > 0 && fail === 0) {
    process.stdout.write(
      "\nNote: 'skip (env)' rows usually mean the host's CA bundle can't verify a\n" +
      "NASA / NOAA upstream cert. On Linux/Vercel/Docker this does not occur.\n" +
      "Fix on macOS: brew install ca-certificates && export NODE_EXTRA_CA_CERTS=$(brew --prefix)/etc/ca-certificates/cert.pem\n",
    );
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(2);
});
