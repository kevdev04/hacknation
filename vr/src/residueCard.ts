/**
 * The residue card: what the reviewer sees after picking a position.
 *
 * Sits on a tilted surface below the protein with a leader line back to the
 * residue it describes, so the structure stays readable while the numbers are
 * within reach. The three stat tiles are measured from the PDB and are true
 * today; the substitution grid carries whatever tier the scan is on.
 */

import { CanvasPanel, THEME, font, signed } from "./ui";
import {
  AA_NAME,
  NEIGHBOUR_CUTOFF_A,
  chargeDelta,
  polarity,
  type ResidueMetrics,
} from "./metrics";
import { scanCaption, type Scan } from "./scan";

const W = 1060;
const H = 920;
const PANEL_WIDTH_M = 0.68;

const COLS = 3;
const ROWS = 7;
const CELL_H = 58;
const CELL_GAP = 8;

export interface SubstitutionRow {
  mut: string;
  llr: number | null;
  inBench: boolean;
}

export interface ResidueCardState {
  pos: number;
  wt: string;
  resName: string;
  chain: string;
  metrics: ResidueMetrics;
  substitutions: SubstitutionRow[];
  scan: Scan | null;
  /** Bench is at capacity and this position is not already on it. */
  blocked: boolean;
  isActiveSite: boolean;
}

export class ResidueCard extends CanvasPanel {
  constructor() {
    super(W, H, PANEL_WIDTH_M);
    this.visible = false;
  }

  render(state: ResidueCardState): void {
    const ctx = this.ctx;
    this.begin();
    this.backdrop();

    // ---------------------------------------------------------- header
    ctx.fillStyle = THEME.pick;
    ctx.font = font(700, 50);
    ctx.fillText(`${state.resName} ${state.pos}`, 44, 76);

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 22);
    ctx.fillText(
      `chain ${state.chain} · wild type ${state.wt}${
        state.isActiveSite ? " · CATALYTIC TRIAD" : ""
      }`,
      44,
      108,
    );

    this.button("card:close", W - 108, 38, 64, 56, "×", THEME.off, { fontSize: 34 });

    // ---------------------------------------------------------- stat tiles
    const tileW = (W - 88 - 2 * 16) / 3;
    const tileY = 136;
    const { metrics } = state;

    this.tile(
      44,
      tileY,
      tileW,
      "Active site",
      metrics.distanceToActiveSite == null
        ? "—"
        : `${metrics.distanceToActiveSite.toFixed(1)} Å`,
      metrics.nearestActiveSite == null
        ? "not measurable"
        : `nearest residue ${metrics.nearestActiveSite}`,
      metrics.distanceToActiveSite != null && metrics.distanceToActiveSite < 8
        ? THEME.warnText
        : THEME.accent,
    );

    this.tile(
      44 + tileW + 16,
      tileY,
      tileW,
      "Burial",
      metrics.burial,
      `${metrics.neighbours} neighbours ≤ ${NEIGHBOUR_CUTOFF_A} Å`,
      metrics.burial === "surface" ? THEME.good : THEME.caution,
    );

    this.tile(
      44 + (tileW + 16) * 2,
      tileY,
      tileW,
      "Wild type",
      AA_NAME[state.wt] ?? state.resName,
      polarity(state.wt),
      THEME.dim,
    );

    let y = tileY + 136;
    this.rule(y);
    y += 40;

    // ---------------------------------------------------------- grid header
    this.heading("Substitute to", 44, y, THEME.bench);
    ctx.textAlign = "right";
    const placeholder = state.scan?.source !== "model";
    ctx.fillStyle = placeholder ? THEME.warnText : THEME.faint;
    ctx.font = font(placeholder ? 700 : null, 19);
    ctx.fillText(scanCaption(state.scan), W - 44, y);
    ctx.textAlign = "left";
    y += 14;

    if (state.blocked) {
      ctx.fillStyle = THEME.warnText;
      ctx.font = font(600, 23);
      ctx.fillText("bench is full — remove a chip to add another", 44, y + 24);
    } else {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 22);
      ctx.fillText("best first · trigger to stack on the bench", 44, y + 24);
    }
    y += 44;

    // ---------------------------------------------------------- grid
    const cellW = (W - 88 - (COLS - 1) * CELL_GAP) / COLS;
    state.substitutions.slice(0, COLS * ROWS).forEach((row, index) => {
      const col = index % COLS;
      const rowIndex = Math.floor(index / COLS);
      const x = 44 + col * (cellW + CELL_GAP);
      const cellY = y + rowIndex * (CELL_H + CELL_GAP);
      this.cell(row, state.wt, x, cellY, cellW, state.blocked);
    });

    this.commit();
  }

  private tile(
    x: number,
    y: number,
    w: number,
    label: string,
    value: string,
    sub: string,
    color: string,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = THEME.surface;
    this.roundRect(x, y, w, 118, 16);
    ctx.fill();
    ctx.strokeStyle = THEME.rule;
    ctx.lineWidth = 2;
    this.roundRect(x, y, w, 118, 16);
    ctx.stroke();

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 22);
    ctx.fillText(label, x + 18, y + 30);

    ctx.fillStyle = color;
    ctx.font = font(700, 36);
    ctx.fillText(value, x + 18, y + 74);

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 22);
    ctx.fillText(sub, x + 18, y + 102);
  }

  private cell(
    row: SubstitutionRow,
    wt: string,
    x: number,
    y: number,
    w: number,
    blocked: boolean,
  ): void {
    const ctx = this.ctx;
    const good = (row.llr ?? 0) >= 0;
    const selectable = !blocked || row.inBench;

    ctx.fillStyle = row.inBench
      ? THEME.tintBench
      : good
        ? THEME.tintGood
        : THEME.surface;
    this.roundRect(x, y, w, CELL_H, 12);
    ctx.fill();

    ctx.strokeStyle = row.inBench ? THEME.bench : THEME.rule;
    ctx.lineWidth = row.inBench ? 3 : 2;
    this.roundRect(x, y, w, CELL_H, 12);
    ctx.stroke();

    const mid = y + CELL_H / 2;
    ctx.textBaseline = "middle";

    ctx.fillStyle = selectable ? THEME.text : THEME.off;
    ctx.font = font(700, 28);
    ctx.fillText(`${wt}→${row.mut}`, x + 16, mid + 1);

    ctx.textAlign = "right";
    ctx.fillStyle = !selectable ? THEME.off : good ? THEME.good : THEME.warnText;
    ctx.font = font(600, 24);
    ctx.fillText(signed(row.llr), x + w - 16, mid + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    // Charge change is a free structural hint about salt-bridge potential.
    const delta = chargeDelta(wt, row.mut);
    if (delta !== 0 && selectable) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 19);
      ctx.fillText(`${delta > 0 ? "+" : "−"}${Math.abs(delta)}e`, x + 16, y + CELL_H - 8);
    }

    if (selectable) this.region(`sub:${row.mut}`, x, y, w, CELL_H);
  }
}
