/**
 * PDB ATOM-record parser plus the geometry the gate needs:
 * a backbone tube from the CA trace, and one InstancedMesh of atoms +
 * one of bonds for the handful of residues we show in full detail.
 *
 * three's PDBLoader gives atoms and bonds but no residue numbering, which is
 * exactly what a mutation review is about, so we parse the records ourselves.
 */

import {
  BufferAttribute,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from "three";

export interface Atom {
  name: string;
  element: string;
  resName: string;
  resSeq: number;
  chain: string;
  pos: Vector3;
}

export interface Residue {
  resSeq: number;
  resName: string;
  chain: string;
  atoms: Atom[];
  ca: Vector3 | null;
}

export interface Structure {
  atoms: Atom[];
  residues: Map<number, Residue>;
  chains: Set<string>;
  /** Offset subtracted from every coordinate so the CA trace is centred. */
  center: Vector3;
  /** Radius of the centred CA trace, in Å. */
  radius: number;
}

const ELEMENT_COLOR: Record<string, number> = {
  C: 0x9aa7b4,
  N: 0x4d8ef7,
  O: 0xf2543d,
  S: 0xf0c04a,
  P: 0xf59c2b,
};

export function elementColor(element: string): number {
  return ELEMENT_COLOR[element] ?? 0xcfd8e3;
}

const AA3 = new Set([
  "ALA", "ARG", "ASN", "ASP", "CYS", "GLN", "GLU", "GLY", "HIS", "ILE",
  "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL",
  "MSE", "SEC", "PYL",
]);

const THREE_TO_ONE: Record<string, string> = {
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C",
  GLN: "Q", GLU: "E", GLY: "G", HIS: "H", ILE: "I",
  LEU: "L", LYS: "K", MET: "M", PHE: "F", PRO: "P",
  SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V",
  MSE: "M",
};

export function oneLetter(resName: string): string {
  return THREE_TO_ONE[resName] ?? "?";
}

/**
 * Parse ATOM records for one chain. Keeps the first altloc, drops hydrogens
 * and waters, and recentres coordinates on the CA centroid.
 */
export function parsePDB(text: string, chain: string): Structure {
  const atoms: Atom[] = [];
  const residues = new Map<number, Residue>();
  const chains = new Set<string>();

  for (const line of text.split("\n")) {
    if (!line.startsWith("ATOM")) {
      // Stop at the end of the first model; NMR ensembles would otherwise
      // stack every model on top of each other.
      if (line.startsWith("ENDMDL")) break;
      continue;
    }
    const altLoc = line[16];
    if (altLoc !== " " && altLoc !== "A") continue;

    const ch = line[21];
    chains.add(ch);
    if (ch !== chain) continue;

    const resName = line.slice(17, 20).trim();
    if (!AA3.has(resName)) continue;

    const element = (line.slice(76, 78).trim() || line.slice(12, 16).trim()[0]).toUpperCase();
    if (element === "H" || element === "D") continue;

    const atom: Atom = {
      name: line.slice(12, 16).trim(),
      element,
      resName,
      resSeq: parseInt(line.slice(22, 26), 10),
      chain: ch,
      pos: new Vector3(
        parseFloat(line.slice(30, 38)),
        parseFloat(line.slice(38, 46)),
        parseFloat(line.slice(46, 54)),
      ),
    };
    atoms.push(atom);

    let res = residues.get(atom.resSeq);
    if (!res) {
      res = { resSeq: atom.resSeq, resName, chain: ch, atoms: [], ca: null };
      residues.set(atom.resSeq, res);
    }
    res.atoms.push(atom);
    if (atom.name === "CA") res.ca = atom.pos;
  }

  // Centre on the CA centroid so grab/rotate pivots through the protein.
  const center = new Vector3();
  let n = 0;
  for (const res of residues.values()) {
    if (res.ca) {
      center.add(res.ca);
      n++;
    }
  }
  if (n > 0) center.divideScalar(n);
  for (const atom of atoms) atom.pos.sub(center);

  let radius = 0;
  for (const res of residues.values()) {
    if (res.ca) radius = Math.max(radius, res.ca.length());
  }

  return { atoms, residues, chains, center, radius: radius || 1 };
}

/** Ordered CA trace, split where the chain breaks (missing residues). */
export function caSegments(structure: Structure, gapAngstrom = 5.5): Vector3[][] {
  const ordered = [...structure.residues.values()]
    .filter((r) => r.ca)
    .sort((a, b) => a.resSeq - b.resSeq);

  const segments: Vector3[][] = [];
  let current: Vector3[] = [];
  let prev: Residue | null = null;

  for (const res of ordered) {
    if (prev && res.ca!.distanceTo(prev.ca!) > gapAngstrom) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(res.ca!);
    prev = res;
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

/**
 * Backbone as a smooth tube, vertex-coloured along the sequence so the fold
 * reads as a path (N-terminus cool → C-terminus warm).
 */
export function buildBackbone(structure: Structure, tubeRadius = 0.38): Group {
  const group = new Group();
  group.name = "backbone";

  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.05,
  });

  const segments = caSegments(structure);
  const total = segments.reduce((sum, s) => sum + s.length, 0);
  let seen = 0;

  for (const points of segments) {
    const curve = new CatmullRomCurve3(points, false, "centripetal", 0.5);
    // ~3 tube rings per residue keeps the curve smooth without exploding the
    // vertex count on a Quest 3S.
    const tubular = Math.max(16, Math.min(points.length * 3, 900));
    const geometry = new TubeGeometry(curve, tubular, tubeRadius, 8, false);

    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3);
    const color = new Color();
    const rings = tubular + 1;
    const radial = 9; // RadialSegments + 1 vertices per ring
    for (let i = 0; i < count; i++) {
      const ring = Math.floor(i / radial);
      const t = (seen + (ring / rings) * points.length) / total;
      // Cool blue (N) to green (C). The old ramp ran through pale yellow,
      // which vanishes against a light backdrop; this stays dark enough to
      // read and leaves the warm accents to the highlights.
      color.setHSL(0.6 - 0.27 * t, 0.52, 0.42);
      color.toArray(colors, i * 3);
    }
    geometry.setAttribute("color", new BufferAttribute(colors, 3));

    group.add(new Mesh(geometry, material));
    seen += points.length;
  }

  return group;
}

const MAX_BOND_A = 1.95;

/**
 * Full-atom representation for a small residue set: one InstancedMesh for
 * spheres, one for bond cylinders. Two draw calls regardless of residue count.
 */
export function buildResidueSticks(
  residues: Residue[],
  opts: { color?: number; atomRadius?: number; bondRadius?: number } = {},
): Group {
  const group = new Group();
  const atoms = residues.flatMap((r) => r.atoms);
  if (atoms.length === 0) return group;

  const atomRadius = opts.atomRadius ?? 0.26;
  const bondRadius = opts.bondRadius ?? 0.12;
  const override = opts.color !== undefined ? new Color(opts.color) : null;

  const sphere = new InstancedMesh(
    new SphereGeometry(atomRadius, 10, 8),
    new MeshStandardMaterial({ roughness: 0.35, metalness: 0.1 }),
    atoms.length,
  );
  const m = new Matrix4();
  const color = new Color();
  atoms.forEach((atom, i) => {
    sphere.setMatrixAt(i, m.makeTranslation(atom.pos.x, atom.pos.y, atom.pos.z));
    sphere.setColorAt(i, override ?? color.setHex(elementColor(atom.element)));
  });
  sphere.instanceMatrix.needsUpdate = true;
  group.add(sphere);

  // Bonds by distance — good enough for standard amino acids and avoids
  // shipping a residue topology table.
  const pairs: [Vector3, Vector3][] = [];
  for (const res of residues) {
    for (let i = 0; i < res.atoms.length; i++) {
      for (let j = i + 1; j < res.atoms.length; j++) {
        const a = res.atoms[i].pos;
        const b = res.atoms[j].pos;
        if (a.distanceTo(b) <= MAX_BOND_A) pairs.push([a, b]);
      }
    }
  }

  if (pairs.length > 0) {
    const bonds = new InstancedMesh(
      new CylinderGeometry(bondRadius, bondRadius, 1, 6, 1, true),
      new MeshStandardMaterial({
        color: override ?? new Color(0xb6c2cf),
        roughness: 0.5,
      }),
      pairs.length,
    );
    const dummy = new Object3D();
    const up = new Vector3(0, 1, 0);
    const dir = new Vector3();
    const q = new Quaternion();
    pairs.forEach(([a, b], i) => {
      dir.subVectors(b, a);
      dummy.position.copy(a).addScaledVector(dir, 0.5);
      dummy.quaternion.copy(q.setFromUnitVectors(up, dir.clone().normalize()));
      dummy.scale.set(1, dir.length(), 1);
      dummy.updateMatrix();
      bonds.setMatrixAt(i, dummy.matrix);
    });
    bonds.instanceMatrix.needsUpdate = true;
    group.add(bonds);
  }

  return group;
}

/** Closest heavy-atom pair between two residues, in structure space. */
export function closestAtomPair(
  a: Residue,
  b: Residue,
): { a: Vector3; b: Vector3; distance: number } | null {
  let best: { a: Vector3; b: Vector3; distance: number } | null = null;
  for (const x of a.atoms) {
    for (const y of b.atoms) {
      const d = x.pos.distanceTo(y.pos);
      if (!best || d < best.distance) {
        best = { a: x.pos.clone(), b: y.pos.clone(), distance: d };
      }
    }
  }
  return best;
}
