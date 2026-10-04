/**
 * The wide strip above the workspace.
 *
 * Carries the controls that must stay reachable wherever everything else has
 * been dragged to: recentring, push-to-talk, and sending a transcript to the
 * agent lab.
 *
 * Laid out as rows rather than one line of competing elements. Text and buttons
 * previously shared a row, so a long headline ran underneath them; now the text
 * owns the upper rows, the buttons own the lower one, and every string is
 * clipped to the width actually available rather than trusted to fit.
 */

import { CanvasPanel, THEME, font } from "./ui";

const W = 1600;
const H = 230;
const PANEL_WIDTH_M = 1.05;

const PAD = 48;
const TEXT_X = 330;

export type VoiceUiState = "idle" | "recording" | "sending" | "error";

export interface ControlBarState {
  /** Short description of what the loop is doing right now. */
  headline: string;
  queueTotal: number;
  benchCount: number;
  reviewer: string;
  /** 0-1 while the agent lab is mid-exploration; null when idle. */
  progress: number | null;
  voice: {
    state: VoiceUiState;
    /** False when the gate has no transcription key — the control greys out. */
    available: boolean;
    /** Last transcript, waiting to be sent. */
    lastText: string;
    lastError: string | null;
    /** True while the transcript is being handed to the lab. */
    sending: boolean;
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

    // ---------------------------------------------------- identity, left
    ctx.fillStyle = THEME.accent;
    ctx.font = font(700, 34);
    ctx.fillText("PETase Lab", PAD, 58);

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 22);
    ctx.fillText(`reviewer ${state.reviewer}`, PAD, 92);

    // ------------------------------------------- what the loop is doing
    const textWidth = W - TEXT_X - PAD;
    ctx.fillStyle = THEME.text;
    ctx.font = font(600, 28);
    ctx.fillText(this.clip(state.headline, textWidth), TEXT_X, 58);

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 22);
    ctx.fillText(
      `${state.queueTotal} pending · ${state.benchCount} on the bench`,
      TEXT_X,
      92,
    );

    // Progress of the live exploration. The lab takes 9-13 s; showing the stage
    // advance is the difference between a demo and a frozen panel.
    if (state.progress != null) {
      const barW = 620;
      ctx.fillStyle = THEME.surface;
      this.roundRect(TEXT_X, 108, barW, 8, 4);
      ctx.fill();
      ctx.fillStyle = THEME.accent;
      this.roundRect(TEXT_X, 108, Math.max(8, barW * state.progress), 8, 4);
      ctx.fill();
    }

    // --------------------------------------------------- buttons, bottom
    const v = state.voice;
    const row = H - PAD - 62;
    const gap = 16;
    const askW = 300;
    const sendW = 300;
    const recenterW = 240;
    let x = W - PAD - recenterW;

    this.button("gate:recenter", x, row, recenterW, 62, "⟳  Recenter", THEME.accent, {
      fontSize: 24,
    });

    // Sending is explicit: the transcript is visible first, so a misheard
    // question can be discarded instead of silently becoming the next query.
    x -= gap + sendW;
    const canSend = !!v.lastText && !v.sending;
    this.button(
      "voice:send",
      x,
      row,
      sendW,
      62,
      v.sending ? "Sending…" : "Send to lab  ➤",
      THEME.bench,
      { fontSize: 24, solid: canSend, disabled: !canSend },
    );

    x -= gap + askW;
    const askLabel =
      v.state === "recording"
        ? "● Listening"
        : v.state === "sending"
          ? "Transcribing…"
          : v.available
            ? "🎤 Hold to ask"
            : "🎤 No voice key";
    this.button(
      "voice:toggle",
      x,
      row,
      askW,
      62,
      askLabel,
      v.state === "recording" ? THEME.warn : THEME.bench,
      {
        fontSize: 23,
        solid: v.state === "recording",
        disabled: !v.available || v.state === "sending",
      },
    );

    // ------------------------------------------- transcript, above the row
    // Clipped to the space left of the buttons so it can never run under them.
    const statusWidth = x - PAD - 24;
    if (v.lastError) {
      ctx.fillStyle = THEME.warnText;
      ctx.font = font(600, 21);
      ctx.fillText(this.clip(v.lastError, statusWidth), PAD, row - 18);
    } else if (v.lastText) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 21);
      ctx.fillText("heard", PAD, row - 18);
      ctx.fillStyle = THEME.text;
      ctx.font = font(700, 22);
      ctx.fillText(this.clip(`“${v.lastText}”`, statusWidth - 72), PAD + 72, row - 18);
    }

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
