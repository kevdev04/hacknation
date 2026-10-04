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
  BufferGeometry,
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
/** Backbone atoms the cartoon already draws. */
const BACKBONE_ATOMS = new Set(["N", "C", "O", "OXT"]);

export function buildResidueSticks(
  residues: Residue[],
  opts: {
    color?: number;
    atomRadius?: number;
    bondRadius?: number;
    /**
     * Drop N, C and O. The cartoon is already drawing the backbone, so
     * including them stacks balls and tubes on top of the ribbon — which is
     * what made a highlighted residue look like a second, competing model.
     * CA is kept so the side chain still visibly joins the chain.
     */
    sideChainOnly?: boolean;
  } = {},
): Group {
  const group = new Group();
  const keep = (a: Atom) => !opts.sideChainOnly || !BACKBONE_ATOMS.has(a.name);
  const atoms = residues.flatMap((r) => r.atoms.filter(keep));
  if (atoms.length === 0) return group;

  const atomRadius = opts.atomRadius ?? 0.17;
  const bondRadius = opts.bondRadius ?? 0.095;
  const override = opts.color !== undefined ? new Color(opts.color) : null;

  const sphere = new InstancedMesh(
    new SphereGeometry(atomRadius, 10, 8),
    new MeshStandardMaterial({ roughness: 0.28, metalness: 0.05 }),
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
    const shown = res.atoms.filter(keep);
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        const a = shown[i].pos;
        const b = shown[j].pos;
        if (a.distanceTo(b) <= MAX_BOND_A) pairs.push([a, b]);
      }
    }
  }

  if (pairs.length > 0) {
    const bonds = new InstancedMesh(
      new CylinderGeometry(bondRadius, bondRadius, 1, 6, 1, true),
      new MeshStandardMaterial({
        color: override ?? new Color(0xb6c2cf),
        roughness: 0.32,
        metalness: 0.05,
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

// ------------------------------------------------------- cartoon rendering

/** Helix, extended strand, or coil. */
export type SS = "H" | "E" | "C";

/**
 * Secondary structure from CA geometry alone, in the manner of P-SEA.
 *
 * Full DSSP needs hydrogen bonds and so needs every backbone atom placed; the
 * CA-only distance and angle criteria below recover helices and strands well
 * enough to draw, which is all this is for. It is a drawing aid, never a
 * structural claim — nothing downstream measures anything from it.
 */
export function assignSecondary(structure: Structure): Map<number, SS> {
  const ordered = [...structure.residues.values()]
    .filter((r) => r.ca)
    .sort((a, b) => a.resSeq - b.resSeq);
  const n = ordered.length;
  const ca = ordered.map((r) => r.ca!);
  const ss = new Map<number, SS>();
  for (const r of ordered) ss.set(r.resSeq, "C");

  const d = (i: number, j: number) => (j >= 0 && j < n ? ca[i].distanceTo(ca[j]) : Infinity);
  const w = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

  // P-SEA's published tolerances. Widening them pushed strand coverage to 35%
  // on 5XJH, which is extended coil being called sheet; at these values the
  // split is 28% helix / 18% strand, which is right for an α/β hydrolase.
  const isHelix: boolean[] = [];
  const isStrand: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const d2 = d(i, i + 2);
    const d3 = d(i, i + 3);
    const d4 = d(i, i + 4);
    isHelix.push(w(d2, 5.0, 6.1) && w(d3, 4.8, 5.8) && w(d4, 5.8, 7.0));
    isStrand.push(w(d2, 6.1, 7.3) && w(d3, 9.0, 10.8) && w(d4, 11.3, 13.5));
  }

  // A lone hit is noise; only a run of consecutive hits is a real element.
  const paint = (flags: boolean[], label: SS, minRun: number, span: number) => {
    let i = 0;
    while (i < n) {
      if (!flags[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && flags[j]) j++;
      if (j - i >= minRun) {
        for (let k = i; k < Math.min(j + span, n); k++) {
          if (label === "H" || ss.get(ordered[k].resSeq) === "C") {
            ss.set(ordered[k].resSeq, label);
          }
        }
      }
      i = j;
    }
  };
  paint(isHelix, "H", 2, 4);
  paint(isStrand, "E", 2, 3);

  // A one-residue island between two of the same kind is a gap, not a change.
  for (let i = 1; i < n - 1; i++) {
    const prev = ss.get(ordered[i - 1].resSeq)!;
    const next = ss.get(ordered[i + 1].resSeq)!;
    if (prev === next && ss.get(ordered[i].resSeq) !== prev) {
      ss.set(ordered[i].resSeq, prev);
    }
  }
  return ss;
}

interface Frame {
  pos: Vector3;
  /** In the peptide plane, perpendicular to the chain: the ribbon's width. */
  right: Vector3;
  ss: SS;
  resSeq: number;
}

/**
 * Per-residue frames. The ribbon's flat face has to follow the peptide plane or
 * a helix renders as a twisted tube instead of a ribbon, so `right` comes from
 * the carbonyl, and each frame is flipped to stay continuous with the last.
 */
function buildFrames(residues: Residue[]): Frame[] {
  const frames: Frame[] = [];
  let previous: Vector3 | null = null;

  for (let i = 0; i < residues.length; i++) {
    const res = residues[i];
    const ca = res.ca!;
    const next = residues[i + 1]?.ca ?? null;
    const prev = residues[i - 1]?.ca ?? null;

    const along = new Vector3();
    if (next && prev) along.subVectors(next, prev);
    else if (next) along.subVectors(next, ca);
    else if (prev) along.subVectors(ca, prev);
    else along.set(0, 0, 1);
    along.normalize();

    const c = res.atoms.find((a) => a.name === "C")?.pos;
    const o = res.atoms.find((a) => a.name === "O")?.pos;
    let right: Vector3;
    if (c && o) {
      right = new Vector3().subVectors(o, c).cross(along).normalize();
    } else {
      right = new Vector3(0, 1, 0).cross(along).normalize();
    }
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);

    // Consecutive carbonyls alternate direction along a strand; without this
    // the ribbon would flip 180° every residue and self-intersect.
    if (previous && right.dot(previous) < 0) right.negate();
    previous = right.clone();

    frames.push({ pos: ca.clone(), right, ss: "C", resSeq: res.resSeq });
  }
  return frames;
}

/** Cross-section half-width and half-thickness, in Å, per structure type. */
const PROFILE: Record<SS, { w: number; t: number }> = {
  H: { w: 1.2, t: 0.26 },
  E: { w: 1.1, t: 0.2 },
  C: { w: 0.3, t: 0.3 },
};

const CROSS_SECTION = 8;

/**
 * Cartoon ribbon: helices and strands as flat ribbons, coil as a thin tube,
 * strands tapering to an arrowhead at their C-terminal end.
 *
 * Built once per structure and never rebuilt on interaction — the rendering
 * rules in CLAUDE.md apply here more than anywhere, since this is the heaviest
 * geometry in the scene.
 */
export function buildCartoon(structure: Structure, samplesPerResidue = 8): Group {
  const group = new Group();
  group.name = "backbone";

  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.42,
    metalness: 0.0,
    flatShading: false,
  });

  const ss = assignSecondary(structure);
  const ordered = [...structure.residues.values()]
    .filter((r) => r.ca)
    .sort((a, b) => a.resSeq - b.resSeq);

  // Split where the chain actually breaks, as the tube version did.
  const segments: Residue[][] = [];
  let run: Residue[] = [];
  let prev: Residue | null = null;
  for (const res of ordered) {
    if (prev && res.ca!.distanceTo(prev.ca!) > 5.5) {
      if (run.length > 1) segments.push(run);
      run = [];
    }
    run.push(res);
    prev = res;
  }
  if (run.length > 1) segments.push(run);

  const total = ordered.length;
  let seen = 0;

  for (const residues of segments) {
    const frames = buildFrames(residues);
    frames.forEach((f, i) => (f.ss = ss.get(residues[i].resSeq) ?? "C"));

    // Frames from the end of the strand each one belongs to, for the arrowhead.
    const toStrandEnd = new Array<number>(frames.length).fill(Infinity);
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].ss !== "E") continue;
      toStrandEnd[i] = frames[i + 1]?.ss === "E" ? toStrandEnd[i + 1] + 1 : 0;
    }

    const centre = new CatmullRomCurve3(
      frames.map((f) => f.pos),
      false,
      "centripetal",
      0.5,
    );
    const steps = Math.max(8, (frames.length - 1) * samplesPerResidue);

    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const vertexResidue: number[] = [];

    const color = new Color();
    const up = new Vector3();
    const right = new Vector3();
    const forward = new Vector3();
    const point = new Vector3();

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      centre.getPoint(t, point);
      centre.getTangent(t, forward).normalize();

      // Interpolate the frame between the two residues this sample sits between.
      const fi = t * (frames.length - 1);
      const i0 = Math.min(Math.floor(fi), frames.length - 1);
      const i1 = Math.min(i0 + 1, frames.length - 1);
      const mix = fi - i0;
      right.copy(frames[i0].right).lerp(frames[i1].right, mix).normalize();
      // Re-orthogonalise: lerping two unit vectors does not keep the angle.
      right.sub(forward.clone().multiplyScalar(right.dot(forward))).normalize();
      up.crossVectors(forward, right).normalize();

      const type = mix < 0.5 ? frames[i0].ss : frames[i1].ss;
      let { w, t: th } = PROFILE[type];

      // A strand ends in an arrowhead: widen, then taper to a point.
      if (type === "E") {
        const lead = toStrandEnd[i0] - mix;
        if (lead >= 0 && lead < 1.7) {
          // 1 at the shoulder, 0 at the tip: widen, then taper to a point.
          const k = lead / 1.7;
          w = 0.3 + 1.6 * k;
        }
      }

      const base = positions.length / 3;
      for (let v = 0; v < CROSS_SECTION; v++) {
        const a = (v / CROSS_SECTION) * Math.PI * 2;
        const ox = Math.cos(a) * w;
        const oy = Math.sin(a) * th;
        positions.push(
          point.x + right.x * ox + up.x * oy,
          point.y + right.y * ox + up.y * oy,
          point.z + right.z * ox + up.z * oy,
        );
        const n = new Vector3(
          right.x * ox * th + up.x * oy * w,
          right.y * ox * th + up.y * oy * w,
          right.z * ox * th + up.z * oy * w,
        ).normalize();
        normals.push(n.x, n.y, n.z);

        const along = (seen + t * frames.length) / total;
        color.setHSL(0.6 - 0.27 * along, 0.55, type === "C" ? 0.46 : 0.42);
        colors.push(color.r, color.g, color.b);
        vertexResidue.push(frames[mix < 0.5 ? i0 : i1].resSeq);
      }

      if (s > 0) {
        const prevBase = base - CROSS_SECTION;
        for (let v = 0; v < CROSS_SECTION; v++) {
          const v2 = (v + 1) % CROSS_SECTION;
          indices.push(prevBase + v, base + v, prevBase + v2);
          indices.push(prevBase + v2, base + v, base + v2);
        }
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
    const colorAttr = new BufferAttribute(new Float32Array(colors), 3);
    geometry.setAttribute("color", colorAttr);
    geometry.setIndex(indices);

    // Repainting the ribbon is an attribute write, never a rebuild — the
    // rendering rules forbid regenerating this geometry on interaction.
    geometry.userData.residueOfVertex = Int32Array.from(vertexResidue);
    geometry.userData.baseColors = Float32Array.from(colors);

    group.add(new Mesh(geometry, material));

    seen += frames.length;
  }

  return group;
}


/**
 * Repaint named residues on the cartoon itself.
 *
 * This is how a result changes the molecule: the ribbon the reviewer is already
 * looking at takes the colour, rather than a second representation being laid
 * over the top of it. Passing an empty map restores the original N→C ramp.
 *
 * Geometry is untouched — only the colour attribute is written — so this is
 * safe to call on every interaction.
 */
export function recolorCartoon(backbone: Group, overrides: Map<number, Color>): void {
  backbone.traverse((child) => {
    const mesh = child as Mesh;
    const geometry = mesh.geometry as BufferGeometry | undefined;
    if (!geometry) return;
    const residues = geometry.userData.residueOfVertex as Int32Array | undefined;
    const base = geometry.userData.baseColors as Float32Array | undefined;
    const attr = geometry.getAttribute("color") as BufferAttribute | undefined;
    if (!residues || !base || !attr) return;

    const array = attr.array as Float32Array;
    for (let v = 0; v < residues.length; v++) {
      const override = overrides.get(residues[v]);
      const i = v * 3;
      if (override) {
        array[i] = override.r;
        array[i + 1] = override.g;
        array[i + 2] = override.b;
      } else {
        array[i] = base[i];
        array[i + 1] = base[i + 1];
        array[i + 2] = base[i + 2];
      }
    }
    attr.needsUpdate = true;
  });
}

/** Textbook cartoon colours: cyan helix, red strand, magenta loop. */
export const SS_COLOR: Record<SS, number> = {
  H: 0x1aa7c0,
  E: 0xc0392b,
  C: 0xa0399c,
};

/**
 * Disulfide bonds, measured from the structure: cysteine SG pairs within
 * bonding distance. Never declared by the caller — a disulfide either is or is
 * not there, and the file is the authority.
 */
export function findDisulfides(
  structure: Structure,
  maxDistance = 2.5,
): { a: number; b: number; distance: number; posA: Vector3; posB: Vector3 }[] {
  const sg: { resSeq: number; pos: Vector3 }[] = [];
  for (const res of structure.residues.values()) {
    if (res.resName !== "CYS") continue;
    const atom = res.atoms.find((a) => a.name === "SG");
    if (atom) sg.push({ resSeq: res.resSeq, pos: atom.pos });
  }
  const out: { a: number; b: number; distance: number; posA: Vector3; posB: Vector3 }[] = [];
  for (let i = 0; i < sg.length; i++) {
    for (let j = i + 1; j < sg.length; j++) {
      const d = sg[i].pos.distanceTo(sg[j].pos);
      if (d <= maxDistance) {
        out.push({
          a: sg[i].resSeq,
          b: sg[j].resSeq,
          distance: d,
          posA: sg[i].pos,
          posB: sg[j].pos,
        });
      }
    }
  }
  return out;
}

/** First and last residue with a CA, for labelling the termini. */
export function termini(structure: Structure): { n: Residue; c: Residue } | null {
  const ordered = [...structure.residues.values()]
    .filter((r) => r.ca)
    .sort((a, b) => a.resSeq - b.resSeq);
  if (ordered.length < 2) return null;
  return { n: ordered[0], c: ordered[ordered.length - 1] };
}

/**
 * Per-residue colours for a scheme, to be handed to `recolorCartoon`. An empty
 * map means "leave the ribbon as built", which is the gradient.
 */
export function schemeColors(
  structure: Structure,
  scheme: "gradient" | "secondary_structure" | "uniform",
): Map<number, Color> {
  const out = new Map<number, Color>();
  if (scheme === "gradient") return out;

  if (scheme === "uniform") {
    const muted = new Color(0x93a7bb);
    for (const res of structure.residues.values()) out.set(res.resSeq, muted);
    return out;
  }

  const ss = assignSecondary(structure);
  for (const [resSeq, type] of ss) out.set(resSeq, new Color(SS_COLOR[type]));
  return out;
}
