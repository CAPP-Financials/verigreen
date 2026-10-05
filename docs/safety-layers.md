# Safety layers

Source of truth is the code; file references below.

1. Input segregation and sanitization: document text wrapped in a tagged block, zero-width and direction-control characters stripped, base64 and hex blobs flagged (`ml-service/api/adversarial.py`).
2. Schema-enforced output: Pydantic validation of the model reply, up to 3 retries (`ml-service/api/extractor.py`).
3. Tool-less model calls: no `tools=` argument is ever passed (`extractor.py`).
4. Multi-pass disagreement: `EXTRACTION_PASSES=3` independent passes, span-overlap agreement, escalation to the larger model and `requires_manual_review` on sharp divergence (`adversarial.compute_pass_agreement`).
5. Per-tenant isolation: the callback route checks the job's organisation against the payload before any write and returns 403 on mismatch (`app/src/routes/api/public/extraction-callback.ts`).
6. Verifier whitelist: third-party verifiers not in `ml-service/data/verifier_whitelist.json` are flagged, and suspiciously perfect scores go to review (`ml-service/api/substantiation.py`).
7. Output anomaly detection: imperative phrases and encoded content in extracted spans are flagged (`adversarial.py`, `substantiation.py`).
8. Per-call audit log: SHA-256 hashes of system prompt, user message and raw output are stored for each model call (`extractor.py`, `models.ModelCallLogEntry`).
9. Regression and observability: Helios fixture runner, Sentry hooks (`ml-service/tests/run_helios_regression.py`, `api/main.py`).
10. Trust posture: the same guardrails apply to every document regardless of claimed verification status (design rule; no dedicated code).

# Callback contract

`POST /api/public/extraction-callback` with headers `X-VeriGreen-Signature: sha256=<hex>` and `X-VeriGreen-Timestamp: <unix seconds>`. The signature is HMAC-SHA256 over `{timestamp}.{raw body}` with a per-organisation secret. Requests outside a 300 second window are rejected. `app/scripts/test-callback.ts` exercises it.
