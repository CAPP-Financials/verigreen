# VeriGreen

ESG claim substantiation: a pipeline that reads a sustainability report, extracts the environmental claims it makes, maps each claim to GRI and SASB disclosures, scores how well the claim is substantiated, and routes doubtful cases to a human reviewer.

> **Status: built and tested on synthetic data only.** The test fixture is a generated fake report ("Helios 2024"). Nothing here has been validated against real corporate reports or with real users. The 140 ML-service tests mock the LLM, so they check pipeline logic and safety rules, not extraction accuracy. The web app has no automated tests beyond a signature smoke script.

## How it works

```
 Browser  -->  app/ (TanStack Start on Cloudflare Workers, Supabase Postgres)
                 |  1. user uploads a PDF, app stores it and creates an extraction job
                 |  2. app calls the ML service with a signed download URL
                 v
 ml-service/ (FastAPI on Vercel)
   parse PDF (pdfplumber, Tesseract/Mistral OCR fallback)
   -> sanitize text, detect hidden or injected instructions
   -> extract claims with Claude, 3 independent passes
   -> compare passes; sharp disagreement escalates to a larger model and flags manual review
   -> map each claim to a GRI/SASB node (embedding match, TF-IDF fallback)
   -> score substantiation (quantified? baseline? time-bound? third-party verified?)
                 |  3. HMAC-SHA256 signed callback (timestamp-bound, 300 s window)
                 v
 app/ /api/public/extraction-callback
   verifies signature, checks the job belongs to the same organisation, writes claims
   -> review queue (assign, resolve, reclassify), webhooks, audit log, GDPR export/delete
```

## What is in each folder

- `ml-service/`: Python extraction service. Entry point `api/main.py`; the flow is in `api/ingest.py`. Taxonomy data for GRI and SASB is in `data/`.
- `app/`: the multi-tenant web app. Auth, API keys, rate limiting, review queue, webhooks, and 11 Supabase migrations including row-level security. It was scaffolded with Lovable, so some auth plumbing is generated code.
- `docs/`: design notes on the safety layers and the callback contract.

## Safety layers (ten-layer design, see `docs/safety-layers.md`)

Input sanitization, schema-enforced output with retries, tool-less model calls, multi-pass disagreement detection, per-tenant isolation, a verifier whitelist, output anomaly checks, a per-call audit log of hashed prompts and outputs, a regression runner over the synthetic fixture, and a trust-posture rule. Layers 1 to 9 have code or tests in this repo.

## Run the ML-service tests

```bash
cd ml-service
pip install -r requirements.txt pytest
python -m pytest -q tests        # 140 tests, LLM mocked, no API keys needed
python tests/run_helios_regression.py   # staged regression over the synthetic fixture
```

Running the real pipeline needs `ANTHROPIC_API_KEY`, a Supabase project and a deployed callback endpoint; see `ml-service/.env.example` and `app/.env.example`. Nothing in this repo contains a real key.

## Known gaps

- No labelled ground truth set, so extraction precision and recall are unmeasured. The F1 harness in `ml-service/api/evaluate.py` is ready for one.
- LLM calls are mocked in tests; live-model behaviour is unverified.
- The app side has no unit or end-to-end tests.
- Not validated with any real user or real report.
