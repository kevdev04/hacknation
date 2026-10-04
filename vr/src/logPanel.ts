/**
 * Connections and activity.
 *
 * Answers one question at a glance — is this actually wired to the agent lab,
 * or is it running on its own mock? Every link in the chain gets a row with the
 * thing it depends on named, because "it works" and "it works against a stub"
 * look identical from inside the headset.
 *
 * The activity list below is a ring buffer of what the gate and the lab have
 * done, so a failure is something you read rather than something you infer from
 * a panel that stopped changing.
 */

import { CanvasPanel, THEME, font } from "./ui";

const W = 1100;
const H = 780;
const PANEL_WIDTH_M = 0.56;

const MAX_ROWS = 7;

export type LinkState = "ok" | "degraded" | "down" | "unknown";

export interface Link {
  name: string;
  state: LinkState;
  /** What it is talking to, or why it is not. */
  detail: string;
}

export interface LogEntry {
  /** Seconds since the page loaded. */
  t: number;
  text: string;
  level: "info" | "warn" | "error";
}

export interface LogPanelState {
  links: Link[];
  entries: LogEntry[];
  /** True only when every link is ok — the headline verdict. */
  fullyConnected: boolean;
}

const STATE_COLOR: Record<LinkState, string> = {
  ok: THEME.good,
  degraded: THEME.caution,
  down: THEME.warn,
  unknown: THEME.off,
};

const LEVEL_COLOR: Record<LogEntry["level"], string> = {
  info: THEME.dim,
  warn: THEME.caution,
  error: THEME.warnText,
};

export class LogPanel extends CanvasPanel {
  constructor() {
    super(W, H, PANEL_WIDTH_M);
  }

  render(state: LogPanelState): void {
    const ctx = this.ctx;
    this.begin();
    this.backdrop();

    let y = 66;
    this.heading("Connections", 44, y, THEME.accent);

    // The verdict, stated rather than left to be worked out from the rows.
    const verdictColor = state.fullyConnected ? THEME.good : THEME.caution;
    ctx.textAlign = "right";
    ctx.fillStyle = verdictColor;
    ctx.font = font(700, 23);
    ctx.fillText(
      state.fullyConnected ? "fully connected" : "partial",
      W - 44,
      y,
    );
    ctx.textAlign = "left";
    y += 18;
    this.rule(y);
    y += 42;

    for (const link of state.links) {
      ctx.fillStyle = STATE_COLOR[link.state];
      ctx.beginPath();
      ctx.arc(56, y - 8, 9, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = THEME.text;
      ctx.font = font(700, 24);
      ctx.fillText(link.name, 80, y);

      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 21);
      y = this.wrap(link.detail, 80, y + 28, W - 124, 26, 2);
      y += 16;
    }

    y += 4;
    this.rule(y);
    y += 40;
    this.heading("Activity", 44, y, THEME.faint);
    y += 34;

    const rows = state.entries.slice(-MAX_ROWS);
    if (rows.length === 0) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 21);
      ctx.fillText("nothing yet", 44, y);
    }

    ctx.font = font(600, 21);
    for (const entry of rows) {
      // Checked before drawing, or the last row lands past the card edge.
      if (y > H - 34) break;
      ctx.fillStyle = THEME.off;
      const stamp = `${entry.t.toFixed(0).padStart(4, " ")}s`;
      ctx.fillText(stamp, 44, y);
      ctx.fillStyle = LEVEL_COLOR[entry.level];
      // One line each: the panel is a tail, not a transcript.
      const text = entry.text.length > 62 ? `${entry.text.slice(0, 61)}…` : entry.text;
      ctx.fillText(text, 126, y);
      y += 28;
    }

    this.commit();
  }
}
