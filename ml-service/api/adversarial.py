"""
Adversarial robustness — Layers 1, 3, 4 (Layer 2 lives in extractor.py).

Layer 1: Input segregation + sanitization
  - Wrap extracted text in <document> XML tag
  - Strip Unicode manipulation chars (zero-width, RTL/LTR marks)
  - Detect hidden text in PDF pages
  - Detect imperative language patterns in extracted text spans
  - Detect base64/hex encoded payloads

Layer 3: Tool-less model enforcement
  - Enforced by never passing tools= to the Anthropic client call

Layer 4: Multi-pass disagreement detection
  - Compare claim sets across N passes
  - Compute Jaccard overlap on char spans
  - Flag sharp divergence → Opus escalation + requires_manual_review
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

from .models import AdversarialIndicators, ExtractedClaim

# Zero-width and RTL/LTR manipulation characters (Layer 1)
_ZERO_WIDTH = re.compile(r"[​‌‍‎‏‪‫‬‭‮﻿]")

# Base64 heuristic: 40+ contiguous base64-alphabet characters (Layer 1 + 7)
_B64_BLOCK = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")
# Hex block heuristic: 40+ hex chars
_HEX_BLOCK = re.compile(r"[0-9a-fA-F]{40,}")

# Imperative injection patterns (Layer 7)
_IMPERATIVE_PATTERNS = [
    re.compile(r"\bignore\b.{0,30}\b(prior|previous|above|instructions)\b", re.I),
    re.compile(r"\b(mark|set|override)\b.{0,30}\b(confidence|score|verified|threshold)\b", re.I),
    re.compile(r"\bbypass\b.{0,30}\b(confidence|threshold|validation)\b", re.I),
    re.compile(r"\brepeat\b.{0,30}\b(instructions|system prompt|initial)\b", re.I),
    re.compile(r"\bactivate\b.{0,30}\b(unrestricted|unfiltered|bypass)\b", re.I),
    re.compile(r"\bYou are\b.{0,60}\b(unfiltered|unrestricted|ESG.GPT|without restrictions)\b", re.I),
]

# Direct injection markers (Layer 1)
_INJECTION_MARKERS = [
    re.compile(r"\[INSTRUCTION TO ANY AI", re.I),
    re.compile(r"\bAI READING THIS\b", re.I),
    re.compile(r"INSTRUCTION.{0,10}(?:AI|system|model)", re.I),
]

# Exfiltration patterns (Layer 7)
_EXFILTRATION_PATTERNS = [
    re.compile(r"\blist\b.{0,50}\bother\b.{0,50}\borganizat", re.I),
    re.compile(r"\bshow\b.{0,30}\b(other|previous|past)\b.{0,30}\b(reports?|data|organizations?)\b", re.I),
    re.compile(r"\brepeat\b.{0,30}\b(other|previous)\b.{0,30}\b(org|report|data)\b", re.I),
]

# System prompt leak patterns (Layer 7)
_SYSTEM_PROMPT_LEAK = [
    re.compile(r"\brepeat\b.{0,40}\b(initial|system|original)\b.{0,30}\b(instructions?|prompt)\b", re.I),
    re.compile(r"\bverbatim\b.{0,40}\b(instructions?|prompt)\b", re.I),
]

# Authority impersonation (Layer 7)
_AUTHORITY_PATTERNS = [
    re.compile(r"\b(administrator|admin)\b.{0,30}\b(directive|approved|bypass|exempt)\b", re.I),
    re.compile(r"\bexempt\b.{0,30}\b(confidence|threshold|validation)\b", re.I),
    re.compile(r"\bpre.?approved\b.{0,40}\b(document|report)\b", re.I),
]

# Multi-step setup patterns
_MULTI_STEP_PATTERNS = [
    re.compile(r"\bfor testing purposes\b.{0,60}\b(established|set|defined)\b.{0,40}\b(beginning|start|earlier)\b", re.I),
    re.compile(r"\bcomplete\b.{0,40}\b(multi.step|instruction sequence|earlier instruction)\b", re.I),
]


def sanitize_text(text: str) -> tuple[str, AdversarialIndicators]:
    """
    Layer 1: Strip manipulation characters, detect injection patterns.
    Returns (sanitized_text, adversarial_indicators).
    """
    indicators = AdversarialIndicators()
    vectors: list[str] = []

    # Strip zero-width and bidirectional control characters
    stripped = _ZERO_WIDTH.sub("", text)

    # Check for direct injection markers
    for pat in _INJECTION_MARKERS:
        if pat.search(stripped):
            indicators.has_direct_injection = True
            vectors.append("direct_instruction_injection")
            break

    # Check for imperative language (Layer 7 output anomaly)
    for pat in _IMPERATIVE_PATTERNS:
        if pat.search(stripped):
            indicators.has_imperative_spans = True
            vectors.append("imperative_override_language")
            break

    # Check for encoded payloads (Layer 7)
    if _B64_BLOCK.search(stripped):
        indicators.has_encoded_payload = True
        vectors.append("base64_encoded_payload")
    if _HEX_BLOCK.search(stripped):
        indicators.has_encoded_payload = True
        vectors.append("hex_encoded_payload")

    # Check for exfiltration attempts
    for pat in _EXFILTRATION_PATTERNS:
        if pat.search(stripped):
            indicators.has_exfiltration_attempt = True
            vectors.append("data_exfiltration_attempt")
            break

    # Check for system prompt leak attempts
    for pat in _SYSTEM_PROMPT_LEAK:
        if pat.search(stripped):
            indicators.has_system_prompt_leak_attempt = True
            vectors.append("system_prompt_leak_attempt")
            break

    # Check for jailbreak/persona attempts
    if re.search(r"\bYou are\b.{0,80}\b(unfiltered|unrestricted|approves? all)\b", stripped, re.I):
        indicators.has_jailbreak_attempt = True
        vectors.append("jailbreak_persona_injection")

    # Check for authority impersonation
    for pat in _AUTHORITY_PATTERNS:
        if pat.search(stripped):
            indicators.has_authority_impersonation = True
            vectors.append("authority_impersonation")
            break

    # Check for multi-step injection
    for pat in _MULTI_STEP_PATTERNS:
        if pat.search(stripped):
            indicators.has_multi_step_injection = True
            vectors.append("multi_step_injection")
            break

    indicators.detected_vectors = vectors
    return stripped, indicators


def wrap_for_extraction(page_text: str) -> str:
    """Layer 1: Wrap extracted text in XML tag so LLM treats it as data, not instructions."""
    return f"<document>\n{page_text}\n</document>"


def merge_adversarial_indicators(a: AdversarialIndicators, b: AdversarialIndicators) -> AdversarialIndicators:
    """Combine two indicator sets (OR all booleans, union all vectors)."""
    return AdversarialIndicators(
        has_direct_injection=a.has_direct_injection or b.has_direct_injection,
        has_hidden_text=a.has_hidden_text or b.has_hidden_text,
        has_jailbreak_attempt=a.has_jailbreak_attempt or b.has_jailbreak_attempt,
        has_exfiltration_attempt=a.has_exfiltration_attempt or b.has_exfiltration_attempt,
        has_system_prompt_leak_attempt=a.has_system_prompt_leak_attempt or b.has_system_prompt_leak_attempt,
        has_authority_impersonation=a.has_authority_impersonation or b.has_authority_impersonation,
        has_encoded_payload=a.has_encoded_payload or b.has_encoded_payload,
        has_multi_step_injection=a.has_multi_step_injection or b.has_multi_step_injection,
        has_imperative_spans=a.has_imperative_spans or b.has_imperative_spans,
        detected_vectors=list(set(a.detected_vectors + b.detected_vectors)),
    )


def _span_overlap(a: ExtractedClaim, b: ExtractedClaim) -> float:
    """Jaccard overlap of character spans for two claims on the same page."""
    if a.page_num != b.page_num:
        return 0.0
    start = max(a.char_start, b.char_start)
    end = min(a.char_end, b.char_end)
    intersection = max(0, end - start)
    union = (a.char_end - a.char_start) + (b.char_end - b.char_start) - intersection
    return intersection / union if union > 0 else 0.0


def compute_pass_agreement(
    pass_results: list[list[ExtractedClaim]],
    overlap_threshold: float = 0.5,
) -> tuple[list[ExtractedClaim], bool]:
    """
    Layer 4: Compare N extraction passes. Returns (agreed_claims, escalation_required).

    Agreement: a claim appears in ≥ ceil(N/2) + 1 passes with span overlap > threshold.
    Escalation: required if any claim appears in only 1 pass (sharp divergence).
    """
    if not pass_results:
        return [], False
    if len(pass_results) == 1:
        return pass_results[0], False

    n = len(pass_results)
    min_agreement = (n // 2) + 1

    # Flatten all claims with pass index
    all_claims: list[tuple[int, ExtractedClaim]] = [
        (pass_idx, claim)
        for pass_idx, claims in enumerate(pass_results)
        for claim in claims
    ]

    agreed: list[ExtractedClaim] = []
    escalation_required = False
    used: set[tuple[int, int]] = set()  # (pass_idx, claim_idx) already matched

    for base_pass, base_claim in [(p, c) for p, c in all_claims if p == 0]:
        base_idx = pass_results[0].index(base_claim)
        if (0, base_idx) in used:
            continue

        matching_passes = {0}
        for other_pass in range(1, n):
            for other_idx, other_claim in enumerate(pass_results[other_pass]):
                if (other_pass, other_idx) in used:
                    continue
                if _span_overlap(base_claim, other_claim) >= overlap_threshold:
                    matching_passes.add(other_pass)
                    used.add((other_pass, other_idx))
                    break

        used.add((0, base_idx))

        if len(matching_passes) >= min_agreement:
            agreed.append(base_claim)
        else:
            # This claim only appeared in 1 pass — divergence signal
            escalation_required = True

    return agreed, escalation_required
