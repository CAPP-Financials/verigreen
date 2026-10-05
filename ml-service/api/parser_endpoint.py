import httpx
from .models import ParseRequest, ParseResult, PageParseResult, AdversarialIndicators
from .pdf_parser import check_pdf_metadata
from .mistral_ocr import call_mistral_ocr
from .adversarial import sanitize_text, merge_adversarial_indicators

async def run_parse(req: ParseRequest) -> ParseResult:
    # Step 1: Download PDF bytes for metadata adversarial check
    async with httpx.AsyncClient(timeout=30.0) as client:
        pdf_resp = await client.get(req.signed_url)
        pdf_resp.raise_for_status()
    meta_indicators = check_pdf_metadata(pdf_resp.content)  # from pdf_parser.py

    # Step 2: Mistral OCR
    pages, _ = await call_mistral_ocr(req.signed_url)

    # Step 3: Adversarial checks on text
    global_adv = merge_adversarial_indicators(AdversarialIndicators(), meta_indicators)
    sanitized = []
    for page in pages:
        clean_text, page_adv = sanitize_text(page.text)  # adversarial.py
        global_adv = merge_adversarial_indicators(global_adv, page_adv)
        if page.has_hidden_text:
            global_adv.has_hidden_text = True
        sanitized.append(page.model_copy(update={"text": clean_text}))

    return ParseResult(
        job_id=req.job_id, document_id=req.document_id,
        organization_id=req.org_id, page_results=sanitized,
        adversarial_indicators=global_adv, status="ok",
    )
