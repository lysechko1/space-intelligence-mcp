export type Provenance = {
  source: string;
  endpoint: string;
  retrieved_at: string;
  licence: string;
  citation: string;
  fields?: string[];
};

const UA = "MCPOrbital-MCP/0.1 (+https://mcporbital.com; mailto:hello@mcporbital.com)";

export class UpstreamError extends Error {
  constructor(public source: string, public status: number, message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

/**
 * Polite fetch with a UA, JSON-friendly accept header, and structured errors.
 * No caching here — clients are expected to wrap with their own cache layer.
 */
export async function upstreamFetch(url: string, source: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": UA,
      Accept: "application/json,text/xml,application/xml,*/*",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new UpstreamError(source, res.status, `${source} ${res.status} for ${url}`);
  }
  return res;
}

export function newProvenance(p: {
  source: string;
  endpoint: string;
  licence: string;
  citation: string;
  fields?: string[];
}): Provenance {
  return { ...p, retrieved_at: new Date().toISOString() };
}
