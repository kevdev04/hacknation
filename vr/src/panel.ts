/**
 * In-world review panel: the agent's flagged candidate and the decision that
 * goes back to the loop. Everything the reviewer needs to decide, including the
 * explicit "agent hypothesis" labelling of model-generated text.
 *
 * The queue strip across the top makes the rest of the backlog visible and
 * jumpable, and "load into bench" hands the candidate to the combination bench
 * so the reviewer can explore around the agent's proposal rather than only
 * judging it.
 */

import { CanvasPanel, THEME, font } from "./ui";
import type { Candidate, DecisionKind } from "./api";

const W = 1024;
const H = 900;
const PANEL_WIDTH_M = 0.62;

const MAX_QUEUE_TILES = 5;

export interface PanelState {
  candidate: Candidate | null;
  queue: Candidate[];
  queueIndex: number;
  queueTotal: number;
  /** Distance measured in the loaded structure, overrides the API value. */
  measuredDistance?: number | null;
  measuredNearest?: number | null;
  wtMismatch?: boolean;
  pickedResidue?: string | null;
  /** The candidate's mutation is already stacked on the bench. */
  inBench?: boolean;
  flash?: { decision: DecisionKind; label: string } | null;
  message?: string | null;
  reviewer: string;
}

const FLASH_COLOR: Record<DecisionKind, string> = {
  approve: THEME.good,
  reject: THEME.warn,
  defer: THEME.caution,
};

export class ReviewPanel extends CanvasPanel {
  constructor() {
    super(W, H, PANEL_WIDTH_M);
  }

  render(state: PanelState): void {
    const ctx = this.ctx;
    this.begin();
    this.backdrop();

    const c = state.candidate;
    let y = 70;

    // ---------------------------------------------------------- header
    this.heading("Human approval gate", 44, y, THEME.accent);
    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 23);
    ctx.textAlign = "right";
    ctx.fillText(
      state.queueTotal
        ? `${state.queueIndex + 1} of ${state.queueTotal} pending`
        : "queue empty",
      W - 44,
      y,
    );
    ctx.textAlign = "left";
    y += 16;
    this.rule(y);
    y += 24;

    // ---------------------------------------------------------- queue strip
    y = this.queueStrip(state, y);

    if (!c) {
      ctx.fillStyle = THEME.text;
      ctx.font = font(600, 44);
      ctx.fillText("Waiting for agents…", 44, y + 60);
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 24);
      this.wrap(
        state.message ??
          "No candidate is flagged for review. The discovery loop is running; this panel updates as soon as an agent requests a human decision. The bench stays usable meanwhile.",
        44,
        y + 120,
        W - 88,
        34,
      );
      this.footer(state);
      this.commit();
      return;
    }

    if (c.kind === "claim") {
      y = this.claimBody(c, y);
      this.footer(state);
      this.commit();
      return;
    }

    // ---------------------------------------------------------- mutation
    ctx.fillStyle = THEME.caution;
    ctx.font = font(700, 70);
    ctx.fillText(c.mutation.label, 44, y + 60);

    ctx.textAlign = "right";
    ctx.fillStyle = THEME.dim;
    ctx.font = font(600, 23);
    const llr = c.scores.esm_llr;
    ctx.fillText(
      `ESM-2 LLR ${typeof llr === "number" ? llr.toFixed(2) : "n/a"}`,
      W - 44,
      y + 34,
    );
    ctx.fillText(
      `rank ${c.scores.rank_in_batch ?? "?"} · iteration ${c.iteration}`,
      W - 44,
      y + 66,
    );
    ctx.textAlign = "left";
    y += 110;

    // ---------------------------------------------------------- distance
    const dist = state.measuredDistance ?? c.distance_to_active_site_A;
    const nearest = state.measuredNearest ?? c.nearest_active_site_residue;
    ctx.fillStyle = THEME.text;
    ctx.font = font(null, 25);
    ctx.fillText(
      dist == null
        ? "distance to active site: unknown"
        : `${dist.toFixed(1)} Å to active site${nearest ? ` (residue ${nearest})` : ""}`,
      44,
      y,
    );
    y += 20;

    // ---------------------------------------------------------- flags
    const flags = [...c.flags];
    if (state.wtMismatch && !flags.includes("wt_mismatch")) flags.push("wt_mismatch");
    if (flags.length) {
      y += 34;
      let x = 44;
      ctx.font = font(600, 23);
      for (const flag of flags) {
        const text = flag.replace(/_/g, " ");
        const w = ctx.measureText(text).width + 28;
        if (x + w > W - 44) break;
        const warn = flag.includes("near_active_site") || flag.includes("mismatch");
        ctx.fillStyle = warn ? THEME.tintWarn : THEME.tintAccent;
        this.roundRect(x, y - 22, w, 36, 18);
        ctx.fill();
        ctx.fillStyle = warn ? THEME.warnText : THEME.accent;
        ctx.fillText(text, x + 14, y + 2);
        x += w + 12;
      }
      y += 22;
    }

    // ------------------------------------- agent hypothesis, always labelled
    y += 44;
    this.heading("Agent hypothesis · not verified", 44, y, THEME.agent);
    y += 34;
    ctx.fillStyle = THEME.body;
    ctx.font = font(600, 24);
    y = this.wrap(c.rationale || "(no rationale provided)", 44, y, W - 88, 32, 5);

    // ---------------------------------------------------------- citations
    if (c.citations.length) {
      y += 26;
      this.heading("References", 44, y, THEME.faint);
      y += 28;
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 23);
      for (const cite of c.citations.slice(0, 2)) {
        y = this.wrap(`· ${cite.title}`, 44, y, W - 88, 26, 2);
        y += 4;
      }
    }

    if (state.pickedResidue) {
      ctx.fillStyle = THEME.pick;
      ctx.font = font(600, 22);
      ctx.fillText(`picked: ${state.pickedResidue}`, 44, H - 250);
    }

    this.footer(state);

    // ---------------------------------------------------------- flash
    if (state.flash) {
      const color = FLASH_COLOR[state.flash.decision];
      ctx.fillStyle = THEME.scrim;
      this.roundRect(6, 6, W - 12, H - 12, 28);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 8;
      this.roundRect(14, 14, W - 28, H - 28, 24);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.font = font(700, 92);
      ctx.fillText(state.flash.decision.toUpperCase(), W / 2, H / 2 - 10);
      ctx.font = font(null, 32);
      ctx.fillStyle = THEME.text;
      ctx.fillText(state.flash.label, W / 2, H / 2 + 56);
      ctx.font = font(600, 23);
      ctx.fillStyle = THEME.faint;
      ctx.fillText("sent to the agent loop", W / 2, H / 2 + 106);
      ctx.textAlign = "left";
    }

    this.commit();
  }

  /**
   * A claim from the agent lab: no residue to measure, so the review rests on
   * what the lab asserted, the evidence behind it, and the checks it failed.
   */
  private claimBody(c: Candidate, y: number): number {
    const ctx = this.ctx;
    const claim = c.claim;

    ctx.fillStyle = THEME.agent;
    ctx.font = font(600, 22);
    ctx.fillText(
      `${claim?.node_type ?? "claim"} · confidence ${(claim?.confidence ?? 0).toFixed(2)}`,
      44,
      y + 6,
    );
    y += 40;

    ctx.fillStyle = THEME.text;
    ctx.font = font(700, 40);
    y = this.wrap(claim?.headline || c.mutation.label, 44, y + 26, W - 88, 48, 2);
    y += 18;

    // The checks the lab ran, each with the threshold it was tested against.
    // A failing row is the reason this reached a human at all.
    const checks = c.validation?.checks ?? [];
    if (c.validation) {
      const verdict = c.validation.verdict;
      const tone =
        verdict === "PASS" ? THEME.good : verdict === "FAIL" ? THEME.warn : THEME.caution;
      this.heading(`Validation · ${verdict}`, 44, y, tone);
      y += 36;

      ctx.font = font(600, 22);
      for (const check of checks.slice(0, 4)) {
        ctx.fillStyle = check.passed ? THEME.good : THEME.warn;
        ctx.fillText(check.passed ? "✓" : "✕", 44, y);
        ctx.fillStyle = check.passed ? THEME.dim : THEME.text;
        ctx.fillText(check.name.replace(/_/g, " "), 76, y);
        ctx.textAlign = "right";
        ctx.fillStyle = check.passed ? THEME.dim : THEME.warnText;
        ctx.fillText(`${check.value} / ${check.threshold}`, W - 44, y);
        ctx.textAlign = "left";
        y += 32;
      }
      y += 12;
    }

    // Agent-written text, labelled as such wherever it appears.
    if (claim?.agent_generated) {
      this.heading("Agent hypothesis · not verified", 44, y, THEME.agent);
      y += 34;
    }
    ctx.fillStyle = THEME.body;
    ctx.font = font(600, 24);
    y = this.wrap(c.rationale || "(no detail provided)", 44, y, W - 88, 32, 4);

    // The sentence from the paper that supports it — the thing that makes this
    // reviewable rather than a vibe. Dropped entirely rather than drawn under
    // the footer when the checks and detail have already used the card.
    const cited = c.citations.find((x) => x.snippet) ?? c.citations[0];
    if (cited && y < H - 360) {
      y += 24;
      this.heading("Evidence", 44, y, THEME.faint);
      y += 30;
      ctx.fillStyle = THEME.dim;
      ctx.font = font(600, 22);
      if (cited.snippet) y = this.wrap(`"${cited.snippet}"`, 44, y, W - 88, 28, 2);
      if (y < H - 300) {
        ctx.fillStyle = THEME.faint;
        y = this.wrap(
          `${cited.doc_id ?? ""} · ${cited.title}`.trim(),
          44,
          y + 8,
          W - 88,
          26,
          1,
        );
      }
    }
    return y;
  }

  /** Pending candidates as jumpable tiles; the current one is outlined. */
  private queueStrip(state: PanelState, y: number): number {
    const ctx = this.ctx;
    if (state.queue.length === 0) return y + 12;

    const tiles = state.queue.slice(0, MAX_QUEUE_TILES);
    const gap = 8;
    const tileW = (W - 88 - gap * (MAX_QUEUE_TILES - 1)) / MAX_QUEUE_TILES;
    const tileH = 48;

    tiles.forEach((candidate, index) => {
      const x = 44 + index * (tileW + gap);
      const current = candidate.candidate_id === state.candidate?.candidate_id;
      const flagged = candidate.flags.length > 0;

      ctx.fillStyle = current ? THEME.tintAccent : THEME.surface;
      this.roundRect(x, y, tileW, tileH, 10);
      ctx.fill();
      ctx.strokeStyle = current ? THEME.accent : THEME.rule;
      ctx.lineWidth = current ? 3 : 2;
      this.roundRect(x, y, tileW, tileH, 10);
      ctx.stroke();

      ctx.fillStyle = current ? THEME.accent : THEME.dim;
      ctx.font = font(600, 23);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tileLabel =
        candidate.kind === "claim"
          ? (candidate.claim?.node_type ?? "claim").slice(0, 9)
          : candidate.mutation.label;
      ctx.fillText(tileLabel, x + tileW / 2, y + tileH / 2 + 1);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";

      if (flagged) {
        ctx.fillStyle = THEME.warn;
        ctx.beginPath();
        ctx.arc(x + tileW - 12, y + 12, 5, 0, Math.PI * 2);
        ctx.fill();
      }

      this.region(`queue:${candidate.candidate_id}`, x, y, tileW, tileH);
    });

    const overflow = state.queue.length - tiles.length;
    if (overflow > 0) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 22);
      ctx.textAlign = "right";
      ctx.fillText(`+${overflow} more`, W - 44, y + tileH + 20);
      ctx.textAlign = "left";
    }

    return y + tileH + 28;
  }

  private footer(state: PanelState): void {
    const ctx = this.ctx;
    this.rule(H - 250);

    const hasCandidate = !!state.candidate;
    const benchable = hasCandidate && state.candidate?.kind !== "claim";
    this.button(
      "gate:bench",
      44,
      H - 226,
      W - 88,
      54,
      state.inBench
        ? "On the bench ✓"
        : benchable
          ? "Load into bench"
          : "No residue to bench",
      state.inBench || !benchable ? THEME.off : THEME.bench,
      { disabled: !benchable || !!state.inBench, fontSize: 22 },
    );

    const buttons: [DecisionKind, string, string, string][] = [
      ["approve", "A", "Approve", THEME.good],
      ["reject", "B", "Reject", THEME.warn],
      ["defer", "X", "Defer", THEME.caution],
    ];
    const gap = 14;
    const buttonW = (W - 88 - gap * 2) / 3;
    buttons.forEach(([decision, key, label, color], index) => {
      this.button(
        `gate:${decision}`,
        44 + index * (buttonW + gap),
        H - 152,
        buttonW,
        66,
        `${key}  ${label}`,
        color,
        { disabled: !hasCandidate, fontSize: 24 },
      );
    });

    ctx.fillStyle = THEME.off;
    ctx.font = font(600, 22);
    ctx.fillText(
      `reviewer ${state.reviewer} · run ${state.candidate?.run_id ?? "—"}`,
      44,
      H - 30,
    );
    if (state.message && state.candidate) {
      ctx.textAlign = "right";
      ctx.fillStyle = THEME.warnText;
      ctx.fillText(state.message, W - 44, H - 30);
      ctx.textAlign = "left";
    }
  }
}
