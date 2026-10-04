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
   candidate, the loop pauses. A scientist in a Quest 3S inspects the mutation in
   3D and approves, rejects or defers it. The decision goes back to the agents.
2. **The combination bench (next).** The scientist stacks several mutations into
   one variant and sees the predicted effect update as they go, then proposes the
   variant back to the agents. This turns the human from a reviewer into a
   participant — they can steer the search, not just veto it.

The gate is the part that earns the judging weight. The bench is what makes the
VR worth wearing.

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
  parser, backbone tube coloured N→C, instanced atoms for the mutation and the
  triad, dashed distance callout in Å, CanvasTexture panel, grip-grab /
  stick-scale / trigger-pick, A/B/X decisions, auto-advance, "Waiting for
  agents…" state. Desktop fallback: drag/scroll/click, `1` `2` `3` to decide.
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

## Where this is going: the combination bench

**Goal:** the scientist selects positions on the protein, picks substitutions,
stacks them into a candidate variant, and sees the predicted effect update
immediately — then sends the variant to the agents.

### The scoring problem, and the honest answer

Running ESM-2 inline is impossible at 72–90 fps. So numbers come in three tiers,
and **the UI must never blur them together**:

| Tier | What it is | Latency | How it's labelled in-world |
|---|---|---|---|
| `lookup` | Precomputed ESM-2 LLR for every single mutant (263 positions × 19 substitutions ≈ 5k values, one offline pass, ~100 KB JSON) | instant | plain number |
| `estimate` | Additive sum of the single-mutant LLRs for a combination | instant | **"additive estimate — ignores epistasis"** |
| `measured` | Real ESM-2 score of the full combined sequence, computed as a job | seconds | plain number, replaces the estimate when it lands |

The additive estimate is *wrong in a specific, nameable way*: it assumes
mutations don't interact. Saying so on the panel is worth more under "scientific
rigor" than a prettier number would be. When the measured score arrives and
disagrees with the estimate, **show both** — that gap is the interesting result,
not an error to hide.

### Structural signals that are free and instant

These come from the PDB with no model at all, and make the bench feel live:

- **Distance to the active site** per mutation (already implemented).
- **Epistasis risk** — if two selected positions are within ~8 Å of each other,
  the additive estimate is least trustworthy. Flag the pair visually, draw the
  line between them. This is the single highest-value addition: it tells the user
  *when to distrust the fast number*.
- **Burial** — count neighbours within 10 Å as a cheap proxy for buried vs
  surface. Surface positions are the usual thermostability targets.
- **Charge change** — substitutions that introduce a potential salt-bridge
  partner within range of an existing opposite charge.

Precompute the contact map (residue pairs within 8 Å) once from the PDB and
serve it; it is a few thousand sparse pairs.

### Interaction model in VR

- **Select** a residue with the controller ray (picking already works).
- **Substitute** via a radial menu of the 19 alternatives, each showing its
  lookup LLR so the good ones are visible before committing.
- **Stack** — chosen mutations become chips on a floating bench panel. Each chip
  carries its own LLR; the stack shows the additive total and any epistasis-risk
  pairs.
- **Toggle** a chip off and on to A/B compare instantly. This is the core loop
  of the bench and must stay under one frame.
- **Score it for real** — one button fires the measured-tier job; the estimate
  stays on screen until the real number replaces it.
- **Propose to the agents** — sends the variant into the loop as a human-origin
  candidate. This is the gate running in reverse and is the most valuable
  demo beat: the human changes what the agents search next.
- The gate inbox stays. From a flagged candidate, "load into bench" lets the
  reviewer explore around the agent's proposal instead of only judging it.

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

### Variant (new — the bench)

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

`tier` is `estimate` or `measured` and **must survive into the UI** — a variant
whose number came from addition may never render like one that came from the
model.

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
  src/main.ts          renderer, XR session, queue + decision flow
  src/protein.ts       PDB parser → backbone tube + instanced atoms
  src/highlight.ts     mutation / active site / distance callout / pick marker
  src/panel.ts         in-world review panel (CanvasTexture)
  src/input.ts         controller ray, grab/scale, A/B/X buttons
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
`/structures`, `/config` to the gate, so there is one origin and no CORS.

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

The gate is done. These build the bench, in order; stop where time runs out.

1. **Offline ESM-2 single-mutant scan** → `gate/data/scan_5XJH_A.json`, served
   at `GET /scan`. Without this nothing else is real-time.
2. **Contact map** → `GET /contacts`, for epistasis-risk flagging.
3. **Bench panel in VR** — select a residue, radial substitution menu showing
   per-substitution LLR, chips accumulate, additive total displayed **and
   labelled as an estimate**.
4. **Epistasis risk** — highlight close pairs, draw the line, warn on the panel.
5. **Toggle chips on/off** for instant A/B comparison. Must stay within a frame.
6. **`POST /variants/score`** — real combined scoring, estimate swaps to measured
   when it lands, both shown if they disagree.
7. **`POST /proposals`** — send the variant into the agent loop. This closes the
   human→agent direction and is the demo's strongest beat.
8. Polish: load-from-gate into bench, multiple enzymes, variant history.

**Cut list if behind:** multiple enzymes → variant history → measured tier (ship
estimate-only, clearly labelled) → radial menu (fall back to a fixed shortlist of
substitutions per position). **Never cut** the gate decisions (built) or
`POST /proposals` — those are the two directions of the loop.

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
