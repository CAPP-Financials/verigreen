"""
Day-8 evaluation harness unit tests.

Tests:
  - load_ground_truth: CSV parsing
  - match_claims: exact and fuzzy matching
  - evaluate_extraction: precision/recall/F1 computation
  - calibrate_threshold: threshold sweep
  - write_prelabeled_csv: output round-trip

No LLM calls. No fixture PDF required.
"""
from __future__ import annotations

import csv
import sys
import os
import tempfile
import unittest.mock as mock

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
if "anthropic" not in sys.modules:
    sys.modules["anthropic"] = mock.MagicMock()

from api.evaluate import (
    GroundTruthClaim,
    calibrate_threshold,
    evaluate_extraction,
    load_ground_truth,
    match_claims,
    write_prelabeled_csv,
    GROUND_TRUTH_COLUMNS,
)
from api.models import ExtractedClaim


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_claim(raw_text: str, page_num: int = 1, category: str | None = None) -> ExtractedClaim:
    return ExtractedClaim(
        raw_text=raw_text,
        page_num=page_num,
        char_start=0,
        char_end=len(raw_text),
        category=category,
    )


def _make_gt(raw_text: str, page_num: int = 1, category: str | None = "emissions") -> GroundTruthClaim:
    return GroundTruthClaim(raw_text=raw_text, page_num=page_num, category=category)


def _write_temp_csv(rows: list[dict]) -> str:
    """Write rows to a temp CSV, return path."""
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False, encoding="utf-8", newline="")
    writer = csv.DictWriter(f, fieldnames=GROUND_TRUTH_COLUMNS)
    writer.writeheader()
    writer.writerows(rows)
    f.close()
    return f.name


# ---------------------------------------------------------------------------
# load_ground_truth
# ---------------------------------------------------------------------------

def test_load_gt_basic():
    """CSV with valid rows loads correctly."""
    path = _write_temp_csv([
        {
            "raw_text": "Scope 1 emissions: 1,234 tCO2e",
            "page_num": "3",
            "category": "emissions",
            "gri_code": "GRI 305-1",
            "sasb_code": "",
            "normalized_value": "1234.0",
            "unit": "tCO2e",
            "is_quantified": "true",
            "notes": "",
        },
    ])
    rows = load_ground_truth(path)
    assert len(rows) == 1
    assert rows[0].raw_text == "Scope 1 emissions: 1,234 tCO2e"
    assert rows[0].page_num == 3
    assert rows[0].category == "emissions"
    assert rows[0].normalized_value == 1234.0
    assert rows[0].unit == "tCO2e"
    assert rows[0].is_quantified is True


def test_load_gt_skips_empty_rows():
    """Rows with empty raw_text are skipped."""
    path = _write_temp_csv([
        {"raw_text": "", "page_num": "1", "category": "emissions",
         "gri_code": "", "sasb_code": "", "normalized_value": "", "unit": "", "is_quantified": "true", "notes": ""},
        {"raw_text": "Valid claim 100 tCO2e", "page_num": "2", "category": "emissions",
         "gri_code": "", "sasb_code": "", "normalized_value": "100", "unit": "tCO2e", "is_quantified": "true", "notes": ""},
    ])
    rows = load_ground_truth(path)
    assert len(rows) == 1
    assert rows[0].raw_text == "Valid claim 100 tCO2e"


def test_load_gt_bad_numeric_graceful():
    """Invalid normalized_value → None, not an exception."""
    path = _write_temp_csv([
        {"raw_text": "Energy use: N/A", "page_num": "5", "category": "energy",
         "gri_code": "", "sasb_code": "", "normalized_value": "N/A", "unit": "MWh",
         "is_quantified": "false", "notes": ""},
    ])
    rows = load_ground_truth(path)
    assert rows[0].normalized_value is None
    assert rows[0].is_quantified is False


# ---------------------------------------------------------------------------
# match_claims
# ---------------------------------------------------------------------------

def test_match_exact():
    """Exact text match → 1 TP."""
    text = "Scope 1: 1,234,567 tCO2e FY2024"
    ec = _make_claim(text)
    gc = _make_gt(text)
    matches, unmatched_ext, unmatched_gt = match_claims([ec], [gc])
    assert len(matches) == 1
    assert not unmatched_ext
    assert not unmatched_gt


def test_match_substring():
    """GT is a substring of extracted → fuzzy match."""
    ec = _make_claim("Total Scope 1 direct GHG emissions: 1,234,567 tCO2e in FY2024")
    gc = _make_gt("Scope 1 direct GHG emissions: 1,234,567 tCO2e in FY2024")
    matches, _, unmatched_gt = match_claims([ec], [gc])
    assert len(matches) == 1
    assert not unmatched_gt


def test_match_no_match():
    """Completely different text → 0 TP, 1 FP, 1 FN."""
    ec = _make_claim("Water withdrawal: 500 ML")
    gc = _make_gt("Scope 1 emissions: 1,234 tCO2e")
    matches, unmatched_ext, unmatched_gt = match_claims([ec], [gc])
    assert len(matches) == 0
    assert len(unmatched_ext) == 1
    assert len(unmatched_gt) == 1


def test_match_multi_claims():
    """3 GT, 3 extracted (2 match + 1 extra) → 2 TP, 1 FP, 1 FN."""
    texts = [
        "Scope 1: 1000 tCO2e",
        "Water: 500 ML",
        "Waste: 200 tonnes",
    ]
    extracted = [_make_claim(texts[0]), _make_claim(texts[1]), _make_claim("Extra spurious claim")]
    gt = [_make_gt(t) for t in texts]
    matches, unmatched_ext, unmatched_gt = match_claims(extracted, gt)
    assert len(matches) == 2
    assert len(unmatched_ext) == 1   # "Extra spurious claim"
    assert len(unmatched_gt) == 1    # "Waste: 200 tonnes"


# ---------------------------------------------------------------------------
# evaluate_extraction
# ---------------------------------------------------------------------------

def test_evaluate_perfect():
    """Perfect extraction → P=R=F1=1.0."""
    text = "Scope 1 emissions: 1,234 tCO2e FY2024"
    ec = _make_claim(text, category="emissions")
    gc = _make_gt(text, category="emissions")
    result = evaluate_extraction([ec], [gc])
    assert result.precision == 1.0
    assert result.recall == 1.0
    assert result.f1 == 1.0
    assert result.matched == 1


def test_evaluate_all_false_negative():
    """Nothing extracted → P=0, R=0, F1=0."""
    gc = _make_gt("Scope 1 emissions: 1,234 tCO2e FY2024", category="emissions")
    result = evaluate_extraction([], [gc])
    assert result.precision == 0.0
    assert result.recall == 0.0
    assert result.f1 == 0.0
    assert result.matched == 0


def test_evaluate_all_false_positive():
    """Extracted but no GT match → P=0, R=0, F1=0."""
    ec = _make_claim("Spurious claim", category="emissions")
    result = evaluate_extraction([ec], [])
    assert result.precision == 0.0
    assert result.recall == 0.0


def test_evaluate_per_category():
    """Per-category metrics computed correctly."""
    claims = [
        _make_claim("Scope 1: 1000 tCO2e", category="emissions"),
        _make_claim("Energy: 5000 MWh", category="energy"),
    ]
    gt = [
        _make_gt("Scope 1: 1000 tCO2e", category="emissions"),
        _make_gt("Energy: 5000 MWh", category="energy"),
    ]
    result = evaluate_extraction(claims, gt)
    assert "emissions" in result.per_category
    assert "energy" in result.per_category
    assert result.per_category["emissions"].f1 == 1.0
    assert result.per_category["energy"].f1 == 1.0
    assert result.macro_f1 == 1.0


def test_evaluate_summary_contains_n():
    """Summary string includes n= caveat."""
    result = evaluate_extraction([], [_make_gt("X", category="emissions")])
    s = result.summary()
    assert "n=1" in s
    assert "preliminary" in s


def test_evaluate_empty_gt():
    """Empty ground truth → handled gracefully."""
    ec = _make_claim("Something")
    result = evaluate_extraction([ec], [])
    assert result.total_gt == 0
    assert result.f1 == 0.0


# ---------------------------------------------------------------------------
# calibrate_threshold
# ---------------------------------------------------------------------------

def test_calibrate_perfect_split():
    """Scores 80-100 are TP, 0-40 are FP → threshold should sit between 40 and 80."""
    scores = [90, 85, 80, 95, 100, 10, 20, 30, 0, 40]
    labels = [1,  1,  1,  1,  1,  0,  0,  0,  0,  0]
    t = calibrate_threshold(scores, labels)
    # Any threshold in (40, 80] gives perfect F1=1.0 on this split
    assert 40 < t <= 80, f"Threshold {t} does not correctly split TP (>=80) from FP (<=40)"


def test_calibrate_empty_falls_back():
    """Empty input returns 50 (default)."""
    assert calibrate_threshold([], []) == 50


def test_calibrate_mismatched_length_falls_back():
    """Mismatched length returns 50."""
    assert calibrate_threshold([80, 90], [1]) == 50


def test_calibrate_all_positives():
    """All positive → threshold of 0 produces F1=1.0 (all accepted)."""
    scores = [60, 70, 80, 90]
    labels = [1, 1, 1, 1]
    t = calibrate_threshold(scores, labels)
    assert t <= 60, f"Threshold {t} excludes all positives"


# ---------------------------------------------------------------------------
# write_prelabeled_csv
# ---------------------------------------------------------------------------

def test_write_prelabeled_csv_round_trip():
    """write_prelabeled_csv produces readable CSV with correct columns."""
    claims = [_make_claim("Scope 1: 500 tCO2e", category="emissions")]
    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as f:
        path = f.name
    write_prelabeled_csv(claims, path)
    rows = load_ground_truth(path)
    assert len(rows) == 1
    assert rows[0].raw_text == "Scope 1: 500 tCO2e"


if __name__ == "__main__":
    tests = sorted(f for f in dir() if f.startswith("test_"))
    passed = failed = 0
    for t in tests:
        try:
            globals()[t]()
            print(f"  PASS  {t}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {t}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ERROR {t}: {type(e).__name__}: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
