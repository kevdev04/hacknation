# PETase Lab — VR Approval Gate

The human approval gate inside an agentic discovery loop. When the safety /
planner agent flags a proposed PETase point mutation, the loop **blocks**; a
scientist in a Quest 3S inspects the mutation in 3D and approves, rejects or
defers it; the decision goes back to the agents and changes the next iteration.

```
Omnigent agents (Python)
   │  request_human_review(candidate)   ← blocks
   ▼
Gate API (FastAPI, :8000)  ◄── poll / POST decision ──  VR app (WebXR, :5173)
   │  decisions.json = audit trail
   ▼
agents continue
```

## Run it

```bash
./dev.sh                     # gate api + vr dev server + adb reverse
open http://localhost:5173   # desktop
```

In the headset: connect over USB, run `adb reverse tcp:5173 tcp:5173`, open
`http://localhost:5173` in the Quest browser (localhost is a secure context, so
WebXR works without certificates), then press **enter mixed reality**. For the
LAN instead of USB: `HTTPS=1 npm run dev` in `vr/`.

Tag the reviewer in the URL — `?reviewer=kevin` — it is recorded on every
decision in the audit trail.

## Controls

| | |
|---|---|
| Grip | grab / rotate the protein |
| Thumbstick ↑↓ | scale |
| Trigger | pick a residue (shows name + number) |
| **A** / **B** / **X** | approve / reject / defer |
| Desktop | drag rotate, scroll zoom, click pick, `1` `2` `3` decide |

## What the reviewer sees

Backbone as a smooth tube coloured N→C, full atoms for the mutated residue
(gold) and the catalytic triad (teal), a dashed line between them labelled in
Å, and an in-world panel with the ESM-2 score, rank, flags, references, and the
agent's rationale explicitly marked **AGENT HYPOTHESIS — NOT VERIFIED**.

## Structure and numbering

`gate/data/petase.pdb` is RCSB **5XJH** (IsPETase, 1.54 Å). The catalytic triad
is **S160, D206, H237** in this file's chain A numbering — verified against the
ATOM records, and configured in `gate/main.py` (`CONFIG`), never in the
frontend. The Gate API measures each candidate's minimum heavy-atom distance to
the triad from the structure itself and flags anything under 8 Å as
`near_active_site`; it also flags `wt_mismatch` when the agent's claimed
wild-type residue disagrees with the structure.

## Gate API

| Method | Path | Purpose |
|---|---|---|
| GET | `/queue` | candidates with `status = pending_review` |
| GET | `/candidates/{id}` | one candidate |
| POST | `/queue` | agent enqueues a candidate for review |
| POST | `/decisions` | submit a decision |
| GET | `/decisions?run_id=` | audit trail for the research record |
| GET | `/structures/{file}` | static PDB files |

State is two JSON files under `gate/state/`, so the audit trail is readable by
hand and survives a restart.

## Agent side

```python
from agent_tool import request_human_review

decision = request_human_review(
    candidate_id="it3-c07", mutation="S121E",
    rationale="...", esm_llr=1.84, iteration=3, flags=["near_active_site"],
)   # blocks until a human decides in VR
```

`REQUEST_HUMAN_REVIEW_SCHEMA` in `gate/agent_tool.py` is the JSON schema to
register with Omnigent. Try the full round trip with no agents involved:

```bash
gate/.venv/bin/python gate/agent_tool.py S238F demo-1   # blocks
# …decide it in the headset, or:
curl -X POST localhost:8000/decisions -H 'content-type: application/json' \
  -d '{"candidate_id":"demo-1","decision":"reject","reviewer":"kevin"}'
```

## Layout

```
gate/
  main.py              FastAPI Gate API (the only thing VR talks to)
  structure.py         PDB parsing, distance measurement, wild-type checks
  agent_tool.py        request_human_review — the blocking agent-side tool
  bridge.py            client for the agent lab's event stream
  data/petase.pdb      5XJH
  state/               candidates.json + decisions.json (audit trail)
vr/
  src/main.ts          renderer, XR session, queue + decision flow
  src/protein.ts       PDB parser → backbone tube + instanced atoms
  src/highlight.ts     mutation / active site / distance callout
  src/panel.ts         in-world review panel (CanvasTexture)
  src/input.ts         controller ray, grab/scale, A/B/X buttons
  src/api.ts           Gate API client
```
