/**
 * The combination bench panel.
 *
 * Chips for each stacked mutation, the additive total, and the structural
 * warning that says when that total should not be trusted. The tier of every
 * number on this panel is part of the display, never implied: an additive sum
 * is labelled as one, and a placeholder scan says so across the top.
 */

import { CanvasPanel, THEME, font, signed } from "./ui";
import type { Bench, BenchMutation } from "./bench";
import { MAX_MUTATIONS } from "./bench";
import type { EpistasisPair } from "./metrics";
import { EPISTASIS_CUTOFF_A } from "./metrics";
import { scanCaption, type Scan } from "./scan";

const W = 1024;
const H = 1080;
const PANEL_WIDTH_M = 0.64;

const CHIP_H = 54;
const CHIP_GAP = 7;
const MAX_RISK_ROWS = 3;

export interface BenchPanelState {
  bench: Bench;
  epistasis: EpistasisPair[];
  scan: Scan | null;
  message: string | null;
  busy: boolean;
}

export class BenchPanel extends CanvasPanel {
  constructor() {
    super(W, H, PANEL_WIDTH_M);
  }

  render(state: BenchPanelState): void {
    const ctx = this.ctx;
    const { bench } = state;
    this.begin();
    this.backdrop();

    // ---------------------------------------------------------- header
    let y = 70;
    this.heading("Combination bench", 44, y, THEME.bench);
    ctx.textAlign = "right";
    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 23);
    ctx.fillText(`${bench.count} / ${MAX_MUTATIONS} slots`, W - 44, y);
    ctx.textAlign = "left";
    y += 16;
    this.rule(y);
    y += 36;

    // Provenance of every score below, stated before any of them are drawn.
    const placeholder = state.scan?.source !== "model";
    if (placeholder) {
      ctx.fillStyle = THEME.tintWarn;
      this.roundRect(44, y - 4, W - 88, 44, 12);
      ctx.fill();
      ctx.fillStyle = THEME.warnText;
      ctx.font = font(700, 23);
      ctx.fillText(scanCaption(state.scan), 60, y + 24);
      y += 62;
    } else {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 22);
      ctx.fillText(scanCaption(state.scan), 44, y + 16);
      y += 42;
    }

    // ---------------------------------------------------------- chips
    const risky = new Set<number>();
    for (const pair of state.epistasis) {
      risky.add(pair.a);
      risky.add(pair.b);
    }

    if (bench.count === 0) {
      ctx.fillStyle = THEME.dim;
      ctx.font = font(null, 26);
      y = this.wrap(
        "Point the controller at the structure and pull the trigger to pick a residue. Substitutions appear on the bench card below the protein.",
        44,
        y + 24,
        W - 88,
        36,
      );
      y += 20;
    } else {
      for (const mutation of bench.mutations) {
        this.chip(mutation, y, risky.has(mutation.pos));
        y += CHIP_H + CHIP_GAP;
      }
      y += 14;
    }

    // ---------------------------------------------------------- estimate
    this.rule(y);
    y += 44;

    const estimate = bench.additiveEstimate();
    this.heading("Additive estimate", 44, y, THEME.caution);
    y += 58;

    ctx.fillStyle = estimate == null ? THEME.off : THEME.caution;
    ctx.font = font(700, 64);
    ctx.fillText(estimate == null ? "—" : signed(estimate), 44, y);

    // The named weakness of this number, on the same line as the number.
    ctx.textAlign = "right";
    ctx.fillStyle = THEME.dim;
    ctx.font = font(600, 23);
    ctx.fillText("sum of single-mutant scores", W - 44, y - 26);
    ctx.fillStyle = THEME.warnText;
    ctx.font = font(600, 23);
    ctx.fillText("ignores epistasis", W - 44, y);
    ctx.textAlign = "left";
    y += 40;

    if (bench.measured) {
      const { esm_llr, estimateWhenRequested } = bench.measured;
      ctx.fillStyle = THEME.good;
      ctx.font = font(600, 22);
      ctx.fillText(`Measured  ${signed(esm_llr)}`, 44, y);
      if (estimateWhenRequested != null) {
        const gap = esm_llr - estimateWhenRequested;
        ctx.fillStyle = Math.abs(gap) > 0.5 ? THEME.warnText : THEME.faint;
        ctx.font = font(600, 23);
        ctx.fillText(
          `estimate was ${signed(estimateWhenRequested)} · gap ${signed(gap)}`,
          300,
          y,
        );
      }
      y += 34;
    }

    // ---------------------------------------------------------- epistasis
    y += 18;
    this.heading(
      "Epistasis risk · measured from structure",
      44,
      y,
      state.epistasis.length ? THEME.warnText : THEME.faint,
    );
    y += 34;

    ctx.font = font(600, 23);
    if (state.epistasis.length === 0) {
      ctx.fillStyle = THEME.faint;
      ctx.fillText(
        bench.enabledMutations.length < 2
          ? `needs two active mutations`
          : `no active pair within ${EPISTASIS_CUTOFF_A} Å — additive holds better`,
        44,
        y,
      );
      y += 32;
    } else {
      for (const pair of state.epistasis.slice(0, MAX_RISK_ROWS)) {
        ctx.fillStyle = THEME.warn;
        ctx.fillText("▲", 44, y);
        ctx.fillStyle = THEME.text;
        ctx.fillText(`${pair.a} ↔ ${pair.b}`, 78, y);
        ctx.fillStyle = THEME.warnText;
        ctx.fillText(`${pair.distance.toFixed(1)} Å`, 250, y);
        ctx.fillStyle = THEME.faint;
        ctx.font = font(600, 23);
        ctx.fillText("likely to interact", 360, y);
        ctx.font = font(600, 23);
        y += 32;
      }
      const extra = state.epistasis.length - MAX_RISK_ROWS;
      if (extra > 0) {
        ctx.fillStyle = THEME.faint;
        ctx.font = font(600, 23);
        ctx.fillText(`+${extra} more pair${extra > 1 ? "s" : ""}`, 78, y);
      }
    }

    // ---------------------------------------------------------- actions
    const empty = bench.count === 0;
    const half = (W - 88 - 16) / 2;
    this.button(
      "act:score",
      44,
      H - 188,
      half,
      58,
      "Score for real",
      THEME.accent,
      { disabled: empty || state.busy, fontSize: 22 },
    );
    this.button("act:clear", 44 + half + 16, H - 188, half, 58, "Clear", THEME.off, {
      disabled: empty,
      fontSize: 22,
    });
    this.button(
      "act:propose",
      44,
      H - 116,
      W - 88,
      66,
      "Propose to agents",
      THEME.bench,
      { solid: true, disabled: empty || state.busy, fontSize: 26 },
    );

    ctx.fillStyle = state.message ? THEME.warnText : THEME.off;
    ctx.font = font(600, 22);
    ctx.fillText(
      state.message ?? "a proposal re-enters the agent loop as a human-origin candidate",
      44,
      H - 26,
    );

    this.commit();
  }

  /** One mutation row: toggle target on the left, remove target on the right. */
  private chip(mutation: BenchMutation, y: number, risky: boolean): void {
    const ctx = this.ctx;
    const x = 44;
    const w = W - 88;
    const deleteW = 64;
    const on = mutation.enabled;

    ctx.fillStyle = on ? THEME.tintBench : THEME.surface;
    this.roundRect(x, y, w, CHIP_H, 14);
    ctx.fill();
    ctx.strokeStyle = on ? THEME.bench : THEME.off;
    ctx.lineWidth = 2;
    this.roundRect(x, y, w, CHIP_H, 14);
    ctx.stroke();

    const mid = y + CHIP_H / 2;

    // Enabled dot
    ctx.beginPath();
    ctx.arc(x + 30, mid, 10, 0, Math.PI * 2);
    ctx.fillStyle = on ? THEME.bench : THEME.off;
    ctx.fill();

    ctx.textBaseline = "middle";
    ctx.fillStyle = on ? THEME.text : THEME.off;
    ctx.font = font(700, 28);
    ctx.fillText(mutation.label, x + 58, mid + 1);

    if (risky && on) {
      ctx.fillStyle = THEME.warn;
      ctx.font = font(700, 22);
      ctx.fillText("▲", x + 200, mid + 1);
    }

    ctx.textAlign = "right";
    ctx.fillStyle = on
      ? (mutation.llr ?? 0) >= 0
        ? THEME.good
        : THEME.warnText
      : THEME.off;
    ctx.font = font(600, 26);
    ctx.fillText(signed(mutation.llr), x + w - deleteW - 20, mid + 1);
    ctx.textAlign = "left";

    // Remove target
    ctx.strokeStyle = THEME.off;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + w - deleteW, y + 10);
    ctx.lineTo(x + w - deleteW, y + CHIP_H - 10);
    ctx.stroke();

    ctx.fillStyle = THEME.off;
    ctx.font = font(600, 28);
    ctx.textAlign = "center";
    ctx.fillText("×", x + w - deleteW / 2, mid + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    this.region(`chip:${mutation.pos}`, x, y, w - deleteW, CHIP_H);
    this.region(`del:${mutation.pos}`, x + w - deleteW, y, deleteW, CHIP_H);
  }
}
