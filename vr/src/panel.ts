/**
 * The review panel: the agent's flagged candidate and the decision that goes
 * back to the loop.
 *
 * There is far more to show than fits on one card — the claim, the evidence
 * behind it, the checks that failed, and the provenance of the whole thing — so
 * the body is a set of tabs over a scrolling region rather than one column that
 * silently drops whatever runs past the bottom. Everything a model wrote stays
 * labelled as such wherever it appears.
 */

import { CanvasPanel, THEME, font } from "./ui";
import type { Candidate, DecisionKind } from "./api";

const W = 1140;
const H = 1100;
const PANEL_WIDTH_M = 0.7;

const PAD = 48;
const MAX_QUEUE_TILES = 5;

/** Where the scrolling body stops and the footer begins. */
const FOOTER_TOP = H - 352;

export type PanelTab = "summary" | "evidence" | "checks" | "details";

export const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "evidence", label: "Evidence" },
  { id: "checks", label: "Checks" },
  { id: "details", label: "Details" },
];

export interface PanelState {
  candidate: Candidate | null;
  queue: Candidate[];
  queueIndex: number;
  queueTotal: number;
  tab: PanelTab;
  /** Pixels scrolled within the body; clamped against `maxScroll`. */
  scroll: number;
  measuredDistance?: number | null;
  measuredNearest?: number | null;
  wtMismatch?: boolean;
  pickedResidue?: string | null;
  inBench?: boolean;
  confirmingDismiss?: boolean;
  pendingNote?: string | null;
  voiceTarget?: "label" | "note" | null;
  flash?: { decision: DecisionKind; label: string } | null;
  message?: string | null;
  reviewer: string;
}

const FLASH_COLOR: Record<DecisionKind, string> = {
  approve: THEME.good,
  reject: THEME.warn,
  defer: THEME.caution,
  dismiss: THEME.off,
};

export class ReviewPanel extends CanvasPanel {
  /** How far the last render could scroll. 0 when everything fitted. */
  private overflow = 0;

  constructor() {
    super(W, H, PANEL_WIDTH_M);
  }

  get maxScroll(): number {
    return this.overflow;
  }

  render(state: PanelState): void {
    const ctx = this.ctx;
    this.begin();
    this.backdrop();

    const c = state.candidate;
    let y = 70;

    this.heading("Human approval gate", PAD, y, THEME.accent);
    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 22);
    ctx.textAlign = "right";
    ctx.fillText(
      state.queueTotal
        ? `${state.queueIndex + 1} of ${state.queueTotal} pending`
        : "queue empty",
      W - PAD,
      y,
    );
    ctx.textAlign = "left";
    y += 16;
    this.rule(y, PAD);
    y += 24;

    y = this.queueStrip(state, y);

    if (!c) {
      ctx.fillStyle = THEME.text;
      ctx.font = font(600, 44);
      ctx.fillText("Waiting for agents…", PAD, y + 60);
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 24);
      this.wrap(
        state.message ??
          "No candidate is flagged for review. The discovery loop is running; this panel updates as soon as an agent requests a human decision. The bench stays usable meanwhile.",
        PAD,
        y + 120,
        W - PAD * 2,
        34,
      );
      this.overflow = 0;
      this.footer(state);
      this.commit();
      return;
    }

    // The body is drawn first so `overflow` is known for THIS tab before the
    // tab bar decides whether the scroll arrows are live. Drawing the bar
    // afterwards is safe: it sits above the body and they never overlap.
    const tabBarTop = y;
    const bodyTop = y + 72;
    const bodyHeight = FOOTER_TOP - bodyTop - 16;
    const scroll = Math.min(Math.max(state.scroll, 0), this.overflow);

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD - 8, bodyTop, W - PAD * 2 + 16, bodyHeight);
    ctx.clip();
    ctx.translate(0, -scroll);

    let end: number;
    if (state.tab === "summary") end = this.summaryTab(c, state, bodyTop);
    else if (state.tab === "evidence") end = this.evidenceTab(c, bodyTop);
    else if (state.tab === "checks") end = this.checksTab(c, bodyTop);
    else end = this.detailsTab(c, state, bodyTop);

    ctx.restore();

    this.overflow = Math.max(0, end - bodyTop - bodyHeight);
    this.tabBar(state, tabBarTop);

    // A fade on the bottom edge is the only honest signal that more exists.
    if (scroll < this.overflow) {
      const fade = ctx.createLinearGradient(
        0,
        bodyTop + bodyHeight - 40,
        0,
        bodyTop + bodyHeight,
      );
      fade.addColorStop(0, "rgba(215, 225, 236, 0)");
      fade.addColorStop(1, THEME.glass);
      ctx.fillStyle = fade;
      ctx.fillRect(PAD - 8, bodyTop + bodyHeight - 40, W - PAD * 2 + 16, 40);
    }

    this.footer(state);
    if (state.flash) this.flash(state.flash);
    this.commit();
  }

  // --------------------------------------------------------------- tabs

  private tabBar(state: PanelState, y: number): number {
    const ctx = this.ctx;
    const scrollW = 56;
    const gap = 8;
    const avail = W - PAD * 2 - (scrollW * 2 + gap * 2);
    const tabW = (avail - gap * (PANEL_TABS.length - 1)) / PANEL_TABS.length;

    PANEL_TABS.forEach((tab, index) => {
      const x = PAD + index * (tabW + gap);
      const active = state.tab === tab.id;

      ctx.fillStyle = active ? THEME.tintAccent : THEME.surface;
      this.roundRect(x, y, tabW, 48, 10);
      ctx.fill();
      ctx.strokeStyle = active ? THEME.accent : THEME.rule;
      ctx.lineWidth = active ? 3 : 2;
      this.roundRect(x, y, tabW, 48, 10);
      ctx.stroke();

      ctx.fillStyle = active ? THEME.accent : THEME.dim;
      ctx.font = font(active ? 700 : 600, 21);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tab.label, x + tabW / 2, y + 25);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";

      this.region(`gate:tab:${tab.id}`, x, y, tabW, 48);
    });

    // Scroll lives with the tabs: a controller has no wheel.
    const canUp = state.scroll > 0;
    const canDown = state.scroll < this.overflow;
    this.button(
      "gate:scroll:up",
      W - PAD - scrollW * 2 - gap,
      y,
      scrollW,
      48,
      "▲",
      THEME.dim,
      { fontSize: 20, disabled: !canUp },
    );
    this.button("gate:scroll:down", W - PAD - scrollW, y, scrollW, 48, "▼", THEME.dim, {
      fontSize: 20,
      disabled: !canDown,
    });

    return y + 72;
  }

  // ------------------------------------------------------------- bodies

  private summaryTab(c: Candidate, state: PanelState, y: number): number {
    const ctx = this.ctx;
    const width = W - PAD * 2;
    const claim = c.claim;

    if (c.kind === "claim") {
      ctx.fillStyle = THEME.agent;
      ctx.font = font(600, 21);
      ctx.fillText(
        `${claim?.node_type ?? "claim"} · confidence ${(claim?.confidence ?? 0).toFixed(2)}`,
        PAD,
        y,
      );
      y += 38;
    } else {
      ctx.fillStyle = THEME.caution;
      ctx.font = font(700, 62);
      ctx.fillText(c.mutation.label, PAD, y + 48);
      ctx.textAlign = "right";
      ctx.fillStyle = THEME.dim;
      ctx.font = font(600, 22);
      const llr = c.scores.esm_llr;
      ctx.fillText(
        `ESM-2 LLR ${typeof llr === "number" ? llr.toFixed(2) : "n/a"}`,
        W - PAD,
        y + 24,
      );
      ctx.fillText(`iteration ${c.iteration}`, W - PAD, y + 52);
      ctx.textAlign = "left";
      y += 92;

      const dist = state.measuredDistance ?? c.distance_to_active_site_A;
      const nearest = state.measuredNearest ?? c.nearest_active_site_residue;
      ctx.fillStyle = THEME.text;
      ctx.font = font(600, 24);
      ctx.fillText(
        dist == null
          ? "distance to active site: unknown"
          : `${dist.toFixed(1)} Å to active site${nearest ? ` (residue ${nearest})` : ""}`,
        PAD,
        y,
      );
      y += 34;
    }

    ctx.fillStyle = THEME.text;
    ctx.font = font(700, 38);
    y = this.wrap(c.label || claim?.headline || c.mutation.label, PAD, y + 8, width, 46, 3);

    // A reviewer's name is for finding it again, not a record of what the lab
    // said — so the lab's own wording stays visible underneath.
    if (c.label && claim?.headline) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 20);
      y = this.wrap(`lab called it: ${claim.headline}`, PAD, y + 6, width, 26, 2);
    }
    y += 18;

    y = this.flagChips(c, state, y);

    if (claim?.agent_generated || c.kind === "claim") {
      this.heading("Agent hypothesis · not verified", PAD, y, THEME.agent);
      y += 32;
    }
    ctx.fillStyle = THEME.body;
    ctx.font = font(600, 24);
    y = this.wrap(c.rationale || "(no detail provided)", PAD, y, width, 32);

    if (claim?.props?.length) {
      y += 18;
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 21);
      for (const prop of claim.props) {
        ctx.fillText(`${prop.k}: ${prop.v}`, PAD, y);
        y += 28;
      }
    }
    return y;
  }

  private evidenceTab(c: Candidate, y: number): number {
    const ctx = this.ctx;
    const width = W - PAD * 2;

    if (c.citations.length === 0) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 23);
      ctx.fillText("No citations attached to this candidate.", PAD, y + 8);
      return y + 40;
    }

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 21);
    ctx.fillText(
      `${c.citations.length} source${c.citations.length > 1 ? "s" : ""} retrieved from the corpus`,
      PAD,
      y,
    );
    y += 34;

    c.citations.forEach((cite, index) => {
      ctx.fillStyle = THEME.accent;
      ctx.font = font(700, 20);
      ctx.fillText(`${index + 1}`, PAD, y);

      ctx.fillStyle = THEME.text;
      ctx.font = font(700, 23);
      y = this.wrap(cite.title || "(untitled)", PAD + 34, y, width - 34, 30, 2);

      const meta = [cite.doc_id, cite.year ? String(cite.year) : null]
        .filter(Boolean)
        .join(" · ");
      if (meta) {
        ctx.fillStyle = THEME.faint;
        ctx.font = font(600, 20);
        ctx.fillText(meta, PAD + 34, y + 4);
        y += 28;
      }

      if (cite.snippet) {
        ctx.fillStyle = THEME.dim;
        ctx.font = font(600, 21);
        y = this.wrap(`“${cite.snippet}”`, PAD + 34, y + 6, width - 34, 28, 3);
      }

      y += 16;
      ctx.strokeStyle = THEME.rule;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(PAD + 34, y - 8);
      ctx.lineTo(W - PAD, y - 8);
      ctx.stroke();
      y += 16;
    });
    return y;
  }

  private checksTab(c: Candidate, y: number): number {
    const ctx = this.ctx;
    const width = W - PAD * 2;
    const validation = c.validation;

    if (!validation) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 23);
      ctx.fillText("The lab reported no validation for this candidate.", PAD, y + 8);
      return y + 40;
    }

    const verdict = validation.verdict;
    const tone =
      verdict === "PASS" ? THEME.good : verdict === "FAIL" ? THEME.warn : THEME.caution;

    ctx.fillStyle = tone;
    ctx.font = font(700, 40);
    ctx.fillText(verdict, PAD, y + 30);
    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 20);
    ctx.fillText(
      `confidence ${validation.confidence.toFixed(2)} · computed, never asserted by a model`,
      PAD + 160,
      y + 30,
    );
    y += 68;

    for (const check of validation.checks) {
      ctx.fillStyle = check.passed ? THEME.good : THEME.warn;
      ctx.font = font(700, 24);
      ctx.fillText(check.passed ? "✓" : "✕", PAD, y);

      ctx.fillStyle = check.passed ? THEME.dim : THEME.text;
      ctx.font = font(700, 23);
      ctx.fillText(check.name.replace(/_/g, " "), PAD + 36, y);

      ctx.textAlign = "right";
      ctx.fillStyle = check.passed ? THEME.dim : THEME.warnText;
      ctx.font = font(600, 22);
      ctx.fillText(`${check.value} / ${check.threshold}`, W - PAD, y);
      ctx.textAlign = "left";
      y += 28;

      if (check.detail) {
        ctx.fillStyle = THEME.faint;
        ctx.font = font(600, 20);
        y = this.wrap(check.detail, PAD + 36, y, width - 36, 26, 2);
      }
      y += 14;
    }

    if (validation.warnings?.length) {
      y += 10;
      this.heading("Warnings", PAD, y, THEME.warnText);
      y += 30;
      ctx.fillStyle = THEME.warnText;
      ctx.font = font(600, 21);
      for (const warning of validation.warnings) {
        y = this.wrap(`· ${warning}`, PAD, y, width, 28, 2);
      }
    }
    return y;
  }

  private detailsTab(c: Candidate, state: PanelState, y: number): number {
    const ctx = this.ctx;
    const rows: [string, string][] = [
      ["candidate", c.candidate_id],
      ["run", c.run_id],
      ["kind", c.kind],
      ["source", c.source],
      ["status", c.status],
      ["iteration", String(c.iteration)],
      ["protein", `${c.protein_id} chain ${c.chain}`],
      ["active site", c.active_site_residues.join(", ")],
      ["flags", c.flags.length ? c.flags.join(", ") : "none"],
      ["approval id", c.approval_id ?? "none — not blocking an agent"],
      ["named by reviewer", c.label ?? "not named"],
      ["picked residue", state.pickedResidue ?? "none"],
    ];

    for (const [key, value] of rows) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 21);
      ctx.fillText(key, PAD, y);
      ctx.fillStyle = THEME.text;
      ctx.font = font(600, 21);
      y = this.wrap(value, PAD + 260, y, W - PAD * 2 - 260, 28, 2);
      y += 10;
    }
    return y;
  }

  private flagChips(c: Candidate, state: PanelState, y: number): number {
    const ctx = this.ctx;
    const flags = [...c.flags];
    if (state.wtMismatch && !flags.includes("wt_mismatch")) flags.push("wt_mismatch");
    if (flags.length === 0) return y;

    let x = PAD;
    ctx.font = font(600, 20);
    for (const flag of flags) {
      const text = flag.replace(/_/g, " ");
      const w = ctx.measureText(text).width + 28;
      if (x + w > W - PAD) break;
      const warn = flag.includes("near_active_site") || flag.includes("mismatch");
      ctx.fillStyle = warn ? THEME.tintWarn : THEME.tintAccent;
      this.roundRect(x, y - 22, w, 36, 18);
      ctx.fill();
      ctx.fillStyle = warn ? THEME.warnText : THEME.accent;
      ctx.fillText(text, x + 14, y + 2);
      x += w + 12;
    }
    return y + 44;
  }

  // ------------------------------------------------------------- chrome

  private queueStrip(state: PanelState, y: number): number {
    const ctx = this.ctx;
    if (state.queue.length === 0) return y + 12;

    const tiles = state.queue.slice(0, MAX_QUEUE_TILES);
    const gap = 8;
    const tileW = (W - PAD * 2 - gap * (MAX_QUEUE_TILES - 1)) / MAX_QUEUE_TILES;
    const tileH = 48;

    tiles.forEach((candidate, index) => {
      const x = PAD + index * (tileW + gap);
      const current = candidate.candidate_id === state.candidate?.candidate_id;

      ctx.fillStyle = current ? THEME.tintAccent : THEME.surface;
      this.roundRect(x, y, tileW, tileH, 10);
      ctx.fill();
      ctx.strokeStyle = current ? THEME.accent : THEME.rule;
      ctx.lineWidth = current ? 3 : 2;
      this.roundRect(x, y, tileW, tileH, 10);
      ctx.stroke();

      ctx.fillStyle = current ? THEME.accent : THEME.dim;
      ctx.font = font(600, 20);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label =
        candidate.label ??
        (candidate.kind === "claim"
          ? (candidate.claim?.node_type ?? "claim")
          : candidate.mutation.label);
      ctx.fillText(this.clip(label, tileW - 18), x + tileW / 2, y + tileH / 2 + 1);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";

      if (candidate.flags.length) {
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
      ctx.font = font(600, 19);
      ctx.textAlign = "right";
      ctx.fillText(`+${overflow} more`, W - PAD, y + tileH + 20);
      ctx.textAlign = "left";
    }
    return y + tileH + 26;
  }

  private flash(flash: NonNullable<PanelState["flash"]>): void {
    const ctx = this.ctx;
    const color = FLASH_COLOR[flash.decision];
    ctx.fillStyle = THEME.scrim;
    this.roundRect(6, 6, W - 12, H - 12, 30);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 8;
    this.roundRect(14, 14, W - 28, H - 28, 24);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.font = font(700, 92);
    ctx.fillText(flash.decision.toUpperCase(), W / 2, H / 2 - 10);
    ctx.font = font(600, 32);
    ctx.fillStyle = THEME.text;
    ctx.fillText(flash.label, W / 2, H / 2 + 56);
    ctx.font = font(600, 23);
    ctx.fillStyle = THEME.faint;
    ctx.fillText("sent to the agent loop", W / 2, H / 2 + 106);
    ctx.textAlign = "left";
  }

  private footer(state: PanelState): void {
    const ctx = this.ctx;
    const c = state.candidate;
    const has = !!c;
    this.rule(FOOTER_TOP, PAD);

    const gap = 14;
    const full = W - PAD * 2;
    const third = (full - gap * 2) / 3;
    const row1 = FOOTER_TOP + 22;

    const naming = state.voiceTarget === "label";
    this.button(
      "gate:rename",
      PAD,
      row1,
      third,
      56,
      naming ? "● Say the name" : c?.label ? "Rename" : "Name it",
      naming ? THEME.warn : THEME.bench,
      { fontSize: 21, solid: naming, disabled: !has },
    );

    const noting = state.voiceTarget === "note";
    this.button(
      "gate:note",
      PAD + third + gap,
      row1,
      third,
      56,
      noting ? "● Say the note" : state.pendingNote ? "Note ✓" : "Add note",
      noting ? THEME.warn : state.pendingNote ? THEME.good : THEME.bench,
      { fontSize: 21, solid: noting, disabled: !has },
    );

    // Two presses: the first arms it, the second commits. Nothing destructive
    // happens on a single mis-aimed press.
    this.button(
      state.confirmingDismiss ? "gate:dismiss-confirm" : "gate:dismiss",
      PAD + (third + gap) * 2,
      row1,
      third,
      56,
      state.confirmingDismiss ? "Sure? Dismiss" : "Dismiss",
      THEME.warn,
      { fontSize: 21, solid: !!state.confirmingDismiss, disabled: !has },
    );

    ctx.font = font(600, 19);
    if (state.confirmingDismiss) {
      ctx.fillStyle = THEME.warnText;
      ctx.fillText(
        "clears it from the queue and is logged — press again, or decide to cancel",
        PAD,
        row1 + 80,
      );
    } else if (state.pendingNote) {
      ctx.fillStyle = THEME.faint;
      ctx.fillText(this.clip(`note: “${state.pendingNote}”`, full), PAD, row1 + 80);
    }

    const benchable = has && c?.kind !== "claim";
    this.button(
      "gate:bench",
      PAD,
      H - 236,
      full,
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
    const buttonW = (full - gap * 2) / 3;
    buttons.forEach(([decision, key, label, color], index) => {
      this.button(
        `gate:${decision}`,
        PAD + index * (buttonW + gap),
        H - 162,
        buttonW,
        66,
        `${key}  ${label}`,
        color,
        { disabled: !has, fontSize: 24 },
      );
    });

    ctx.fillStyle = THEME.off;
    ctx.font = font(600, 19);
    ctx.fillText(`reviewer ${state.reviewer} · run ${c?.run_id ?? "—"}`, PAD, H - 34);
    if (state.message && c) {
      ctx.textAlign = "right";
      ctx.fillStyle = THEME.warnText;
      ctx.fillText(state.message, W - PAD, H - 34);
      ctx.textAlign = "left";
    }
  }

  private clip(text: string, maxWidth: number): string {
    const ctx = this.ctx;
    if (maxWidth <= 0 || ctx.measureText(text).width <= maxWidth) return text;
    let out = text;
    while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
      out = out.slice(0, -1);
    }
    return `${out}…`;
  }
}
