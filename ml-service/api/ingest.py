"""
/ingest endpoint handler — orchestrates the full extraction pipeline.

Flow:
  1. Download PDF from signed Supabase Storage URL
  2. Parse pages (pdfplumber + OCR fallback)
  3. Extract claims via multi-model LLM
  4. Send HMAC-signed callback to Worker
"""
from __future__ import annotations

import httpx

from .callback import send_callback
from .extractor import extract_claims
from .models import ExtractionResult, IngestRequest
from .pdf_parser import check_pdf_metadata, parse_pdf
from .substantiation import get_whitelist, score_claims
from .taxonomy import get_mapper


async def run_ingest(req: IngestRequest) -> ExtractionResult:
    """
    Execute the full ingestion pipeline. Returns ExtractionResult.
    All state updates flow through the callback — this function never writes to Supabase.
    """
    # 1. Download PDF
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.get(req.signed_url)
            resp.raise_for_status()
            pdf_bytes = resp.content
    except Exception as e:
        result = ExtractionResult(
            job_id=req.job_id,
            document_id=req.document_id,
            organization_id=req.org_id,
            status="failed",
            error={"code": "download_failed", "message": str(e)},
        )
        await _try_callback(req, result)
        return result

    # 2. Parse PDF
    try:
        pages = parse_pdf(pdf_bytes)
    except Exception as e:
        result = ExtractionResult(
            job_id=req.job_id,
            document_id=req.document_id,
            organization_id=req.org_id,
            status="failed",
            error={"code": "parse_failed", "message": str(e)},
        )
        await _try_callback(req, result)
        return result

    has_failures = any(p.failure_reason is not None for p in pages)
    has_content = any(p.text and not p.failure_reason for p in pages)

    if not has_content:
        result = ExtractionResult(
            job_id=req.job_id,
            document_id=req.document_id,
            organization_id=req.org_id,
            status="failed",
            page_results=pages,
            error={"code": "no_extractable_content", "message": "No pages with extractable text"},
        )
        await _try_callback(req, result)
        return result

    # 2b. Check PDF metadata for adversarial content (Vector 2 — document-level)
    meta_adversarial = check_pdf_metadata(pdf_bytes)

    # 3. Extract claims
    try:
        claims, adversarial, metrics, call_logs = extract_claims(pages)
    except Exception as e:
        result = ExtractionResult(
            job_id=req.job_id,
            document_id=req.document_id,
            organization_id=req.org_id,
            status="failed",
            page_results=pages,
            error={"code": "extraction_failed", "message": str(e)},
        )
        await _try_callback(req, result)
        return result

    # 4. Map claims to GRI/SASB taxonomy nodes (non-fatal — taxonomy failure doesn't block callback)
    try:
        claims = get_mapper().map_claims(claims)
    except Exception as e:
        print(f"[taxonomy_failed] job={req.job_id} error={e}")

    # 5. Substantiation scoring — Layers 6 + 7 (non-fatal)
    try:
        claims = score_claims(claims, get_whitelist())
    except Exception as e:
        print(f"[substantiation_failed] job={req.job_id} error={e}")

    # Merge document-level metadata indicators into page-level adversarial indicators
    if meta_adversarial.has_metadata_injection:
        adversarial.has_metadata_injection = True
        for v in meta_adversarial.detected_vectors:
            if v not in adversarial.detected_vectors:
                adversarial.detected_vectors.append(v)

    status = "partial" if has_failures else "complete"
    result = ExtractionResult(
        job_id=req.job_id,
        document_id=req.document_id,
        organization_id=req.org_id,
        status=status,
        claims=claims,
        adversarial_indicators=adversarial,
        page_results=pages,
        metrics=metrics,
        model_call_logs=call_logs,  # Layer 8: written to model_call_log table by Worker
    )

    await _try_callback(req, result)
    return result


async def _try_callback(req: IngestRequest, result: ExtractionResult) -> None:
    try:
        await send_callback(req.callback_url, req.webhook_secret, result)
    except Exception as e:
        # Log but don't propagate — caller gets the result object regardless
        print(f"[callback_failed] job={req.job_id} error={e}")
