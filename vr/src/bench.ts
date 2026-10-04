/**
 * Combination bench state.
 *
 * Deliberately free of three.js and of any network call: adding, removing and
 * toggling a mutation is pure arithmetic over a short array, so the A/B compare
 * that is the core loop of the bench resolves inside one frame. Anything that
 * needs geometry rebuilt or a score fetched is driven from main.ts off the back
 * of these mutations.
 */

import type { EpistasisPair } from "./metrics";

/** Cap on simultaneously detailed residues — see the rendering rules. */
export const MAX_MUTATIONS = 8;

export interface BenchMutation {
  pos: number;
  wt: string;
  mut: string;
  label: string;
  /** Single-mutant score from the scan; may be a placeholder. */
  llr: number | null;
  /** Heavy-atom clashes of the modelled side chain against its neighbours. */
  clashes?: number;
  /** Toggled off chips stay on the bench but leave the estimate and the 3D. */
  enabled: boolean;
}

export type MeasuredScore = {
  esm_llr: number;
  /** The estimate at the time the job was fired, for the disagreement line. */
  estimateWhenRequested: number | null;
};

export class Bench {
  readonly mutations: BenchMutation[] = [];

  /** Score of the full combined sequence, once a real job has returned. */
  measured: MeasuredScore | null = null;

  get count(): number {
    return this.mutations.length;
  }

  get full(): boolean {
    return this.mutations.length >= MAX_MUTATIONS;
  }

  get enabledMutations(): BenchMutation[] {
    return this.mutations.filter((m) => m.enabled);
  }

  get enabledPositions(): number[] {
    return this.enabledMutations.map((m) => m.pos);
  }

  has(pos: number): boolean {
    return this.mutations.some((m) => m.pos === pos);
  }

  at(pos: number): BenchMutation | undefined {
    return this.mutations.find((m) => m.pos === pos);
  }

  /**
   * Add a substitution, replacing any existing one at the same position — a
   * position can only carry one mutation in a variant.
   */
  add(mutation: Omit<BenchMutation, "enabled">): boolean {
    const existing = this.mutations.findIndex((m) => m.pos === mutation.pos);
    if (existing >= 0) {
      this.mutations[existing] = { ...mutation, enabled: true };
      this.invalidateMeasured();
      return true;
    }
    if (this.full) return false;
    this.mutations.push({ ...mutation, enabled: true });
    this.mutations.sort((a, b) => a.pos - b.pos);
    this.invalidateMeasured();
    return true;
  }

  remove(pos: number): void {
    const index = this.mutations.findIndex((m) => m.pos === pos);
    if (index < 0) return;
    this.mutations.splice(index, 1);
    this.invalidateMeasured();
  }

  toggle(pos: number): void {
    const mutation = this.at(pos);
    if (!mutation) return;
    mutation.enabled = !mutation.enabled;
    this.invalidateMeasured();
  }

  clear(): void {
    this.mutations.length = 0;
    this.measured = null;
  }

  /**
   * Sum of the enabled single-mutant scores. This is an *estimate* and the
   * caller must label it as one: it assumes the mutations do not interact,
   * which is exactly what the epistasis pairs warn about.
   */
  additiveEstimate(): number | null {
    const enabled = this.enabledMutations;
    if (enabled.length === 0) return null;
    let total = 0;
    for (const mutation of enabled) {
      if (mutation.llr == null) return null;
      total += mutation.llr;
    }
    return total;
  }

  /** `["S121E", "D186H"]` — the wire format for a variant. */
  labels(): string[] {
    return this.enabledMutations.map((m) => m.label);
  }

  /** The measured score stops describing the stack as soon as the stack moves. */
  private invalidateMeasured(): void {
    this.measured = null;
  }
}

/** Epistasis pairs restricted to the positions currently switched on. */
export function riskForBench(
  bench: Bench,
  pairs: EpistasisPair[],
): EpistasisPair[] {
  const enabled = new Set(bench.enabledPositions);
  return pairs.filter((p) => enabled.has(p.a) && enabled.has(p.b));
}
