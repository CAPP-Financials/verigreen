"""
Adversarial Layer 8 unit tests — per-call model audit log.

Tests:
  - _hash_text produces deterministic sha256 hex
  - extract_claims returns 4-tuple (claims, adversarial, metrics, call_logs)
  - Each LLM call produces a ModelCallLogEntry with correct fields
  - Hash fields are 64-char hex strings
  - Empty pages produce no log entries

Uses mock.patch("api.extractor.anthropic") to patch the extractor's module-level
anthropic reference directly — works correctly both standalone and in the
regression runner (avoids sys.modules["anthropic"] re-binding issues).
"""
from __future__ import annotations

import hashlib
import json
import sys
import os
import unittest.mock as mock

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

if "anthropic" not in sys.modules:
    sys.modules["anthropic"] = mock.MagicMock()

from api.extractor import _hash_text, extract_claims
from api.models import ModelCallLogEntry, PageParseResult

# Realistic LLM response fixture
_MOCK_OUTPUT = json.dumps({"claims": [
    {
        "raw_text": "Scope 1 emissions 1000 tCO2e",
        "page_num": 1,
        "char_start": 0,
        "char_end": 28,
        "normalized_value": 1000.0,
        "unit": "tCO2e",
        "category": "emissions",
    }
]})


def _make_mock_anthropic():
    """Build a realistic anthropic mock that returns parseable responses."""
    msg = mock.MagicMock()
    msg.content = [mock.MagicMock(text=_MOCK_OUTPUT)]
    msg.usage.input_tokens = 100
    msg.usage.output_tokens = 50
    anthro = mock.MagicMock()
    anthro.Anthropic.return_value.messages.create.return_value = msg
    return anthro


def _make_page(text: str, page_num: int = 1) -> PageParseResult:
    return PageParseResult(page_num=page_num, text=text, char_count=len(text))


# ── _hash_text ────────────────────────────────────────────────────────────────

def test_hash_text_returns_sha256_hex():
    """_hash_text produces a 64-char lowercase hex sha256."""
    h = _hash_text("hello world")
    assert len(h) == 64, f"Expected 64 chars, got {len(h)}"
    assert h == hashlib.sha256("hello world".encode()).hexdigest()


def test_hash_text_deterministic():
    """Same input always produces same hash."""
    assert _hash_text("test") == _hash_text("test")


def test_hash_text_distinct_inputs():
    """Different inputs produce different hashes."""
    assert _hash_text("a") != _hash_text("b")


# ── extract_claims 4-tuple return ─────────────────────────────────────────────

def test_extract_claims_returns_4_tuple():
    """extract_claims returns (claims, adversarial, metrics, call_logs)."""
    with mock.patch("api.extractor.anthropic", _make_mock_anthropic()):
        result = extract_claims([_make_page("Scope 1: 1000 tCO2e FY2024.")])
    assert len(result) == 4, f"Expected 4-tuple, got {len(result)}"


def test_extract_claims_log_entries_populated():
    """Each LLM call produces a ModelCallLogEntry in call_logs."""
    with mock.patch("api.extractor.anthropic", _make_mock_anthropic()):
        _, _, _, call_logs = extract_claims([_make_page("Scope 1: 1000 tCO2e FY2024.")])
    assert len(call_logs) >= 1, "Expected at least one log entry"
    assert all(isinstance(e, ModelCallLogEntry) for e in call_logs)


def test_log_entry_hash_fields_are_hex():
    """Log entry hash fields are 64-char hex strings."""
    with mock.patch("api.extractor.anthropic", _make_mock_anthropic()):
        _, _, _, call_logs = extract_claims([_make_page("Energy: 5000 MWh FY2024.")])
    assert call_logs, "No log entries produced"
    entry = call_logs[0]
    for field_name in ("system_prompt_hash", "user_message_hash", "output_hash"):
        val = getattr(entry, field_name)
        assert len(val) == 64, f"{field_name} length {len(val)} != 64"
        assert all(c in "0123456789abcdef" for c in val), f"{field_name} not hex"


def test_log_entry_token_counts():
    """Log entry captures token counts from LLM response."""
    with mock.patch("api.extractor.anthropic", _make_mock_anthropic()):
        _, _, _, call_logs = extract_claims([_make_page("Water: 500 ML FY2024.")])
    assert call_logs
    entry = call_logs[0]
    assert entry.tokens_in == 100   # matches mock
    assert entry.tokens_out == 50   # matches mock


def test_log_entry_model_id():
    """Log entry records the model_id string."""
    with mock.patch("api.extractor.anthropic", _make_mock_anthropic()):
        _, _, _, call_logs = extract_claims([_make_page("Waste: 200 tonnes FY2024.")])
    assert call_logs
    assert call_logs[0].model_id != "", "model_id should not be empty"


def test_log_entry_duration_positive():
    """Log entry duration_ms is a non-negative integer."""
    with mock.patch("api.extractor.anthropic", _make_mock_anthropic()):
        _, _, _, call_logs = extract_claims([_make_page("Scope 2: 500 tCO2e FY2024.")])
    assert call_logs
    assert call_logs[0].duration_ms >= 0


def test_extract_claims_empty_page_no_logs():
    """Pages with no text produce no log entries (no LLM calls made)."""
    with mock.patch("api.extractor.anthropic", _make_mock_anthropic()):
        _, _, _, call_logs = extract_claims([_make_page("")])
    assert call_logs == [], f"Expected empty logs for empty page, got {len(call_logs)}"


def test_multi_page_produces_multiple_logs():
    """Two pages with text → at least 2 log entries (one per pass per page)."""
    pages = [
        _make_page("Scope 1: 1000 tCO2e FY2024.", page_num=1),
        _make_page("Energy: 5000 MWh FY2024.", page_num=2),
    ]
    with mock.patch("api.extractor.anthropic", _make_mock_anthropic()):
        _, _, _, call_logs = extract_claims(pages)
    assert len(call_logs) >= 2, f"Expected >=2 logs for 2 pages, got {len(call_logs)}"


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
