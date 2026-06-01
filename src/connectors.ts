/**
 * Inline connector layer for the MCP server. Self-contained — no shared package
 * dependency on the web app. Each fetcher returns `{data, provenance}` and is
 * polite to upstreams (UA, JSON accept, structured errors).
 */

import { upstreamFetch, newProvenance, type Provenance } from "./provenance.js";

const AU_KM = 149_597_870.7;

/* ────────────────────────────────────────────────────────────────────────── */
/* JPL SBDB                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export type SBDBObject = {
  primary_id: string;
  shortname: string;
  designation: string;
  spk_id: number | null;
  classification: { kind: string; neo: boolean; pha: boolean; orbit_class: string | null };
  orbit: {
    epoch_jd: number | null;
    epoch_iso: string | null;
    elements: Record<string, number>;
  };
  physical: Record<string, { value: number | string; sigma?: number; ref?: string; units?: string }>;
  discovery?: { date: string; site: string; who: string };
};

export async function fetchSBDB(query: string): Promise<{ data: SBDBObject; provenance: Provenance }> {
  const url = new URL("https://ssd-api.jpl.nasa.gov/sbdb.api");
  url.searchParams.set("sstr", query);
  url.searchParams.set("phys-par", "1");
  url.searchParams.set("full-prec", "1");
  url.searchParams.set("discovery", "1");

  const res = await upstreamFetch(url.toString(), "JPL SBDB");
  const raw = await res.json() as any;

  const obj = raw.object ?? {};
  const elements: Record<string, number> = {};
  for (const e of (raw.orbit?.elements ?? []) as any[]) {
    const v = parseFloat(e.value);
    if (Number.isFinite(v)) elements[e.name] = v;
  }
  const physical: SBDBObject["physical"] = {};
  for (const p of (raw.phys_par ?? []) as any[]) {
    const v = parseFloat(p.value);
    physical[p.name] = {
      value: Number.isFinite(v) ? v : p.value,
      sigma: p.sigma ? parseFloat(p.sigma) : undefined,
      ref: p.ref,
      units: p.units,
    };
  }
  const epoch_jd = raw.orbit?.epoch ? parseFloat(raw.orbit.epoch) : null;

  const data: SBDBObject = {
    primary_id: obj.fullname ?? obj.shortname ?? query,
    shortname: obj.shortname ?? obj.fullname ?? query,
    designation: obj.des ?? "",
    spk_id: obj.spkid ? parseInt(obj.spkid, 10) : null,
    classification: {
      kind: obj.kind ?? "",
      neo: Boolean(obj.neo),
      pha: Boolean(obj.pha),
      orbit_class: obj.orbit_class?.name ?? obj.orbit_class?.code ?? null,
    },
    orbit: {
      epoch_jd,
      epoch_iso: epoch_jd ? jdToISO(epoch_jd) : null,
      elements,
    },
    physical,
    discovery: raw.discovery
      ? { date: raw.discovery.date ?? "", site: raw.discovery.site ?? "", who: raw.discovery.who ?? "" }
      : undefined,
  };

  return {
    data,
    provenance: newProvenance({
      source: "JPL SBDB",
      endpoint: url.toString(),
      licence: "PD-USG",
      citation: `NASA/JPL Solar System Dynamics, Small-Body Database (accessed ${new Date().toISOString().slice(0, 10)}).`,
      fields: ["primary_id", "designation", "orbit", "physical", "discovery", "classification"],
    }),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* JPL Horizons                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

export type EphemerisRowObs = {
  kind: "OBSERVER";
  epoch_iso: string;
  ra_deg: number | null;
  dec_deg: number | null;
  apparent_mag: number | null;
  surface_brightness: number | null;
  range_au: number | null;
  range_rate_km_s: number | null;
};
export type EphemerisRowVec = {
  kind: "VECTORS";
  jd_tdb: number;
  epoch_iso: string;
  x_km: number;
  y_km: number;
  z_km: number;
  vx_km_s: number;
  vy_km_s: number;
  vz_km_s: number;
};
export type EphemerisRow = EphemerisRowObs | EphemerisRowVec;

export type HorizonsQuery = {
  primary_id: string;
  start_iso: string;
  stop_iso: string;
  step: string;
  ephem_type: "OBSERVER" | "VECTORS";
  center: string;
};

export type HorizonsResult = {
  target_name: string;
  center_name: string;
  frame: string;
  rows: EphemerisRow[];
  notes: string[];
};

export async function fetchHorizons(q: HorizonsQuery): Promise<{ data: HorizonsResult; provenance: Provenance }> {
  const u = new URL("https://ssd.jpl.nasa.gov/api/horizons.api");
  u.searchParams.set("format", "json");
  u.searchParams.set("COMMAND", `'${q.primary_id}'`);
  u.searchParams.set("OBJ_DATA", "'NO'");
  u.searchParams.set("MAKE_EPHEM", "'YES'");
  u.searchParams.set("EPHEM_TYPE", `'${q.ephem_type}'`);
  u.searchParams.set("CENTER", `'${q.center}'`);
  u.searchParams.set("START_TIME", `'${q.start_iso}'`);
  u.searchParams.set("STOP_TIME", `'${q.stop_iso}'`);
  u.searchParams.set("STEP_SIZE", `'${q.step}'`);
  u.searchParams.set("CSV_FORMAT", "'YES'");
  u.searchParams.set("REF_SYSTEM", "'ICRF'");
  if (q.ephem_type === "OBSERVER") {
    u.searchParams.set("QUANTITIES", "'1,9,20'");
    u.searchParams.set("ANG_FORMAT", "'DEG'");
    u.searchParams.set("APPARENT", "'AIRLESS'");
    u.searchParams.set("RANGE_UNITS", "'AU'");
    u.searchParams.set("TIME_DIGITS", "'MINUTES'");
  } else {
    u.searchParams.set("VEC_TABLE", "'3'");
    u.searchParams.set("OUT_UNITS", "'KM-S'");
    u.searchParams.set("REF_PLANE", "'FRAME'");
  }
  const res = await upstreamFetch(u.toString(), "JPL Horizons");
  const json = (await res.json()) as { result?: string };
  const text = json.result ?? "";

  const target_name = match1(text, /Target body name:\s*([^\n{]+?)(?:\s*\{|\n)/) ?? q.primary_id;
  const center_name = match1(text, /Center body name:\s*([^\n{]+?)(?:\s*\{|\n)/) ?? q.center;
  const frame = match1(text, /Reference frame:\s*([^\n]+)/) ?? "ICRF/J2000.0";

  const notes: string[] = [];
  const block = matchBetween(text, "$$SOE", "$$EOE");
  const rows: EphemerisRow[] = [];
  if (block) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const cells = line.split(",").map((c) => c.trim());
      if (q.ephem_type === "OBSERVER") {
        // Fixed-position columns from QUANTITIES='1,9,20':
        //   0:Date · 1:SunFlag · 2:TargetFlag · 3:RA · 4:Dec · 5:APmag · 6:S-brt · 7:Delta · 8:Deldot
        const date = parseCDDate(cells[0]);
        const parse = (idx: number) => {
          const n = parseFloat(cells[idx] ?? "");
          return Number.isFinite(n) ? n : null;
        };
        const ra = parse(3);
        const dec = parse(4);
        const range = parse(7);
        if (ra === null || dec === null || range === null) continue;
        rows.push({
          kind: "OBSERVER",
          epoch_iso: date,
          ra_deg: ra,
          dec_deg: dec,
          apparent_mag: parse(5),
          surface_brightness: parse(6),
          range_au: range,
          range_rate_km_s: parse(8),
        });
      } else {
        const jd = Number(cells[0]);
        const date = parseCDDate(cells[1]);
        const nums = cells.slice(2).map((c) => Number(c));
        if (!Number.isFinite(jd) || nums.slice(0, 6).some((n) => !Number.isFinite(n))) continue;
        rows.push({
          kind: "VECTORS",
          jd_tdb: jd,
          epoch_iso: date,
          x_km: nums[0],
          y_km: nums[1],
          z_km: nums[2],
          vx_km_s: nums[3],
          vy_km_s: nums[4],
          vz_km_s: nums[5],
        });
      }
    }
  } else if (/No ephemeris/i.test(text)) {
    notes.push("Horizons reports no ephemeris available for the requested target/window.");
  } else {
    notes.push("Horizons returned no $$SOE/$$EOE data block — query likely invalid.");
  }

  return {
    data: { target_name, center_name, frame, rows, notes },
    provenance: newProvenance({
      source: "JPL Horizons",
      endpoint: u.toString(),
      licence: "PD-USG",
      citation: `NASA/JPL Solar System Dynamics, Horizons On-Line Ephemeris System (accessed ${new Date().toISOString().slice(0, 10)}).`,
      fields: ["rows", "frame", "target_name", "center_name"],
    }),
  };
}

function match1(s: string, re: RegExp): string | null {
  const m = s.match(re);
  return m ? m[1].trim() : null;
}
function matchBetween(s: string, a: string, b: string): string | null {
  const i = s.indexOf(a);
  if (i < 0) return null;
  const j = s.indexOf(b, i + a.length);
  if (j < 0) return null;
  return s.slice(i + a.length, j);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* JPL CAD                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export type CloseApproach = {
  body: string;
  date_utc: string;
  miss_distance_au: number;
  miss_distance_km: number;
  relative_velocity_km_s: number;
  source: "JPL CAD";
};

export async function fetchCAD(opts: {
  des: string;
  date_min?: string;
  date_max?: string;
  dist_max?: number;
  body?: string;
}): Promise<{ data: CloseApproach[]; provenance: Provenance }> {
  const url = new URL("https://ssd-api.jpl.nasa.gov/cad.api");
  url.searchParams.set("des", opts.des);
  url.searchParams.set("date-min", opts.date_min ?? yearsFromNow(-30));
  url.searchParams.set("date-max", opts.date_max ?? yearsFromNow(100));
  url.searchParams.set("dist-max", String(opts.dist_max ?? 0.3));
  if (opts.body) url.searchParams.set("body", opts.body);

  const res = await upstreamFetch(url.toString(), "JPL CAD");
  const raw = await res.json() as any;
  const fields: string[] = raw.fields ?? [];
  const idx = (n: string) => fields.indexOf(n);
  const i_cd = idx("cd");
  const i_dist = idx("dist");
  const i_vrel = idx("v_rel");
  const i_body = idx("body");

  const data: CloseApproach[] = (raw.data ?? []).map((r: string[]) => {
    const dist_au = parseFloat(r[i_dist] ?? "0");
    return {
      body: r[i_body] ?? opts.body ?? "Earth",
      date_utc: parseCDDate(r[i_cd] ?? ""),
      miss_distance_au: dist_au,
      miss_distance_km: dist_au * AU_KM,
      relative_velocity_km_s: parseFloat(r[i_vrel] ?? "0"),
      source: "JPL CAD",
    };
  });

  return {
    data,
    provenance: newProvenance({
      source: "JPL CAD",
      endpoint: url.toString(),
      licence: "PD-USG",
      citation: `NASA/JPL CNEOS, Close-Approach Data (accessed ${new Date().toISOString().slice(0, 10)}).`,
      fields: ["close_approaches"],
    }),
  };
}

export type CloseApproachBulkRow = CloseApproach & {
  designation: string;
  fullname: string;
  h_mag: number | null;
};

export async function fetchCADBulk(opts: {
  date_min?: string;
  date_max?: string;
  dist_max?: number;
  h_max?: number;
  pha?: boolean;
  body?: string;
  limit?: number;
}): Promise<{ data: CloseApproachBulkRow[]; provenance: Provenance }> {
  const url = new URL("https://ssd-api.jpl.nasa.gov/cad.api");
  url.searchParams.set("date-min", opts.date_min ?? "now");
  url.searchParams.set("date-max", opts.date_max ?? "+30");
  url.searchParams.set("dist-max", String(opts.dist_max ?? 0.05));
  if (opts.h_max !== undefined) url.searchParams.set("h-max", String(opts.h_max));
  if (opts.pha) url.searchParams.set("pha", "true");
  if (opts.body) url.searchParams.set("body", opts.body);
  url.searchParams.set("sort", "date");
  url.searchParams.set("fullname", "true");

  const res = await upstreamFetch(url.toString(), "JPL CAD");
  const raw = await res.json() as any;
  const fields: string[] = raw.fields ?? [];
  const idx = (n: string) => fields.indexOf(n);
  const i_des = idx("des");
  const i_cd = idx("cd");
  const i_dist = idx("dist");
  const i_vrel = idx("v_rel");
  const i_body = idx("body");
  const i_h = idx("h");
  const i_full = idx("fullname");

  const limit = Math.min(opts.limit ?? 100, 500);
  const data: CloseApproachBulkRow[] = (raw.data ?? []).slice(0, limit).map((r: string[]) => {
    const dist_au = parseFloat(r[i_dist] ?? "0");
    const h = i_h >= 0 ? parseFloat(r[i_h] ?? "") : NaN;
    return {
      body: r[i_body] ?? opts.body ?? "Earth",
      date_utc: parseCDDate(r[i_cd] ?? ""),
      miss_distance_au: dist_au,
      miss_distance_km: dist_au * AU_KM,
      relative_velocity_km_s: parseFloat(r[i_vrel] ?? "0"),
      source: "JPL CAD" as const,
      designation: r[i_des] ?? "",
      fullname: i_full >= 0 ? (r[i_full] ?? r[i_des] ?? "") : (r[i_des] ?? ""),
      h_mag: Number.isFinite(h) ? h : null,
    };
  });

  return {
    data,
    provenance: newProvenance({
      source: "JPL CAD",
      endpoint: url.toString(),
      licence: "PD-USG",
      citation: `NASA/JPL CNEOS Close-Approach Data — bulk feed (accessed ${new Date().toISOString().slice(0, 10)}).`,
      fields: ["close_approaches_bulk"],
    }),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* arXiv                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

export type ArxivPaper = {
  title: string;
  abstract: string;
  authors: string[];
  year: number;
  url: string;
  arxiv_id: string;
  doi?: string;
  journal?: string;
};

export async function searchArxiv(opts: {
  query: string;
  category?: string;
  max?: number;
}): Promise<{ data: ArxivPaper[]; provenance: Provenance }> {
  const max = Math.min(opts.max ?? 10, 50);
  const cat = opts.category ?? "astro-ph.EP";
  const url = `https://export.arxiv.org/api/query?search_query=cat:${cat}+AND+all:${encodeURIComponent(opts.query)}&start=0&max_results=${max}&sortBy=submittedDate&sortOrder=descending`;
  const res = await upstreamFetch(url, "arXiv");
  const xml = await res.text();

  const data: ArxivPaper[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const tag = (n: string) => {
      const r = new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(block);
      return r ? decode(r[1].trim()) : "";
    };
    const title = tag("title").replace(/\s+/g, " ");
    if (!title) continue;
    const idTag = tag("id");
    const arxiv_id = idTag.replace(/^https?:\/\/arxiv\.org\/abs\//, "").split("v")[0];
    const authors: string[] = [];
    const authRe = /<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g;
    let am: RegExpExecArray | null;
    while ((am = authRe.exec(block)) !== null) authors.push(decode(am[1].trim()));

    const doiM = block.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/);
    const jM = block.match(/<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/);
    const published = tag("published");

    data.push({
      title,
      abstract: tag("summary").replace(/\s+/g, " "),
      authors,
      year: published ? new Date(published).getUTCFullYear() : new Date().getUTCFullYear(),
      url: idTag || `https://arxiv.org/abs/${arxiv_id}`,
      arxiv_id,
      doi: doiM ? decode(doiM[1].trim()) : undefined,
      journal: jM ? decode(jM[1].trim()) : "arXiv preprint",
    });
  }

  return {
    data,
    provenance: newProvenance({
      source: "arXiv",
      endpoint: url,
      licence: "arXiv-API-ToU",
      citation: "Thank you to arXiv for use of its open access interoperability.",
      fields: ["papers"],
    }),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* JPL Sentry — long-term impact monitoring                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export type SentrySummary = {
  des: string;
  fullname: string;
  ip_cum: number;
  ps_cum: number;
  ts_max: number | null;
  n_imp: number;
  diameter_km: number | null;
  removed: boolean;
  removed_reason?: string;
};
export type SentryImpact = {
  date_iso: string;
  ip: number;
  energy_mt: number | null;
  palermo: number | null;
  torino: number | null;
};
export type SentryResult = { summary: SentrySummary; impacts: SentryImpact[] };

/**
 * Note on `removed`: the Sentry API rejects `removed=1` when combined with
 * `des` (mode-O). Object-by-designation queries must omit it.
 */
export async function fetchSentry(des: string): Promise<{ data: SentryResult; provenance: Provenance }> {
  const u = new URL("https://ssd-api.jpl.nasa.gov/sentry.api");
  u.searchParams.set("des", des);
  const res = await upstreamFetch(u.toString(), "JPL Sentry");
  const raw = await res.json() as any;
  const sum = raw.summary ?? {};
  const data: SentryResult = {
    summary: {
      des: sum.des ?? des,
      fullname: sum.fullname ?? des,
      ip_cum: numOr0(sum.ip ?? sum.ip_cum),
      ps_cum: numOr0(sum.ps_cum),
      ts_max: numOrNull(sum.ts_max),
      n_imp: Math.round(numOr0(sum.n_imp)),
      diameter_km: numOrNull(sum.diameter),
      removed: Boolean(sum.removed),
      removed_reason: sum.removed_reason,
    },
    impacts: Array.isArray(raw.data) ? raw.data.map((r: any) => ({
      date_iso: parseSentryDate(r.date ?? r.date_calc ?? ""),
      ip: numOr0(r.ip),
      energy_mt: numOrNull(r.energy),
      palermo: numOrNull(r.ps),
      torino: numOrNull(r.ts),
    })) : [],
  };
  return {
    data,
    provenance: newProvenance({
      source: "JPL Sentry",
      endpoint: u.toString(),
      licence: "PD-USG",
      citation: `NASA/JPL CNEOS Sentry (accessed ${new Date().toISOString().slice(0, 10)}).`,
      fields: ["impact_monitoring"],
    }),
  };
}

function numOr0(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseSentryDate(s: string): string {
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?/);
  if (!m) return s;
  const frac = m[4] ? parseFloat("0." + m[4]) : 0;
  const sec = Math.round(frac * 86400);
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return `${m[1]}-${m[2]}-${m[3]}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}Z`;
}
function pad2(n: number) { return String(n).padStart(2, "0"); }

export type SentryListRow = {
  des: string;
  fullname: string;
  ip_cum: number;
  ps_cum: number;
  ts_max: number | null;
  n_imp: number;
  diameter_km: number | null;
  v_inf_km_s: number | null;
};

export async function fetchSentryList(opts: {
  ip_min?: number;
  ps_min?: number;
  h_max?: number;
  limit?: number;
} = {}): Promise<{ data: SentryListRow[]; provenance: Provenance }> {
  const u = new URL("https://ssd-api.jpl.nasa.gov/sentry.api");
  if (opts.ip_min !== undefined) u.searchParams.set("ip-min", String(opts.ip_min));
  if (opts.ps_min !== undefined) u.searchParams.set("ps-min", String(opts.ps_min));
  if (opts.h_max !== undefined) u.searchParams.set("h-max", String(opts.h_max));
  const res = await upstreamFetch(u.toString(), "JPL Sentry");
  const raw = await res.json() as any;
  const rows: any[] = Array.isArray(raw.data) ? raw.data : [];
  const limit = Math.min(opts.limit ?? 50, 200);
  const data: SentryListRow[] = rows.slice(0, limit).map((r) => ({
    des: String(r.des ?? ""),
    fullname: String(r.fullname ?? r.des ?? ""),
    ip_cum: numOr0(r.ip ?? r.ip_cum),
    ps_cum: numOr0(r.ps_cum ?? r.ps_max),
    ts_max: numOrNull(r.ts_max),
    n_imp: Math.round(numOr0(r.n_imp)),
    diameter_km: numOrNull(r.diameter),
    v_inf_km_s: numOrNull(r.v_inf),
  }));
  data.sort((a, b) => b.ip_cum - a.ip_cum);
  return {
    data,
    provenance: newProvenance({
      source: "JPL Sentry",
      endpoint: u.toString(),
      licence: "PD-USG",
      citation: `NASA/JPL CNEOS Sentry risk list (accessed ${new Date().toISOString().slice(0, 10)}).`,
      fields: ["risk_list"],
    }),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* CelesTrak GP                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

export type TLE = {
  norad_id: number;
  object_name: string;
  intl_designator: string;
  epoch_iso: string;
  mean_motion: number;
  eccentricity: number;
  inclination_deg: number;
  raan_deg: number;
  arg_of_perigee_deg: number;
  mean_anomaly_deg: number;
  bstar: number | null;
  rev_at_epoch: number | null;
  element_set_number: number | null;
  classification: "U" | "C" | "S";
  tle_line1: string;
  tle_line2: string;
};

export type CelestrakSel =
  | { catnr: number }
  | { intl_designator: string }
  | { name: string }
  | { group: string };

export async function fetchCelestrak(sel: CelestrakSel): Promise<{ data: TLE[]; provenance: Provenance }> {
  const u = new URL("https://celestrak.org/NORAD/elements/gp.php");
  if ("catnr" in sel) u.searchParams.set("CATNR", String(sel.catnr));
  else if ("intl_designator" in sel) u.searchParams.set("INTDES", sel.intl_designator);
  else if ("name" in sel) u.searchParams.set("NAME", sel.name);
  else u.searchParams.set("GROUP", sel.group);
  u.searchParams.set("FORMAT", "JSON");

  const res = await upstreamFetch(u.toString(), "CelesTrak");
  const text = await res.text();
  if (/no\s+gp\s+data/i.test(text)) {
    throw new Error("CelesTrak: no GP data for query");
  }
  let rows: any[] = [];
  try {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error("CelesTrak: non-JSON response");
  }
  if (rows.length === 0) throw new Error("CelesTrak: no matches");

  const data: TLE[] = rows.map((r) => ({
    norad_id: r.NORAD_CAT_ID,
    object_name: (r.OBJECT_NAME ?? "").trim(),
    intl_designator: r.OBJECT_ID ?? "",
    epoch_iso: r.EPOCH ? new Date(r.EPOCH).toISOString() : new Date().toISOString(),
    mean_motion: r.MEAN_MOTION,
    eccentricity: r.ECCENTRICITY,
    inclination_deg: r.INCLINATION,
    raan_deg: r.RA_OF_ASC_NODE,
    arg_of_perigee_deg: r.ARG_OF_PERICENTER,
    mean_anomaly_deg: r.MEAN_ANOMALY,
    bstar: typeof r.BSTAR === "number" ? r.BSTAR : null,
    rev_at_epoch: typeof r.REV_AT_EPOCH === "number" ? r.REV_AT_EPOCH : null,
    element_set_number: typeof r.ELEMENT_SET_NO === "number" ? r.ELEMENT_SET_NO : null,
    classification: r.CLASSIFICATION_TYPE ?? "U",
    tle_line1: r.TLE_LINE1 ?? "",
    tle_line2: r.TLE_LINE2 ?? "",
  }));

  return {
    data,
    provenance: newProvenance({
      source: "CelesTrak",
      endpoint: u.toString(),
      licence: "CelesTrak-FairUse",
      citation: "CelesTrak (Dr. T. S. Kelso) — celestrak.org. GP data sourced from US Space Force 18 SDS.",
      fields: ["tle", "epoch", "elements"],
    }),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* NASA Exoplanet Archive (TAP)                                               */
/* ────────────────────────────────────────────────────────────────────────── */

export type ExoplanetRow = {
  pl_name: string;
  hostname: string;
  pl_orbper_d: number | null;
  pl_rade_re: number | null;
  pl_bmasse_me: number | null;
  pl_eqt_k: number | null;
  st_teff_k: number | null;
  st_dist_pc: number | null;
  discoverymethod: string | null;
  disc_year: number | null;
  disc_facility: string | null;
};

export async function fetchExoplanets(opts: {
  hostname?: string;
  pl_name?: string;
  where?: string;
  limit?: number;
  table?: "ps" | "pscomppars" | "toi" | "k2pandc";
}): Promise<{ data: ExoplanetRow[]; provenance: Provenance }> {
  const table = opts.table ?? "ps";
  const limit = Math.min(opts.limit ?? 25, 200);
  const cols = "pl_name,hostname,pl_orbper,pl_rade,pl_bmasse,pl_eqt,st_teff,sy_dist,discoverymethod,disc_year,disc_facility";
  const filters: string[] = [];
  if (opts.hostname) filters.push(`hostname like '${opts.hostname.replace(/'/g, "''")}%'`);
  if (opts.pl_name) filters.push(`pl_name like '%${opts.pl_name.replace(/'/g, "''")}%'`);
  if (opts.where) filters.push(`(${opts.where})`);
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const adql = `select top ${limit} ${cols} from ${table} ${where} order by disc_year desc`;

  const u = new URL("https://exoplanetarchive.ipac.caltech.edu/TAP/sync");
  u.searchParams.set("query", adql);
  u.searchParams.set("format", "csv");
  const res = await upstreamFetch(u.toString(), "NASA Exoplanet Archive");
  const csv = await res.text();
  const lines = csv.split("\n").filter((l) => l && !l.startsWith("#"));
  if (lines.length < 2) {
    return {
      data: [],
      provenance: newProvenance({
        source: "NASA Exoplanet Archive",
        endpoint: u.toString(),
        licence: "PD-USG",
        citation: "NASA Exoplanet Archive (Caltech IPAC).",
        fields: ["planets"],
      }),
    };
  }
  const headers = splitCsv(lines[0]);
  const idx = (n: string) => headers.indexOf(n);
  const data: ExoplanetRow[] = lines.slice(1).map((line) => {
    const c = splitCsv(line);
    const year = parseNum(c[idx("disc_year")]);
    return {
      pl_name: c[idx("pl_name")] ?? "",
      hostname: c[idx("hostname")] ?? "",
      pl_orbper_d: parseNum(c[idx("pl_orbper")]),
      pl_rade_re: parseNum(c[idx("pl_rade")]),
      pl_bmasse_me: parseNum(c[idx("pl_bmasse")]),
      pl_eqt_k: parseNum(c[idx("pl_eqt")]),
      st_teff_k: parseNum(c[idx("st_teff")]),
      st_dist_pc: parseNum(c[idx("sy_dist")]),
      discoverymethod: c[idx("discoverymethod")] || null,
      disc_year: year !== null ? Math.round(year) : null,
      disc_facility: c[idx("disc_facility")] || null,
    };
  });

  return {
    data,
    provenance: newProvenance({
      source: "NASA Exoplanet Archive",
      endpoint: u.toString(),
      licence: "PD-USG",
      citation: `NASA Exoplanet Archive (Caltech IPAC, accessed ${new Date().toISOString().slice(0, 10)}).`,
      fields: ["planets"],
    }),
  };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function parseNum(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* NOAA SWPC                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export type SpaceWeatherNow = {
  at: string;
  kp_now: number;
  kp_history: { time_tag: string; kp_index: number }[];
  bz_nT: number | null;
  solar_wind_speed_km_s: number | null;
  solar_wind_density_cm3: number | null;
  xray_class_now: string;
};

export async function fetchSpaceWeather(): Promise<{ data: SpaceWeatherNow; provenance: Provenance[] }> {
  const KP_URL = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
  const MAG_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json";
  const WIND_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json";
  const XRAY_URL = "https://services.swpc.noaa.gov/json/goes/primary/xrays-7-day.json";

  const [kp, mag, wind, xray] = await Promise.allSettled([
    upstreamFetch(KP_URL, "NOAA SWPC").then((r) => r.json() as Promise<any[]>),
    upstreamFetch(MAG_URL, "NOAA DSCOVR RT").then((r) => r.json() as Promise<any[]>),
    upstreamFetch(WIND_URL, "NOAA DSCOVR RT").then((r) => r.json() as Promise<any[]>),
    upstreamFetch(XRAY_URL, "NOAA SWPC").then((r) => r.json() as Promise<any[]>),
  ]);

  const provenance: Provenance[] = [];
  let kp_now = 0;
  let kp_history: SpaceWeatherNow["kp_history"] = [];
  if (kp.status === "fulfilled") {
    kp_history = kp.value.slice(-16);
    kp_now = kp_history.at(-1)?.kp_index ?? 0;
    provenance.push(newProvenance({
      source: "NOAA SWPC",
      endpoint: KP_URL,
      licence: "PD-USG",
      citation: "NOAA Space Weather Prediction Center, real-time planetary K-index.",
      fields: ["kp_now", "kp_history"],
    }));
  }

  let bz_nT: number | null = null;
  if (mag.status === "fulfilled") {
    const last = (mag.value as any[]).findLast?.((r) => typeof r.bz_gsm === "number");
    bz_nT = last?.bz_gsm ?? null;
    provenance.push(newProvenance({
      source: "NOAA DSCOVR RT",
      endpoint: MAG_URL,
      licence: "PD-USG",
      citation: "NOAA DSCOVR Real-Time Solar Wind — magnetometer.",
      fields: ["bz_nT"],
    }));
  }

  let speed: number | null = null;
  let density: number | null = null;
  if (wind.status === "fulfilled") {
    const last = (wind.value as any[]).findLast?.((r) => typeof r.proton_speed === "number");
    speed = last?.proton_speed ?? null;
    density = last?.proton_density ?? null;
    provenance.push(newProvenance({
      source: "NOAA DSCOVR RT",
      endpoint: WIND_URL,
      licence: "PD-USG",
      citation: "NOAA DSCOVR Real-Time Solar Wind — plasma.",
      fields: ["solar_wind_speed_km_s", "solar_wind_density_cm3"],
    }));
  }

  let xray_class_now = "—";
  if (xray.status === "fulfilled") {
    const long = (xray.value as any[]).filter((r) => r.energy?.includes("0.1-0.8nm"));
    const last = long.at(-1);
    if (last && typeof last.flux === "number") xray_class_now = toXrayClass(last.flux);
    provenance.push(newProvenance({
      source: "NOAA SWPC",
      endpoint: XRAY_URL,
      licence: "PD-USG",
      citation: "NOAA SWPC, GOES X-ray Sensor.",
      fields: ["xray_class_now"],
    }));
  }

  return {
    data: {
      at: new Date().toISOString(),
      kp_now,
      kp_history,
      bz_nT,
      solar_wind_speed_km_s: speed,
      solar_wind_density_cm3: density,
      xray_class_now,
    },
    provenance,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function jdToISO(jd: number): string {
  return new Date((jd - 2440587.5) * 86400_000).toISOString();
}
function yearsFromNow(yrs: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + yrs);
  return d.toISOString().slice(0, 10);
}
function parseCDDate(cd: string): string {
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const m = cd.match(/(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return new Date().toISOString();
  return `${m[1]}-${months[m[2]] ?? "01"}-${m[3]}T${m[4]}:${m[5]}:00Z`;
}
function toXrayClass(flux: number): string {
  if (flux >= 1e-4) return `X${(flux / 1e-4).toFixed(1)}`;
  if (flux >= 1e-5) return `M${(flux / 1e-5).toFixed(1)}`;
  if (flux >= 1e-6) return `C${(flux / 1e-6).toFixed(1)}`;
  if (flux >= 1e-7) return `B${(flux / 1e-7).toFixed(1)}`;
  return `A${(flux / 1e-8).toFixed(1)}`;
}
function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
