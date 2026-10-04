"""Pre-loaded use cases and the question history, for the viewer's Cases / History panel.

  GET  /lab/cases     use cases (data/cases.json): the lineage case and questions picked by what
                      the corpus contains, each with what a correct answer looks like
  POST /lab/lineage   loads the bridge's lineage use case as a finished run; its counterfactual
                      branches (agent-written) are queued for human review like any hypothesis
  GET  /lab/history   every question the lab received (bridge /api/v1/queries, a Databricks table),
                      newest first, with verdict, evidence, latency and error

Questions themselves still go through POST /bridge/explore, so a case or a history row asked
again is an ordinary run: live by default (LAB_MODE), same queue, same audit trail.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable

import httpx
from fastapi import APIRouter, HTTPException

import bridge

CASES_FILE = Path(__file__).parent / "data" / "cases.json"


def make_router(config: dict, accept_candidate: Callable[[dict], None], runs: dict[str, Any]) -> APIRouter:
    router = APIRouter(prefix="/lab")

    @router.get("/cases")
    def cases() -> dict:
        data = json.loads(CASES_FILE.read_text(encoding="utf-8"))
        return {"count": len(data["cases"]), "cases": data["cases"]}

    @router.post("/lineage")
    def lineage() -> dict:
        started = time.monotonic()
        try:
            response = httpx.get(f"{bridge.BRIDGE_URL}/api/v1/lineage", headers=bridge.auth_headers(), timeout=60)
        except httpx.HTTPError as exc:
            raise HTTPException(503, f"agent lab unreachable: {exc}") from exc
        if response.status_code != 200:
            raise HTTPException(502, f"agent lab answered {response.status_code}: {response.text[:300]}")
        body = response.json()

        run = bridge.Run("Linaje de las PET hidrolasas", "live")
        run.stage = "done"
        run.citations = body.get("citations", [])
        run.nodes = body.get("nodes", [])
        run.answer = body.get("answer")
        run.latency_ms = body.get("latency_ms") or int((time.monotonic() - started) * 1000)
        run.finished = True
        runs[run.query_id] = run

        # Counterfactual branches are agent hypotheses, not history: same review as any other.
        queued = 0
        for node in run.nodes:
            if node.get("agent_generated"):
                accept_candidate(bridge.candidate_from_node(run, node, config))
                queued += 1
        historical = sum(1 for n in run.nodes if not n.get("agent_generated"))
        return {"ok": True, "query_id": run.query_id, "historical": historical, "alternatives": queued,
                "queued_for_review": queued, "answer": run.answer}

    @router.get("/history")
    def history(limit: int = 30, asked_by: str = "", unanswered: bool = False) -> dict:
        params: dict[str, Any] = {"limit": max(1, min(limit, 200))}
        if asked_by:
            params["asked_by"] = asked_by
        if unanswered:
            params["unanswered"] = "true"
        try:
            response = httpx.get(f"{bridge.BRIDGE_URL}/api/v1/queries", params=params,
                                 headers=bridge.auth_headers(), timeout=30)
        except httpx.HTTPError as exc:
            raise HTTPException(503, f"agent lab unreachable: {exc}") from exc
        if response.status_code != 200:
            raise HTTPException(502, f"agent lab answered {response.status_code}: {response.text[:300]}")
        return response.json()

    return router
