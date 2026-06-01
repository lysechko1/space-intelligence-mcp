/**
 * MCP tools — research / simulation / decision-support catalog.
 *
 *   - search_space_object
 *   - get_object_profile
 *   - get_ephemeris               · real JPL Horizons OBSERVER + VECTORS
 *   - get_asteroid_close_approaches
 *   - get_space_weather_now
 *   - get_satellite_tle           · CelesTrak GP (NORAD/Intl-designator/name/group)
 *   - get_exoplanet_data          · NASA Exoplanet Archive TAP / ADQL
 *   - compare_data_sources        · cross-source diff on a named field
 *
 * Every tool's result envelope includes `provenance[]` so the calling agent can
 * cite primary sources. Sandbox/simulated outputs would set `is_simulation:true`,
 * but none of the current tools produce synthesised values.
 */

import { z } from "zod";
import {
  fetchSBDB,
  fetchCAD,
  searchArxiv,
  fetchSpaceWeather,
  fetchHorizons,
  fetchCelestrak,
  fetchExoplanets,
  fetchSentry,
  fetchCADBulk,
  fetchSentryList,
  type SBDBObject,
  type CloseApproach,
  type ArxivPaper,
  type SpaceWeatherNow,
  type HorizonsResult,
  type TLE,
  type ExoplanetRow,
  type SentryResult,
  type CloseApproachBulkRow,
  type SentryListRow,
} from "./connectors.js";
import type { Provenance } from "./provenance.js";
import { assertSafe } from "./safety.js";

export type ToolResult<T> = {
  schema_version: "1.0";
  result: T;
  provenance: Provenance[];
  disclaimers: string[];
  is_simulation: boolean;
};

/* ────────────────────────────────────────────────────────────────────────── */

export const SearchInput = z.object({
  query: z.string().min(1).max(120).describe("Free-form name, designation, or NORAD ID."),
  limit: z.number().int().min(1).max(50).optional().describe("Max hits (default 10)."),
  class_filter: z.array(z.string()).optional().describe("Optional class filter, e.g. ['asteroid','comet']."),
});

export async function search_space_object(args: z.infer<typeof SearchInput>): Promise<ToolResult<{ hits: any[] }>> {
  const { query, limit = 10 } = args;
  assertSafe(query);
  const { data, provenance } = await fetchSBDB(query);
  const hits = [{
    primary_id: data.primary_id,
    designation: data.designation,
    shortname: data.shortname,
    spk_id: data.spk_id,
    class: data.classification,
  }];
  return {
    schema_version: "1.0",
    result: { hits: hits.slice(0, limit) },
    provenance: [provenance],
    disclaimers: [],
    is_simulation: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */

export const ProfileInput = z.object({
  primary_id: z.string().min(1).describe("Canonical id, designation, or name (e.g. '99942 Apophis')."),
  include: z.array(z.enum(["orbit", "physical", "discovery", "papers"])).optional(),
});

export async function get_object_profile(
  args: z.infer<typeof ProfileInput>,
): Promise<ToolResult<{ object: SBDBObject; papers?: ArxivPaper[] }>> {
  const { primary_id, include = ["orbit", "physical", "discovery", "papers"] } = args;
  assertSafe(primary_id);
  const sbdb = await fetchSBDB(primary_id);
  let papers: ArxivPaper[] = [];
  const allProv: Provenance[] = [sbdb.provenance];
  if (include.includes("papers")) {
    try {
      const arx = await searchArxiv({ query: sbdb.data.shortname, category: "astro-ph.EP", max: 10 });
      papers = arx.data;
      allProv.push(arx.provenance);
    } catch {
      /* arXiv occasionally times out; surface partial result */
    }
  }
  return {
    schema_version: "1.0",
    result: { object: sbdb.data, papers },
    provenance: allProv,
    disclaimers: [],
    is_simulation: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */

export const EphemerisInput = z.object({
  primary_id: z.string().min(1).describe("Target body — SPK-ID, designation, or name (e.g. '99942', 'Apophis')."),
  ephem_type: z.enum(["OBSERVER", "VECTORS"]).optional().describe("OBSERVER = RA/Dec/Mag/Range (default). VECTORS = Cartesian state."),
  start_iso: z.string().optional().describe("ISO-8601 UTC start (default: now)."),
  stop_iso: z.string().optional().describe("ISO-8601 UTC stop (default: +30 days)."),
  step: z.string().optional().describe("Horizons step token: '1 d', '6 h', '15 m'. Default '1 d'."),
  center: z.string().optional().describe("Horizons center code. Default '500@399' (Earth geocenter). Examples: F51 (Pan-STARRS), I11 (Goldstone), 500@10 (heliocenter)."),
  include_keplerian: z.boolean().optional().describe("If true, also return SBDB Keplerian elements at epoch."),
});

/**
 * Real JPL Horizons ephemeris. Returns OBSERVER (RA/Dec/Mag/Range) by default
 * or VECTORS (Cartesian state) on request. Optionally also pulls SBDB
 * Keplerian elements at epoch for legacy clients.
 */
export async function get_ephemeris(args: z.infer<typeof EphemerisInput>): Promise<ToolResult<{
  ephemeris: HorizonsResult;
  keplerian?: { elements: Record<string, number>; epoch_iso: string | null };
}>> {
  assertSafe(args.primary_id);
  const ephem_type = args.ephem_type ?? "OBSERVER";
  const now = new Date();
  const start = args.start_iso ?? now.toISOString().slice(0, 16) + ":00Z";
  const stop = args.stop_iso ?? new Date(now.getTime() + 30 * 86400_000).toISOString().slice(0, 16) + ":00Z";
  const step = args.step ?? "1 d";
  const center = args.center ?? "500@399";

  const ephem = await fetchHorizons({
    primary_id: args.primary_id,
    start_iso: start,
    stop_iso: stop,
    step,
    ephem_type,
    center,
  });

  const allProv = [ephem.provenance];
  let keplerian: { elements: Record<string, number>; epoch_iso: string | null } | undefined;
  if (args.include_keplerian) {
    try {
      const sbdb = await fetchSBDB(args.primary_id);
      keplerian = { elements: sbdb.data.orbit.elements, epoch_iso: sbdb.data.orbit.epoch_iso };
      allProv.push(sbdb.provenance);
    } catch {
      /* SBDB lookup is opportunistic; ephemeris is the primary product */
    }
  }

  return {
    schema_version: "1.0",
    result: { ephemeris: ephem.data, keplerian },
    provenance: allProv,
    disclaimers: ephem.data.notes,
    is_simulation: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */

export const CADInput = z.object({
  primary_id: z.string().min(1).describe("Object designation, e.g. '99942'."),
  date_min: z.string().optional().describe("ISO date (default: -30 years)."),
  date_max: z.string().optional().describe("ISO date (default: +100 years)."),
  dist_max_au: z.number().positive().optional().describe("Max approach distance in AU (default 0.3)."),
  body: z.string().optional().describe("Target body (default: 'Earth')."),
});

export async function get_asteroid_close_approaches(args: z.infer<typeof CADInput>): Promise<ToolResult<{ approaches: CloseApproach[] }>> {
  assertSafe(args.primary_id);
  // Use the numeric portion of the id as the CAD `des` parameter for highest hit rate.
  const numeric = args.primary_id.match(/\d{1,7}/)?.[0] ?? args.primary_id;
  const cad = await fetchCAD({
    des: numeric,
    date_min: args.date_min,
    date_max: args.date_max,
    dist_max: args.dist_max_au,
    body: args.body,
  });
  return {
    schema_version: "1.0",
    result: { approaches: cad.data },
    provenance: [cad.provenance],
    disclaimers: [],
    is_simulation: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */

export const WeatherInput = z.object({
  include_history: z.boolean().optional().describe("Include the recent Kp history (default true)."),
});

export async function get_space_weather_now(_args: z.infer<typeof WeatherInput>): Promise<ToolResult<SpaceWeatherNow>> {
  const { data, provenance } = await fetchSpaceWeather();
  return {
    schema_version: "1.0",
    result: data,
    provenance,
    disclaimers: [
      "Real-time feeds may have gaps; verify against multiple providers for ops decisions.",
    ],
    is_simulation: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */

export const SatelliteTleInput = z.object({
  norad_id: z.number().int().positive().optional().describe("NORAD catalogue number (e.g. 25544 = ISS)."),
  intl_designator: z.string().optional().describe("COSPAR designator (e.g. '1998-067A')."),
  name: z.string().optional().describe("Substring of the object name (case-insensitive)."),
  group: z.string().optional().describe("CelesTrak GROUP (e.g. 'stations', 'starlink', 'gps-ops', 'active', 'weather', 'noaa')."),
});

export async function get_satellite_tle(args: z.infer<typeof SatelliteTleInput>): Promise<ToolResult<{ tle: TLE[] }>> {
  assertSafe(args.name);
  if (args.norad_id !== undefined) {
    const out = await fetchCelestrak({ catnr: args.norad_id });
    return { schema_version: "1.0", result: { tle: out.data }, provenance: [out.provenance], disclaimers: [], is_simulation: false };
  }
  if (args.intl_designator) {
    const out = await fetchCelestrak({ intl_designator: args.intl_designator });
    return { schema_version: "1.0", result: { tle: out.data }, provenance: [out.provenance], disclaimers: [], is_simulation: false };
  }
  if (args.name) {
    const out = await fetchCelestrak({ name: args.name });
    return { schema_version: "1.0", result: { tle: out.data }, provenance: [out.provenance], disclaimers: [], is_simulation: false };
  }
  if (args.group) {
    const out = await fetchCelestrak({ group: args.group });
    return { schema_version: "1.0", result: { tle: out.data }, provenance: [out.provenance], disclaimers: ["Group queries return many rows — narrow with `norad_id` or `name` if you only need one satellite."], is_simulation: false };
  }
  throw new Error("Provide one of: norad_id, intl_designator, name, group.");
}

/* ────────────────────────────────────────────────────────────────────────── */

export const ExoplanetInput = z.object({
  hostname: z.string().optional().describe("Prefix-match the host star name (e.g. 'TRAPPIST-1', 'Kepler-186')."),
  pl_name: z.string().optional().describe("Substring-match the planet name (e.g. 'TRAPPIST-1e')."),
  where: z.string().optional().describe("Raw ADQL WHERE fragment for power users (e.g. 'pl_orbper < 2 and pl_rade < 1.5')."),
  table: z.enum(["ps", "pscomppars", "toi", "k2pandc"]).optional().describe("Which Exoplanet Archive table to query (default 'ps')."),
  limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 25, hard cap 200)."),
});

export async function get_exoplanet_data(args: z.infer<typeof ExoplanetInput>): Promise<ToolResult<{ planets: ExoplanetRow[] }>> {
  assertSafe(args.hostname, args.pl_name, args.where);
  const out = await fetchExoplanets(args);
  return {
    schema_version: "1.0",
    result: { planets: out.data },
    provenance: [out.provenance],
    disclaimers: out.data.length === 0 ? ["No matches — try a broader `hostname` or remove the `where` filter."] : [],
    is_simulation: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */

export const ImpactInput = z.object({
  primary_id: z.string().min(1).describe("Asteroid designation or SPK-ID — e.g. '99942' or '101955'."),
});

export async function get_impact_monitoring(args: z.infer<typeof ImpactInput>): Promise<ToolResult<SentryResult>> {
  assertSafe(args.primary_id);
  const numeric = args.primary_id.match(/\d{1,7}/)?.[0] ?? args.primary_id;
  const out = await fetchSentry(numeric);
  const s = out.data.summary;
  return {
    schema_version: "1.0",
    result: out.data,
    provenance: [out.provenance],
    disclaimers: s.removed
      ? [`Removed from Sentry. ${s.removed_reason ?? "Orbit refined; no impact probability over the published horizon."}`]
      : (s.n_imp === 0 ? ["Not currently on the Sentry risk list."] : []),
    is_simulation: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */

export const CompareInput = z.object({
  primary_id: z.string().min(1).describe("Target body."),
  field: z.enum(["orbit.semi_major_axis", "orbit.eccentricity", "orbit.inclination", "physical.diameter", "physical.density", "physical.albedo"]).describe("Which scalar to compare across sources."),
});

export async function compare_data_sources(args: z.infer<typeof CompareInput>): Promise<ToolResult<{
  field: string;
  values: { source: string; value: number | string | null; uncertainty?: number; units?: string }[];
  agreement: "match" | "small-diff" | "divergent" | "single-source" | "unknown";
}>> {
  assertSafe(args.primary_id);
  const sbdb = await fetchSBDB(args.primary_id);
  const values: { source: string; value: number | string | null; uncertainty?: number; units?: string }[] = [];
  switch (args.field) {
    case "orbit.semi_major_axis": values.push({ source: "JPL SBDB", value: sbdb.data.orbit.elements.a ?? null, units: "AU" }); break;
    case "orbit.eccentricity":    values.push({ source: "JPL SBDB", value: sbdb.data.orbit.elements.e ?? null }); break;
    case "orbit.inclination":     values.push({ source: "JPL SBDB", value: sbdb.data.orbit.elements.i ?? null, units: "deg" }); break;
    case "physical.diameter": {
      const p = sbdb.data.physical["diameter"];
      values.push({ source: "JPL SBDB", value: p ? (typeof p.value === "number" ? p.value : null) : null, uncertainty: p?.sigma, units: "km" });
      break;
    }
    case "physical.density": {
      const p = sbdb.data.physical["density"];
      values.push({ source: "JPL SBDB", value: p ? (typeof p.value === "number" ? p.value : null) : null, uncertainty: p?.sigma, units: "g/cm^3" });
      break;
    }
    case "physical.albedo": {
      const p = sbdb.data.physical["albedo"];
      values.push({ source: "JPL SBDB", value: p ? (typeof p.value === "number" ? p.value : null) : null, uncertainty: p?.sigma });
      break;
    }
  }
  // Future: pull MPC + Sentry + ADS-cited values; for v0.1 SBDB is the canonical anchor.
  const agreement = values.filter((v) => v.value !== null).length <= 1 ? "single-source" : "match";
  return {
    schema_version: "1.0",
    result: { field: args.field, values, agreement },
    provenance: [sbdb.provenance],
    disclaimers: agreement === "single-source"
      ? ["Single-source value — Cosmx v0.2 adds MPC + Sentry + ADS cross-checks."]
      : [],
    is_simulation: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */

export const FindNeosInput = z.object({
  date_min: z.string().optional().describe("ISO date or '+Nd' (default 'now')."),
  date_max: z.string().optional().describe("ISO date or '+Nd' (default '+30')."),
  dist_max_au: z.number().positive().optional().describe("Max miss distance in AU (default 0.05 — about 19.5 lunar distances)."),
  h_max: z.number().optional().describe("Max H magnitude (smaller = larger body). H=22 ≈ 130m; H=18 ≈ 0.9km; H=15 ≈ 4km."),
  pha_only: z.boolean().optional().describe("Restrict to officially designated Potentially Hazardous Asteroids."),
  body: z.string().optional().describe("Target body (default Earth). Examples: Earth, Moon, Mars, Venus."),
  limit: z.number().int().min(1).max(500).optional().describe("Max rows (default 100, hard cap 500)."),
});

export async function find_neos_near_earth(args: z.infer<typeof FindNeosInput>): Promise<ToolResult<{ approaches: CloseApproachBulkRow[]; window: { from: string; to: string }; count: number }>> {
  const out = await fetchCADBulk({
    date_min: args.date_min,
    date_max: args.date_max,
    dist_max: args.dist_max_au,
    h_max: args.h_max,
    pha: args.pha_only,
    body: args.body,
    limit: args.limit,
  });
  return {
    schema_version: "1.0",
    result: {
      approaches: out.data,
      window: { from: args.date_min ?? "now", to: args.date_max ?? "+30" },
      count: out.data.length,
    },
    provenance: [out.provenance],
    disclaimers: out.data.length === 0 ? ["No matches in the requested window. Try widening dist_max_au or extending date_max."] : [],
    is_simulation: false,
  };
}

export const TopRisksInput = z.object({
  ip_min: z.number().optional().describe("Minimum cumulative impact probability (default: include all)."),
  ps_min: z.number().optional().describe("Minimum Palermo scale (e.g. -3 to filter out the deepest-background entries)."),
  h_max: z.number().optional().describe("Max H magnitude (smaller = larger object). H=22 ≈ 130m."),
  limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 25)."),
});

export async function top_sentry_risks(args: z.infer<typeof TopRisksInput>): Promise<ToolResult<{ risks: SentryListRow[]; count: number }>> {
  const out = await fetchSentryList(args);
  return {
    schema_version: "1.0",
    result: { risks: out.data, count: out.data.length },
    provenance: [out.provenance],
    disclaimers: [
      "Sentry rankings update as new astrometry refines orbits — re-run for current state. Cleared objects (e.g. Apophis 2021) drop out of this list.",
    ],
    is_simulation: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */

export const TOOLS = [
  {
    name: "search_space_object",
    description: "Resolve a free-form query to one or more canonical space objects via JPL SBDB.",
    inputSchema: SearchInput,
    handler: search_space_object,
  },
  {
    name: "get_object_profile",
    description: "Return a full object profile (orbit + physical + discovery + recent papers) from SBDB + arXiv.",
    inputSchema: ProfileInput,
    handler: get_object_profile,
  },
  {
    name: "get_ephemeris",
    description: "JPL Horizons OBSERVER (RA / Dec / App.Mag / Range) or VECTORS (Cartesian state) ephemeris over a window. Supports topocentric sites (Pan-STARRS F51, Goldstone I11, ATLAS T05/G37, ZTF Z18) and barycentric / heliocentric / L2 centers.",
    inputSchema: EphemerisInput,
    handler: get_ephemeris,
  },
  {
    name: "get_asteroid_close_approaches",
    description: "Past + future close approaches for an asteroid/comet from JPL CAD (CNEOS).",
    inputSchema: CADInput,
    handler: get_asteroid_close_approaches,
  },
  {
    name: "get_space_weather_now",
    description: "Current Kp / Bz / solar wind / GOES X-ray snapshot from NOAA SWPC + DSCOVR.",
    inputSchema: WeatherInput,
    handler: get_space_weather_now,
  },
  {
    name: "get_satellite_tle",
    description: "Latest TLE / OMM orbital elements for any satellite or piece of catalogued debris from CelesTrak GP. Query by NORAD ID, international designator, name substring, or CelesTrak group (e.g. 'stations', 'starlink', 'gps-ops').",
    inputSchema: SatelliteTleInput,
    handler: get_satellite_tle,
  },
  {
    name: "get_exoplanet_data",
    description: "ADQL query against the NASA Exoplanet Archive — `ps` (confirmed planets), `pscomppars` (composite parameters), `toi` (TESS candidates), `k2pandc` (K2). Filter by host star, planet name, or a raw WHERE fragment.",
    inputSchema: ExoplanetInput,
    handler: get_exoplanet_data,
  },
  {
    name: "compare_data_sources",
    description: "Cross-source comparison for a named scalar (orbit.semi_major_axis, physical.diameter, etc.). v0.1 anchors on JPL SBDB; v0.2 adds MPC + Sentry + ADS.",
    inputSchema: CompareInput,
    handler: compare_data_sources,
  },
  {
    name: "get_impact_monitoring",
    description: "JPL Sentry impact-monitoring data for a NEO — cumulative impact probability (IP_cum), Palermo scale (PS_cum), Torino, per-date virtual impactors. Use for planetary-defense workflows. Returns 'removed' status with rationale for cleared objects like Apophis.",
    inputSchema: ImpactInput,
    handler: get_impact_monitoring,
  },
  {
    name: "find_neos_near_earth",
    description: "Bulk JPL CAD query — list all upcoming close approaches in a window. Daily-check workflow: 'What's incoming this week within 0.05 AU?' Filter by max distance (AU), max H magnitude (smaller H = larger), PHA-only flag. Returns objects sorted by date, with designation, fullname, miss distance, relative velocity, and H magnitude.",
    inputSchema: FindNeosInput,
    handler: find_neos_near_earth,
  },
  {
    name: "top_sentry_risks",
    description: "List-mode JPL Sentry — top NEOs on the impact risk list, sorted by cumulative impact probability descending. Planetary-defense scientists' top-risk dashboard. Filter by minimum IP, Palermo scale, or maximum H magnitude.",
    inputSchema: TopRisksInput,
    handler: top_sentry_risks,
  },
] as const;
