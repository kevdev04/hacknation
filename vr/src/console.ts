/**
 * The console: where a session starts and every question is asked.
 *
 * Sits below the molecule, where the substitution card used to be. It opens on
 * a greeting rather than a blank field because the first thing a reviewer needs
 * is to know the thing is listening and what it expects of them.
 *
 * Push-to-talk lives here rather than on the top bar: asking is the main action
 * in the room, and the control strip above is for status and recovery.
 */

import { CanvasPanel, THEME, font } from "./ui";

const W = 1180;
const H = 560;
const PANEL_WIDTH_M = 0.78;

const PAD = 52;

export type ConsoleVoiceState = "idle" | "recording" | "sending" | "error";

export interface ConsoleState {
  reviewer: string;
  /** False when the gate has no transcription key. */
  voiceAvailable: boolean;
  voiceState: ConsoleVoiceState;
  /** What was heard, waiting to be sent. */
  transcript: string;
  error: string | null;
  /** True while the question is in flight to the lab. */
  sending: boolean;
  /** Set while the lab is working, so the console can say so. */
  busyStage: string | null;
  /** How many questions have been asked this session. */
  asked: number;
  /** The residue the controller last pointed at, e.g. "SER 160". */
  picked: string | null;
  /** Characters of format contract travelling with the question. */
  contextChars: number;
}

export class ConsolePanel extends CanvasPanel {
  constructor() {
    super(W, H, PANEL_WIDTH_M);
  }

  render(state: ConsoleState): void {
    const ctx = this.ctx;
    this.begin();
    this.backdrop();

    const width = W - PAD * 2;
    let y = 86;

    // ------------------------------------------------------------ greeting
    ctx.fillStyle = THEME.text;
    ctx.font = font(700, 44);
    ctx.fillText(`Hi ${state.reviewer},`, PAD, y);
    y += 54;

    ctx.fillStyle = THEME.dim;
    ctx.font = font(600, 32);
    ctx.fillText("what do you want to experiment with today?", PAD, y);
    y += 50;

    // ------------------------------------------------------- what was heard
    if (state.error) {
      ctx.fillStyle = THEME.warnText;
      ctx.font = font(600, 23);
      y = this.wrap(state.error, PAD, y + 10, width, 30, 2);
    } else if (state.transcript) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 21);
      ctx.fillText("heard", PAD, y);
      y += 32;
      ctx.fillStyle = THEME.text;
      ctx.font = font(700, 28);
      y = this.wrap(`“${state.transcript}”`, PAD, y, width, 36, 3);
    } else if (state.busyStage) {
      ctx.fillStyle = THEME.accent;
      ctx.font = font(600, 26);
      ctx.fillText(`the lab is ${state.busyStage}…`, PAD, y + 8);
      y += 44;
    } else {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 23);
      y = this.wrap(
        state.voiceAvailable
          ? "Hold the button below, or the left Y on your controller, and speak. You will see what was heard before anything is sent."
          : "Voice is off — the gate has no transcription key. Set OPENAI_API_KEY and restart it.",
        PAD,
        y + 10,
        width,
        30,
        3,
      );
    }

    // --------------------------------------------------------------- buttons
    const row = H - PAD - 86;
    const gap = 16;
    const askW = 380;
    const sendW = 380;

    const listening = state.voiceState === "recording";
    const askLabel = listening
      ? "● Listening"
      : state.voiceState === "sending"
        ? "Transcribing…"
        : state.voiceAvailable
          ? "🎤 Hold to ask"
          : "🎤 No voice key";

    this.button(
      "console:ask",
      PAD,
      row,
      askW,
      86,
      askLabel,
      listening ? THEME.warn : THEME.bench,
      {
        fontSize: 27,
        solid: listening,
        disabled: !state.voiceAvailable || state.voiceState === "sending",
      },
    );

    const canSend = !!state.transcript && !state.sending;
    this.button(
      "console:send",
      PAD + askW + gap,
      row,
      sendW,
      86,
      state.sending ? "Sending…" : "Send to lab  ➤",
      THEME.accent,
      { fontSize: 27, solid: canSend, disabled: !canSend },
    );

    this.button(
      "console:clear",
      PAD + askW + sendW + gap * 2,
      row,
      width - askW - sendW - gap * 2,
      86,
      "Clear",
      THEME.off,
      { fontSize: 24, disabled: !state.transcript },
    );

    // The question does not travel alone, and the reviewer should know that.
    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 19);
    const footer = state.transcript
      ? `sends your question plus ${state.contextChars} characters of format contract`
      : `${state.asked} question${state.asked === 1 ? "" : "s"} this session`;
    ctx.fillText(footer, PAD, H - 34);

    // Picking a residue is a way of pointing at what you are about to ask
    // about, so the name is kept where the question is being composed.
    if (state.picked) {
      ctx.textAlign = "right";
      ctx.fillStyle = THEME.accent;
      ctx.font = font(700, 20);
      ctx.fillText(`pointing at ${state.picked}`, W - PAD, H - 34);
      ctx.textAlign = "left";
    }

    this.commit();
  }
}
