/**
 * Self-check for the side-chain builder, run with `?rotamertest=1`.
 *
 * The test that matters: rebuild a residue as its *own* type and compare the
 * modelled side chain against the experimental one. If the internal coordinates
 * or the dihedral conventions are wrong, this blows up immediately — a correct
 * builder with a small rotamer library should land most side chains within a
 * couple of ångströms, because chi1 is recovered most of the time.
 */

import { oneLetter, type Structure } from "./protein";
import { mutateResidue } from "./rotamer";

function rmsd(a: { name: string; pos: { distanceTo(o: any): number } }[], b: any[]): number | null {
  const byName = new Map(b.map((x) => [x.name, x.pos]));
  let sum = 0;
  let n = 0;
  for (const atom of a) {
    const other = byName.get(atom.name);
    if (!other) continue;
    const d = atom.pos.distanceTo(other);
    sum += d * d;
    n++;
  }
  return n === 0 ? null : Math.sqrt(sum / n);
}

const BACKBONE = new Set(["N", "CA", "C", "O"]);

export function runRotamerTest(structure: Structure): void {
  const perType = new Map<string, number[]>();
  const bondLengths: number[] = [];
  let rebuilt = 0;
  let failed = 0;

  for (const res of structure.residues.values()) {
    const one = oneLetter(res.resName);
    if (one === "?" || one === "G" || one === "A") continue;

    const result = mutateResidue(structure, res.resSeq, one);
    if (!result || result.failed) {
      failed++;
      continue;
    }
    rebuilt++;

    const modelled = result.residue.atoms.filter((a) => !BACKBONE.has(a.name) && a.name !== "CB");
    const measured = res.atoms.filter((a) => !BACKBONE.has(a.name) && a.name !== "CB");
    const value = rmsd(modelled, measured);
    if (value != null) {
      if (!perType.has(res.resName)) perType.set(res.resName, []);
      perType.get(res.resName)!.push(value);
    }

    // Sanity on the first bond out of CB: a real C-C is ~1.52 A.
    const cb = result.residue.atoms.find((a) => a.name === "CB");
    const cg = result.residue.atoms.find((a) => a.name.startsWith("CG") || a.name === "OG" || a.name === "SG" || a.name === "OG1");
    if (cb && cg) bondLengths.push(cb.pos.distanceTo(cg.pos));
  }

  const all = [...perType.values()].flat().sort((x, y) => x - y);
  const median = all.length ? all[Math.floor(all.length / 2)] : NaN;
  const mean = all.length ? all.reduce((s, v) => s + v, 0) / all.length : NaN;
  const within2 = all.filter((v) => v <= 2).length;

  console.log("[rotamer] rebuilt", rebuilt, "residues,", failed, "failed");
  console.log(
    `[rotamer] side-chain RMSD vs experimental: median ${median.toFixed(2)} A, mean ${mean.toFixed(2)} A, ` +
      `${((100 * within2) / all.length).toFixed(0)}% within 2 A`,
  );
  const bl = bondLengths.sort((x, y) => x - y);
  console.log(
    `[rotamer] CB-CG bond length: median ${bl[Math.floor(bl.length / 2)].toFixed(3)} A (expect ~1.5)`,
  );

  const rows = [...perType.entries()]
    .map(([name, values]) => {
      const s = [...values].sort((x, y) => x - y);
      return { name, n: values.length, med: s[Math.floor(s.length / 2)] };
    })
    .sort((a, b) => b.med - a.med);
  for (const r of rows) {
    console.log(`[rotamer]   ${r.name} n=${String(r.n).padStart(3)} median ${r.med.toFixed(2)} A`);
  }
}
