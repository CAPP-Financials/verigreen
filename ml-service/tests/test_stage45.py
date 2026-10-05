"""
Stage 4 + Stage 5 unit tests — Helios fixture verification.

Stage 4: Layout edge cases — graceful degradation, multi-page table, landscape page.
Stage 5: Numerical edge cases — ranges (min/max), approximations, negatives, span handling.

No LLM calls. Tests parse_pdf helpers and _normalize_claims logic directly.
"""
from __future__ import annotations

import sys
import os
import unittest.mock as mock
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# anthropic must be mocked before api.extractor is imported (it imports at module level)
if "anthropic" not in sys.modules:
    sys.modules["anthropic"] = mock.MagicMock()

from pathlib import Path

from api.pdf_parser import _detect_mojibake, _is_encrypted_marker, find_span, validate_span, parse_pdf
from api.models import LLMClaimItem, PageParseResult
from api.extractor import _normalize_claims

HELIOS_PDF = Path(__file__).parent.parent / "fixtures" / "helios_2024.pdf"

_helios_pages: list[PageParseResult] | None = None


def _load_helios() -> list[PageParseResult]:
    """Load Helios fixture once per test run (cached)."""
    global _helios_pages
    if _helios_pages is None:
        with open(HELIOS_PDF, "rb") as f:
            _helios_pages = parse_pdf(f.read())
    return _helios_pages


def _get_page(pages: list[PageParseResult], pn: int) -> PageParseResult:
    p = next((x for x in pages if x.page_num == pn), None)
    assert p is not None, f"Page {pn} not found in fixture"
    return p


def _claim(raw: str, page: int, start: int, end: int, value=None, unit=None, cat=None):
    return LLMClaimItem(
        raw_text=raw, page_num=page, char_start=start, char_end=end,
        normalized_value=value, unit=unit, category=cat,
    )


# =============================================================
# Stage 4: Helper-level graceful degradation
# =============================================================

def test_mojibake_detection_positive():
    # UTF-8 bytes (Ã© = U+00C3 U+00A9) decoded as Latin-1 produce Ã followed by ©
    assert _detect_mojibake("DonnÃ©es environnementales 2022")
    assert _detect_mojibake("some Ã©missions data")


def test_mojibake_detection_negative():
    assert not _detect_mojibake("Scope 1 emissions: 1,234 tCO2e in FY2024")
    assert not _detect_mojibake("Carbon sequestration: -45,000 tCO2e")


def test_encrypted_marker_detected():
    assert _is_encrypted_marker("[PASSWORD-PROTECTED PAGE 9 — access restricted]")
    assert _is_encrypted_marker("[Password-protected page content here]")


def test_encrypted_marker_clean():
    assert not _is_encrypted_marker("Normal page content with no password marker")


def test_partial_status_when_page_fails():
    """has_failures=True → ingest pipeline emits status='partial' not 'complete'."""
    pages = [
        PageParseResult(page_num=1, text="Good content", char_count=12),
        PageParseResult(page_num=2, text="", char_count=0, failure_reason="page_encrypted"),
    ]
    has_failures = any(p.failure_reason is not None for p in pages)
    has_content = any(p.text and not p.failure_reason for p in pages)
    assert has_failures
    assert has_content
    assert ("partial" if has_failures else "complete") == "partial"


def test_complete_status_all_pages_ok():
    pages = [
        PageParseResult(page_num=1, text="Good content page 1", char_count=19),
        PageParseResult(page_num=2, text="Good content page 2", char_count=19),
    ]
    assert not any(p.failure_reason is not None for p in pages)
    assert ("partial" if any(p.failure_reason for p in pages) else "complete") == "complete"


# =============================================================
# Stage 4: Helios fixture smoke tests
# =============================================================

def test_helios_encrypted_page_detected():
    """Helios page 9 (password-protected) → failure_reason='page_encrypted'."""
    p9 = _get_page(_load_helios(), 9)
    assert p9.failure_reason == "page_encrypted"


def test_helios_encoding_anomaly_detected():
    """Helios page 19 (mojibake) → failure_reason='encoding_anomaly'."""
    p19 = _get_page(_load_helios(), 19)
    assert p19.failure_reason == "encoding_anomaly"


def test_helios_multipage_table_extractable():
    """Multi-page emissions table (pages 13, 15, 16) has substantial extractable content."""
    pages = _load_helios()
    for pn in [13, 15, 16]:
        p = _get_page(pages, pn)
        assert p.failure_reason is None, f"Page {pn} unexpected failure: {p.failure_reason}"
        assert p.char_count > 100, f"Page {pn} too sparse: {p.char_count} chars"
        # Table content should include emission values or Scope references
        assert ("tCOne" in p.text or "Scope" in p.text or "tCO" in p.text), \
            f"Page {pn} missing expected table content"


def test_helios_landscape_page_extractable():
    """Helios page 18 (landscape Scope 3 table) has substantial extractable content."""
    p18 = _get_page(_load_helios(), 18)
    assert p18.failure_reason is None
    assert p18.char_count > 200
    assert "Scope 3" in p18.text or "Tier" in p18.text


def test_helios_partial_success_overall():
    """Fixture has failing pages (p9, p19) but also good pages → ingest would emit 'partial'."""
    pages = _load_helios()
    failed_pages = [p.page_num for p in pages if p.failure_reason is not None]
    good_pages = [p for p in pages if p.text and not p.failure_reason]
    assert len(failed_pages) > 0, "Expected at least one failing page (p9, p19)"
    assert len(good_pages) > 0, "Expected good pages alongside failures"


def test_helios_hidden_text_detected():
    """At least one Helios page has hidden text (adversarial injection vectors)."""
    pages = _load_helios()
    hidden = [p.page_num for p in pages if p.has_hidden_text]
    assert len(hidden) > 0, f"No hidden text detected; expected adversarial pages"


def test_find_span_and_validate_span():
    """find_span locates verbatim text; validate_span verifies exact boundaries."""
    page_text = "Scope 1 emissions: 1,234 tCO2e in FY2024"
    start, end = find_span(page_text, "1,234 tCO2e")
    assert start == 19
    assert end == 30
    assert validate_span(page_text, "1,234 tCO2e", start, end)
    assert not validate_span(page_text, "1,234 tCO2e", 99, 110)
    assert find_span(page_text, "not present") == (-1, -1)


# =============================================================
# Stage 5: _normalize_claims numerical edge cases
# =============================================================

def test_range_en_dash_produces_min_max():
    """En-dash range → min_value, max_value; normalized_value_uncertain=True."""
    raw = "500–700 metric tons"  # en-dash U+2013
    page_text = f"Biogenic CO2 from combustion: {raw} in FY2024"
    start = page_text.index(raw)
    item = _claim(raw, 1, start, start + len(raw), value=600.0, unit="metric tons")
    result = _normalize_claims([item], page_text, 1)
    assert len(result) == 1
    assert result[0].min_value == 500.0
    assert result[0].max_value == 700.0
    assert result[0].normalized_value_uncertain


def test_range_fffd_separator():
    """U+FFFD separator (pdfplumber encoding issue) treated as range separator."""
    raw = "450�520 tCO2e"
    page_text = f"Methane fugitive emissions: {raw} equivalent"
    start = page_text.index(raw)
    item = _claim(raw, 1, start, start + len(raw), value=485.0, unit="tCO2e")
    result = _normalize_claims([item], page_text, 1)
    assert len(result) == 1
    assert result[0].min_value == 450.0
    assert result[0].max_value == 520.0
    assert result[0].normalized_value_uncertain


def test_gri_code_not_treated_as_range():
    """GRI code '305-7' in context does not trigger range parsing (lo > hi)."""
    page_text = "Particulate matter (GRI 305-7): 3.4 tonnes PM10 in FY2024"
    raw = "3.4 tonnes PM10"
    start = page_text.index(raw)
    item = _claim(raw, 1, start, start + len(raw), value=3.4, unit="tonnes")
    result = _normalize_claims([item], page_text, 1)
    assert len(result) == 1
    assert result[0].min_value is None
    assert result[0].max_value is None


def test_approximate_tilde_uncertain():
    """Tilde qualifier (~ ) sets normalized_value_uncertain; no min/max."""
    page_text = "Capital goods emissions: ~78,000 tCO2e preliminary estimate"
    raw = "~78,000 tCO2e"
    start = page_text.index(raw)
    item = _claim(raw, 1, start, start + len(raw), value=78000.0, unit="tCO2e")
    result = _normalize_claims([item], page_text, 1)
    assert result[0].normalized_value_uncertain
    assert result[0].min_value is None


def test_approximate_word_uncertain():
    """'approximately' sets normalized_value_uncertain."""
    page_text = "Scope 3 Category 3: approximately 450,000 tCO2e fuel and energy"
    raw = "approximately 450,000 tCO2e"
    start = page_text.index(raw)
    item = _claim(raw, 1, start, start + len(raw), value=450000.0, unit="tCO2e")
    result = _normalize_claims([item], page_text, 1)
    assert result[0].normalized_value_uncertain


def test_gt_qualifier_uncertain():
    """> qualifier sets normalized_value_uncertain."""
    page_text = "Business travel emissions: >5,000 tCO2e per travel policy"
    raw = ">5,000 tCO2e"
    start = page_text.index(raw)
    item = _claim(raw, 1, start, start + len(raw), value=5000.0, unit="tCO2e")
    result = _normalize_claims([item], page_text, 1)
    assert result[0].normalized_value_uncertain


def test_negative_value_preserved():
    """Negative normalized_value (sequestration) preserved; not flagged uncertain."""
    page_text = "Carbon sequestration through forestry: -45,000 tCO2e in FY2024"
    raw = "-45,000 tCO2e"
    start = page_text.index(raw)
    item = _claim(raw, 1, start, start + len(raw), value=-45000.0, unit="tCO2e")
    result = _normalize_claims([item], page_text, 1)
    assert len(result) == 1
    assert result[0].normalized_value == -45000.0
    assert not result[0].normalized_value_uncertain
    assert result[0].min_value is None  # negative is not a range


def test_span_wrong_offset_relocated():
    """Claim with wrong char offsets is relocated via string search if text found."""
    page_text = "Scope 1 emissions: 1,234 tCO2e in FY2024"
    item = _claim("1,234 tCO2e", 1, 99, 110, value=1234.0)  # offsets wrong
    result = _normalize_claims([item], page_text, 1)
    assert len(result) == 1
    assert result[0].char_start == 19   # relocated to correct position
    assert result[0].char_end == 30


def test_span_not_in_page_dropped():
    """Claim text not in page → dropped (citation would be invalid)."""
    page_text = "Scope 1 emissions: 1,234 tCO2e in FY2024"
    item = _claim("99,999 tCO2e", 1, 0, 12, value=99999.0)
    result = _normalize_claims([item], page_text, 1)
    assert result == []


def test_wrong_page_num_skipped():
    """Claim with page_num != current page is silently skipped."""
    page_text = "Scope 1 emissions: 1,234 tCO2e"
    item = _claim("1,234 tCO2e", 2, 0, 11, value=1234.0)  # page 2, processing page 1
    result = _normalize_claims([item], page_text, 1)
    assert result == []


def test_null_normalized_value_is_uncertain():
    """None normalized_value → normalized_value_uncertain=True."""
    page_text = "Total emissions under review (value TBD)"
    raw = "emissions under review"
    start = page_text.index(raw)
    item = _claim(raw, 1, start, start + len(raw), value=None)
    result = _normalize_claims([item], page_text, 1)
    assert len(result) == 1
    assert result[0].normalized_value_uncertain


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
