/**
 * The answer: what the lab said, on the right.
 *
 * Answers are long — a headline, a paragraph, half a dozen metrics with their
 * provenance, several citations with the sentence each one rests on, and the
 * prose the model wrote around its JSON. So this opens compact and expands:
 * the brief view is what you read to decide, and "Review in depth" is what you
 * read when the brief view is not enough.
 */

import { CanvasPanel, THEME, font, signed } from "./ui";
import type { AgentResult, Metric, Tier } from "./result";

const W = 1160;
const H = 1120;
const PANEL_WIDTH_M = 0.72;

const PAD = 48;
const FOOTER_TOP = H - 150;

/** Where a number came from, spelled out rather than implied by styling. */
const TIER_LABEL: Record<Tier, string> = {
  measured: "measured",
  estimate: "estimate · ignores interaction",
  lookup: "precomputed scan",
  predicted: "model prediction",
};

export interface AnswerPanelState {
  result: AgentResult | null;
  /** Prose the lab wrote around its JSON block. */
  prose: string;
  /** Set when the reply could not be read as a result. */
  problem: string | null;
  deep: boolean;
  scroll: number;
  /** Stepping through the example cases. */
  index: number;
  count: number;
  /** True while a question is in flight. */
  busy: boolean;
  busyStage: string | null;
  busyProgress: number | null;
}

export class AnswerPanel extends CanvasPanel {
  private overflow = 0;

  constructor() {
    super(W, H, PANEL_WIDTH_M);
  }

  get maxScroll(): number {
    return this.overflow;
  }

  render(state: AnswerPanelState): void {
    const ctx = this.ctx;
    this.begin();
    this.backdrop();

    let y = 70;
    this.heading("Answer", PAD, y, THEME.accent);

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 21);
    ctx.textAlign = "right";
    ctx.fillText(
      state.count ? `case ${state.index + 1} of ${state.count}` : "—",
      W - PAD,
      y,
    );
    ctx.textAlign = "left";
    y += 16;
    this.rule(y, PAD);
    y += 26;

    // The lab takes 9-13 s; showing the stage is what keeps that from reading
    // as a hung panel.
    if (state.busy) {
      ctx.fillStyle = THEME.accent;
      ctx.font = font(600, 26);
      ctx.fillText(state.busyStage ?? "working…", PAD, y + 24);
      if (state.busyProgress != null) {
        const barW = W - PAD * 2;
        ctx.fillStyle = THEME.surface;
        this.roundRect(PAD, y + 44, barW, 8, 4);
        ctx.fill();
        ctx.fillStyle = THEME.accent;
        this.roundRect(PAD, y + 44, Math.max(8, barW * state.busyProgress), 8, 4);
        ctx.fill();
      }
      y += 78;
    }

    const bodyTop = y;
    const bodyHeight = FOOTER_TOP - bodyTop - 16;
    const scroll = Math.min(Math.max(state.scroll, 0), this.overflow);
    // Canvas text is drawn from its baseline, so the first line has to start a
    // full ascent below the clip edge or its glyph tops are shaved off.
    const drawTop = bodyTop + 30;

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD - 8, bodyTop, W - PAD * 2 + 16, bodyHeight);
    ctx.clip();
    ctx.translate(0, -scroll);

    const end = state.deep ? this.deepBody(state, drawTop) : this.briefBody(state, drawTop);

    ctx.restore();
    this.overflow = Math.max(0, end - bodyTop - bodyHeight);

    if (scroll < this.overflow) {
      const fade = ctx.createLinearGradient(0, bodyTop + bodyHeight - 40, 0, bodyTop + bodyHeight);
      fade.addColorStop(0, "rgba(215, 225, 236, 0)");
      fade.addColorStop(1, THEME.glass);
      ctx.fillStyle = fade;
      ctx.fillRect(PAD - 8, bodyTop + bodyHeight - 40, W - PAD * 2 + 16, 40);
    }

    this.footer(state);
    this.commit();
  }

  // -------------------------------------------------------------- bodies

  private briefBody(state: AnswerPanelState, y: number): number {
    const ctx = this.ctx;
    const width = W - PAD * 2;
    const r = state.result;

    // A reply that broke the contract still usually carries real evidence. Say
    // what was wrong, then show what came back anyway — hiding it would make a
    // formatting failure look like an empty run.
    if (state.problem) {
      ctx.fillStyle = THEME.warnText;
      ctx.font = font(700, 25);
      y = this.wrap("The 3D view could not be built from this reply", PAD, y + 8, width, 32, 2);
      ctx.fillStyle = THEME.dim;
      ctx.font = font(600, 21);
      y = this.wrap(state.problem, PAD, y + 6, width, 27, 3);
      y += 10;

      if (!r) {
        if (state.prose) {
          this.heading("What it said instead", PAD, y, THEME.faint);
          y += 30;
          ctx.fillStyle = THEME.body;
          ctx.font = font(600, 21);
          y = this.wrap(state.prose, PAD, y, width, 28, 10);
        }
        return y;
      }

      this.rule(y, PAD);
      y += 26;
    }

    if (!r) {
      ctx.fillStyle = THEME.dim;
      ctx.font = font(600, 24);
      return this.wrap(
        "Nothing yet. Ask a question below, or step through the example answers with the arrows to see how each kind renders.",
        PAD,
        y + 10,
        width,
        33,
      );
    }

    if (r.query) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 20);
      y = this.wrap(`asked: "${r.query}"`, PAD, y, width, 26, 2);
      y += 14;
    }

    ctx.fillStyle = r.kind === "none" ? THEME.warnText : THEME.text;
    ctx.font = font(700, 36);
    y = this.wrap(r.headline, PAD, y + 8, width, 44, 4);
    y += 12;

    if (r.agent_generated) {
      this.heading("Agent hypothesis · not verified", PAD, y, THEME.agent);
      y += 32;
    }

    if (r.summary) {
      ctx.fillStyle = THEME.body;
      ctx.font = font(600, 24);
      y = this.wrap(r.summary, PAD, y, width, 32, 6);
      y += 18;
    }

    if (r.metrics?.length) {
      this.rule(y, PAD);
      y += 34;
      for (const m of r.metrics.slice(0, 4)) y = this.metricRow(m, y, width);
      if (r.metrics.length > 4) {
        ctx.fillStyle = THEME.faint;
        ctx.font = font(600, 19);
        ctx.fillText(`+${r.metrics.length - 4} more in depth`, PAD, y + 4);
        y += 28;
      }
    }

    if (r.citations?.length) {
      y += 10;
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 20);
      ctx.fillText(
        `${r.citations.length} source${r.citations.length > 1 ? "s" : ""} · open in depth to read them`,
        PAD,
        y,
      );
      y += 28;
    }
    return y;
  }

  private deepBody(state: AnswerPanelState, y: number): number {
    const ctx = this.ctx;
    const width = W - PAD * 2;
    const r = state.result;
    if (!r) return this.briefBody(state, y);

    if (r.query) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 20);
      y = this.wrap(`asked: "${r.query}"`, PAD, y, width, 26, 3);
      y += 14;
    }

    ctx.fillStyle = THEME.text;
    ctx.font = font(700, 32);
    y = this.wrap(r.headline, PAD, y + 6, width, 40);
    y += 10;

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 20);
    ctx.fillText(
      `${r.kind} · confidence ${(r.confidence ?? 0).toFixed(2)}${r.agent_generated ? " · model-written" : ""}`,
      PAD,
      y,
    );
    y += 34;

    if (r.summary) {
      ctx.fillStyle = THEME.body;
      ctx.font = font(600, 23);
      y = this.wrap(r.summary, PAD, y, width, 31);
      y += 20;
    }

    // Every metric, with its provenance spelled out.
    if (r.metrics?.length) {
      this.rule(y, PAD);
      y += 34;
      this.heading("Numbers", PAD, y, THEME.faint);
      y += 32;
      for (const m of r.metrics) y = this.metricRow(m, y, width);
      y += 10;
    }

    // Every citation, with the sentence it rests on.
    if (r.citations?.length) {
      this.rule(y, PAD);
      y += 34;
      this.heading("Evidence", PAD, y, THEME.faint);
      y += 32;
      r.citations.forEach((c, i) => {
        ctx.fillStyle = THEME.accent;
        ctx.font = font(700, 20);
        ctx.fillText(`${i + 1}`, PAD, y);
        ctx.fillStyle = THEME.text;
        ctx.font = font(700, 22);
        y = this.wrap(c.title, PAD + 32, y, width - 32, 29, 3);
        ctx.fillStyle = THEME.faint;
        ctx.font = font(600, 19);
        ctx.fillText(`${c.doc_id}${c.year ? ` · ${c.year}` : ""}`, PAD + 32, y + 4);
        y += 28;
        if (c.snippet) {
          ctx.fillStyle = THEME.dim;
          ctx.font = font(600, 20);
          y = this.wrap(`“${c.snippet}”`, PAD + 32, y + 4, width - 32, 27, 4);
        }
        y += 16;
      });
    }

    // What the molecule was told to draw, so the 3D is auditable too.
    const v = r.view;
    this.rule(y, PAD);
    y += 34;
    this.heading("What the molecule shows", PAD, y, THEME.faint);
    y += 32;
    ctx.fillStyle = THEME.dim;
    ctx.font = font(600, 21);
    if (!v) {
      y = this.wrap("Nothing — this answer left the structure unchanged.", PAD, y, width, 28);
    } else {
      const rep = v.representation;
      const lines = [
        rep ? `drawn as ${rep.base}, coloured by ${rep.color}` : "drawn with the default for this kind",
        v.focus != null ? `focused on residue ${v.focus}` : null,
        ...(v.mutations ?? []).map(
          (m) => `${m.wt}${m.pos}${m.mut} modelled on the backbone${m.score != null ? ` · ${signed(m.score)}` : ""}`,
        ),
        ...(v.highlights ?? []).map(
          (h) => `${h.residues.join(", ")} — ${h.role}${h.style ? ` as ${h.style}` : ""}`,
        ),
        ...(v.links ?? []).map((l) => `${l.from} ↔ ${l.to}${l.label ? ` · ${l.label}` : ""}`),
      ].filter(Boolean) as string[];
      for (const line of lines) y = this.wrap(`· ${line}`, PAD, y, width, 28, 2);
    }

    if (state.prose) {
      y += 14;
      this.rule(y, PAD);
      y += 34;
      this.heading("The lab's own words", PAD, y, THEME.faint);
      y += 32;
      ctx.fillStyle = THEME.body;
      ctx.font = font(600, 21);
      y = this.wrap(state.prose, PAD, y, width, 28);
    }
    return y;
  }

  private metricRow(m: Metric, y: number, width: number): number {
    const ctx = this.ctx;
    ctx.fillStyle = m.warn ? THEME.warnText : THEME.dim;
    ctx.font = font(600, 21);
    ctx.fillText(this.clipText(m.k, width * 0.55), PAD, y);

    ctx.textAlign = "right";
    ctx.fillStyle = m.warn ? THEME.warn : THEME.text;
    ctx.font = font(700, 25);
    ctx.fillText(m.v, W - PAD, y);
    ctx.textAlign = "left";
    y += 25;

    if (m.tier) {
      ctx.textAlign = "right";
      ctx.fillStyle = m.tier === "measured" ? THEME.good : THEME.caution;
      ctx.font = font(600, 17);
      ctx.fillText(TIER_LABEL[m.tier], W - PAD, y);
      ctx.textAlign = "left";
    }
    return y + 24;
  }

  private footer(state: AnswerPanelState): void {
    const ctx = this.ctx;
    this.rule(FOOTER_TOP, PAD);

    const gap = 14;
    const navW = 72;
    const row = FOOTER_TOP + 24;

    this.button("answer:prev", PAD, row, navW, 64, "◀", THEME.dim, {
      fontSize: 24,
      disabled: state.count < 2,
    });
    this.button("answer:next", PAD + navW + gap, row, navW, 64, "▶", THEME.dim, {
      fontSize: 24,
      disabled: state.count < 2,
    });

    const scrollX = W - PAD - navW;
    this.button("answer:scroll:down", scrollX, row, navW, 64, "▼", THEME.dim, {
      fontSize: 22,
      disabled: state.scroll >= this.overflow,
    });
    this.button(
      "answer:scroll:up",
      scrollX - navW - gap,
      row,
      navW,
      64,
      "▲",
      THEME.dim,
      { fontSize: 22, disabled: state.scroll <= 0 },
    );

    const deepX = PAD + (navW + gap) * 2;
    const deepW = scrollX - navW - gap - deepX - gap;
    this.button(
      "answer:deep",
      deepX,
      row,
      deepW,
      64,
      state.deep ? "Back to summary" : "Review in depth",
      THEME.bench,
      { fontSize: 23, solid: state.deep, disabled: !state.result },
    );

    ctx.fillStyle = THEME.off;
    ctx.font = font(600, 18);
    ctx.fillText(
      state.result?.result_id ? `result ${state.result.result_id}` : "no result",
      PAD,
      H - 28,
    );
  }

  private clipText(text: string, maxWidth: number): string {
    const ctx = this.ctx;
    if (maxWidth <= 0 || ctx.measureText(text).width <= maxWidth) return text;
    let out = text;
    while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
    return `${out}…`;
  }
}
