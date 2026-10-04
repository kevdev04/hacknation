/**
 * The wide strip above the workspace.
 *
 * Status and recovery only. It says who is reviewing, what the lab is doing,
 * and gives back the one control that must stay reachable however far the other
 * surfaces have been dragged: recentring.
 *
 * Push-to-talk used to live here and now lives on the console below the
 * molecule, where asking a question actually happens.
 */

import { CanvasPanel, THEME, font } from "./ui";

const W = 1600;
const H = 184;
const PANEL_WIDTH_M = 1.05;

const PAD = 48;
const TEXT_X = 330;

export interface ControlBarState {
  /** Short description of what the loop is doing right now. */
  headline: string;
  reviewer: string;
  /** Questions asked this session. */
  asked: number;
  /** Experiments kept. */
  saved: number;
  /** 0-1 while the agent lab is mid-exploration; null when idle. */
  progress: number | null;
  /** True when every link in the project panel's log is up. */
  connected: boolean;
}

export class ControlBar extends CanvasPanel {
  constructor() {
    super(W, H, PANEL_WIDTH_M);
  }

  render(state: ControlBarState): void {
    const ctx = this.ctx;
    this.begin();
    this.backdrop();

    // ---------------------------------------------------- identity, left
    ctx.fillStyle = THEME.accent;
    ctx.font = font(700, 34);
    ctx.fillText("PETase Lab", PAD, 58);

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 22);
    ctx.fillText(`reviewer ${state.reviewer}`, PAD, 92);

    // ------------------------------------------- what the loop is doing
    const recenterW = 240;
    const buttonX = W - PAD - recenterW;
    const textWidth = buttonX - TEXT_X - 32;

    ctx.fillStyle = THEME.text;
    ctx.font = font(600, 28);
    ctx.fillText(this.clip(state.headline, textWidth), TEXT_X, 58);

    ctx.fillStyle = state.connected ? THEME.good : THEME.caution;
    ctx.beginPath();
    ctx.arc(TEXT_X + 7, 85, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 22);
    ctx.fillText(
      `${state.asked} asked · ${state.saved} saved${state.connected ? "" : " · a link is down, see the log"}`,
      TEXT_X + 26,
      92,
    );

    // Progress of the live exploration. The lab takes 9-13 s; showing the stage
    // advance is the difference between a demo and a frozen panel.
    if (state.progress != null) {
      const barW = Math.min(620, textWidth);
      ctx.fillStyle = THEME.surface;
      this.roundRect(TEXT_X, 110, barW, 8, 4);
      ctx.fill();
      ctx.fillStyle = THEME.accent;
      this.roundRect(TEXT_X, 110, Math.max(8, barW * state.progress), 8, 4);
      ctx.fill();
    }

    this.button(
      "gate:recenter",
      buttonX,
      H - PAD - 54,
      recenterW,
      62,
      "⟳  Recenter",
      THEME.accent,
      { fontSize: 24 },
    );

    this.commit();
  }

  /** Truncate to a pixel width with an ellipsis, using the current font. */
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
