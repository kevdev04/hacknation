# PETase Lab — VR

## What this project is

A 24-hour hackathon build for the **Hack-Nation × Databricks "Agentic Scientific
Discovery" challenge** (Omnigent required).

The science: an agentic lab that proposes **point mutations to PETase** (the
PET-plastic-degrading enzyme from *Ideonella sakaiensis*) to improve
thermostability without breaking catalytic activity. Agents orchestrated in
Omnigent read literature, propose mutations, score them (ESM-2 zero-shot
log-likelihood ratio), and a planner picks what to evaluate next under a budget.
The measured outcome: how many candidates the lab must evaluate to recover known
stabilizing mutations, compared with random search.

**This repo is the VR part**, and it does two jobs:

1. **The approval gate (built).** When the safety/planner agent flags a
   candidate, the loop pauses until a human decides. The decision goes back to
   the agents. This is the direction that earns the judging weight.
2. **The console (built).** The scientist asks the lab a question out loud and
   the answer builds the molecule in front of them — the structure redraws to
   whatever the answer is about. This turns the human from a reviewer into a
   participant: they steer what gets searched, not just veto it.

The gate is why the VR is in the architecture. The console is what makes it
worth wearing.

> Judging weights, for prioritization: 30% Omnigent orchestration, 25%
> breakthrough potential, 20% discovery acceleration, 15% scientific rigor, 10%
> creativity/responsibility. **Never cut the decision feeding back into the
> loop** — that is the whole point of the VR being in the architecture.

---

## Status — what exists and is verified

Everything below was built and tested end to end. A new session should read this
before changing anything.

### Working

- **Gate API** (`gate/main.py`, FastAPI on `:8000`) — full contract below.
  State is two JSON files in `gate/state/`, so the audit trail is readable by
  hand and survives a restart.
- **Structure measurement** (`gate/structure.py`) — the backend measures each
  candidate against the real PDB rather than trusting the agent: minimum
  heavy-atom distance to the catalytic triad, auto-flags `near_active_site`
  under 8 Å, and flags `wt_mismatch` when the agent's claimed wild-type residue
  disagrees with the structure.
- **Agent tool** (`gate/agent_tool.py`) — `request_human_review(...)` enqueues a
  candidate and **blocks** until a human decides. `REQUEST_HUMAN_REVIEW_SCHEMA`
  is the JSON schema to register with Omnigent. Verified: agent blocked, VR
  decided, agent resumed.
- **VR app** (`vr/`, three.js r186 + WebXR, Vite on `:5173`) — custom ATOM
  parser, cartoon ribbon from P-SEA secondary structure, rotamer-rebuilt side
  chains, liquid-glass CanvasTexture panels, grip-grab / stick-scale /
  trigger-pick, head-relative layout with one-press recentre. Four surfaces:
  **project** (left), **console** (below), **answer** (right), **control bar**
  (top). Desktop fallback: drag a handle to move a surface, drag background to
  orbit, click to press.
- **The ask → answer → model loop** — a spoken question is transcribed by the
  gate, wrapped in the format contract from `vr/src/prompt.ts`, and sent to the
  lab. The reply's fenced JSON block is parsed into an `AgentResult`
  (`vr/src/result.ts`) which drives both the answer panel's text and the
  molecule. A reply with no JSON block says so on the panel rather than quietly
  rendering nothing.
- **Experiments** — `GET/POST/DELETE /experiments`, stored in
  `gate/state/experiments.json`. An answer worth keeping is saved whole, so it
  can be reopened later and rebuilt in 3D exactly as it was.
- **Agent lab bridge** (`gate/bridge.py`) — consumes `WS /ws/explore` from the
  hack-databricks `ar_vr_bridge`, turns its nodes into candidates with real
  citations and computed validation, and relays decisions back to
  `POST /api/v1/approve/{id}`. The hand-written mock queue is gone: the bridge's
  own `mode: "mock"` covers running with no agents.

### Verified facts — do not re-derive these

- **Structure: RCSB 5XJH**, IsPETase, 1.54 Å, chain A, residues 30–292, 199 KB,
  served at `/structures/petase.pdb`.
- **Catalytic triad: S160, D206, H237** in this file's chain A numbering,
  confirmed against the ATOM records. Lives in `CONFIG` in `gate/main.py`,
  **never in the frontend**.
- 6EQE (0.92 Å) was rejected: alternate conformations on several residues
  including 121, more parser edge cases for no demo gain.
- Environment: Python 3.14, FastAPI 0.142, three r186, Vite 8, TypeScript 7,
  Node 22.

### Known gotchas, already paid for

- **The bridge and the gate both default to `:8000`.** Run the bridge on another
  port and point the gate at it with `BRIDGE_URL` (default
  `http://127.0.0.1:8010`). The bridge falls back to its mock when
  `agent_lab.runtime` is absent, so it runs with no Databricks credentials.
- **Their `request_approval()` is wired but nothing calls it yet.** Until the
  Safety Agent does, `gate/bridge.py::needs_review` is the policy that decides
  what reaches a human: agent-written nodes whose validation is WARN/FAIL or
  whose confidence is under 0.80. Retrieved evidence and measured rows are never
  gated — they are not opinions.
- **Quest Browser has no Web Speech API.** Verified on device: no
  `SpeechRecognition` (prefixed or not) and no `speechSynthesis`. It does have
  `getUserMedia` and `MediaRecorder` with opus/webm, so speech-to-text records
  in the browser and transcribes on the gate (`gate/voice.py`). `OPENAI_API_KEY`
  lives in the gate's environment, never in the frontend. Re-check with
  `/voice-probe.html`.
- **`npx -y metavr` fails** with `ENOTEMPTY` on this machine. Use the cached
  binary directly:
  `/Users/kevdev/.npm/_npx/f918dadf77c7f4aa/node_modules/.bin/metavr`
- **Queue polling must not live in the render loop.** A backgrounded tab or a
  sleeping headset parks `requestAnimationFrame`. It is on a `setInterval` in
  `vr/src/main.ts`; keep it there.
- **`adb reverse` does not survive headset sleep or an unplug.** Re-run it when
  the page stops loading.
- The USB debugging prompt appears *inside the headset* and is easy to miss.
- Device on hand: **Quest 3S**, serial `340YC10GBH103Q`.

---

## The combination bench — cut, and why

An earlier design had the reviewer stack mutations into a variant on a bench
panel and watch an additive estimate update. **That is gone.** It was replaced
by the console: the reviewer asks the lab a question in words, and the lab
answers with a result that builds the molecule. The bench put the human in the
role of a worse search algorithm; the console puts them in the role of the one
asking what to search.

The files are still on disk and unreferenced (`bench.ts`, `benchPanel.ts`,
`residueCard.ts`, `panel.ts`, `logPanel.ts`, `metrics.ts`, `scan.ts`) in case
any of it is wanted back. Nothing imports them.

**The tier discipline survives the cut and is not negotiable.** Every number
carries where it came from:

| Tier | What it is | Latency | How it's labelled in-world |
|---|---|---|---|
| `lookup` | Precomputed ESM-2 LLR for every single mutant (263 positions × 19 substitutions ≈ 5k values, one offline pass, ~100 KB JSON) | instant | plain number |
| `estimate` | Additive sum of the single-mutant LLRs for a combination | instant | **"additive estimate — ignores epistasis"** |
| `measured` | Real ESM-2 score of the full combined sequence, computed as a job | seconds | plain number, replaces the estimate when it lands |
| `predicted` | A model said so, with no measurement behind it | — | **"model prediction"** |

An estimate is *wrong in a specific, nameable way*, and naming it is worth more
under "scientific rigor" than a prettier number would be. `TIER_LABEL` in
`vr/src/answerPanel.ts` is where each tier gets its words; an `estimate` reads
"estimate · ignores interaction" and a `predicted` reads "model prediction".
When a measured number arrives and disagrees with an estimate, **show both** —
that gap is the interesting result, not an error to hide.

### Structural signals that are free and instant

These come from the PDB with no model at all, and are what let the viewer check
the lab rather than take its word:

- **Distance to the active site** per mutation (implemented, `gate/structure.py`).
- **Wild-type check** — the structure is the authority on what residue is at a
  position, so a claimed `wt` that disagrees is flagged (`wt_mismatch`).
- **Disulfides** — detected from the file (SG–SG under 2.5 Å), never declared by
  the backend. In 5XJH: Cys203–Cys239 (2.12 Å) and Cys273–Cys289 (2.05 Å).
- **Secondary structure** — P-SEA from CA positions alone, used for the cartoon
  and for `color: "secondary_structure"`. Gives 28% helix / 18% strand here,
  which is what an α/β hydrolase should look like.
- **Burial** — neighbours within 10 Å as a cheap proxy for buried vs surface.

### Interaction model in VR

- **Ask** — hold the console button (or left Y) and speak. The transcript is
  shown *before* anything is sent, so a misheard question can be discarded.
- **Send** — the question goes to the lab wrapped in the format contract from
  `vr/src/prompt.ts`. A bare question gets prose back, and prose renders as
  nothing in the middle of the room.
- **Read** — the answer panel opens brief and expands with *Review in depth*:
  every metric with its tier, every citation with the sentence it rests on, and
  a plain-language list of what the molecule was told to draw.
- **Watch the molecule** — the structure repaints to the answer's `view`.
  Highlights recolour the ribbon itself; side chains are drawn only where the
  chemistry is the point. Never two models stacked on each other.
- **Keep it** — *Save current answer* writes the whole result to the gate, so it
  can be reopened later and rebuilt in 3D exactly as it was.
- **Move anything** — every surface and the molecule carry a white grab bar.
  Recentre puts the whole workspace back in front of you.
- The gate stays. A flagged candidate lands in the run log and is decided with
  `1` / `2` / `3` — thin, but losing the human's half of the loop is not an
  option.

### Multiple enzymes

`CONFIG` should become a registry keyed by protein, not a single structure, so
LCC and MHETase can be added later. **Active-site numbering must be re-verified
against each new PDB file** — it differs per structure and getting it wrong
invalidates every distance on screen. Only IsPETase/5XJH is verified today.

---

## Architecture

```
Omnigent agents (Python)          Agent lab bridge (hack-databricks, :8010)
   │  request_human_review()         │  WS /ws/explore  → stage/node/citations/
   │  ▲ human variants re-enter      │     validation/approval_request/done
   ▼  │                              ▼  ▲ POST /api/v1/approve/{id}
Gate API (FastAPI, :8000)  ◄── poll / POST ──  VR app (WebXR, :5173)
   │  candidates.json + decisions.json = audit trail
   ▼
agents read the decision and continue
```

Two agent sources feed the same queue. `gate/bridge.py` consumes the bridge's
event stream and translates it into candidates; the VR app cannot tell them
apart and still talks only to the Gate API.

- The VR app **never talks to Omnigent directly**. Only the Gate API. This keeps
  VR buildable in parallel against the mock queue.
- The Gate API is the boundary and the place where structure truth lives
  (distances, triad numbering, wild-type checks).

---

## Data contracts

### Candidate (GET from Gate API)

`kind` is `mutation` when a residue can be measured against the structure, and
`claim` when the lab asserted something with no residue in it — same decision,
same audit trail, no geometry. `source` is `mock` or `bridge`.

```json
{
  "candidate_id": "it3-c07",
  "run_id": "run-001",
  "iteration": 3,
  "kind": "mutation",
  "source": "bridge",
  "protein_id": "IsPETase",
  "pdb_url": "/structures/petase.pdb",
  "chain": "A",
  "mutation": { "wt": "S", "pos": 121, "mut": "E", "label": "S121E" },
  "scores": { "esm_llr": 1.84, "rank_in_batch": 2 },
  "distance_to_active_site_A": 9.3,
  "nearest_active_site_residue": 160,
  "active_site_residues": [160, 206, 237],
  "rationale": "Agent-generated hypothesis: ...",
  "citations": [{ "title": "...", "url": "..." }],
  "flags": ["near_active_site"],
  "status": "pending_review",
  "validation": { "verdict": "WARN", "confidence": 0.68, "checks": [
    { "name": "overfit_gap", "passed": false, "value": 0.09, "threshold": 0.05 }
  ]},
  "claim": { "headline": "...", "node_type": "hypothesis", "confidence": 0.71,
             "agent_generated": true, "props": [] },
  "approval_id": "ap_3c1d"
}
```

`validation` comes from the lab and is **computed, never asserted by an LLM** —
each check carries the threshold it was tested against, and the panel shows both.
`approval_id` is present only when the lab's own Safety Agent is blocked on the
answer; a decision on such a candidate is relayed to
`POST /api/v1/approve/{id}` as well as logged.

`rationale` is an **agent-generated hypothesis** and is labelled as such in the
UI ("AGENT HYPOTHESIS — NOT VERIFIED"). Keep that labelling on anything a model
wrote.

### Decision (POST to Gate API)

```json
{
  "candidate_id": "it3-c07",
  "decision": "approve",
  "note": "optional, short",
  "reviewer": "kevin",
  "timestamp": "2026-10-03T21:10:00Z"
}
```

`decision` is one of `approve | reject | defer`. The reviewer comes from
`?reviewer=` on the VR URL.

### Variant (designed, not built — kept for `POST /proposals`)

```json
{
  "variant_id": "bench-014",
  "protein_id": "IsPETase",
  "chain": "A",
  "mutations": ["S121E", "D186H", "R280A"],
  "score": { "tier": "estimate", "esm_llr": 3.47 },
  "epistasis_risk": [{ "pair": [121, 186], "distance_A": 7.2 }],
  "origin": "human",
  "proposed_by": "kevin"
}
```

`tier` is `estimate` or `measured` and **must survive into the UI** — a number
that came from addition may never render like one that came from the model.
Nothing emits this shape today; it is the contract for sending a human-origin
candidate back into the loop.

### Endpoints

| Method | Path | Purpose | Status |
|---|---|---|---|
| GET | `/queue` | candidates with `status = pending_review` | built |
| GET | `/candidates/{id}` | one candidate | built |
| POST | `/queue` | agent enqueues a candidate for review | built |
| POST | `/decisions` | submit a decision | built |
| GET | `/decisions?run_id=` | audit trail for the research record | built |
| GET | `/structures/{file}` | static PDB files | built |
| GET | `/config` | protein registry, triad numbering | built |
| GET | `/experiments` | saved experiments, newest first | built |
| POST | `/experiments` | keep an answer in the project record | built |
| DELETE | `/experiments/{id}` | drop one | built |
| GET | `/scan?protein=&chain=` | precomputed single-mutant LLR matrix | **next** |
| GET | `/contacts?protein=&chain=` | residue pairs within 8 Å | **next** |
| POST | `/variants/score` | queue real scoring of a combination | **next** |
| GET | `/variants/{id}` | scoring result | **next** |
| POST | `/proposals` | human-proposed variant into the agent loop | **next** |
| GET | `/bridge/health` | is the agent lab bridge reachable | built |
| POST | `/bridge/explore` | ask the lab a question; reviewable nodes enter the queue | built |
| GET | `/bridge/runs` | live stage/progress of each exploration | built |
| GET | `/voice/health` | is transcription configured on the gate | built |
| POST | `/voice/ask` | upload a spoken question, transcribe, start a run | built |

Polling every 2 s is fine. Don't add WebSockets unless everything else works.

---

## Stack

- **Frontend:** Vite + TypeScript + three.js r186, WebXR. No Unity, no APK, no
  sideloading. Runs in the Quest browser.
- **Backend:** FastAPI (same language as the agents). JSON files for state.
- **Structure data:** PDB served by the backend; numbering verified against the
  file, never assumed.

### Rendering rules (Quest 3S has little headroom)

- Backbone as one tube: CA atoms → `CatmullRomCurve3` → `TubeGeometry`, vertex
  coloured. **Build it once per structure and never rebuild it on interaction** —
  only the highlight groups change.
- Never one mesh per atom. One `InstancedMesh` for spheres, one for bond
  cylinders, for the handful of residues shown in full detail.
- Cap simultaneously detailed residues (~8–10). A ten-mutation variant with every
  side chain drawn is still fine instanced; a hundred separate meshes is not.
- No allocation in the render loop. Label textures are built on change, not per
  frame.
- `renderer.xr.setFoveation(0.5)` is set; keep it.
- three.js has a `PDBLoader` in `examples/jsm/loaders/` — **don't use it**. It
  gives atoms and bonds but no residue numbering, which is the only thing a
  mutation review cares about. `vr/src/protein.ts` parses ATOM records directly.

---

## Repo layout

```
gate/
  main.py              FastAPI Gate API — the only thing VR talks to
  structure.py         PDB parsing, distance measurement, wild-type checks
  agent_tool.py        request_human_review — the blocking agent-side tool
  bridge.py            client for the agent lab's event stream
  data/petase.pdb      5XJH
  state/               candidates.json + decisions.json (audit trail, gitignored)
vr/
  src/main.ts          renderer, XR session, layout, the ask → answer loop
  src/prompt.ts        the format contract sent with every question + parser
  src/result.ts        AgentResult — the one shape text and 3D both read
  src/projectPanel.ts  left: questions / saved experiments / run log
  src/console.ts       below: greeting, push-to-talk, send
  src/answerPanel.ts   right: brief answer + review in depth
  src/controlBar.ts    top: status and recentre
  src/protein.ts       PDB parser → cartoon ribbon + side-chain sticks
  src/rotamer.ts       rebuild a side chain as the residue it would become
  src/highlight.ts     active site / labels / pick marker
  src/input.ts         controller ray, grab/scale
  src/voice.ts         record in the headset, transcribe on the gate
  src/api.ts           Gate API client
dev.sh                 gate + vite + adb reverse, one command
```

---

## Dev setup

```bash
./dev.sh                     # gate :8000 + vite :5173 + adb reverse
open http://localhost:5173/?reviewer=kevin
```

**Headset:** USB-C to the Mac, accept the in-headset debugging prompt,
`adb devices` to confirm, then open `http://localhost:5173/?reviewer=kevin` in
the Quest browser and press *enter mixed reality*. WebXR needs a secure context;
`localhost` over `adb reverse` counts as one, which is why USB is the primary
route. Untethered: `cloudflared tunnel --url http://localhost:5173` plus
`TUNNEL=1 npm run dev` (Vite rejects unknown Host headers otherwise), or wireless
adb via `adb tcpip 5555`.

Only port 5173 needs forwarding — Vite proxies `/queue`, `/decisions`,
`/experiments`, `/structures`, `/config`, `/bridge` and `/voice` to the gate, so
there is one origin and no CORS. **A new gate route needs adding to `paths` in
`vr/vite.config.ts`**, or the dev server answers it with `index.html` and a 200.

Iterate on desktop first with Meta's Immersive Web Emulator extension.

### Deploying (if the agents move off the laptop)

The frontend deploys to Vercel as a static build with no changes. **The Gate API
does not** — Vercel functions are stateless, so `gate/state/*.json` would not
survive. It needs Redis or Postgres behind the four storage functions in
`main.py` (`load_candidates`, `save_candidates`, `load_decisions`, `_write`),
about an hour of work. Only worth it if Omnigent runs somewhere that cannot
reach `127.0.0.1` — which is the real argument for doing it, since a public gate
URL is what lets Databricks-hosted agents call the human gate.

---

## Milestones for the next session

The loop is closed: ask → lab → answer → molecule → saved experiment, with the
gate still able to stop the agents. What is left, in order of what the demo
gains:

1. **Make the lab answer in the contract.** `vr/src/prompt.ts` is sent with
   every question, but nothing on the lab side enforces it. Until a real reply
   comes back with a JSON block, the answer panel falls back to prose and says
   so. This is the one thing that turns the whole thing on.
2. **Reopen a saved experiment in 3D** — the result is stored whole, the
   rebuild path exists; it needs a pass with real saved data.
3. **A flagged candidate deserves better than a keypress.** A small approve /
   reject / defer strip on the console when the queue is non-empty.
4. **`POST /proposals`** — let the reviewer send a result back as a
   human-origin candidate. The strongest remaining beat: the human changes what
   the agents search next.
5. **Multiple enzymes.** `CONFIG` becomes a registry keyed by protein so LCC and
   MHETase can be added. **Active-site numbering must be re-verified against
   each new PDB file** — only IsPETase/5XJH is verified today.

**Cut list if behind:** multiple enzymes → reopening experiments in 3D → the
console decision strip. **Never cut** the gate decisions or the format contract
travelling with the question — those are the two directions of the loop.

---

## Rules for working in this repo

- Keep the Gate API contract stable; if it must change, update this file first.
- **Active-site numbering comes from the backend config and is verified against
  the actual PDB file.** Never hardcode it in the frontend, never assume it
  carries across structures.
- Agent-generated content is always labelled as such in the UI.
- **Never present an additive estimate as a model score.** The tier is part of
  the data and part of the display.
- Every decision is logged with timestamp and reviewer; the audit trail is a
  judging requirement.
- No secrets in the frontend.
- Prefer measuring something from the structure over asking a model for it — it
  is faster, it is checkable, and it catches agent hallucinations (`wt_mismatch`
  exists for exactly this reason).
