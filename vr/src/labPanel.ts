/**
 * Cases / History panel (desktop and phone). Pre-loaded use cases are one click
 * away, and every question the lab ever received can be asked again.
 *
 * Everything goes through the gate: /lab/cases, /lab/lineage, /lab/history, and
 * /bridge/explore for the question itself — so a case or a re-asked question is
 * an ordinary run (live by default), with the same queue and audit trail.
 */
import { explore } from "./api";

interface LabCase {
  id: string;
  kind: "lineage" | "question";
  group: string;
  title: string;
  query: string;
  expect: string;
}

interface HistoryRow {
  query_id: string;
  query: string;
  asked_at: string;
  mode: string;
  answered: boolean;
  verdict: string | null;
  has_evidence: boolean | null;
  latency_ms: number | null;
  citation_doc_ids: string[] | null;
  error: string | null;
}

type Log = (text: string, level?: "info" | "warn" | "error") => void;

const HISTORY_POLL_MS = 15_000;

const STYLE = `
#lab { position: fixed; left: 12px; bottom: 12px; z-index: 11; width: 360px; max-height: 46vh;
  display: flex; flex-direction: column; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: linear-gradient(160deg, rgba(238,244,250,.86), rgba(186,200,215,.72));
  border: 1px solid rgba(40,66,90,.4); border-radius: 14px; backdrop-filter: blur(10px); color: #12222e; }
#lab header { display: flex; gap: 6px; padding: 8px 10px 6px; align-items: center; }
#lab header b { flex: 1; letter-spacing: .06em; text-transform: uppercase; color: #06707f; font-size: 11px; }
#lab header button { font: inherit; border: 1px solid rgba(40,66,90,.35); background: rgba(255,255,255,.5);
  border-radius: 999px; padding: 2px 10px; cursor: pointer; }
#lab header button[aria-pressed="true"] { background: #06707f; color: #f3f9fc; border-color: #06707f; }
#lab .body { overflow: auto; padding: 0 10px 10px; }
#lab .group { margin: 8px 0 2px; color: #3a5569; font-size: 11px; }
#lab .item { display: block; width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer;
  padding: 6px 8px; margin: 3px 0; border-radius: 8px; border: 1px solid rgba(40,66,90,.2); background: rgba(255,255,255,.55); }
#lab .item:hover { background: rgba(255,255,255,.85); }
#lab .item small { display: block; color: #3a5569; }
#lab .tag { float: right; font-size: 10px; padding: 0 6px; border-radius: 999px; background: #c9d6e2; }
#lab .tag.PASS { background: #bfe3cc; } #lab .tag.WARN { background: #f2dfae; }
#lab .tag.FAIL, #lab .tag.ERR { background: #f0c2c8; }
#lab .note { color: #3a5569; padding: 6px 2px; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json() as Promise<T>;
}

export function startLabPanel(log: Log): void {
  if (document.getElementById("lab")) return;
  document.head.appendChild(el("style", {}, STYLE));
  const root = el("section", { id: "lab", "aria-label": "Use cases and history" });
  const header = el("header");
  const title = el("b", {}, "Lab");
  const casesBtn = el("button", { "aria-pressed": "true" }, "Casos");
  const historyBtn = el("button", { "aria-pressed": "false" }, "Historial");
  const hideBtn = el("button", { title: "Ocultar / mostrar" }, "–");
  header.append(title, casesBtn, historyBtn, hideBtn);
  const body = el("div", { class: "body" });
  root.append(header, body);
  document.body.appendChild(root);

  let tab: "cases" | "history" = "cases";
  let cases: LabCase[] = [];
  let history: HistoryRow[] = [];
  let note = "";

  async function ask(query: string, label: string): Promise<void> {
    try {
      const { query_id } = await explore(query);
      note = `enviado: ${label} → ${query_id}`;
      log(`asked lab: ${label} → ${query_id}`.slice(0, 70));
    } catch (error) {
      note = `no se pudo preguntar: ${(error as Error).message}`;
      log(note.slice(0, 70), "error");
    }
    render();
  }

  async function loadLineage(): Promise<void> {
    note = "cargando el linaje…";
    render();
    try {
      const r = await getJson<{ query_id: string; historical: number; alternatives: number }>("/lab/lineage", { method: "POST" });
      note = `linaje: ${r.historical} hitos citados, ${r.alternatives} caminos alternativos en revisión (${r.query_id})`;
      log(`lineage loaded: ${r.alternatives} branches queued for review`);
    } catch (error) {
      note = `linaje no disponible: ${(error as Error).message}`;
      log(note.slice(0, 70), "error");
    }
    render();
  }

  function renderCases(): void {
    let group = "";
    for (const c of cases) {
      if (c.group !== group) {
        group = c.group;
        body.append(el("div", { class: "group" }, group));
      }
      const item = el("button", { class: "item", title: c.query });
      item.append(document.createTextNode(c.title), el("small", {}, `Correcto si: ${c.expect}`));
      item.onclick = () => (c.kind === "lineage" ? loadLineage() : ask(c.query, c.id));
      body.append(item);
    }
  }

  function renderHistory(): void {
    if (!history.length) body.append(el("div", { class: "note" }, "Sin preguntas todavía."));
    for (const h of history) {
      const tagText = h.error ? "ERR" : h.verdict || (h.answered ? "OK" : "…");
      const item = el("button", { class: "item", title: "Volver a preguntar" });
      const when = h.asked_at ? new Date(h.asked_at).toLocaleTimeString() : "";
      const facts = [
        when,
        h.mode,
        h.has_evidence === false ? "sin evidencia" : h.citation_doc_ids?.length ? `${h.citation_doc_ids.length} citas` : "",
        h.latency_ms ? `${(h.latency_ms / 1000).toFixed(1)} s` : "",
        h.error ? h.error.slice(0, 60) : "",
      ].filter(Boolean);
      item.append(el("span", { class: `tag ${tagText}` }, tagText), document.createTextNode(h.query),
        el("small", {}, facts.join(" · ")));
      item.onclick = () => ask(h.query, "historial");
      body.append(item);
    }
  }

  function render(): void {
    body.replaceChildren();
    casesBtn.setAttribute("aria-pressed", String(tab === "cases"));
    historyBtn.setAttribute("aria-pressed", String(tab === "history"));
    if (note) body.append(el("div", { class: "note" }, note));
    if (tab === "cases") renderCases();
    else renderHistory();
  }

  async function refreshHistory(): Promise<void> {
    try {
      history = (await getJson<{ queries: HistoryRow[] }>("/lab/history?limit=30")).queries;
    } catch (error) {
      note = `historial no disponible: ${(error as Error).message}`;
    }
    if (tab === "history") render();
  }

  casesBtn.onclick = () => { tab = "cases"; render(); };
  historyBtn.onclick = () => { tab = "history"; render(); void refreshHistory(); };
  hideBtn.onclick = () => { body.hidden = !body.hidden; hideBtn.textContent = body.hidden ? "+" : "–"; };

  getJson<{ cases: LabCase[] }>("/lab/cases")
    .then((r) => { cases = r.cases; render(); })
    .catch((error) => { note = `casos no disponibles: ${(error as Error).message}`; render(); });
  // On its own timer, never in the render loop (see CLAUDE.md: a parked rAF must not stall it).
  setInterval(() => { if (tab === "history" && !body.hidden) void refreshHistory(); }, HISTORY_POLL_MS);
  render();
}
