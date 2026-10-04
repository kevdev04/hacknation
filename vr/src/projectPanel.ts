/**
 * The project, on the left.
 *
 * Three views of the same session: what has been asked, what was kept, and what
 * the system has been doing. The point is that a reviewer can leave, come back,
 * and see the shape of the work — which questions were asked, which answers
 * were worth saving, and whether anything failed on the way.
 *
 * Questions live for the session. Experiments are saved deliberately and
 * persist on the gate, so the project record is what a human judged worth
 * keeping rather than everything that was ever typed.
 */

import { CanvasPanel, THEME, font } from "./ui";

const W = 1060;
const H = 1080;
const PANEL_WIDTH_M = 0.66;

const PAD = 44;
const FOOTER_TOP = H - 132;

export type ProjectTab = "questions" | "experiments" | "log";

export const PROJECT_TABS: { id: ProjectTab; label: string }[] = [
  { id: "questions", label: "Questions" },
  { id: "experiments", label: "Saved" },
  { id: "log", label: "Log" },
];

export type QuestionStatus = "running" | "answered" | "failed" | "empty";

export interface SessionQuestion {
  query_id: string;
  query: string;
  status: QuestionStatus;
  /** Set once an answer has been read. */
  headline?: string;
  kind?: string;
  latency_ms?: number;
  verdict?: string | null;
  /** Seconds since the session started. */
  at: number;
  /** True when this is the question whose answer is on screen. */
  current?: boolean;
}

export interface SavedExperiment {
  experiment_id: string;
  query: string;
  headline: string;
  kind: string;
  saved_at?: string | null;
}

export interface LogLine {
  t: number;
  text: string;
  level: "info" | "warn" | "error";
}

export interface ProjectLink {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProjectPanelState {
  tab: ProjectTab;
  scroll: number;
  reviewer: string;
  questions: SessionQuestion[];
  experiments: SavedExperiment[];
  log: LogLine[];
  links: ProjectLink[];
  /** True when every link is up. */
  connected: boolean;
}

const STATUS: Record<QuestionStatus, { dot: string; word: string }> = {
  running: { dot: THEME.caution, word: "running" },
  answered: { dot: THEME.good, word: "answered" },
  failed: { dot: THEME.warn, word: "failed" },
  empty: { dot: THEME.off, word: "no evidence" },
};

const LEVEL: Record<LogLine["level"], string> = {
  info: THEME.dim,
  warn: THEME.caution,
  error: THEME.warnText,
};

export class ProjectPanel extends CanvasPanel {
  private overflow = 0;

  constructor() {
    super(W, H, PANEL_WIDTH_M);
  }

  get maxScroll(): number {
    return this.overflow;
  }

  render(state: ProjectPanelState): void {
    const ctx = this.ctx;
    this.begin();
    this.backdrop();

    let y = 68;
    this.heading("Project", PAD, y, THEME.accent);

    ctx.textAlign = "right";
    ctx.fillStyle = state.connected ? THEME.good : THEME.caution;
    ctx.font = font(700, 20);
    ctx.fillText(state.connected ? "all systems up" : "partial", W - PAD, y);
    ctx.textAlign = "left";
    y += 14;
    this.rule(y, PAD);
    y += 22;

    ctx.fillStyle = THEME.faint;
    ctx.font = font(600, 20);
    ctx.fillText(
      `${state.reviewer} · ${state.questions.length} asked · ${state.experiments.length} saved`,
      PAD,
      y + 4,
    );
    y += 34;

    y = this.tabBar(state, y);

    const bodyTop = y;
    const bodyHeight = FOOTER_TOP - bodyTop - 14;
    const scroll = Math.min(Math.max(state.scroll, 0), this.overflow);
    // Canvas text is drawn from its baseline, so the first line has to start a
    // full ascent below the clip edge or its glyph tops are shaved off.
    const drawTop = bodyTop + 26;

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD - 6, bodyTop, W - PAD * 2 + 12, bodyHeight);
    ctx.clip();
    ctx.translate(0, -scroll);

    let end: number;
    if (state.tab === "questions") end = this.questionsBody(state, drawTop);
    else if (state.tab === "experiments") end = this.experimentsBody(state, drawTop);
    else end = this.logBody(state, drawTop);

    ctx.restore();
    this.overflow = Math.max(0, end - bodyTop - bodyHeight);

    if (scroll < this.overflow) {
      const fade = ctx.createLinearGradient(0, bodyTop + bodyHeight - 36, 0, bodyTop + bodyHeight);
      fade.addColorStop(0, "rgba(215, 225, 236, 0)");
      fade.addColorStop(1, THEME.glass);
      ctx.fillStyle = fade;
      ctx.fillRect(PAD - 6, bodyTop + bodyHeight - 36, W - PAD * 2 + 12, 36);
    }

    this.footer(state);
    this.commit();
  }

  private tabBar(state: ProjectPanelState, y: number): number {
    const ctx = this.ctx;
    const gap = 8;
    const tabW = (W - PAD * 2 - gap * (PROJECT_TABS.length - 1)) / PROJECT_TABS.length;

    PROJECT_TABS.forEach((tab, index) => {
      const x = PAD + index * (tabW + gap);
      const active = state.tab === tab.id;
      ctx.fillStyle = active ? THEME.tintAccent : THEME.surface;
      this.roundRect(x, y, tabW, 46, 10);
      ctx.fill();
      ctx.strokeStyle = active ? THEME.accent : THEME.rule;
      ctx.lineWidth = active ? 3 : 2;
      this.roundRect(x, y, tabW, 46, 10);
      ctx.stroke();
      ctx.fillStyle = active ? THEME.accent : THEME.dim;
      ctx.font = font(active ? 700 : 600, 20);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tab.label, x + tabW / 2, y + 24);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      this.region(`project:tab:${tab.id}`, x, y, tabW, 46);
    });
    // A generous gap: the panel is seen at an angle, so a tight one lets the
    // first body line visually run into the tab row at the far edge.
    return y + 70;
  }

  // ------------------------------------------------------------- bodies

  private questionsBody(state: ProjectPanelState, y: number): number {
    const ctx = this.ctx;
    const width = W - PAD * 2;

    if (state.questions.length === 0) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 22);
      return this.wrap(
        "Nothing asked yet. Use the console below the molecule to ask the lab something.",
        PAD,
        y + 8,
        width,
        30,
      );
    }

    // Newest first: the thing just asked is the thing being looked at.
    for (const q of [...state.questions].reverse()) {
      const top = y - 24;
      const rowH = 86;

      if (q.current) {
        ctx.fillStyle = THEME.tintAccent;
        this.roundRect(PAD - 10, top, width + 20, rowH, 10);
        ctx.fill();
      }

      const status = STATUS[q.status];
      ctx.fillStyle = status.dot;
      ctx.beginPath();
      ctx.arc(PAD + 6, y - 6, 7, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = THEME.text;
      ctx.font = font(600, 22);
      const line = this.clipText(q.query, width - 40);
      ctx.fillText(line, PAD + 26, y);
      y += 28;

      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 18);
      const meta = [
        status.word,
        q.kind,
        q.latency_ms ? `${(q.latency_ms / 1000).toFixed(1)} s` : null,
        q.verdict,
        `${q.at.toFixed(0)}s`,
      ]
        .filter(Boolean)
        .join(" · ");
      ctx.fillText(meta, PAD + 26, y);
      y += 24;

      if (q.headline) {
        ctx.fillStyle = THEME.dim;
        ctx.font = font(600, 19);
        y = this.wrap(q.headline, PAD + 26, y, width - 26, 24, 1);
      }

      this.region(`project:open:${q.query_id}`, PAD - 10, top, width + 20, rowH);
      y += 22;
    }
    return y;
  }

  private experimentsBody(state: ProjectPanelState, y: number): number {
    const ctx = this.ctx;
    const width = W - PAD * 2;

    if (state.experiments.length === 0) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 22);
      return this.wrap(
        "No saved experiments. When an answer is worth keeping, save it from the answer panel — it persists on the gate and survives a restart.",
        PAD,
        y + 8,
        width,
        30,
      );
    }

    for (const e of state.experiments) {
      const top = y - 22;
      const rowH = 92;

      ctx.fillStyle = THEME.surface;
      this.roundRect(PAD - 10, top, width + 20, rowH, 10);
      ctx.fill();

      ctx.fillStyle = THEME.accent;
      ctx.font = font(700, 18);
      ctx.fillText(e.experiment_id, PAD + 4, y);

      ctx.textAlign = "right";
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 17);
      ctx.fillText((e.saved_at ?? "").replace("T", " ").replace("Z", ""), W - PAD - 4, y);
      ctx.textAlign = "left";
      y += 26;

      ctx.fillStyle = THEME.text;
      ctx.font = font(700, 21);
      y = this.wrap(e.headline || e.query, PAD + 4, y, width - 8, 27, 2);

      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 18);
      y = this.wrap(`${e.kind} · ${e.query}`, PAD + 4, y + 2, width - 8, 23, 1);

      this.region(`project:load:${e.experiment_id}`, PAD - 10, top, width + 20, rowH);
      y += 26;
    }
    return y;
  }

  private logBody(state: ProjectPanelState, y: number): number {
    const ctx = this.ctx;
    const width = W - PAD * 2;

    // Connections first: a log full of failures means nothing without knowing
    // which link is down.
    for (const link of state.links) {
      ctx.fillStyle = link.ok ? THEME.good : THEME.warn;
      ctx.beginPath();
      ctx.arc(PAD + 6, y - 6, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = THEME.text;
      ctx.font = font(700, 20);
      ctx.fillText(link.name, PAD + 24, y);
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 18);
      y = this.wrap(link.detail, PAD + 24, y + 24, width - 24, 23, 2);
      y += 14;
    }

    y += 8;
    this.rule(y, PAD);
    y += 32;
    this.heading("Run log", PAD, y, THEME.faint);
    y += 30;

    if (state.log.length === 0) {
      ctx.fillStyle = THEME.faint;
      ctx.font = font(600, 20);
      ctx.fillText("nothing yet", PAD, y);
      return y + 28;
    }

    ctx.font = font(600, 19);
    for (const line of [...state.log].reverse()) {
      ctx.fillStyle = THEME.off;
      ctx.fillText(`${line.t.toFixed(0)}s`.padStart(5, " "), PAD, y);
      ctx.fillStyle = LEVEL[line.level];
      ctx.fillText(this.clipText(line.text, width - 80), PAD + 72, y);
      y += 26;
    }
    return y;
  }

  private footer(state: ProjectPanelState): void {
    const ctx = this.ctx;
    this.rule(FOOTER_TOP, PAD);

    const gap = 12;
    const navW = 66;
    const row = FOOTER_TOP + 20;

    this.button("project:scroll:up", PAD, row, navW, 60, "▲", THEME.dim, {
      fontSize: 22,
      disabled: state.scroll <= 0,
    });
    this.button("project:scroll:down", PAD + navW + gap, row, navW, 60, "▼", THEME.dim, {
      fontSize: 22,
      disabled: state.scroll >= this.overflow,
    });

    const x = PAD + (navW + gap) * 2;
    this.button(
      "project:save",
      x,
      row,
      W - PAD - x,
      60,
      "Save current answer",
      THEME.bench,
      { fontSize: 22 },
    );

    ctx.fillStyle = THEME.off;
    ctx.font = font(600, 18);
    ctx.fillText("saved experiments persist on the gate", PAD, H - 26);
  }

  private clipText(text: string, maxWidth: number): string {
    const ctx = this.ctx;
    if (maxWidth <= 0 || ctx.measureText(text).width <= maxWidth) return text;
    let out = text;
    while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
    return `${out}…`;
  }
}
