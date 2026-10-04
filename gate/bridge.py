"""Client for the agent lab bridge (hack-databricks `ar_vr_bridge`).

The VR app still only ever talks to the Gate API; this module is what the Gate
API talks to. It opens `WS /ws/explore`, consumes the event stream, and turns it
into candidates in our own contract, so the headset sees real agent output with
real citations rather than hand-written ones.

Two things the bridge gives us that we had to invent before:

* **Citations with provenance.** `doc_id`, `doi`, `url` and the `snippet` that
  actually supports the claim, against a corpus of ~4.9k documents.
* **Validation that was computed, not asserted.** `Check` rows carry a value and
  the threshold it was tested against, which is exactly what the review panel
  should be showing a human.

What it does *not* give us is a per-position mutation score — there is no ESM in
that project, by design. So a node only becomes a full structural review when a
mutation token can be read off it; otherwise it is reviewed as a claim.

Their `request_approval()` is wired but nothing calls it yet, so the gate applies
its own review policy (see `needs_review`) and routes a decision back through
`POST /api/v1/approve/{id}` when an approval id is present.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import uuid
from typing import Any, Callable, Iterable

BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://127.0.0.1:8010")
# Databricks Apps sit behind OAuth and cannot be made public, so a deployed
# bridge needs a bearer token on every call — including the WebSocket
# handshake. Empty when the lab runs locally, where no auth is involved.
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "").strip()


_workspace = None


def _sdk_headers() -> dict[str, str] | None:
    """Ask the Databricks SDK for a fresh header, or None if it cannot.

    The SDK caches the token and refreshes it when it expires, so calling this on
    every request costs nothing and never goes stale.
    """
    global _workspace
    try:
        from databricks.sdk import WorkspaceClient
    except ImportError:
        return None
    if _workspace is None:
        profile = os.environ.get("DATABRICKS_CONFIG_PROFILE", "hack")
        try:
            _workspace = WorkspaceClient(profile=profile)
        except Exception:  # noqa: BLE001 - no profile configured, fall back
            return None
    try:
        return _workspace.config.authenticate()
    except Exception:  # noqa: BLE001 - expired login, fall back
        return None


def auth_headers() -> dict[str, str]:
    """Authorization header, minted fresh on every call.

    Databricks Apps reject personal access tokens and only accept OAuth user
    tokens, which expire in about an hour. A fixed `BRIDGE_TOKEN` in `.env`
    therefore stops working mid-demo — and because it was read once at import,
    replacing it needed a process restart. Measured against the deployed app:
    every health check turned into a 302 to OAuth an hour after the token was
    issued, which looks exactly like the bridge being down.

    So the SDK is asked first; it refreshes on its own. That needs
    `databricks auth login --profile hack` on this machine, once.

    `BRIDGE_TOKEN` still works as a manual override, and is read at call time so
    a refreshed `.env` no longer needs a restart. Empty means no auth at all,
    which is the case when the lab runs locally.
    """
    if headers := _sdk_headers():
        return headers
    token = os.environ.get("BRIDGE_TOKEN", "").strip() or BRIDGE_TOKEN
    return {"Authorization": f"Bearer {token}"} if token else {}

# Mutations as written in the literature: S121E, D186H, R280A.
MUTATION_RE = re.compile(r"\b([ACDEFGHIKLMNPQRSTVWY])(\d{1,4})([ACDEFGHIKLMNPQRSTVWY])\b")

# A claim is sent to a human when the lab is not confident in it. Their mock
# returns WARN with overfit_gap failing, which is exactly the case a reviewer
# should see rather than have silently accepted.
REVIEW_VERDICTS = {"WARN", "FAIL", "PENDING"}
REVIEW_CONFIDENCE = 0.80


def ws_url() -> str:
    return BRIDGE_URL.replace("https://", "wss://").replace("http://", "ws://") + "/ws/explore"


def find_mutation(*texts: str) -> dict | None:
    """First mutation token in any of `texts`, or None if the node is a claim."""
    for text in texts:
        if not text:
            continue
        match = MUTATION_RE.search(text)
        if match:
            wt, pos, mut = match.group(1), int(match.group(2)), match.group(3)
            return {"wt": wt, "pos": pos, "mut": mut, "label": f"{wt}{pos}{mut}"}
    return None


def needs_review(node: dict, validation: dict | None) -> bool:
    """The gate's own safety policy, standing in until their Safety Agent calls
    `request_approval`. Only model-written nodes are ever gated — measured rows
    and retrieved evidence are not opinions."""
    if not node.get("agent_generated"):
        return False
    if node.get("confidence", 1.0) < REVIEW_CONFIDENCE:
        return True
    verdict = (validation or {}).get("verdict")
    return verdict in REVIEW_VERDICTS


class Run:
    """One exploration: its live stage, the events it produced, and the
    candidates the gate derived from them."""

    def __init__(self, query: str, mode: str) -> None:
        self.query_id = f"q_{uuid.uuid4().hex[:8]}"
        self.query = query
        self.mode = mode
        self.stage = "received"
        self.progress = 0.0
        self.message = ""
        self.citations: list[dict] = []
        self.validation: dict | None = None
        self.answer: dict | None = None
        self.nodes: list[dict] = []
        self.latency_ms = 0
        self.next_question = ""
        self.error: str | None = None
        self.finished = False

    def snapshot(self) -> dict:
        return {
            "query_id": self.query_id,
            "query": self.query,
            "mode": self.mode,
            "stage": self.stage,
            "progress": self.progress,
            "message": self.message,
            "answer": self.answer,
            "validation": self.validation,
            "citations": self.citations,
            "latency_ms": self.latency_ms,
            "next_question": self.next_question,
            "error": self.error,
            "finished": self.finished,
        }


def candidate_from_node(
    run: Run,
    node: dict,
    config: dict,
    approval_id: str | None = None,
) -> dict:
    """Translate one bridge node into a Gate API candidate.

    A node carrying a mutation token becomes a structural review — the backend
    then measures it against the real PDB exactly as before, which is what
    catches an agent that invented a residue. A node without one becomes a claim
    review: same decision, same audit trail, no structure.
    """
    mutation = find_mutation(node.get("label", ""), node.get("detail", ""))
    kind = "mutation" if mutation else "claim"

    cited = set(node.get("citation_ids") or [])
    citations = [
        {
            "title": c.get("title", ""),
            "url": c.get("url", ""),
            "doc_id": c.get("doc_id", ""),
            "snippet": c.get("snippet", ""),
            "year": c.get("year"),
        }
        for c in run.citations
        if not cited or c.get("id") in cited
    ]

    candidate: dict[str, Any] = {
        "candidate_id": f"{run.query_id}-{node.get('id', uuid.uuid4().hex[:4])}",
        "run_id": run.query_id,
        "iteration": int(node.get("layer", 0)),
        "kind": kind,
        "protein_id": config["protein_id"],
        "pdb_url": config["pdb_url"],
        "chain": config["chain"],
        "active_site_residues": list(config["active_site_residues"]),
        # The bridge's own words, labelled as model-written wherever it says so.
        "rationale": node.get("detail") or node.get("label", ""),
        "claim": {
            "headline": node.get("label", ""),
            "node_type": node.get("type", ""),
            "confidence": node.get("confidence", 1.0),
            "agent_generated": bool(node.get("agent_generated")),
            "props": node.get("props") or [],
        },
        "citations": citations,
        "validation": run.validation,
        "scores": {"bridge_confidence": node.get("confidence", 1.0)},
        "flags": [],
        "status": "pending_review",
        "source": "bridge",
        "approval_id": approval_id,
    }

    if mutation:
        candidate["mutation"] = mutation
    else:
        # The contract keeps `mutation` required for structural review; a claim
        # carries a placeholder the UI never renders as a residue.
        candidate["mutation"] = {"wt": "", "pos": 0, "mut": "", "label": node.get("label", "")[:48]}

    if node.get("agent_generated"):
        candidate["flags"].append("agent_generated")
    verdict = (run.validation or {}).get("verdict")
    if verdict in REVIEW_VERDICTS:
        candidate["flags"].append(f"validation_{str(verdict).lower()}")
    return candidate


async def stream_run(
    run: Run,
    config: dict,
    on_candidate: Callable[[dict], None],
    on_update: Callable[[Run], None],
) -> None:
    """Drive one exploration to completion, emitting candidates as they qualify.

    Nodes are buffered rather than gated on arrival: `validation` lands near the
    end of the stream, and whether a claim needs a human depends on it.
    """
    import websockets

    try:
        async with websockets.connect(
            ws_url(),
            additional_headers=auth_headers(),
            open_timeout=25,
        ) as ws:
            await ws.send(json.dumps({"query": run.query, "mode": run.mode, "query_id": run.query_id}))

            while True:
                # The live lab can stay silent while an agent phase runs (up to the Gateway's phase
                # timeout, and once more on a retry); the simulator never did. It always ends with
                # done or error, so this is only a guard against a dead socket.
                raw = await asyncio.wait_for(ws.recv(), timeout=float(os.environ.get("BRIDGE_EVENT_TIMEOUT_S", "420")))
                event = json.loads(raw)
                kind = event.get("event")

                if kind == "stage":
                    run.stage = event.get("stage", run.stage)
                    run.progress = event.get("progress", run.progress)
                    run.message = event.get("message", "")
                elif kind == "node":
                    run.nodes.append(event["node"])
                elif kind == "citations":
                    run.citations = event.get("citations", [])
                elif kind == "answer":
                    run.answer = event.get("answer")
                elif kind == "validation":
                    run.validation = event.get("validation")
                elif kind == "approval_request":
                    # Their Safety Agent asked directly: queue it and answer on
                    # the same socket once a human has decided.
                    node = {
                        "id": event.get("approval_id", "ap"),
                        "label": event.get("question", "")[:48],
                        "detail": event.get("context", ""),
                        "type": "hypothesis",
                        "layer": 3,
                        "confidence": 0.0,
                        "agent_generated": True,
                        "citation_ids": [],
                    }
                    on_candidate(
                        candidate_from_node(run, node, config, approval_id=event.get("approval_id"))
                    )
                elif kind == "error":
                    run.error = event.get("message", "bridge error")
                elif kind == "done":
                    run.latency_ms = event.get("latency_ms", 0)
                    run.next_question = event.get("next_question", "")
                    break
                on_update(run)
    except Exception as exc:  # noqa: BLE001 — surfaced to the panel, not swallowed
        run.error = f"{type(exc).__name__}: {exc}"

    # Validation is known now, so apply the review policy to the buffered nodes.
    # One malformed node must not strand the run with no verdict and no queue.
    for node in run.nodes:
        try:
            if needs_review(node, run.validation):
                on_candidate(candidate_from_node(run, node, config))
        except Exception as exc:  # noqa: BLE001
            run.error = f"node {node.get('id')}: {type(exc).__name__}: {exc}"

    run.finished = True
    on_update(run)


def start_run(
    query: str,
    mode: str,
    config: dict,
    on_candidate: Callable[[dict], None],
    on_update: Callable[[Run], None],
) -> Run:
    """Run an exploration on its own thread so the Gate API stays responsive —
    the loop takes 9–13 s and the headset polls throughout."""
    run = Run(query, mode)

    def worker() -> None:
        asyncio.run(stream_run(run, config, on_candidate, on_update))

    threading.Thread(target=worker, name=f"bridge-{run.query_id}", daemon=True).start()
    return run


def send_decision(approval_id: str, decision: str) -> dict:
    """Route a human decision back to the bridge's approval gate."""
    import httpx

    url = f"{BRIDGE_URL}/api/v1/approve/{approval_id}"
    try:
        response = httpx.post(url, params={"decision": decision}, headers=auth_headers(), timeout=15)
        return response.json()
    except Exception as exc:  # noqa: BLE001
        return {"status": "unreachable", "detail": str(exc)}


def health(timeout: float = 15) -> dict:
    import httpx

    try:
        response = httpx.get(f"{BRIDGE_URL}/health", headers=auth_headers(), timeout=timeout)
        return {"reachable": response.status_code == 200, **response.json()}
    except Exception as exc:  # noqa: BLE001
        return {"reachable": False, "detail": str(exc)}
