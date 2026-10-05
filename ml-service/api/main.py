"""FastAPI application entry point — Vercel Fluid Compute."""
from __future__ import annotations

import os

import sentry_sdk
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse

import asyncio
from .ingest import run_ingest
from .models import IngestRequest, ParseRequest, ParseResult, ScoreRequest, ScoreResult, MatchRequest, FeedbackRequest, TaxonomyMapping
from .parser_endpoint import run_parse
from .substantiation import score_claims, get_whitelist
from .embedding_matcher import match_claim_embedding, apply_feedback, rebuild_taxonomy_embeddings
from .supabase_client import _persist_feedback_to_supabase, _load_embeddings_from_supabase

# Adversarial Layer 9 / Observability: Sentry error + performance monitoring.
# No-op when SENTRY_DSN is unset (dev / test environments).
_sentry_dsn = os.getenv("SENTRY_DSN", "")
if _sentry_dsn:
    sentry_sdk.init(
        dsn=_sentry_dsn,
        traces_sample_rate=0.1,
        environment=os.getenv("ENVIRONMENT", "production"),
        # Exclude CI adversarial regression traffic from billing
        profiles_sample_rate=0.0,
    )

app = FastAPI(title="VeriGreen ML Service", version="0.1.0")

_ML_SERVICE_API_KEY = os.getenv("ML_SERVICE_API_KEY", "")


def _require_api_key(request: Request) -> None:
    """Bearer token auth — prevents unauthenticated calls to /ingest."""
    if not _ML_SERVICE_API_KEY:
        return  # Key not configured → allow in dev (log warning)
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    if auth.removeprefix("Bearer ") != _ML_SERVICE_API_KEY:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "verigreen-ml"}


@app.post("/ingest", dependencies=[Depends(_require_api_key)])
async def ingest(req: IngestRequest) -> JSONResponse:
    result = await run_ingest(req)
    return JSONResponse(content=result.model_dump(), status_code=200)

@app.post("/parse", dependencies=[Depends(_require_api_key)])
async def parse_endpoint(req: ParseRequest) -> ParseResult:
    return await run_parse(req)  # from parser_endpoint.py

@app.post("/score", dependencies=[Depends(_require_api_key)])
async def score_endpoint(req: ScoreRequest) -> ScoreResult:
    from .substantiation import score_claims, get_whitelist
    scored = score_claims(req.claims, get_whitelist())
    return ScoreResult(job_id=req.job_id, claims=scored)

@app.post("/match", dependencies=[Depends(_require_api_key)])
async def match_endpoint(req: MatchRequest) -> TaxonomyMapping:
    return match_claim_embedding(
        req.claim_embedding, req.raw_text, req.unit, req.category
    )

@app.post("/feedback", dependencies=[Depends(_require_api_key)])
async def feedback_endpoint(req: FeedbackRequest) -> dict:
    count = apply_feedback(
        req.claim_embedding, req.correct_node_id,
        req.wrong_node_id, req.system_score, req.system_correct,
    )
    asyncio.create_task(_persist_feedback_to_supabase(req.correct_node_id, req.claim_embedding))
    return {"ok": True, "anchor_count": count}

@app.post("/taxonomy/rebuild", dependencies=[Depends(_require_api_key)])
async def taxonomy_rebuild() -> dict:
    results = await rebuild_taxonomy_embeddings()
    return {"nodes_embedded": len(results), "node_ids": list(results.keys())}

# Startup: load embeddings from Supabase (or rebuild if empty)
@app.on_event("startup")
async def startup():
    asyncio.create_task(_load_embeddings_from_supabase())
