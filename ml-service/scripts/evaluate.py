"""
Evaluation script — compute F1 + calibrated threshold from ground truth CSV.

Usage:
    python scripts/evaluate.py data/ground_truth.csv
    python scripts/evaluate.py data/ground_truth.csv --extracted-from fixtures/helios_2024.pdf

Modes:
    Self-evaluation (no --extracted-from):
        Treats every GT row as a correctly extracted claim.
        Measures substantiation score calibration only.
        Useful for a quick sanity check after labeling.

    Full evaluation (--extracted-from PDFs):
        Re-runs extraction against the source PDFs, then matches extracted
        claims against the ground truth CSV. Computes precision/recall/F1.
        This is the "real" benchmark — copy the output into the Lovable prompt.

Output:
    Prints an EvalResult.summary() — ready to paste into the Lovable benchmark
    page prompt.  Also writes results to data/eval_results.json for the record.

Prerequisites (full evaluation):
    ANTHROPIC_API_KEY set in .env or environment
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_ROOT))

try:
    from dotenv import load_dotenv
    load_dotenv(_ROOT / ".env")
except ImportError:
    pass

from api.evaluate import (
    EvalResult,
    calibrate_threshold,
    evaluate_extraction,
    load_ground_truth,
)
from api.models import ExtractedClaim


def _re_extract(pdf_paths: list[Path]) -> list[ExtractedClaim]:
    """Run full extraction pipeline against source PDFs."""
    _api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not _api_key:
        print("[evaluate] ERROR: ANTHROPIC_API_KEY required for --extracted-from mode.")
        sys.exit(1)

    from api.extractor import extract_claims
    from api.pdf_parser import parse_pdf
    from api.substantiation import get_whitelist, score_claims
    from api.taxonomy import get_mapper

    all_claims: list[ExtractedClaim] = []
    for pdf_path in pdf_paths:
        if not pdf_path.exists():
            print(f"[evaluate] ERROR: {pdf_path} not found")
            sys.exit(1)
        print(f"  Extracting from {pdf_path.name} ...", end=" ", flush=True)
        t0 = time.monotonic()
        pages = parse_pdf(pdf_path.read_bytes())
        claims, _, metrics, _ = extract_claims(pages)
        try:
            claims = get_mapper().map_claims(claims)
        except Exception:
            pass
        try:
            claims = score_claims(claims, get_whitelist())
        except Exception:
            pass
        print(f"{len(claims)} claims ({time.monotonic() - t0:.1f}s)")
        all_claims.extend(claims)
    return all_claims


def _self_eval_claims(gt_rows) -> list[ExtractedClaim]:
    """
    Self-evaluation mode: convert GT rows into ExtractedClaim objects.
    Every GT row is treated as a correctly extracted claim.
    Used to calibrate substantiation threshold when no re-extraction is done.
    """
    from api.models import ExtractedClaim
    claims = []
    for row in gt_rows:
        claims.append(ExtractedClaim(
            raw_text=row.raw_text,
            page_num=row.page_num,
            char_start=0,
            char_end=len(row.raw_text),
            normalized_value=row.normalized_value,
            unit=row.unit,
            category=row.category,
        ))
    return claims


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compute F1 and calibrated threshold from labeled ground truth."
    )
    parser.add_argument(
        "ground_truth",
        type=Path,
        help="Path to corrected ground truth CSV (data/ground_truth.csv)",
    )
    parser.add_argument(
        "--extracted-from",
        nargs="+",
        type=Path,
        metavar="PDF",
        help="Re-run extraction against these PDFs for full precision/recall eval",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=_ROOT / "data" / "eval_results.json",
        help="Write JSON results to this file (default: data/eval_results.json)",
    )
    args = parser.parse_args()

    if not args.ground_truth.exists():
        print(f"[evaluate] ERROR: {args.ground_truth} not found")
        sys.exit(1)

    print(f"\n[evaluate] Loading ground truth from {args.ground_truth} ...")
    gt_rows = load_ground_truth(args.ground_truth)
    print(f"  {len(gt_rows)} labeled claims loaded")

    if not gt_rows:
        print("[evaluate] ERROR: ground truth CSV is empty or has no valid rows.")
        sys.exit(1)

    # Get extracted claims
    if args.extracted_from:
        print(f"\n[evaluate] Re-extracting from {len(args.extracted_from)} PDF(s) ...")
        extracted = _re_extract(args.extracted_from)
        mode = "full"
    else:
        print("\n[evaluate] Self-evaluation mode (no --extracted-from specified)")
        print("  Treating GT rows as extracted claims. Measures calibration only.")
        extracted = _self_eval_claims(gt_rows)
        mode = "self"

    # Compute F1
    print("\n[evaluate] Computing metrics ...")
    result = evaluate_extraction(extracted, gt_rows)

    # Calibrate substantiation threshold
    from api.substantiation import get_whitelist, score_claims
    from api.models import ExtractedClaim as EC
    scored = score_claims(extracted, get_whitelist())

    # Build (score, label) pairs for calibration
    # Label: 1 if this extracted claim matches a GT row, 0 if it's a false positive
    from api.evaluate import match_claims
    matches, unmatched_ext, _ = match_claims(extracted, gt_rows)
    matched_ext_indices = {ei for ei, gi in matches}

    scores_for_calib = []
    labels_for_calib = []
    for i, claim in enumerate(scored):
        if claim.substantiation:
            scores_for_calib.append(claim.substantiation.score)
            labels_for_calib.append(1 if i in matched_ext_indices else 0)

    best_threshold = calibrate_threshold(scores_for_calib, labels_for_calib)
    result.calibrated_threshold = best_threshold

    # Print summary
    print()
    print("=" * 60)
    print(result.summary())
    print("=" * 60)

    # Lovable benchmark page prompt
    cat_lines = []
    for cat, m in sorted(result.per_category.items()):
        cat_lines.append(
            f"  {cat.capitalize():<12} F1={m.f1:.3f}  "
            f"P={m.precision:.3f}  R={m.recall:.3f}  (n={m.n_gt})"
        )

    print()
    print("─" * 60)
    print("LOVABLE BENCHMARK PAGE PROMPT — copy everything below:")
    print("─" * 60)
    print(f"""
Add a benchmark page at /benchmark showing VeriGreen extraction accuracy.

Evaluation data (mode={mode}, n={result.n_labeled} labeled claims):
  Overall:    P={result.precision:.3f}  R={result.recall:.3f}  F1={result.f1:.3f}
  Macro F1:   {result.macro_f1:.3f}
{chr(10).join(cat_lines)}
  Calibrated substantiation threshold: {best_threshold}

Page design:
- Metric cards for each category (same card style as the dashboard)
- Overall F1 as the headline number
- "n={result.n_labeled} labeled claims, preliminary" caveat below numbers
- Short explanation: "Measured on the Helios Industrial Group 2024 fixture — a
  26-page synthetic sustainability report with standard GRI disclosures,
  numerical edge cases, and adversarial content filtered by VeriGreen's
  10-layer robustness architecture."
- Link to /docs for methodology
- Note: "Threshold calibrated at {best_threshold} — claims with substantiation
  score ≥ {best_threshold} are accepted; below = flagged for review."
""")

    # Save JSON results
    results_dict = {
        "mode": mode,
        "n_labeled": result.n_labeled,
        "total_extracted": result.total_extracted,
        "total_gt": result.total_gt,
        "matched": result.matched,
        "precision": round(result.precision, 4),
        "recall": round(result.recall, 4),
        "f1": round(result.f1, 4),
        "macro_f1": round(result.macro_f1, 4),
        "calibrated_threshold": best_threshold,
        "per_category": {
            cat: {
                "precision": round(m.precision, 4),
                "recall": round(m.recall, 4),
                "f1": round(m.f1, 4),
                "n_gt": m.n_gt,
            }
            for cat, m in result.per_category.items()
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results_dict, indent=2), encoding="utf-8")
    print(f"[evaluate] Results saved to {args.output}")


if __name__ == "__main__":
    main()
