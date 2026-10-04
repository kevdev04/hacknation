/**
 * Shared canvas-panel plumbing for the in-world UI.
 *
 * Every surface in the lab — review card, combination bench, residue card — is
 * one CanvasTexture on one plane, so a repaint costs one texture upload and one
 * draw call. Panels register hit regions in canvas pixels while they draw; a
 * controller ray that lands on the plane is converted through the hit UV and
 * tested against those regions. That is what makes chips and buttons clickable
 * without a second piece of geometry per widget, which matters on a Quest 3S.
 */

import {
  CanvasTexture,
  DoubleSide,
  LinearFilter,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  type Material,
  type Object3D,
  type Vector2,
} from "three";

export const MONO = "ui-monospace, Menlo, monospace";

/**
 * Frosted-glass lab palette: light surfaces, dark text, saturated ink accents.
 *
 * Light panels are not only a look — in passthrough they read far better in a
 * bright room than dark ones, which wash out against the camera feed. Accents
 * are chosen dark enough to carry text on a near-white card rather than the
 * neon values a dark theme needs.
 */
/**
 * Liquid glass, for a lab.
 *
 * The sheet is a cool grey held in the mid-80s for alpha: enough to still read
 * as glass against a real room, but enough of a substrate that text does not
 * have to fight whatever is behind it. Lower looked better on a clean desktop
 * grid and fell apart over a saturated wall in passthrough — antialiased glyph
 * edges are only partly opaque, so every thin stroke blends with the room and
 * small type dissolves. Depth comes from the edges rather than the fill: a
 * gradient that lets light rake across the sheet, an outer hairline that keeps
 * it legible against a bright wall, and a specular rim just inside it.
 *
 * Inset wells go DARKER than the sheet. On a translucent surface a lighter
 * inset reads as a hole, not a layer.
 *
 * Ink and accents are pitched dark because the backdrop is a real room and
 * cannot be relied on: every accent has to carry small text at 55% alpha over
 * whatever happens to be behind it.
 */
export const THEME = {
  glassLift: "rgba(241, 246, 251, 0.90)",
  glass: "rgba(215, 225, 236, 0.86)",
  glassDeep: "rgba(197, 209, 223, 0.84)",
  rim: "rgba(255, 255, 255, 0.70)",
  edge: "rgba(30, 54, 76, 0.55)",
  rule: "rgba(36, 62, 86, 0.28)",
  /** Inset wells: stat tiles, chips, inactive controls. */
  surface: "rgba(126, 150, 175, 0.30)",
  /** Full-card wash behind the decision flash. */
  scrim: "rgba(224, 233, 243, 0.93)",
  control: "rgba(243, 248, 252, 0.72)",
  controlDisabled: "rgba(203, 215, 228, 0.45)",
  /** Text sitting on top of a filled accent button. */
  onAccent: "#f3f9fc",

  text: "#06121c",
  body: "#17293a",
  dim: "#27455c",
  faint: "#3f5d76",

  accent: "#06707f",
  bench: "#1f55b8",
  warn: "#a62638",
  warnText: "#8e1a2b",
  caution: "#9e4f08",
  good: "#116a4f",
  agent: "#4d3399",
  pick: "#a3175c",
  off: "#627a90",

  tintAccent: "rgba(6, 112, 127, 0.15)",
  tintBench: "rgba(31, 85, 184, 0.15)",
  tintWarn: "rgba(166, 38, 56, 0.15)",
  tintGood: "rgba(17, 106, 79, 0.13)",
} as const;

export function font(weight: number | null, px: number): string {
  return `${weight ? `${weight} ` : ""}${px}px ${MONO}`;
}

interface Region {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ButtonOptions {
  /** Filled rather than outlined — for the primary action on a panel. */
  solid?: boolean;
  /** Drawn at half strength and not registered as a hit region. */
  disabled?: boolean;
  fontSize?: number;
}

export class CanvasPanel {
  readonly group = new Group();
  readonly mesh: Mesh;
  readonly widthMeters: number;
  readonly heightMeters: number;

  protected readonly ctx: CanvasRenderingContext2D;
  protected readonly W: number;
  protected readonly H: number;

  private readonly texture: CanvasTexture;
  private regions: Region[] = [];

  constructor(width: number, height: number, widthMeters: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    this.W = width;
    this.H = height;
    this.widthMeters = widthMeters;
    this.heightMeters = (widthMeters * height) / width;
    this.ctx = canvas.getContext("2d")!;

    this.texture = new CanvasTexture(canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;

    this.mesh = new Mesh(
      new PlaneGeometry(this.widthMeters, this.heightMeters),
      new MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        toneMapped: false,
      }),
    );
    this.mesh.userData.panel = this;
    this.group.add(this.mesh);
  }

  /** Hang a drag handle just below the panel's bottom edge. */
  addGrabBar(): Group {
    const width = this.widthMeters * 0.32;
    const bar = makeGrabBar(width);
    bar.position.set(0, -this.heightMeters / 2 - width * 0.17, 0.002);
    this.group.add(bar);
    return bar;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }

  /**
   * Map a ray/plane intersection UV onto the regions drawn in the last repaint.
   * Later regions win so a chip drawn over a panel background is picked first.
   */
  hitTest(uv: Vector2): string | null {
    const x = uv.x * this.W;
    const y = (1 - uv.y) * this.H;
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
    }
    return null;
  }

  /** Clear the canvas and drop last frame's hit regions. */
  protected begin(): void {
    this.regions.length = 0;
    this.ctx.clearRect(0, 0, this.W, this.H);
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "alphabetic";
  }

  protected commit(): void {
    this.texture.needsUpdate = true;
  }

  protected region(id: string, x: number, y: number, w: number, h: number): void {
    this.regions.push({ id, x, y, w, h });
  }

  /**
   * The glass sheet. Three stops of gradient give it the rake of light that
   * makes a translucent surface read as a pane rather than a flat wash, and the
   * two concentric strokes are what actually sell it: a dark hairline for
   * definition against an unknown room, a bright rim inside it for the
   * specular edge.
   */
  protected backdrop(): void {
    const ctx = this.ctx;
    const inset = 6;
    const w = this.W - inset * 2;
    const h = this.H - inset * 2;

    const sheet = ctx.createLinearGradient(0, 0, this.W * 0.25, this.H);
    sheet.addColorStop(0, THEME.glassLift);
    sheet.addColorStop(0.5, THEME.glass);
    sheet.addColorStop(1, THEME.glassDeep);
    ctx.fillStyle = sheet;
    this.roundRect(inset, inset, w, h, 30);
    ctx.fill();

    ctx.strokeStyle = THEME.edge;
    ctx.lineWidth = 2.5;
    this.roundRect(inset, inset, w, h, 30);
    ctx.stroke();

    ctx.strokeStyle = THEME.rim;
    ctx.lineWidth = 2;
    this.roundRect(inset + 3, inset + 3, w - 6, h - 6, 27);
    ctx.stroke();
  }

  protected rule(y: number, inset = 44): void {
    const ctx = this.ctx;
    ctx.strokeStyle = THEME.rule;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(inset, y);
    ctx.lineTo(this.W - inset, y);
    ctx.stroke();
  }

  /** Section heading in the small caps style used across every panel. */
  protected heading(text: string, x: number, y: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.font = font(600, 20);
    this.ctx.fillText(text, x, y);
  }

  protected button(
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    color: string,
    opts: ButtonOptions = {},
  ): void {
    const ctx = this.ctx;
    const disabled = !!opts.disabled;

    if (opts.solid && !disabled) {
      ctx.fillStyle = color;
      this.roundRect(x, y, w, h, h / 2);
      ctx.fill();
    } else {
      ctx.fillStyle = disabled ? THEME.controlDisabled : THEME.control;
      this.roundRect(x, y, w, h, h / 2);
      ctx.fill();
      ctx.strokeStyle = disabled ? THEME.off : color;
      ctx.lineWidth = 3;
      this.roundRect(x, y, w, h, h / 2);
      ctx.stroke();
    }

    ctx.fillStyle =
      opts.solid && !disabled ? THEME.onAccent : disabled ? THEME.off : color;
    ctx.font = font(700, opts.fontSize ?? 24);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    if (!disabled) this.region(id, x, y, w, h);
  }

  protected roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  /** Word-wrap; returns the y after the last line drawn. */
  protected wrap(
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
    maxLines = Infinity,
  ): number {
    const ctx = this.ctx;
    let line = "";
    let lines = 0;
    for (const word of text.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        if (lines + 1 >= maxLines) {
          ctx.fillText(`${line}…`, x, y);
          return y + lineHeight;
        }
        ctx.fillText(line, x, y);
        y += lineHeight;
        lines++;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      ctx.fillText(line, x, y);
      y += lineHeight;
    }
    return y;
  }
}

/**
 * The handle that says "pick me up here": a plain white line under the surface.
 *
 * The visible line is deliberately thin, but a bare line is far too small to
 * pinch at arm's length, so an invisible plane several times its height carries
 * the actual hit area. Both are tagged `userData.grabHandle`, which is how the
 * grab resolvers tell a deliberate reposition from a press on a control.
 */
export function makeGrabBar(widthMeters: number): Group {
  const group = new Group();

  const lineHeight = widthMeters / 22;
  // Comfortable pinch/point target regardless of how thin the line looks.
  const hitHeight = Math.max(lineHeight * 6, widthMeters * 0.22);

  const hit = new Mesh(
    new PlaneGeometry(widthMeters * 1.12, hitHeight),
    new MeshBasicMaterial({ visible: false }),
  );
  hit.userData.grabHandle = true;
  group.add(hit);

  // Rounded ends read as a handle rather than a stray edge, which a bare
  // PlaneGeometry cannot give us.
  const W = 256;
  const H = 16;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const r = H / 2;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(W, 0, W, H, r);
  ctx.arcTo(W, H, 0, H, r);
  ctx.arcTo(0, H, 0, 0, r);
  ctx.arcTo(0, 0, W, 0, r);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "rgba(18, 34, 46, 0.55)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;

  const line = new Mesh(
    new PlaneGeometry(widthMeters, lineHeight),
    new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.85,
      toneMapped: false,
      side: DoubleSide,
      depthWrite: false,
    }),
  );
  line.userData.grabHandle = true;
  line.renderOrder = 5;
  group.add(line);

  group.userData.grabHandle = true;
  return group;
}

/** Signed score, always with an explicit sign so +/- reads at a glance. */
export function signed(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
}

/** Free the geometry, materials and canvas textures under a discarded group. */
export function disposeGroup(root: Object3D): void {
  root.traverse((obj) => {
    const node = obj as Object3D & {
      geometry?: { dispose(): void };
      material?: Material | Material[];
    };
    node.geometry?.dispose();
    const materials = Array.isArray(node.material)
      ? node.material
      : node.material
        ? [node.material]
        : [];
    for (const material of materials) {
      const textured = material as Material & { map?: { dispose(): void } | null };
      textured.map?.dispose();
      material.dispose();
    }
  });
}
