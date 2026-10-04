"""Gate API — the human approval gate between the agent loops and VR.

The VR app only ever talks to this service. Candidates arrive two ways: an
Omnigent agent calls `POST /queue` (or blocks on `gate/agent_tool.py`), or
`gate/bridge.py` derives them from the agent lab's event stream. Decisions go
back out of `GET /decisions`, and are relayed to the lab when it is blocked on
one.

State lives in two JSON files under ./state so the hackathon demo survives a
restart and the audit trail is inspectable by hand.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

# Secrets come from a .env the gate reads at import, before anything looks at
# os.environ. It lives at the repo root or beside this file — never under vr/,
# because Vite reads .env from its own root and will happily bake a
# VITE_-prefixed value into the client bundle.
def _load_env() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    here = Path(__file__).parent
    for candidate in (here.parent / ".env", here / ".env"):
        if candidate.exists():
            load_dotenv(candidate, override=False)


_load_env()

BASE = Path(__file__).parent
DATA = BASE / "data"
STATE = BASE / "state"
CANDIDATES_FILE = STATE / "candidates.json"
DECISIONS_FILE = STATE / "decisions.json"
EXPERIMENTS_FILE = STATE / "experiments.json"

# Catalytic triad of IsPETase as numbered in 5XJH chain A (verified against
# data/petase.pdb: S160, D206, H237). Backend config — never hardcode in the
# frontend.
CONFIG = {
    "protein_id": "IsPETase",
    "pdb_file": "petase.pdb",
    "pdb_url": "/structures/petase.pdb",
    "chain": "A",
    "active_site_residues": [160, 206, 237],
    "structure_id": "5XJH",
}

_lock = threading.Lock()

app = FastAPI(title="PETase Lab Gate API", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- models


class Mutation(BaseModel):
    wt: str
    pos: int
    mut: str
    label: str = ""


class Candidate(BaseModel):
    candidate_id: str
    run_id: str = "run-001"
    iteration: int = 0
    # "mutation" carries a residue the backend can measure against the PDB;
    # "claim" is an agent assertion reviewed on its evidence alone.
    kind: Literal["mutation", "claim"] = "mutation"
    protein_id: str = CONFIG["protein_id"]
    pdb_url: str = CONFIG["pdb_url"]
    chain: str = CONFIG["chain"]
    mutation: Mutation
    scores: dict[str, Any] = Field(default_factory=dict)
    distance_to_active_site_A: float | None = None
    nearest_active_site_residue: int | None = None
    active_site_residues: list[int] = Field(
        default_factory=lambda: list(CONFIG["active_site_residues"])
    )
    rationale: str = ""
    # Values are not all strings: the bridge's Citation carries an int year
    # and a float score alongside the text fields.
    citations: list[dict[str, Any]] = Field(default_factory=list)
    flags: list[str] = Field(default_factory=list)
    status: str = "pending_review"
    enqueued_at: str | None = None
    # Populated when the candidate came from the agent lab bridge.
    # A name the reviewer gave it, so a hypothesis can be referred to by
    # something other than the lab's own 48-character label.
    label: str | None = None
    source: str = "mock"
    claim: dict[str, Any] | None = None
    validation: dict[str, Any] | None = None
    approval_id: str | None = None


class Decision(BaseModel):
    candidate_id: str
    # "dismiss" is housekeeping, not science: it clears the queue without
    # claiming anything about the candidate. Still logged.
    decision: Literal["approve", "reject", "defer", "dismiss"]
    note: str | None = None
    reviewer: str = "unknown"
    timestamp: str | None = None


# ---------------------------------------------------------------- storage


def _read(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text() or "null") or default


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2))
    tmp.replace(path)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def load_candidates() -> list[dict]:
    return _read(CANDIDATES_FILE, [])


def save_candidates(items: list[dict]) -> None:
    _write(CANDIDATES_FILE, items)


def load_decisions() -> list[dict]:
    return _read(DECISIONS_FILE, [])


# ------------------------------------------------- structure enrichment


def enrich(cand: dict) -> dict:
    """Fill in geometry from the real PDB and sanity-check the wild-type
    residue the agent claims is at that position.

    Claims carry no residue, so there is nothing to measure and nothing to
    check — returning early keeps a text assertion from being reported with a
    distance it never had."""
    from structure import min_distance_to_active_site, residue_letter

    if cand.get("kind") == "claim" or not cand.get("mutation", {}).get("pos"):
        return cand

    pdb = str(DATA / CONFIG["pdb_file"])
    chain = cand.get("chain") or CONFIG["chain"]
    mut = cand["mutation"]
    pos = int(mut["pos"])

    if not mut.get("label"):
        mut["label"] = f"{mut['wt']}{pos}{mut['mut']}"

    actual = residue_letter(pdb, chain, pos)
    if actual is None:
        cand.setdefault("flags", []).append("position_not_in_structure")
    elif actual != mut["wt"]:
        mut["wt_in_structure"] = actual
        if "wt_mismatch" not in cand.setdefault("flags", []):
            cand["flags"].append("wt_mismatch")

    site = cand.get("active_site_residues") or CONFIG["active_site_residues"]
    found = min_distance_to_active_site(pdb, chain, pos, site)
    if found:
        dist, nearest = found
        cand["distance_to_active_site_A"] = round(dist, 1)
        cand["nearest_active_site_residue"] = nearest
        if dist < 8.0 and "near_active_site" not in cand.setdefault("flags", []):
            cand["flags"].append("near_active_site")
    return cand


# ---------------------------------------------------------------- routes


@app.get("/health")
def health() -> dict:
    items = load_candidates()
    return {
        "ok": True,
        "config": CONFIG,
        "candidates": len(items),
        "pending": sum(1 for c in items if c["status"] == "pending_review"),
        "decisions": len(load_decisions()),
    }


@app.get("/config")
def get_config() -> dict:
    return CONFIG


@app.get("/queue")
def get_queue(run_id: str | None = None) -> dict:
    items = [c for c in load_candidates() if c["status"] == "pending_review"]
    if run_id:
        items = [c for c in items if c.get("run_id") == run_id]
    items.sort(key=lambda c: (c.get("iteration", 0), c["candidate_id"]))
    return {"count": len(items), "candidates": items}


@app.get("/candidates/{candidate_id}")
def get_candidate(candidate_id: str) -> dict:
    for c in load_candidates():
        if c["candidate_id"] == candidate_id:
            return c
    raise HTTPException(404, f"no candidate {candidate_id}")


@app.post("/queue")
def enqueue(candidate: Candidate) -> dict:
    """Agent side: add a candidate that needs human review."""
    with _lock:
        items = load_candidates()
        if any(c["candidate_id"] == candidate.candidate_id for c in items):
            raise HTTPException(409, "candidate_id already queued")
        cand = candidate.model_dump()
        cand["status"] = "pending_review"
        cand["enqueued_at"] = _now()
        cand = enrich(cand)
        items.append(cand)
        save_candidates(items)
    return cand


@app.post("/decisions")
def post_decision(decision: Decision) -> dict:
    status_map = {
        "approve": "approved",
        "reject": "rejected",
        "defer": "deferred",
        "dismiss": "dismissed",
    }
    with _lock:
        items = load_candidates()
        target = next(
            (c for c in items if c["candidate_id"] == decision.candidate_id), None
        )
        if target is None:
            raise HTTPException(404, f"no candidate {decision.candidate_id}")

        record = decision.model_dump()
        record["timestamp"] = record.get("timestamp") or _now()
        record["run_id"] = target.get("run_id")
        record["iteration"] = target.get("iteration")
        record["mutation_label"] = target["mutation"].get("label")

        target["status"] = status_map[decision.decision]
        target["decided_at"] = record["timestamp"]
        target["decision"] = decision.decision
        target["reviewer"] = decision.reviewer
        if decision.note:
            target["note"] = decision.note

        save_candidates(items)
        log = load_decisions()
        log.append(record)
        _write(DECISIONS_FILE, log)

    # A candidate that came from the agent lab's own approval gate has an agent
    # blocked on it, so the decision has to travel back out, not just be logged.
    if target.get("approval_id"):
        import bridge

        relay = bridge.send_decision(target["approval_id"], decision.decision)
        record["relayed_to_bridge"] = relay
        with _lock:
            log = load_decisions()
            if log:
                log[-1] = record
                _write(DECISIONS_FILE, log)

    remaining = sum(1 for c in items if c["status"] == "pending_review")
    return {"ok": True, "decision": record, "pending_remaining": remaining}


class LabelPatch(BaseModel):
    label: str


@app.post("/candidates/{candidate_id}/label")
def set_label(candidate_id: str, patch: LabelPatch) -> dict:
    """Name a candidate. Renaming is not a decision and is not logged as one —
    it only changes how the thing is referred to."""
    name = patch.label.strip()[:80]
    with _lock:
        items = load_candidates()
        target = next((c for c in items if c["candidate_id"] == candidate_id), None)
        if target is None:
            raise HTTPException(404, f"no candidate {candidate_id}")
        target["label"] = name or None
        save_candidates(items)
    return {"ok": True, "candidate_id": candidate_id, "label": target["label"]}


@app.get("/decisions")
def get_decisions(run_id: str | None = None, candidate_id: str | None = None) -> dict:
    log = load_decisions()
    if run_id:
        log = [d for d in log if d.get("run_id") == run_id]
    if candidate_id:
        log = [d for d in log if d.get("candidate_id") == candidate_id]
    return {"count": len(log), "decisions": log}


@app.get("/structures/{filename}")
def get_structure(filename: str) -> FileResponse:
    path = (DATA / filename).resolve()
    if not path.is_file() or DATA.resolve() not in path.parents:
        raise HTTPException(404, "no such structure")
    return FileResponse(path, media_type="chemical/x-pdb")


# ------------------------------------------------------------ agent bridge

_runs: dict[str, Any] = {}


class ExploreRequest(BaseModel):
    query: str
    mode: Literal["live", "mock"] = "mock"


def _accept_candidate(cand: dict) -> None:
    """Called from the bridge thread as each reviewable node arrives."""
    with _lock:
        items = load_candidates()
        if any(c["candidate_id"] == cand["candidate_id"] for c in items):
            return
        cand["enqueued_at"] = _now()
        items.append(enrich(Candidate(**cand).model_dump()))
        save_candidates(items)


@app.get("/bridge/health")
def bridge_health() -> dict:
    import bridge

    return {"bridge_url": bridge.BRIDGE_URL, **bridge.health()}


@app.post("/bridge/explore")
def bridge_explore(request: ExploreRequest) -> dict:
    """Ask the agent lab a question. Nodes it is not confident about arrive in
    the review queue while the loop is still running."""
    import bridge

    run = bridge.start_run(
        request.query,
        request.mode,
        CONFIG,
        on_candidate=_accept_candidate,
        on_update=lambda r: _runs.__setitem__(r.query_id, r),
    )
    _runs[run.query_id] = run
    return {"ok": True, "query_id": run.query_id, "stage": run.stage}


# ----------------------------------------------------------- experiments


class Experiment(BaseModel):
    """A question and the answer worth keeping.

    Saved deliberately by the reviewer, so the project record is what a human
    judged worth keeping rather than everything that was ever asked.
    """

    experiment_id: str = ""
    query: str
    query_id: str | None = None
    headline: str = ""
    kind: str = ""
    # The whole AgentResult, so an experiment can be reopened and rebuilt in 3D
    # exactly as it was, not just read as text.
    result: dict[str, Any] | None = None
    note: str | None = None
    saved_by: str = "unknown"
    saved_at: str | None = None


def load_experiments() -> list[dict]:
    return _read(EXPERIMENTS_FILE, [])


@app.get("/experiments")
def get_experiments(saved_by: str | None = None) -> dict:
    items = load_experiments()
    if saved_by:
        items = [e for e in items if e.get("saved_by") == saved_by]
    items.sort(key=lambda e: e.get("saved_at") or "", reverse=True)
    return {"count": len(items), "experiments": items}


@app.post("/experiments")
def save_experiment(experiment: Experiment) -> dict:
    record = experiment.model_dump()
    record["saved_at"] = record.get("saved_at") or _now()
    if not record.get("experiment_id"):
        record["experiment_id"] = f"exp-{len(load_experiments()) + 1:03d}"
    with _lock:
        items = load_experiments()
        items.append(record)
        _write(EXPERIMENTS_FILE, items)
    return {"ok": True, "experiment": record}


@app.delete("/experiments/{experiment_id}")
def delete_experiment(experiment_id: str) -> dict:
    with _lock:
        items = load_experiments()
        kept = [e for e in items if e.get("experiment_id") != experiment_id]
        if len(kept) == len(items):
            raise HTTPException(404, f"no experiment {experiment_id}")
        _write(EXPERIMENTS_FILE, kept)
    return {"ok": True, "removed": experiment_id, "remaining": len(kept)}


# ---------------------------------------------------------------- voice


@app.get("/voice/health")
def voice_health() -> dict:
    """Whether the gate can transcribe, so the viewer can grey out the button
    instead of letting someone record into a void."""
    import voice

    return {"configured": voice.configured(), "model": voice.MODEL}


@app.post("/voice/ask")
async def voice_ask(
    audio: UploadFile = File(...),
    mode: str = Form("mock"),
    explore: bool = Form(True),
) -> dict:
    """Transcribe a spoken question and, unless told otherwise, send it straight
    to the agent lab. One round trip from the headset: speak, and candidates
    start arriving."""
    import voice

    payload = await audio.read()
    try:
        result = voice.transcribe(payload, audio.filename or "speech.webm")
    except voice.TranscriptionError as err:
        raise HTTPException(err.status, err.message) from err

    query = result["text"]
    if not query:
        return {"ok": False, "text": "", "reason": "nothing recognised in the audio"}

    response: dict = {"ok": True, **result}
    if explore:
        import bridge

        run = bridge.start_run(
            query,
            mode if mode in ("live", "mock") else "mock",
            CONFIG,
            on_candidate=_accept_candidate,
            on_update=lambda r: _runs.__setitem__(r.query_id, r),
        )
        _runs[run.query_id] = run
        response["query_id"] = run.query_id
    return response


@app.get("/bridge/runs")
def bridge_runs() -> dict:
    """Live status of every exploration, newest first — this is what turns the
    9-13 s loop into visible progress instead of a frozen panel."""
    runs = [r.snapshot() for r in _runs.values()]
    runs.sort(key=lambda r: r["finished"])
    return {"count": len(runs), "runs": runs}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
