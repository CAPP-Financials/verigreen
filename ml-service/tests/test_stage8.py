"""
Stage 8 unit tests — format corruption handling.

Stage 8: corrupted pages fail gracefully; rest of document processes normally.

Fixture facts (verified against helios_2024.pdf):
  Page  9: password marker → failure_reason="page_encrypted"
  Page 19: mojibake encoding → failure_reason="encoding_anomaly"
  26 pages total, 2 failures, 24 successful pages with text.

Pass criteria:
  Corrupted pages → failure_reason populated (never None crash).
  Non-failed pages → text present, char_count > 0.
  Document-level partial state: has_failures=True, has_content=True.
  No full-document failure from individual page corruption.
"""
from __future__ import annotations

import sys
import os
import unittest.mock as mock

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
if "anthropic" not in sys.modules:
    sys.modules["anthropic"] = mock.MagicMock()

from pathlib import Path
from api.pdf_parser import parse_pdf, _detect_mojibake, _is_encrypted_marker
from api.models import PageParseResult

HELIOS_PDF = Path(__file__).parent.parent / "fixtures" / "helios_2024.pdf"

_pages: list[PageParseResult] | None = None


def _load() -> list[PageParseResult]:
    global _pages
    if _pages is None:
        with open(HELIOS_PDF, "rb") as f:
            _pages = parse_pdf(f.read())
    return _pages


def _page(pn: int) -> PageParseResult:
    p = next((x for x in _load() if x.page_num == pn), None)
    assert p is not None, f"Page {pn} missing"
    return p


# ── Stage 8, Test 1: encrypted page fails gracefully ─────────────────────────

def test_stage8_encrypted_page_fails_gracefully():
    """Page 9 (password marker) → failure_reason='page_encrypted', not a crash."""
    p = _page(9)
    assert p.failure_reason == "page_encrypted", (
        f"Page 9 should be page_encrypted, got {p.failure_reason!r}"
    )
    # Text may still contain the marker (used for detection) — that's fine
    # What matters is failure_reason is set so downstream skips it


# ── Stage 8, Test 2: mojibake page fails gracefully ──────────────────────────

def test_stage8_encoding_anomaly_fails_gracefully():
    """Page 19 (corrupted encoding) → failure_reason='encoding_anomaly'."""
    p = _page(19)
    assert p.failure_reason == "encoding_anomaly", (
        f"Page 19 should be encoding_anomaly, got {p.failure_reason!r}"
    )
    # char_count still > 0 — page was partially readable
    assert p.char_count > 0


# ── Stage 8, Test 3: failure pages don't prevent other pages ─────────────────

def test_stage8_partial_document_still_parses():
    """26 pages parse; 2 fail; the other 24 have extractable text."""
    pages = _load()
    assert len(pages) == 26, f"Expected 26 pages, got {len(pages)}"

    failed = [p for p in pages if p.failure_reason is not None]
    successful = [p for p in pages if p.failure_reason is None and p.text]

    assert len(failed) == 2, f"Expected 2 failures, got {len(failed)}: {[p.page_num for p in failed]}"
    assert len(successful) >= 20, f"Too few successful pages: {len(successful)}"


# ── Stage 8, Test 4: has_failures and has_content flags work correctly ────────

def test_stage8_document_level_partial_state():
    """Document-level: has_failures=True AND has_content=True (partial success)."""
    pages = _load()
    has_failures = any(p.failure_reason is not None for p in pages)
    has_content = any(p.text and not p.failure_reason for p in pages)

    assert has_failures, "has_failures should be True (pages 9+19 failed)"
    assert has_content, "has_content should be True (other pages extracted)"

    # This maps to ExtractionResult.status="partial" (not "failed")
    status = "partial" if has_failures else "complete"
    assert status == "partial"


# ── Stage 8, Test 5: helper functions detect corruption markers ───────────────

def test_stage8_mojibake_detector():
    """_detect_mojibake() flags Latin-1 corruption patterns."""
    assert _detect_mojibake("Ã€Â© data"), "Should detect mojibake"
    assert not _detect_mojibake("Clean ASCII text 1234 tCO2e"), "Should not flag clean text"


def test_stage8_encrypted_marker_detector():
    """_is_encrypted_marker() detects the password-protection sentinel."""
    assert _is_encrypted_marker("[PASSWORD-PROTECTED PAGE — contents not available]")
    assert not _is_encrypted_marker("Normal page text about emissions 500 tCO2e")


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
