"""
Pre-extraction script for co-labeling.

Runs the full VeriGreen pipeline (parse → LLM extract → taxonomy → substantiation)
against one or more PDF files and writes a pre-populated CSV for human review.

Usage:
    python scripts/pre_extract.py fixtures/helios_2024.pdf
    python scripts/pre_extract.py fixtures/helios_2024.pdf other_report.pdf
    python scripts/pre_extract.py fixtures/helios_2024.pdf --output data/my_prelabeled.csv

Prerequisites:
    ANTHROPIC_API_KEY  set in .env or environment
    pip install pdfplumber pillow pydantic python-dotenv

The script is synchronous — it wraps async ingest logic for CLI use.
LLM calls consume Anthropic API credits (typically 3× Sonnet per page).

Output CSV columns (matches evaluate.py ground truth format):
    raw_text, page_num, category, gri_code, sasb_code,
    normalized_value, unit, is_quantified, notes

After reviewing the CSV:
    1. Correct wrong category values
    2. Add gri_code / sasb_code where you know them
    3. Set is_quantified=false for bad extractions / hallucinated claims
    4. Add notes for unusual cases
    5. Save as data/ground_truth.csv
    6. Run: python scripts/evaluate.py data/ground_truth.csv
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from pathlib import Path

# Ensure repo root is on sys.path
_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_ROOT))

# Load .env if present (dev workflow)
try:
    from dotenv import load_dotenv
    load_dotenv(_ROOT / ".env")
except ImportError:
    pass  # python-dotenv optional; rely on env being set directly

# Validate API key early
_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
if not _API_KEY:
    print(
        "[pre_extract] ERROR: ANTHROPIC_API_KEY not set.\n"
        "  Set it in ml-service/.env or export it in your shell.\n"
        "  Example: echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env"
    )
    sys.exit(1)

from api.adversarial import sanitize_text, wrap_for_extraction
from api.evaluate import GROUND_TRUTH_COLUMNS, write_prelabeled_csv
from api.extractor import (
    PRIMARY_MODEL,
    _SYSTEM_PROMPT,
    _build_client,
    extract_claims,
)
from api.models import ExtractedClaim, LLMExtractionResponse, PageParseResult
from api.pdf_parser import parse_pdf
from api.substantiation import get_whitelist, score_claims
from api.taxonomy import get_mapper


def run_smoke_test() -> None:
    """
    F1: single real API call to PRIMARY_MODEL that does NOT swallow exceptions.
    Confirms model ID + auth + JSON shape for ~$0.01 before the full job.
    Exits 1 loudly on any failure.
    """
    print(f"[smoke] Testing model '{PRIMARY_MODEL}' with one API call ...")
    test_page = "Scope 1 emissions: 1,234 tCO2e in FY2024 (FY2020 baseline: 1,500 tCO2e)."
    wrapped = wrap_for_extraction(test_page)

    try:
        client = _build_client()
        resp = client.messages.create(
            model=PRIMARY_MODEL,
            max_tokens=1024,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": wrapped}],
        )
    except Exception as e:
        print(f"\n[smoke] FAILED: {type(e).__name__}: {e}")
        print("  Check: ANTHROPIC_API_KEY valid? PRIMARY_MODEL correct? AI_GATEWAY_URL blank?")
        sys.exit(1)

    raw = resp.content[0].text.strip()
    if raw.startswith("```"):
        import re as _re
        raw = _re.sub(r"^```(?:json)?\s*", "", raw)
        raw = _re.sub(r"\s*```$", "", raw)

    print(f"  Model:   {resp.model}")
    print(f"  Tokens:  {resp.usage.input_tokens} in / {resp.usage.output_tokens} out")
    print(f"  Output:  {raw[:200]}{'...' if len(raw) > 200 else ''}")

    try:
        parsed = LLMExtractionResponse.model_validate_json(raw)
        print(f"  JSON:    OK — parsed {len(parsed.claims)} claim(s)")
    except Exception as e:
        print(f"  JSON:    PARSE FAILED — {type(e).__name__}: {e}")
        print("  Model responds but output is not schema-valid JSON. Full run may yield few claims.")
        sys.exit(1)

    print("\n[smoke] PASS — model + auth + JSON shape confirmed. Safe to run the full job.")


def _load_pdf(path: Path) -> list[PageParseResult]:
    print(f"  Parsing {path.name} ...", end=" ", flush=True)
    pages = parse_pdf(path.read_bytes())
    ok = sum(1 for p in pages if p.text and not p.failure_reason)
    failed = sum(1 for p in pages if p.failure_reason)
    print(f"{len(pages)} pages ({ok} with text, {failed} failed)")
    return pages


def _is_adversarial_claim(claim: ExtractedClaim, pages: list[PageParseResult]) -> bool:
    """
    Skip claims whose source page contains adversarial injection.
    We don't want injection text in the ground truth CSV.
    """
    page = next((p for p in pages if p.page_num == claim.page_num), None)
    if page is None or not page.text:
        return False
    _, ind = sanitize_text(page.text)
    return any([
        ind.has_direct_injection,
        ind.has_jailbreak_attempt,
        ind.has_exfiltration_attempt,
        ind.has_system_prompt_leak_attempt,
        ind.has_authority_impersonation,
    ])


def extract_from_pdf(pdf_path: Path) -> list[ExtractedClaim]:
    """Run full pipeline against one PDF, return scored + mapped claims."""
    pages = _load_pdf(pdf_path)

    print(f"  Extracting claims via LLM ...", end=" ", flush=True)
    t0 = time.monotonic()
    claims, adversarial, metrics, _ = extract_claims(pages)
    elapsed = time.monotonic() - t0
    print(
        f"{len(claims)} claims extracted "
        f"({metrics.model_calls} LLM calls, {elapsed:.1f}s, "
        f"{metrics.tokens_in + metrics.tokens_out} tokens)"
    )

    if adversarial.detected_vectors:
        print(f"  [adversarial] detected: {', '.join(adversarial.detected_vectors)}")

    # Taxonomy mapping
    try:
        print(f"  Mapping to GRI/SASB taxonomy ...", end=" ", flush=True)
        claims = get_mapper().map_claims(claims)
        mapped = sum(1 for c in claims if c.taxonomy and c.taxonomy.routing == "matched")
        print(f"{mapped}/{len(claims)} matched")
    except Exception as e:
        print(f"SKIPPED ({e})")

    # Substantiation scoring
    try:
        print(f"  Scoring substantiation ...", end=" ", flush=True)
        claims = score_claims(claims, get_whitelist())
        print("done")
    except Exception as e:
        print(f"SKIPPED ({e})")

    # Filter adversarial pages from review set
    before = len(claims)
    claims = [c for c in claims if not _is_adversarial_claim(c, pages)]
    filtered = before - len(claims)
    if filtered:
        print(f"  [adversarial] filtered {filtered} claims from injection pages")

    return claims


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pre-extract claims for co-labeling review."
    )
    parser.add_argument(
        "pdfs",
        nargs="*",
        type=Path,
        help="PDF file(s) to extract from",
    )
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="Preflight: make ONE API call to confirm model + auth, then exit (~$0.01)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=_ROOT / "data" / "ground_truth_prelabeled.csv",
        help="Output CSV path (default: data/ground_truth_prelabeled.csv)",
    )
    args = parser.parse_args()

    # F1: smoke preflight — confirm model + auth before the full job
    if args.smoke:
        run_smoke_test()
        return

    if not args.pdfs:
        parser.error("at least one PDF is required (or use --smoke for the preflight)")

    all_claims: list[ExtractedClaim] = []

    for pdf_path in args.pdfs:
        if not pdf_path.exists():
            print(f"[pre_extract] ERROR: {pdf_path} not found")
            sys.exit(1)
        print(f"\n[{pdf_path.name}]")
        claims = extract_from_pdf(pdf_path)
        all_claims.extend(claims)

    if not all_claims:
        print("\n[pre_extract] No claims extracted. Check ANTHROPIC_API_KEY and PDF content.")
        sys.exit(1)

    # Write pre-labeled CSV
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_prelabeled_csv(all_claims, args.output)

    print(f"\n[pre_extract] Done.")
    print(f"  {len(all_claims)} claims written to {args.output}")
    print()
    print("Next steps:")
    print(f"  1. Open {args.output} in Excel / Google Sheets")
    print("  2. Review each row:")
    print("       - Correct 'category' (emissions/energy/water/waste/other)")
    print("       - Add 'gri_code' / 'sasb_code' where you know them")
    print("       - Set 'is_quantified=false' for hallucinated / bad extractions")
    print("       - Add 'notes' for unusual cases")
    print(f"  3. Save corrected file as data/ground_truth.csv")
    print(f"  4. Run: python scripts/evaluate.py data/ground_truth.csv")


if __name__ == "__main__":
    main()
