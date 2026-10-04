/**
 * The wide strip above the workspace.
 *
 * Carries the one control that must stay reachable no matter where everything
 * else has been dragged to: recentring. It lives on its own surface rather than
 * inside the gate panel so that losing track of a panel never costs you the way
 * back — and so it reads at a glance from across the room.
 */

import { CanvasPanel, THEME, font } from "./ui";

const W = 1600;
const H = 150;
const PANEL_WIDTH_M = 1.05;

export interface ControlBarState {
  /** Short description of what the loop is doing right now. */
  headline: string;
  queueTotal: number;
  benchCount: number;
  reviewer: string;
  /** 0-1 while the agent lab is mid-exploration; null when idle. */
  progress: number | null;
  voice: {
    state: "idle" | "recording" | "sending" | "error";
    /** False when the gate has no transcription key — the control greys out. */
    available: boolean;
    lastText: string;
    lastError: string | null;
  };
}

export class ControlBar extends CanvasPanel {
  constructor() {
    super(W, H, PANEL_WIDTH_M);
  }

  render(state: ControlBarState): void {
    const ctx = this.ctx;
    this.begin();
    this.backdrop();

    // Identity, left.
    ctx.fillStyle = THEME.accent;
    ctx.font = font(700, 34);
    ctx.fillText("PETase Lab", 48, 66);

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 22);
    ctx.fillText(`reviewer ${state.reviewer}`, 48, 104);

    // What the loop is doing, centre-left of the button.
    ctx.fillStyle = THEME.text;
    ctx.font = font(600, 28);
    ctx.fillText(state.headline, 330, 66);

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 22);
    ctx.fillText(
      `${state.queueTotal} pending · ${state.benchCount} on the bench`,
      330,
      104,
    );

    // Progress of the live exploration. The lab takes 9-13 s; showing the
    // stage advance is the difference between a demo and a frozen panel.
    if (state.progress != null) {
      const barX = 330;
      const barW = 540;
      const barY = 118;
      ctx.fillStyle = THEME.surface;
      this.roundRect(barX, barY, barW, 8, 4);
      ctx.fill();
      ctx.fillStyle = THEME.accent;
      this.roundRect(barX, barY, Math.max(8, barW * state.progress), 8, 4);
      ctx.fill();
    }

    // Ask by voice, then recentre — both right-aligned, recentre outermost
    // because it is the one you reach for when everything else has moved.
    const buttonH = 82;
    const recenterW = 300;
    const askW = 330;
    const top = (H - buttonH) / 2;

    const v = state.voice;
    const askLabel =
      v.state === "recording"
        ? "● Listening — release"
        : v.state === "sending"
          ? "Transcribing…"
          : v.available
            ? "🎤 Hold to ask"
            : "🎤 No voice key";
    this.button(
      "voice:toggle",
      W - 48 - recenterW - 16 - askW,
      top,
      askW,
      buttonH,
      askLabel,
      v.state === "recording" ? THEME.warn : THEME.bench,
      { fontSize: 24, solid: v.state === "recording", disabled: !v.available },
    );

    this.button(
      "gate:recenter",
      W - 48 - recenterW,
      top,
      recenterW,
      buttonH,
      "⟳  Recenter",
      THEME.accent,
      { fontSize: 26 },
    );

    // What the gate actually heard, so a misheard question is visible rather
    // than silently becoming the wrong query.
    if (v.lastError || v.lastText) {
      ctx.fillStyle = v.lastError ? THEME.warnText : THEME.faint;
      ctx.font = font(600, 20);
      const line = v.lastError ? v.lastError : `heard: "${v.lastText}"`;
      ctx.fillText(line.slice(0, 58), 330, 136);
    }

    this.commit();
  }
}
