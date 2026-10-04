/**
 * Structural signals measured straight from the loaded PDB.
 *
 * Everything here is real today and costs nothing: no model, no endpoint, just
 * arithmetic over coordinates we already parsed. Per the repo rule, measuring
 * something from the structure beats asking a model for it — it is faster, it
 * is checkable, and it is what tells the reviewer when to distrust the fast
 * additive number.
 */

import { closestAtomPair, type Residue, type Structure } from "./protein";

export const AA = "ACDEFGHIKLMNPQRSTVWY".split("");

export const AA_NAME: Record<string, string> = {
  A: "Ala", C: "Cys", D: "Asp", E: "Glu", F: "Phe",
  G: "Gly", H: "His", I: "Ile", K: "Lys", L: "Leu",
  M: "Met", N: "Asn", P: "Pro", Q: "Gln", R: "Arg",
  S: "Ser", T: "Thr", V: "Val", W: "Trp", Y: "Tyr",
};

/** Formal charge at neutral pH; histidine is partial and treated as such. */
export const CHARGE: Record<string, number> = {
  D: -1, E: -1, K: 1, R: 1, H: 0.5,
};

const HYDROPHOBIC = new Set(["A", "V", "L", "I", "M", "F", "W", "C", "P", "G"]);

export function polarity(one: string): "hydrophobic" | "polar" | "charged" {
  if (CHARGE[one] !== undefined && Math.abs(CHARGE[one]) >= 1) return "charged";
  return HYDROPHOBIC.has(one) ? "hydrophobic" : "polar";
}

export type Burial = "surface" | "intermediate" | "buried";

export interface ResidueMetrics {
  /** CA atoms within NEIGHBOUR_CUTOFF Å — a cheap buried/surface proxy. */
  neighbours: number;
  burial: Burial;
  distanceToActiveSite: number | null;
  nearestActiveSite: number | null;
}

export const NEIGHBOUR_CUTOFF_A = 10;
export const EPISTASIS_CUTOFF_A = 8;

function burialFrom(neighbours: number): Burial {
  if (neighbours >= 22) return "buried";
  if (neighbours >= 14) return "intermediate";
  return "surface";
}

/** CA neighbour count — the standard cheap proxy for solvent exposure. */
export function neighbourCount(
  structure: Structure,
  pos: number,
  cutoff = NEIGHBOUR_CUTOFF_A,
): number {
  const target = structure.residues.get(pos);
  const centre = target?.ca;
  if (!centre) return 0;

  const cutoffSq = cutoff * cutoff;
  let count = 0;
  for (const res of structure.residues.values()) {
    if (res.resSeq === pos || !res.ca) continue;
    if (res.ca.distanceToSquared(centre) <= cutoffSq) count++;
  }
  return count;
}

/** Minimum heavy-atom distance between two residues, in Å. */
export function residueDistance(
  structure: Structure,
  a: number,
  b: number,
): number | null {
  const resA = structure.residues.get(a);
  const resB = structure.residues.get(b);
  if (!resA || !resB) return null;
  return closestAtomPair(resA, resB)?.distance ?? null;
}

export function residueMetrics(
  structure: Structure,
  pos: number,
  activeSite: number[],
): ResidueMetrics {
  const neighbours = neighbourCount(structure, pos);

  let distanceToActiveSite: number | null = null;
  let nearestActiveSite: number | null = null;
  for (const site of activeSite) {
    if (site === pos) continue;
    const d = residueDistance(structure, pos, site);
    if (d != null && (distanceToActiveSite == null || d < distanceToActiveSite)) {
      distanceToActiveSite = d;
      nearestActiveSite = site;
    }
  }

  return {
    neighbours,
    burial: burialFrom(neighbours),
    distanceToActiveSite,
    nearestActiveSite,
  };
}

export interface EpistasisPair {
  a: number;
  b: number;
  distance: number;
}

/**
 * Selected positions that sit within `cutoff` Å of each other. These are the
 * pairs where the additive estimate is least trustworthy, because two mutations
 * that close are very likely to interact.
 */
export function epistasisPairs(
  structure: Structure,
  positions: number[],
  cutoff = EPISTASIS_CUTOFF_A,
): EpistasisPair[] {
  const pairs: EpistasisPair[] = [];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const d = residueDistance(structure, positions[i], positions[j]);
      if (d != null && d <= cutoff) {
        pairs.push({ a: positions[i], b: positions[j], distance: d });
      }
    }
  }
  return pairs.sort((x, y) => x.distance - y.distance);
}

/** Net formal-charge change introduced by a substitution. */
export function chargeDelta(wt: string, mut: string): number {
  return (CHARGE[mut] ?? 0) - (CHARGE[wt] ?? 0);
}

export function describeResidue(res: Residue, one: string): string {
  return `${AA_NAME[one] ?? res.resName} ${res.resSeq}`;
}
