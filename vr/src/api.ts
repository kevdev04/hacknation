/** Gate API client. The VR app talks to nothing else. */

export interface Mutation {
  wt: string;
  pos: number;
  mut: string;
  label: string;
  wt_in_structure?: string;
}

/** A check the agent lab computed, with the threshold it was tested against. */
export interface ValidationCheck {
  name: string;
  passed: boolean;
  value: number;
  threshold: number;
  detail?: string;
}

export interface Validation {
  verdict: "PASS" | "WARN" | "FAIL" | "PENDING";
  confidence: number;
  checks: ValidationCheck[];
  warnings?: string[];
}

/** An assertion the lab made, reviewed on its evidence rather than a residue. */
export interface Claim {
  headline: string;
  node_type: string;
  confidence: number;
  agent_generated: boolean;
  props: { k: string; v: string }[];
}

export interface Candidate {
  candidate_id: string;
  run_id: string;
  iteration: number;
  /** "mutation" is measured against the PDB; "claim" has no residue. */
  kind: "mutation" | "claim";
  source: string;
  /** A name the reviewer gave it, shown instead of the lab's own label. */
  label?: string | null;
  claim?: Claim | null;
  validation?: Validation | null;
  approval_id?: string | null;
  protein_id: string;
  pdb_url: string;
  chain: string;
  mutation: Mutation;
  scores: { esm_llr?: number; rank_in_batch?: number } & Record<string, unknown>;
  distance_to_active_site_A: number | null;
  nearest_active_site_residue: number | null;
  active_site_residues: number[];
  rationale: string;
  citations: { title: string; url?: string; doc_id?: string; snippet?: string; year?: number }[];
  flags: string[];
  status: string;
}

/** "dismiss" clears the queue without claiming anything about the science. */
export type DecisionKind = "approve" | "reject" | "defer" | "dismiss";

const REVIEWER =
  new URLSearchParams(location.search).get("reviewer") ?? "unknown";

export const reviewer = REVIEWER;

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${input} → ${res.status}`);
  return res.json() as Promise<T>;
}

export function getQueue(): Promise<{ count: number; candidates: Candidate[] }> {
  return json("/queue");
}

export function postDecision(
  candidate_id: string,
  decision: DecisionKind,
  note?: string,
): Promise<{ ok: boolean; pending_remaining: number }> {
  return json("/decisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidate_id,
      decision,
      note,
      reviewer: REVIEWER,
      timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    }),
  });
}

const pdbCache = new Map<string, Promise<string>>();

export function getStructure(url: string): Promise<string> {
  let hit = pdbCache.get(url);
  if (!hit) {
    hit = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
      return r.text();
    });
    pdbCache.set(url, hit);
  }
  return hit;
}

// ------------------------------------------------------------------ variants

export interface EpistasisRisk {
  pair: [number, number];
  distance_A: number;
}

export interface VariantPayload {
  protein_id: string;
  chain: string;
  mutations: string[];
  score: { tier: "estimate" | "measured"; esm_llr: number | null };
  epistasis_risk: EpistasisRisk[];
  origin: "human";
  proposed_by: string;
}

export interface VariantResult {
  variant_id: string;
  score?: { tier: "estimate" | "measured"; esm_llr: number | null };
  status?: string;
}

/**
 * Queue real scoring of a combination and send a human-proposed variant into
 * the agent loop. Both endpoints are still to be built on the gate, so callers
 * must handle the rejection and keep the estimate on screen rather than
 * pretending a measured number arrived.
 */
export function scoreVariant(payload: VariantPayload): Promise<VariantResult> {
  return json("/variants/score", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function proposeVariant(payload: VariantPayload): Promise<VariantResult> {
  return json("/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// -------------------------------------------------------------------- config

export interface GateConfig {
  protein_id: string;
  pdb_file: string;
  pdb_url: string;
  chain: string;
  /** Verified against the actual PDB by the backend — never hardcoded here. */
  active_site_residues: number[];
  structure_id: string;
}

export function getConfig(): Promise<GateConfig> {
  return json("/config");
}

// ------------------------------------------------------------- agent bridge

export interface BridgeRun {
  query_id: string;
  query: string;
  stage: string;
  progress: number;
  message: string;
  answer: { headline: string; conclusion?: string } | null;
  validation: Validation | null;
  latency_ms: number;
  next_question: string;
  error: string | null;
  finished: boolean;
}

/**
 * Live state of the agent lab's explorations. The loop takes 9-13 s, so this is
 * what turns that wait into visible progress rather than a frozen panel.
 */
export function getBridgeRuns(): Promise<{ count: number; runs: BridgeRun[] }> {
  return json("/bridge/runs");
}

export function explore(query: string, mode: "live" | "mock" = "mock") {
  return json<{ ok: boolean; query_id: string }>("/bridge/explore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, mode }),
  });
}

export interface BridgeHealth {
  bridge_url: string;
  reachable: boolean;
  status?: string;
  schema_version?: string;
  detail?: string;
}

/** Is the agent lab bridge actually answering, and at which URL. */
export function getBridgeHealth(): Promise<BridgeHealth> {
  return json("/bridge/health");
}

export interface FullHealth {
  web: { ok: boolean; detail: string };
  agent: { ok: boolean; url: string; detail?: string | null };
  data: {
    ok: boolean;
    structure: string | null;
    triad: string;
    state_writable: boolean;
    candidates: number;
    decisions: number;
  };
  checked_ms: number;
}

/** Viewer → gate → agent lab, and the data the gate stands on, in one call. */
export function getFullHealth(): Promise<FullHealth> {
  return json("/health/full");
}

/** Name a candidate. Not a decision, and not written to the audit trail. */
export function setLabel(candidate_id: string, label: string) {
  return json<{ ok: boolean; label: string | null }>(
    `/candidates/${encodeURIComponent(candidate_id)}/label`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    },
  );
}
