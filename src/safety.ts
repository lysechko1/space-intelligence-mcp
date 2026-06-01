/**
 * Safety layer for the MCP server (docs/04_MCP_SERVER_SPEC §9).
 *
 * - Hard refusal patterns for commanding / deception / dual-use targeting.
 * - Returns a structured refusal envelope the agent can render to the user.
 *
 * This server provides only *read* and *compute* tools. There is no commanding
 * tool. The refusal patterns guard against jailbreaks that try to get
 * permitted tools to do impermissible things via their inputs.
 */

const REFUSAL_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(send|upload|push)\b.{0,30}\b(command|firmware|patch|payload)\b/i,    reason: "live-commanding" },
  { re: /\b(jam|spoof|hack|deactivate|disable)\b.{0,30}\b(satellite|spacecraft|asset|orbit)\b/i, reason: "deception-or-attack" },
  { re: /\b(inject|forge|fake|spoof)\b.{0,30}\b(tle|cdm|ephemeris)\b/i,          reason: "data-deception" },
  { re: /\b(target|aim|strike)\b.{0,30}\b(icbm|missile|launch|payload)\b/i,      reason: "dual-use-targeting" },
  { re: /\b(produce|generate|build)\b.{0,40}\b(targeting list|kill chain)\b/i,   reason: "dual-use-targeting" },
];

export const REFUSAL_MESSAGE = [
  "This request asks for live, commanding, deceptive, or dual-use operations on a real space asset,",
  "which is outside Cosmx's safety policy. The MCP server operates in research, simulation, and",
  "decision-support modes only. Please rephrase as an analysis or simulation question, or escalate",
  "to your organisation's licensed operations channel.",
].join(" ");

export type RefusalReason =
  | "live-commanding"
  | "deception-or-attack"
  | "data-deception"
  | "dual-use-targeting"
  | "ok";

export function classify(input: string): RefusalReason {
  for (const r of REFUSAL_PATTERNS) {
    if (r.re.test(input)) return r.reason as RefusalReason;
  }
  return "ok";
}

/** Asserts and throws a structured refusal error if the input crosses safety lines. */
export function assertSafe(...inputs: (string | undefined | null)[]): void {
  const joined = inputs.filter(Boolean).join(" \n ");
  const verdict = classify(joined);
  if (verdict !== "ok") {
    const err = new Error(REFUSAL_MESSAGE);
    (err as Error & { reason?: RefusalReason; refusal?: true }).reason = verdict;
    (err as Error & { reason?: RefusalReason; refusal?: true }).refusal = true;
    throw err;
  }
}
