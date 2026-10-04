"""Agent-side tool: `request_human_review`.

This is what the Omnigent safety/planner agent calls when a candidate needs a
human decision. It enqueues the candidate on the Gate API and blocks until a
reviewer in VR approves, rejects or defers it — so from the agent's point of
view the human gate is just a slow tool call.

Usage from an Omnigent tool definition:

    from agent_tool import request_human_review

    decision = request_human_review(
        candidate_id="it3-c07",
        mutation="S121E",
        rationale="...",
        esm_llr=1.84,
        iteration=3,
    )
    if decision["decision"] == "approve":
        ...

Run this file directly for an end-to-end check against a local Gate API.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

GATE_URL = os.environ.get("GATE_URL", "http://127.0.0.1:8000")
DEFAULT_TIMEOUT_S = float(os.environ.get("GATE_REVIEW_TIMEOUT_S", "1800"))
POLL_S = 2.0

TERMINAL = {"approved", "rejected", "deferred"}
STATUS_TO_DECISION = {
    "approved": "approve",
    "rejected": "reject",
    "deferred": "defer",
}


def request_human_review(
    candidate_id: str,
    mutation: str,
    rationale: str,
    *,
    esm_llr: float | None = None,
    rank_in_batch: int | None = None,
    iteration: int = 0,
    run_id: str = "run-001",
    citations: list[dict[str, str]] | None = None,
    flags: list[str] | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    gate_url: str = GATE_URL,
    on_wait: Any = None,
) -> dict:
    """Queue a candidate for human review in VR and block until decided.

    `mutation` is a label like "S121E". The Gate API fills in the distance to
    the active site from the structure file, so the agent does not have to.

    Returns {"decision": "approve"|"reject"|"defer", "candidate_id", "note",
    "reviewer", "timestamp"}. Raises TimeoutError if no human decides in time.
    """
    wt, pos, mut = mutation[0], int(mutation[1:-1]), mutation[-1]

    payload = {
        "candidate_id": candidate_id,
        "run_id": run_id,
        "iteration": iteration,
        "mutation": {"wt": wt, "pos": pos, "mut": mut, "label": mutation},
        "scores": {"esm_llr": esm_llr, "rank_in_batch": rank_in_batch},
        "rationale": rationale,
        "citations": citations or [],
        "flags": flags or [],
    }

    with httpx.Client(base_url=gate_url, timeout=30.0) as client:
        res = client.post("/queue", json=payload)
        if res.status_code == 409:
            # Already queued (agent retry) — fall through to waiting.
            pass
        else:
            res.raise_for_status()

        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            cand = client.get(f"/candidates/{candidate_id}").json()
            if cand["status"] in TERMINAL:
                return {
                    "candidate_id": candidate_id,
                    "mutation": mutation,
                    "decision": STATUS_TO_DECISION[cand["status"]],
                    "note": cand.get("note"),
                    "reviewer": cand.get("reviewer"),
                    "timestamp": cand.get("decided_at"),
                    "distance_to_active_site_A": cand.get("distance_to_active_site_A"),
                }
            if on_wait:
                on_wait(cand)
            time.sleep(POLL_S)

    raise TimeoutError(
        f"no human decision for {candidate_id} within {timeout_s:.0f}s"
    )


def decisions_for_run(run_id: str, gate_url: str = GATE_URL) -> list[dict]:
    """Audit trail for the research record."""
    with httpx.Client(base_url=gate_url, timeout=30.0) as client:
        return client.get("/decisions", params={"run_id": run_id}).json()["decisions"]


# Tool schema for registering with an agent framework (Omnigent / MCP / any
# JSON-schema tool caller).
REQUEST_HUMAN_REVIEW_SCHEMA = {
    "name": "request_human_review",
    "description": (
        "Pause the discovery loop and ask a human scientist to inspect a "
        "proposed point mutation in VR. Blocks until the reviewer approves, "
        "rejects or defers. Use when a candidate is flagged (near the active "
        "site, low model confidence, or contradicts prior evidence)."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "candidate_id": {"type": "string"},
            "mutation": {"type": "string", "description": "e.g. S121E"},
            "rationale": {"type": "string"},
            "esm_llr": {"type": "number"},
            "rank_in_batch": {"type": "integer"},
            "iteration": {"type": "integer"},
            "run_id": {"type": "string"},
            "flags": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["candidate_id", "mutation", "rationale"],
    },
}


if __name__ == "__main__":
    import sys

    label = sys.argv[1] if len(sys.argv) > 1 else "N233K"
    cid = sys.argv[2] if len(sys.argv) > 2 else f"demo-{int(time.time())}"

    print(f"[agent] requesting human review of {label} ({cid})")
    print("[agent] blocked — waiting for the reviewer in VR…")
    result = request_human_review(
        candidate_id=cid,
        mutation=label,
        rationale=(
            "Agent hypothesis: predicted to add a stabilising contact without "
            "contacting the catalytic triad. Flagged for human confirmation."
        ),
        esm_llr=1.55,
        rank_in_batch=1,
        iteration=4,
        flags=["agent_requested"],
        timeout_s=600,
        on_wait=lambda c: print("  …still pending", end="\r", flush=True),
    )
    print(f"\n[agent] decision: {result['decision']} by {result['reviewer']}")
    print(f"[agent] loop continues with {label} "
          f"{'included' if result['decision'] == 'approve' else 'excluded'}")
