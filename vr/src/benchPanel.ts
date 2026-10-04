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
import type { AgentResult, Metric, Tier } from "./result";

const W = 1024;
const H = 1080;
const PANEL_WIDTH_M = 0.64;

const CHIP_H = 54;
const CHIP_GAP = 7;
const MAX_RISK_ROWS = 3;

export type BenchTab = "bench" | "result";

/** Where a number came from, spelled out rather than implied by styling. */
const TIER_LABEL: Record<Tier, string> = {
  measured: "measured",
  estimate: "estimate · ignores epistasis",
  lookup: "single-mutant scan",
  predicted: "predicted",
};

export interface BenchPanelState {
  tab: BenchTab;
  /** The lab's answer to the last question, if one has come back. */
  result: AgentResult | null;
  /** Position in the example set, for stepping through test cases. */
  resultIndex: number;
  resultCount: number;
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
    this.begin();
    this.backdrop();
    const y = this.tabs(state, 70);
    if (state.tab === "result") this.resultBody(state, y);
    else this.benchBody(state, y);
    this.commit();
  }

  /** Two views of the same surface: what you are building, and what came back. */
  private tabs(state: BenchPanelState, y: number): number {
    const ctx = this.ctx;
    const gap = 10;
    const tabW = (W - 88 - gap) / 2;
    ([["bench", "Bench"], ["result", "Result"]] as const).forEach(([id, label], i) => {
      const x = 44 + i * (tabW + gap);
      const active = state.tab === id;
      ctx.fillStyle = active ? THEME.tintBench : THEME.surface;
      this.roundRect(x, y, tabW, 48, 10);
      ctx.fill();
      ctx.strokeStyle = active ? THEME.bench : THEME.rule;
      ctx.lineWidth = active ? 3 : 2;
      this.roundRect(x, y, tabW, 48, 10);
      ctx.stroke();
      ctx.fillStyle = active ? THEME.bench : THEME.dim;
      ctx.font = font(active ? 700 : 600, 22);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + tabW / 2, y + 25);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      this.region(`benchtab:${id}`, x, y, tabW, 48);
    });
    return y + 74;
  }

  private benchBody(state: BenchPanelState, startY: number): void {
    const ctx = this.ctx;
    const { bench } = state;
    let y = startY;
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
  }


  /**
   * What the lab answered. Driven entirely by the AgentResult contract, so
   * anything the backend can express shows up here without further changes.
   */
  private resultBody(state: BenchPanelState, startY: number): void {
    const ctx = this.ctx;
    const r = state.result;
    let y = startY;
    const width = W - 88;

    // Step through the cases. Arrows live at the top so they are reachable
    // whatever the body below happens to be.
    const navW = 64;
    this.button("result:prev", 44, y, navW, 48, "◀", THEME.dim, {
      fontSize: 22,
      disabled: state.resultCount < 2,
    });
    this.button("result:next", 44 + navW + 10, y, navW, 48, "▶", THEME.dim, {
      fontSize: 22,
      disabled: state.resultCount < 2,
    });
    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 20);
    ctx.fillText(
      state.resultCount
        ? `case ${state.resultIndex + 1} of ${state.resultCount}`
        : "no result yet",
      44 + navW * 2 + 28,
      y + 31,
    );
    ctx.textAlign = "right";
    ctx.fillText(r ? r.kind : "—", W - 44, y + 31);
    ctx.textAlign = "left";
    y += 74;

    if (!r) {
      ctx.fillStyle = THEME.dim;
      ctx.font = font(600, 24);
      this.wrap(
        "Nothing has come back from the lab yet. Ask a question, or step through the example cases with the arrows to check how each kind of answer renders.",
        44,
        y + 10,
        width,
        34,
      );
      return;
    }

    if (r.query) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 20);
      y = this.wrap(`asked: "${r.query}"`, 44, y, width, 26, 2);
      y += 12;
    }

    ctx.fillStyle = r.kind === "none" ? THEME.warnText : THEME.text;
    ctx.font = font(700, 34);
    y = this.wrap(r.headline, 44, y + 8, width, 42, 3);
    y += 10;

    if (r.agent_generated) {
      this.heading("Agent hypothesis · not verified", 44, y, THEME.agent);
      y += 32;
    }

    if (r.summary) {
      ctx.fillStyle = THEME.body;
      ctx.font = font(600, 23);
      y = this.wrap(r.summary, 44, y, width, 31, 5);
      y += 16;
    }

    if (r.metrics?.length) {
      this.rule(y);
      y += 34;
      for (const m of r.metrics.slice(0, 6)) {
        y = this.metricRow(m, y, width);
      }
      y += 8;
    }

    if (r.citations?.length) {
      this.rule(y);
      y += 34;
      this.heading("Evidence", 44, y, THEME.faint);
      y += 30;
      for (const c of r.citations.slice(0, 2)) {
        ctx.fillStyle = THEME.text;
        ctx.font = font(600, 21);
        y = this.wrap(c.title, 44, y, width, 27, 2);
        ctx.fillStyle = THEME.faint;
        ctx.font = font(600, 19);
        y = this.wrap(`${c.doc_id}${c.year ? ` · ${c.year}` : ""}`, 44, y + 2, width, 24, 1);
        y += 10;
      }
    }

    // What the molecule is being told to show, stated rather than left implicit.
    const view = r.view;
    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 19);
    const shown = view
      ? [
          view.mutations?.length ? `${view.mutations.length} modelled` : null,
          view.highlights?.length ? `${view.highlights.length} highlighted` : null,
          view.links?.length ? `${view.links.length} linked` : null,
          view.focus ? `focus ${view.focus}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "structure unchanged — nothing to show";
    ctx.fillText(this.clipText(shown, width), 44, H - 26);
  }

  private metricRow(m: Metric, y: number, width: number): number {
    const ctx = this.ctx;
    ctx.fillStyle = m.warn ? THEME.warnText : THEME.dim;
    ctx.font = font(600, 21);
    ctx.fillText(this.clipText(m.k, width * 0.5), 44, y);

    ctx.textAlign = "right";
    ctx.fillStyle = m.warn ? THEME.warn : THEME.text;
    ctx.font = font(700, 24);
    ctx.fillText(m.v, W - 44, y);
    ctx.textAlign = "left";
    y += 24;

    // The tier is part of the number, never implied by how it is drawn.
    if (m.tier) {
      ctx.textAlign = "right";
      ctx.fillStyle = m.tier === "measured" ? THEME.good : THEME.caution;
      ctx.font = font(600, 17);
      ctx.fillText(TIER_LABEL[m.tier], W - 44, y);
      ctx.textAlign = "left";
    }
    return y + 22;
  }

  private clipText(text: string, maxWidth: number): string {
    const ctx = this.ctx;
    if (maxWidth <= 0 || ctx.measureText(text).width <= maxWidth) return text;
    let out = text;
    while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
    return `${out}…`;
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
