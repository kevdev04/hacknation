/** Mutation and active-site highlighting, labels, and the distance callout. */

import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Line,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import {
  buildResidueSticks,
  closestAtomPair,
  oneLetter,
  type Residue,
  type Structure,
} from "./protein";

export const COLOR_MUTATION = 0xd1820a;
export const COLOR_ACTIVE_SITE = 0x0d8277;
export const COLOR_PICK = 0xb01f66;

/** Text label on a transparent canvas, sized in structure units (Å). */
export function makeLabel(text: string, color = 0xffffff, heightA = 2.6): Sprite {
  const pad = 16;
  const fontPx = 64;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `600 ${fontPx}px ui-monospace, Menlo, monospace`;
  const width = Math.ceil(measure.measureText(text).width) + pad * 2;
  const height = fontPx + pad * 2;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `600 ${fontPx}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = "middle";

  // Frosted chip to match the panels. The border keeps the bright geometry
  // colour so the label still ties to the atoms it names, while the text is a
  // darkened version of it so it carries on a near-white background.
  const base = new Color(color);
  const ink = base.clone().multiplyScalar(0.45);

  ctx.fillStyle = "rgba(226, 235, 243, 0.80)";
  roundRect(ctx, 0, 0, width, height, 18);
  ctx.fill();
  ctx.strokeStyle = `#${base.getHexString()}`;
  ctx.lineWidth = 4;
  roundRect(ctx, 2, 2, width - 4, height - 4, 16);
  ctx.stroke();

  ctx.fillStyle = `#${ink.getHexString()}`;
  ctx.fillText(text, pad, height / 2 + 2);

  const texture = new CanvasTexture(canvas);
  texture.anisotropy = 4;
  const sprite = new Sprite(
    new SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  sprite.scale.set((heightA * width) / height, heightA, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Soft glow sphere marking a residue so it is findable from across the room. */
function halo(center: Vector3, color: number, radius: number): Mesh {
  const mesh = new Mesh(
    new SphereGeometry(radius, 16, 12),
    new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  );
  mesh.position.copy(center);
  return mesh;
}

export function residueCentroid(res: Residue): Vector3 {
  const c = new Vector3();
  for (const a of res.atoms) c.add(a.pos);
  return c.divideScalar(res.atoms.length || 1);
}

export interface HighlightResult {
  group: Group;
  /** Å between the mutated residue and its nearest active-site residue. */
  distance: number | null;
  nearestResidue: number | null;
  /** True when the structure's residue does not match the candidate's `wt`. */
  wtMismatch: boolean;
}

export function buildHighlights(
  structure: Structure,
  opts: {
    mutationPos: number;
    mutationLabel: string;
    expectedWt: string;
    activeSite: number[];
  },
): HighlightResult {
  const group = new Group();
  group.name = "highlights";

  const mutated = structure.residues.get(opts.mutationPos) ?? null;
  const siteResidues = opts.activeSite
    .map((pos) => structure.residues.get(pos))
    .filter((r): r is Residue => !!r);

  // Active site: second colour, full atoms, labelled with residue identity.
  if (siteResidues.length > 0) {
    group.add(
      buildResidueSticks(siteResidues, { color: COLOR_ACTIVE_SITE, sideChainOnly: true }),
    );
    for (const res of siteResidues) {
      const c = residueCentroid(res);
      group.add(halo(c, COLOR_ACTIVE_SITE, 2.4));
      const label = makeLabel(
        `${oneLetter(res.resName)}${res.resSeq}`,
        COLOR_ACTIVE_SITE,
        1.9,
      );
      label.position.copy(c).add(new Vector3(0, 2.6, 0));
      group.add(label);
    }
  }

  let distance: number | null = null;
  let nearestResidue: number | null = null;
  let wtMismatch = false;

  if (mutated) {
    wtMismatch = oneLetter(mutated.resName) !== opts.expectedWt;

    group.add(
      buildResidueSticks([mutated], { color: COLOR_MUTATION, sideChainOnly: true }),
    );
    const c = residueCentroid(mutated);
    group.add(halo(c, COLOR_MUTATION, 3.4));

    const label = makeLabel(opts.mutationLabel, COLOR_MUTATION, 3.2);
    label.position.copy(c).add(new Vector3(0, 6.2, 0));
    group.add(label);

    // Dashed line to the nearest active-site residue, labelled in Å.
    let best: { pair: ReturnType<typeof closestAtomPair>; res: Residue } | null = null;
    for (const res of siteResidues) {
      if (res.resSeq === mutated.resSeq) continue;
      const pair = closestAtomPair(mutated, res);
      if (pair && (!best || pair.distance < best.pair!.distance)) {
        best = { pair, res };
      }
    }

    if (best?.pair) {
      distance = best.pair.distance;
      nearestResidue = best.res.resSeq;

      const geometry = new BufferGeometry().setFromPoints([
        best.pair.a,
        best.pair.b,
      ]);
      const line = new Line(
        geometry,
        new LineDashedMaterial({
          color: 0x33475b,
          dashSize: 0.55,
          gapSize: 0.45,
          transparent: true,
          opacity: 0.85,
        }),
      );
      line.computeLineDistances();
      group.add(line);

      // Nudge the distance label sideways off the line so it never lands on
      // the mutation label above it.
      const mid = best.pair.a.clone().add(best.pair.b).multiplyScalar(0.5);
      const along = best.pair.b.clone().sub(best.pair.a).normalize();
      const side = new Vector3().crossVectors(along, new Vector3(0, 1, 0));
      if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
      const distLabel = makeLabel(`${distance.toFixed(1)} Å`, 0x33475b, 1.8);
      distLabel.position.copy(mid).addScaledVector(side.normalize(), 2.4);
      group.add(distLabel);
    }
  }

  return { group, distance, nearestResidue, wtMismatch };
}

/** Marker for the residue the user picked with the controller ray. */
export class PickMarker {
  readonly group = new Group();
  private label: Sprite | null = null;
  private dot: Mesh;

  constructor() {
    this.dot = new Mesh(
      new SphereGeometry(1.1, 16, 12),
      new MeshBasicMaterial({
        color: COLOR_PICK,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      }),
    );
    this.group.add(this.dot);
    this.group.visible = false;
  }

  show(res: Residue): void {
    const c = residueCentroid(res);
    this.dot.position.copy(c);
    if (this.label) {
      this.group.remove(this.label);
      this.label.material.map?.dispose();
      this.label.material.dispose();
    }
    this.label = makeLabel(
      `${res.resName} ${res.resSeq}`,
      COLOR_PICK,
      2.0,
    );
    this.label.position.copy(c).add(new Vector3(0, -2.6, 0));
    this.group.add(this.label);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }
}

// --------------------------------------------------------------- bench overlay

export const COLOR_BENCH = 0x2461c4;
export const COLOR_BENCH_OFF = 0x8fa2b6;
export const COLOR_EPISTASIS = 0xc2384b;

export interface BenchOverlayMutation {
  pos: number;
  label: string;
  enabled: boolean;
  /** Modelled mutant residue; falls back to the wild type when absent. */
  residue?: Residue | null;
}

export interface BenchOverlayPair {
  a: number;
  b: number;
  distance: number;
}

/**
 * Every stacked mutation drawn at once, plus a line between each pair close
 * enough that the additive estimate should be distrusted.
 *
 * Rebuilt on bench change only — never per frame. Enabled mutations get full
 * side-chain detail (instanced, so the whole stack is two draw calls); toggled
 * off ones keep a dim halo so the position stays visible without competing.
 */
export function buildBenchOverlay(
  structure: Structure,
  opts: {
    mutations: BenchOverlayMutation[];
    epistasis: BenchOverlayPair[];
  },
): Group {
  const group = new Group();
  group.name = "bench-overlay";

  const enabled: Residue[] = [];

  for (const mutation of opts.mutations) {
    // The modelled side chain is what the reviewer should see once a
    // substitution is on the bench — the wild type is no longer what is there.
    const res = mutation.residue ?? structure.residues.get(mutation.pos);
    if (!res) continue;
    const centre = residueCentroid(res);

    if (mutation.enabled) {
      enabled.push(res);
      group.add(halo(centre, COLOR_BENCH, 3.0));
      const label = makeLabel(mutation.label, COLOR_BENCH, 2.6);
      label.position.copy(centre).add(new Vector3(0, 5.2, 0));
      group.add(label);
    } else {
      group.add(halo(centre, COLOR_BENCH_OFF, 2.0));
    }
  }

  if (enabled.length > 0) {
    group.add(
      buildResidueSticks(enabled, { color: COLOR_BENCH, sideChainOnly: true }),
    );
  }

  for (const pair of opts.epistasis) {
    const resA = structure.residues.get(pair.a);
    const resB = structure.residues.get(pair.b);
    if (!resA || !resB) continue;
    const closest = closestAtomPair(resA, resB);
    if (!closest) continue;

    const line = new Line(
      new BufferGeometry().setFromPoints([closest.a, closest.b]),
      new LineDashedMaterial({
        color: COLOR_EPISTASIS,
        dashSize: 0.4,
        gapSize: 0.3,
        transparent: true,
        opacity: 0.95,
      }),
    );
    line.computeLineDistances();
    group.add(line);

    const mid = closest.a.clone().add(closest.b).multiplyScalar(0.5);
    const label = makeLabel(`${pair.distance.toFixed(1)} Å`, COLOR_EPISTASIS, 1.6);
    label.position.copy(mid).add(new Vector3(0, 1.6, 0));
    group.add(label);
  }

  return group;
}
