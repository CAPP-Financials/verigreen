"""
PDF ingestion — pdfplumber primary, tesseract OCR fallback.

Page-aware extraction preserving:
- page_num (1-indexed)
- character offsets (relative to the page's extracted text string)
- hidden text detection (white-on-white, very small font)
- mojibake/encoding anomaly detection
"""
from __future__ import annotations

import io
import re
from typing import Optional

import pdfplumber
from PIL import Image

from .models import AdversarialIndicators, PageParseResult

# Minimum chars to consider a page text-extracted (below this → OCR fallback)
_MIN_TEXT_CHARS = 30

# Hidden text markers: white or near-white fill, or font size < 2
_WHITE_FILL_THRESHOLD = 240  # RGB value considered "white"

# Mojibake detection: sequences of Latin-1 corruption patterns
_MOJIBAKE_PATTERN = re.compile(r"[ÃÂÄÅ][€©¢®¬]{1,3}")

# Fixture markers we should NOT attempt to extract as claims
_FIXTURE_MARKER = re.compile(r"TEST FIXTURE (?:NOTE|MARKER)", re.I)
_PASSWORD_MARKER = re.compile(r"\[PASSWORD-PROTECTED PAGE", re.I)


def _detect_hidden_text(page: "pdfplumber.page.Page") -> bool:
    """Check for white-on-white or sub-2pt font text (adversarial hidden text)."""
    try:
        for char in page.chars:
            size = char.get("size", 10)
            color = char.get("non_stroking_color")
            if size is not None and size < 2:
                return True
            # Detect near-white fill (reportlab sets color as float 0-1 or int 0-255)
            if color is not None:
                if isinstance(color, (int, float)) and color > 0.94:
                    return True
                if isinstance(color, (list, tuple)) and len(color) == 3:
                    if all(c > 0.94 for c in color):
                        return True
    except Exception:
        pass
    return False


def _detect_mojibake(text: str) -> bool:
    return bool(_MOJIBAKE_PATTERN.search(text))


def _is_encrypted_marker(text: str) -> bool:
    return bool(_PASSWORD_MARKER.search(text))


def _ocr_page(page: "pdfplumber.page.Page") -> str:
    """Render page to image and OCR with tesseract."""
    try:
        import pytesseract

        img = page.to_image(resolution=150).original
        return pytesseract.image_to_string(img, config="--psm 6")
    except Exception as e:
        return f"[OCR_FAILED: {e}]"


# Adversarial keywords to look for in PDF metadata fields (Author, Title, Keywords, Subject)
_META_ADVERSARIAL_RE = re.compile(
    r'\b(?:override|bypass|ignore|system\s*:?|instruction|disable|inject|directive|set\s+confidence'
    r'|admin|administrator|exempt)\b',
    re.IGNORECASE,
)


def check_pdf_metadata(pdf_bytes: bytes) -> "AdversarialIndicators":
    """
    Layer 1 / Vector 2: scan PDF metadata fields for adversarial content.
    Returns AdversarialIndicators with has_metadata_injection=True if found.
    """
    from .models import AdversarialIndicators

    indicators = AdversarialIndicators()
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            meta = pdf.metadata or {}
        # Check all metadata values (Author, Title, Keywords, Subject, etc.)
        combined = " ".join(str(v) for v in meta.values() if v)
        if _META_ADVERSARIAL_RE.search(combined):
            indicators.has_metadata_injection = True
            if "metadata_injection" not in indicators.detected_vectors:
                indicators.detected_vectors.append("metadata_injection")
    except Exception:
        pass
    return indicators


def parse_pdf(pdf_bytes: bytes) -> list[PageParseResult]:
    """
    Parse all pages of a PDF. Returns per-page results including:
    - extracted text (or OCR fallback)
    - hidden text detection flag
    - failure_reason for pages that could not be parsed
    """
    results: list[PageParseResult] = []

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            pg_num = page.page_number  # 1-indexed

            # Try text extraction first
            try:
                text = page.extract_text() or ""
            except Exception as e:
                results.append(PageParseResult(
                    page_num=pg_num,
                    text="",
                    char_count=0,
                    failure_reason=f"text_extraction_error: {e}",
                ))
                continue

            # Detect encrypted/password marker (Stage 8)
            if _is_encrypted_marker(text):
                results.append(PageParseResult(
                    page_num=pg_num,
                    text=text,
                    char_count=len(text),
                    failure_reason="page_encrypted",
                ))
                continue

            # Detect hidden text (Layer 1 adversarial check)
            has_hidden = _detect_hidden_text(page)

            # OCR fallback if insufficient text
            is_ocr = False
            if len(text.strip()) < _MIN_TEXT_CHARS:
                ocr_text = _ocr_page(page)
                if len(ocr_text.strip()) > _MIN_TEXT_CHARS:
                    text = ocr_text
                    is_ocr = True
                elif text.strip():
                    # Some text but below threshold — keep it, no OCR needed
                    pass
                else:
                    # Truly no text (image-only page)
                    results.append(PageParseResult(
                        page_num=pg_num,
                        text="",
                        char_count=0,
                        is_ocr_fallback=False,
                        has_hidden_text=has_hidden,
                        failure_reason="no_text_layer",
                    ))
                    continue

            # Detect mojibake encoding issues (Stage 8)
            failure: Optional[str] = None
            if _detect_mojibake(text):
                failure = "encoding_anomaly"

            # Strip fixture test notes — not real ESG content
            text = _FIXTURE_MARKER.sub("", text)

            results.append(PageParseResult(
                page_num=pg_num,
                text=text,
                char_count=len(text),
                is_ocr_fallback=is_ocr,
                has_hidden_text=has_hidden,
                failure_reason=failure,
            ))

    return results


def find_span(page_text: str, raw_text: str) -> tuple[int, int]:
    """Find char_start and char_end of raw_text within page_text (exact match)."""
    idx = page_text.find(raw_text)
    if idx == -1:
        return -1, -1
    return idx, idx + len(raw_text)


def validate_span(page_text: str, claim_raw_text: str, char_start: int, char_end: int) -> bool:
    """Verify that page_text[char_start:char_end] == claim_raw_text (exact span integrity)."""
    if char_start < 0 or char_end > len(page_text):
        return False
    return page_text[char_start:char_end] == claim_raw_text
