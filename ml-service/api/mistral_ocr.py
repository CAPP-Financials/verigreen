import httpx, os, re

MISTRAL_OCR_URL = "https://api.mistral.ai/v1/ocr"
_FIXTURE_MARKER = re.compile(r"\[TEST-FIXTURE-[A-Z0-9]+\]")

async def call_mistral_ocr(signed_url: str) -> tuple[list, dict]:
    """
    Returns (page_results: list[PageParseResult], raw_response: dict)
    Mistral OCR response shape:
      {"pages": [{"index": 0, "markdown": "...", "images": [], "dimensions": {...}}]}
    """
    payload = {
        "model": "mistral-ocr-latest",
        "document": {"type": "document_url", "document_url": signed_url},
        "include_image_base64": False,
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            MISTRAL_OCR_URL,
            json=payload,
            headers={"Authorization": f"Bearer {os.getenv(\'MISTRAL_API_KEY\', \'\')}",
                     "Content-Type": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()

    pages = []
    for page in data.get("pages", []):
        text = _FIXTURE_MARKER.sub("", page.get("markdown", ""))
        has_potential_hidden = (
            len(page.get("images", [])) > 0 and len(text.strip()) < 30
        )
        pages.append(PageParseResult(
            page_num=page["index"] + 1,   # 1-indexed
            text=text,
            char_count=len(text),
            is_ocr_fallback=True,          # Mistral OCR is the extraction method
            has_hidden_text=has_potential_hidden,
            failure_reason=None if text.strip() else "no_text_layer",
        ))
    return pages, data
