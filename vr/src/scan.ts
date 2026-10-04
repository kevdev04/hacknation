/**
 * Single-mutant score lookup.
 *
 * The real article is an offline ESM-2 pass over every position × substitution,
 * served by `GET /scan`. That file does not exist yet, so this module falls
 * back to a deterministic placeholder matrix and reports `source: "placeholder"`
 * so every surface that draws one of these numbers can say where it came from.
 *
 * The fallback is deliberately *not* correlated with burial, charge or anything
 * else structural. A placeholder that looked like it knew something would be
 * worse than one that obviously does not: the bench is for building the
 * interaction, and the numbers are swapped for real ones the moment /scan lands.
 */

import { AA } from "./metrics";

export type ScanSource = "model" | "placeholder";

export interface Scan {
  source: ScanSource;
  /** Model name when the scores are real; null for the placeholder. */
  model: string | null;
  /** Log-likelihood ratio for one substitution, or null if not scored. */
  llr(pos: number, mut: string): number | null;
  /** Every substitution at a position, best first. */
  ranked(pos: number, wt: string): { mut: string; llr: number | null }[];
}

interface ScanResponse {
  model?: string;
  /** `{ "121": { "E": 1.84, ... }, ... }` */
  values: Record<string, Record<string, number>>;
}

/** FNV-1a → [0, 1). Stable across reloads so the demo does not flicker. */
function hash01(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

function placeholderLLR(protein: string, pos: number, mut: string): number {
  // Most substitutions are mildly destabilising, a few are favourable — the
  // shape of a real LLR distribution, with none of its meaning.
  const raw = hash01(`${protein}:${pos}:${mut}`);
  return Math.round((raw * 7.5 - 5.2) * 100) / 100;
}

function build(
  source: ScanSource,
  model: string | null,
  lookup: (pos: number, mut: string) => number | null,
): Scan {
  return {
    source,
    model,
    llr: lookup,
    ranked(pos: number, wt: string) {
      return AA.filter((mut) => mut !== wt)
        .map((mut) => ({ mut, llr: lookup(pos, mut) }))
        .sort((a, b) => (b.llr ?? -Infinity) - (a.llr ?? -Infinity));
    },
  };
}

/**
 * Load the scan for a protein/chain, falling back to the placeholder matrix if
 * the endpoint is missing or malformed. Never throws: the bench must be usable
 * before the scoring pipeline exists.
 */
export async function loadScan(protein: string, chain: string): Promise<Scan> {
  try {
    const res = await fetch(
      `/scan?protein=${encodeURIComponent(protein)}&chain=${encodeURIComponent(chain)}`,
    );
    if (res.ok) {
      const body = (await res.json()) as ScanResponse;
      if (body?.values && typeof body.values === "object") {
        return build("model", body.model ?? "ESM-2", (pos, mut) => {
          const value = body.values[String(pos)]?.[mut];
          return typeof value === "number" ? value : null;
        });
      }
    }
  } catch {
    // Endpoint absent during the bench build — expected, fall through.
  }

  return build("placeholder", null, (pos, mut) =>
    placeholderLLR(protein, pos, mut),
  );
}

/** One-line provenance string for any panel that renders a scan number. */
export function scanCaption(scan: Scan | null): string {
  if (!scan) return "scores loading…";
  return scan.source === "model"
    ? `${scan.model} single-mutant scan`
    : "Placeholder scores · not ESM-2";
}
