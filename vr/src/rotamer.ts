/**
 * Side-chain modelling for a point mutation.
 *
 * Re-folding a protein to show a single substitution is the wrong operation:
 * the backbone moves well under an ångström, so a full prediction hands back
 * essentially the structure you started with — and AlphaFold-class models are
 * famously insensitive to point mutations anyway. What actually changes is the
 * side chain at that position and the packing of its neighbours.
 *
 * So this does what a homology-modelling pipeline does: keep the measured
 * backbone, then rebuild the side chain from internal coordinates using a
 * backbone-independent rotamer library, and pick the rotamer that clashes
 * least with everything already in the structure.
 *
 * It is a *model*, not a measurement, and the UI has to keep saying so — the
 * backbone and the neighbours are experimental, the new side chain is not.
 */

import { Vector3 } from "three";
import type { Atom, Residue, Structure } from "./protein";

const DEG = Math.PI / 180;

/** Heavy atoms closer than this to a non-bonded neighbour count as a clash. */
const CLASH_A = 3.0;
/** Neighbours beyond this never matter, and skipping them keeps this cheap. */
const NEIGHBOUR_A = 12;

export const THREE_LETTER: Record<string, string> = {
  A: "ALA", R: "ARG", N: "ASN", D: "ASP", C: "CYS",
  Q: "GLN", E: "GLU", G: "GLY", H: "HIS", I: "ILE",
  L: "LEU", K: "LYS", M: "MET", F: "PHE", P: "PRO",
  S: "SER", T: "THR", W: "TRP", Y: "TYR", V: "VAL",
};

/**
 * One atom, placed from three already-known atoms by bond length, bond angle
 * and a dihedral. `chi` indexes the rotamer's chi angles; `offset` is added to
 * it (branches like the two oxygens of a carboxylate); `fixed` pins a dihedral
 * that is not a rotatable chi at all (ring closure, planar groups).
 */
interface Build {
  name: string;
  a: string;
  b: string;
  c: string;
  bond: number;
  angle: number;
  chi?: number;
  offset?: number;
  fixed?: number;
}

interface ResidueSpec {
  build: Build[];
  /** Common rotamers, chi angles in degrees. First is the most frequent. */
  rotamers: number[][];
}

// Standard geometry: sp3 C-C 1.52 Å at ~111°, sp2 ring bonds 1.39 Å at 120°.
const SPECS: Record<string, ResidueSpec> = {
  ALA: { build: [], rotamers: [[]] },
  GLY: { build: [], rotamers: [[]] },

  SER: {
    build: [{ name: "OG", a: "N", b: "CA", c: "CB", bond: 1.42, angle: 111, chi: 0 }],
    rotamers: [[62], [-177], [-65]],
  },
  CYS: {
    build: [{ name: "SG", a: "N", b: "CA", c: "CB", bond: 1.81, angle: 114, chi: 0 }],
    rotamers: [[-65], [-177], [62]],
  },
  THR: {
    build: [
      { name: "OG1", a: "N", b: "CA", c: "CB", bond: 1.43, angle: 109, chi: 0 },
      { name: "CG2", a: "N", b: "CA", c: "CB", bond: 1.52, angle: 111, chi: 0, offset: -120 },
    ],
    rotamers: [[62], [-175], [-61]],
  },
  VAL: {
    build: [
      { name: "CG1", a: "N", b: "CA", c: "CB", bond: 1.52, angle: 111, chi: 0 },
      { name: "CG2", a: "N", b: "CA", c: "CB", bond: 1.52, angle: 111, chi: 0, offset: 122 },
    ],
    rotamers: [[175], [63], [-60]],
  },
  LEU: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.53, angle: 116, chi: 0 },
      { name: "CD1", a: "CA", b: "CB", c: "CG", bond: 1.52, angle: 111, chi: 1 },
      { name: "CD2", a: "CA", b: "CB", c: "CG", bond: 1.52, angle: 111, chi: 1, offset: 122 },
    ],
    rotamers: [[-65, 175], [-177, 63], [-172, 145], [-85, 65]],
  },
  ILE: {
    build: [
      { name: "CG1", a: "N", b: "CA", c: "CB", bond: 1.53, angle: 110, chi: 0 },
      { name: "CG2", a: "N", b: "CA", c: "CB", bond: 1.52, angle: 111, chi: 0, offset: -122 },
      { name: "CD1", a: "CA", b: "CB", c: "CG1", bond: 1.52, angle: 114, chi: 1 },
    ],
    rotamers: [[-65, 170], [-177, 66], [62, 100], [-57, -60]],
  },
  MET: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.52, angle: 114, chi: 0 },
      { name: "SD", a: "CA", b: "CB", c: "CG", bond: 1.80, angle: 112, chi: 1 },
      { name: "CE", a: "CB", b: "CG", c: "SD", bond: 1.79, angle: 100, chi: 2 },
    ],
    rotamers: [[-67, 180, 75], [-177, 180, 75], [-65, -65, 103], [62, 180, 75]],
  },
  PRO: {
    // The ring is closed back to N, so chi1 is effectively fixed by geometry.
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.49, angle: 104, chi: 0 },
      { name: "CD", a: "CA", b: "CB", c: "CG", bond: 1.50, angle: 106, fixed: -25 },
    ],
    rotamers: [[28], [-28]],
  },

  // Carboxylates / amides: the second heteroatom sits 180° across the sp2 plane.
  ASP: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.52, angle: 113, chi: 0 },
      { name: "OD1", a: "CA", b: "CB", c: "CG", bond: 1.25, angle: 118, chi: 1 },
      { name: "OD2", a: "CA", b: "CB", c: "CG", bond: 1.25, angle: 118, chi: 1, offset: 180 },
    ],
    rotamers: [[-70, -15], [-177, 0], [62, -10]],
  },
  ASN: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.52, angle: 113, chi: 0 },
      { name: "OD1", a: "CA", b: "CB", c: "CG", bond: 1.23, angle: 121, chi: 1 },
      { name: "ND2", a: "CA", b: "CB", c: "CG", bond: 1.33, angle: 116, chi: 1, offset: 180 },
    ],
    rotamers: [[-65, -20], [-174, -20], [62, -10]],
  },
  GLU: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.52, angle: 114, chi: 0 },
      { name: "CD", a: "CA", b: "CB", c: "CG", bond: 1.52, angle: 113, chi: 1 },
      { name: "OE1", a: "CB", b: "CG", c: "CD", bond: 1.25, angle: 118, chi: 2 },
      { name: "OE2", a: "CB", b: "CG", c: "CD", bond: 1.25, angle: 118, chi: 2, offset: 180 },
    ],
    rotamers: [[-67, 180, -10], [-177, 180, 0], [-65, -65, -40], [62, 180, -20]],
  },
  GLN: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.52, angle: 114, chi: 0 },
      { name: "CD", a: "CA", b: "CB", c: "CG", bond: 1.52, angle: 113, chi: 1 },
      { name: "OE1", a: "CB", b: "CG", c: "CD", bond: 1.23, angle: 121, chi: 2 },
      { name: "NE2", a: "CB", b: "CG", c: "CD", bond: 1.33, angle: 116, chi: 2, offset: 180 },
    ],
    rotamers: [[-67, 180, -25], [-177, 180, 0], [-65, -65, -40], [62, 180, 20]],
  },
  LYS: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.52, angle: 114, chi: 0 },
      { name: "CD", a: "CA", b: "CB", c: "CG", bond: 1.52, angle: 111, chi: 1 },
      { name: "CE", a: "CB", b: "CG", c: "CD", bond: 1.52, angle: 111, chi: 2 },
      { name: "NZ", a: "CG", b: "CD", c: "CE", bond: 1.49, angle: 112, chi: 3 },
    ],
    rotamers: [
      [-67, 180, 180, 180],
      [-177, 180, 180, 180],
      [-67, 180, 180, 65],
      [-67, 180, 68, 180],
      [-177, 68, 180, 65],
      [-85, 68, 180, 180],
      [62, 180, 68, 180],
      [-67, -68, 180, 180],
    ],
  },
  ARG: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.52, angle: 114, chi: 0 },
      { name: "CD", a: "CA", b: "CB", c: "CG", bond: 1.52, angle: 111, chi: 1 },
      { name: "NE", a: "CB", b: "CG", c: "CD", bond: 1.46, angle: 112, chi: 2 },
      { name: "CZ", a: "CG", b: "CD", c: "NE", bond: 1.33, angle: 124, chi: 3 },
      { name: "NH1", a: "CD", b: "NE", c: "CZ", bond: 1.33, angle: 120, fixed: 0 },
      { name: "NH2", a: "CD", b: "NE", c: "CZ", bond: 1.33, angle: 120, fixed: 180 },
    ],
    rotamers: [
      [-67, 180, 65, 85],
      [-177, 180, 65, 85],
      [-67, 180, 180, 85],
      [-67, -167, 180, 85],
      [-177, 65, 65, 85],
      [-62, -68, 180, 85],
      [-67, 180, -65, -85],
      [62, 180, 65, 85],
      [-177, 180, -65, -85],
    ],
  },

  // Rings are built as rigid planar groups off chi1/chi2.
  HIS: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.50, angle: 114, chi: 0 },
      { name: "ND1", a: "CA", b: "CB", c: "CG", bond: 1.38, angle: 122, chi: 1 },
      { name: "CD2", a: "CA", b: "CB", c: "CG", bond: 1.35, angle: 131, chi: 1, offset: 180 },
      { name: "CE1", a: "CB", b: "CG", c: "ND1", bond: 1.32, angle: 109, fixed: 180 },
      { name: "NE2", a: "CB", b: "CG", c: "CD2", bond: 1.37, angle: 107, fixed: 180 },
    ],
    rotamers: [[-65, -70], [-177, -80], [-65, 165], [62, -75]],
  },
  PHE: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.50, angle: 114, chi: 0 },
      { name: "CD1", a: "CA", b: "CB", c: "CG", bond: 1.39, angle: 120, chi: 1 },
      { name: "CD2", a: "CA", b: "CB", c: "CG", bond: 1.39, angle: 120, chi: 1, offset: 180 },
      { name: "CE1", a: "CB", b: "CG", c: "CD1", bond: 1.39, angle: 120, fixed: 180 },
      { name: "CE2", a: "CB", b: "CG", c: "CD2", bond: 1.39, angle: 120, fixed: 180 },
      { name: "CZ", a: "CG", b: "CD1", c: "CE1", bond: 1.39, angle: 120, fixed: 0 },
    ],
    rotamers: [[-65, -85], [-177, 80], [62, 90], [-65, -30]],
  },
  TYR: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.50, angle: 114, chi: 0 },
      { name: "CD1", a: "CA", b: "CB", c: "CG", bond: 1.39, angle: 120, chi: 1 },
      { name: "CD2", a: "CA", b: "CB", c: "CG", bond: 1.39, angle: 120, chi: 1, offset: 180 },
      { name: "CE1", a: "CB", b: "CG", c: "CD1", bond: 1.39, angle: 120, fixed: 180 },
      { name: "CE2", a: "CB", b: "CG", c: "CD2", bond: 1.39, angle: 120, fixed: 180 },
      { name: "CZ", a: "CG", b: "CD1", c: "CE1", bond: 1.39, angle: 120, fixed: 0 },
      { name: "OH", a: "CD1", b: "CE1", c: "CZ", bond: 1.38, angle: 120, fixed: 180 },
    ],
    rotamers: [[-65, -85], [-177, 80], [62, 90], [-65, -30]],
  },
  TRP: {
    build: [
      { name: "CG", a: "N", b: "CA", c: "CB", bond: 1.50, angle: 114, chi: 0 },
      { name: "CD1", a: "CA", b: "CB", c: "CG", bond: 1.36, angle: 127, chi: 1 },
      { name: "CD2", a: "CA", b: "CB", c: "CG", bond: 1.43, angle: 127, chi: 1, offset: 180 },
      { name: "NE1", a: "CB", b: "CG", c: "CD1", bond: 1.38, angle: 110, fixed: 180 },
      { name: "CE2", a: "CB", b: "CG", c: "CD2", bond: 1.41, angle: 107, fixed: 180 },
      { name: "CE3", a: "CB", b: "CG", c: "CD2", bond: 1.40, angle: 134, fixed: 0 },
      { name: "CZ2", a: "CG", b: "CD2", c: "CE2", bond: 1.40, angle: 122, fixed: 180 },
      { name: "CZ3", a: "CG", b: "CD2", c: "CE3", bond: 1.39, angle: 118, fixed: 180 },
      { name: "CH2", a: "CD2", b: "CE2", c: "CZ2", bond: 1.37, angle: 118, fixed: 0 },
    ],
    rotamers: [
      [-65, 95], [-177, -105], [-65, -90], [62, -90],
      [-177, 90], [-65, -5], [62, 90], [-177, 5],
    ],
  },
};

/**
 * Natural-extension reference frame: place an atom at `bond` from c, making
 * `angle` with b-c, and `dihedral` about the a-b-c-d torsion.
 */
function place(
  a: Vector3,
  b: Vector3,
  c: Vector3,
  bond: number,
  angleDeg: number,
  dihedralDeg: number,
): Vector3 {
  const angle = angleDeg * DEG;
  const dihedral = dihedralDeg * DEG;

  const bc = new Vector3().subVectors(c, b).normalize();
  const ab = new Vector3().subVectors(b, a);
  const n = new Vector3().crossVectors(ab, bc).normalize();
  const nbc = new Vector3().crossVectors(n, bc);

  const d = new Vector3(
    -bond * Math.cos(angle),
    bond * Math.sin(angle) * Math.cos(dihedral),
    bond * Math.sin(angle) * Math.sin(dihedral),
  );

  return new Vector3(
    c.x + d.x * bc.x + d.y * nbc.x + d.z * n.x,
    c.y + d.x * bc.y + d.y * nbc.y + d.z * n.y,
    c.z + d.x * bc.z + d.y * nbc.z + d.z * n.z,
  );
}

export interface MutantResidue {
  residue: Residue;
  /** Heavy-atom contacts under CLASH_A with atoms outside this residue. */
  clashes: number;
  /** Chi angles of the rotamer chosen, in degrees. */
  chi: number[];
  /** True when the side chain could not be built (unknown type, no backbone). */
  failed: boolean;
}

function atom(name: string, element: string, res: Residue, pos: Vector3): Atom {
  return {
    name,
    element,
    resName: res.resName,
    resSeq: res.resSeq,
    chain: res.chain,
    pos,
  };
}

/**
 * Rebuild residue `pos` as `target` (one-letter), keeping the measured
 * backbone and choosing the least-clashing common rotamer.
 */
export function mutateResidue(
  structure: Structure,
  pos: number,
  target: string,
): MutantResidue | null {
  const original = structure.residues.get(pos);
  if (!original) return null;

  const resName = THREE_LETTER[target];
  const spec = resName ? SPECS[resName] : undefined;

  const backbone = new Map<string, Vector3>();
  for (const a of original.atoms) {
    if (["N", "CA", "C", "O", "CB"].includes(a.name)) backbone.set(a.name, a.pos);
  }
  const n = backbone.get("N");
  const ca = backbone.get("CA");
  const c = backbone.get("C");
  if (!n || !ca || !c) return null;

  // Glycine has no CB to inherit, so build an ideal one off the backbone.
  let cb = backbone.get("CB");
  if (!cb && resName !== "GLY") {
    cb = place(c, n, ca, 1.53, 110.5, 122.5);
    backbone.set("CB", cb);
  }

  const mutant: Residue = {
    resSeq: pos,
    resName: resName ?? original.resName,
    chain: original.chain,
    atoms: [],
    ca,
  };

  const keep = resName === "GLY" ? ["N", "CA", "C", "O"] : ["N", "CA", "C", "O", "CB"];
  for (const name of keep) {
    const p = backbone.get(name);
    if (p) mutant.atoms.push(atom(name, name === "N" ? "N" : name === "O" ? "O" : "C", mutant, p));
  }

  if (!spec) {
    return { residue: mutant, clashes: 0, chi: [], failed: !resName };
  }

  // Neighbour atoms once, for scoring every rotamer against the same set.
  const neighbours: Vector3[] = [];
  for (const res of structure.residues.values()) {
    if (res.resSeq === pos || !res.ca) continue;
    if (res.ca.distanceTo(ca) > NEIGHBOUR_A) continue;
    for (const a of res.atoms) neighbours.push(a.pos);
  }

  let best: { atoms: Map<string, Vector3>; clashes: number; chi: number[] } | null = null;

  for (const chi of spec.rotamers) {
    const placed = new Map<string, Vector3>(backbone);
    for (const step of spec.build) {
      const pa = placed.get(step.a);
      const pb = placed.get(step.b);
      const pc = placed.get(step.c);
      if (!pa || !pb || !pc) continue;
      const dihedral =
        step.fixed !== undefined ? step.fixed : (chi[step.chi ?? 0] ?? 180) + (step.offset ?? 0);
      placed.set(step.name, place(pa, pb, pc, step.bond, step.angle, dihedral));
    }

    let clashes = 0;
    for (const step of spec.build) {
      const p = placed.get(step.name);
      if (!p) continue;
      for (const q of neighbours) {
        if (p.distanceTo(q) < CLASH_A) clashes++;
      }
    }

    if (!best || clashes < best.clashes) best = { atoms: placed, clashes, chi };
    if (clashes === 0) break; // nothing beats a clash-free rotamer
  }

  if (best) {
    for (const step of spec.build) {
      const p = best.atoms.get(step.name);
      if (!p) continue;
      const element = step.name.startsWith("O")
        ? "O"
        : step.name.startsWith("N")
          ? "N"
          : step.name.startsWith("S")
            ? "S"
            : "C";
      mutant.atoms.push(atom(step.name, element, mutant, p));
    }
  }

  return {
    residue: mutant,
    clashes: best?.clashes ?? 0,
    chi: best?.chi ?? [],
    failed: false,
  };
}
