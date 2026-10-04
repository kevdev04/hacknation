/**
 * Three lights on the desktop HUD: web (viewer → gate), agent (gate → agent
 * lab bridge) and data (the structure and the audit-trail state the gate
 * stands on). On its own setInterval, never in the render loop — a parked
 * requestAnimationFrame must not freeze the lights green.
 */
import { getFullHealth, type FullHealth } from "./api";

const POLL_MS = 10_000;

type Light = "ok" | "down" | "unknown";

function row(root: HTMLElement, key: string): HTMLElement {
  let el = root.querySelector<HTMLElement>(`[data-link="${key}"]`);
  if (!el) {
    el = document.createElement("div");
    el.className = "link";
    el.dataset.link = key;
    root.appendChild(el);
  }
  return el;
}

function paint(root: HTMLElement, key: string, label: string, light: Light, detail: string): void {
  const el = row(root, key);
  el.dataset.state = light;
  el.textContent = `${label} · ${detail}`;
}

function render(root: HTMLElement, h: FullHealth): void {
  paint(root, "web", "web → gate", "ok", `${h.checked_ms} ms`);
  paint(
    root,
    "agent",
    "gate → agent lab",
    h.agent.ok ? "ok" : "down",
    h.agent.ok ? `schema ${h.agent.detail ?? "?"}` : "unreachable · mock queue",
  );
  paint(
    root,
    "data",
    "data",
    h.data.ok ? "ok" : "down",
    h.data.ok
      ? `${h.data.structure} triad ${h.data.triad} · ${h.data.candidates} cand · ${h.data.decisions} dec`
      : `${h.data.structure ? "" : "structure missing "}${h.data.state_writable ? "" : "state not writable"}`.trim(),
  );
}

export function startHealthHud(onChange?: (h: FullHealth | null) => void): void {
  const root = document.getElementById("health");
  if (!root) return;

  const tick = async () => {
    try {
      const h = await getFullHealth();
      render(root, h);
      onChange?.(h);
    } catch {
      // The gate itself did not answer: nothing behind it is knowable.
      paint(root, "web", "web → gate", "down", "no answer");
      paint(root, "agent", "gate → agent lab", "unknown", "—");
      paint(root, "data", "data", "unknown", "—");
      onChange?.(null);
    }
  };

  void tick();
  setInterval(tick, POLL_MS);
}
