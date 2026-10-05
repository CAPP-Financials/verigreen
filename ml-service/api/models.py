"""Shared Pydantic models for the ML service."""
from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field


class IngestRequest(BaseModel):
    job_id: str
    document_id: str
    org_id: str
    signed_url: str
    callback_url: str
    webhook_secret: str


class ParseRequest(BaseModel):
    job_id: str
    document_id: str
    org_id: str
    signed_url: str


class ParseResult(BaseModel):
    job_id: str
    document_id: str
    organization_id: str
    page_results: list[PageParseResult]
    adversarial_indicators: AdversarialIndicators
    status: Literal["ok", "failed"]
    error: Optional[dict] = None


class ScoreRequest(BaseModel):
    job_id: str
    claims: list[ExtractedClaim]


class ScoreResult(BaseModel):
    job_id: str
    claims: list[ExtractedClaim]   # same claims with .substantiation populated


class MatchRequest(BaseModel):
    claim_embedding: list[float]   # 768-dimensional Gemini vector
    raw_text: str
    unit: Optional[str] = None
    category: Optional[str] = None
    job_id: str


class FeedbackRequest(BaseModel):
    validation_id: str
    claim_embedding: list[float]
    correct_node_id: str
    wrong_node_id: Optional[str] = None
    system_score: float = 0.0
    system_correct: bool = True
    org_id: str


class TaxonomyMapping(BaseModel):
    node_id: Optional[str] = None
    framework: Optional[Literal["GRI", "SASB"]] = None
    code: Optional[str] = None
    label: Optional[str] = None
    score: float = 0.0
    routing: Literal["matched", "requires_manual_review", "unmapped"] = "unmapped"


class ExtractedClaim(BaseModel):
    raw_text: str
    page_num: int
    char_start: int
    char_end: int
    normalized_value: Optional[float] = None
    unit: Optional[str] = None
    category: Optional[Literal["emissions", "energy", "water", "waste", "other"]] = None
    normalized_value_uncertain: bool = False
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    taxonomy: Optional[TaxonomyMapping] = None
    substantiation: Optional[SubstantiationResult] = None


class SubstantiationIndicators(BaseModel):
    vague_language: bool = False
    vague_language_evidence: Optional[str] = None
    lacks_quantification: bool = False
    lacks_quantification_evidence: Optional[str] = None
    lacks_baseline: bool = False
    lacks_baseline_evidence: Optional[str] = None
    lacks_time_bound: bool = False
    lacks_time_bound_evidence: Optional[str] = None
    lacks_third_party_verification: bool = False
    lacks_third_party_verification_evidence: Optional[str] = None
    # Layer 6
    unverified_third_party_claim: bool = False
    unverified_authority: Optional[str] = None
    has_known_verifier: bool = False
    suspiciously_perfect_score: bool = False
    # Layer 7
    has_imperative_spans: bool = False
    has_encoded_content: bool = False


class SubstantiationResult(BaseModel):
    score: int  # 0–100
    indicators: SubstantiationIndicators = Field(default_factory=SubstantiationIndicators)
    disclaimer: str = ""
    requires_manual_review: bool = False


class AdversarialIndicators(BaseModel):
    has_direct_injection: bool = False
    has_hidden_text: bool = False
    has_metadata_injection: bool = False  # Vector 2: adversarial content in PDF metadata fields
    has_jailbreak_attempt: bool = False
    has_exfiltration_attempt: bool = False
    has_system_prompt_leak_attempt: bool = False
    has_authority_impersonation: bool = False
    has_encoded_payload: bool = False
    has_multi_step_injection: bool = False
    has_imperative_spans: bool = False
    detected_vectors: list[str] = Field(default_factory=list)


class PageParseResult(BaseModel):
    page_num: int
    text: str
    char_count: int
    is_ocr_fallback: bool = False
    has_hidden_text: bool = False
    failure_reason: Optional[str] = None


class ExtractionMetrics(BaseModel):
    tokens_in: int = 0
    tokens_out: int = 0
    duration_ms: int = 0
    model_calls: int = 0
    passes: int = 0
    escalated: bool = False


# Adversarial Layer 8: per-call model audit log entry.
# Hashes enable replay detection without retaining full prompt text.
class ModelCallLogEntry(BaseModel):
    model_id: str
    system_prompt_hash: str   # sha256 hex of the system prompt used
    user_message_hash: str    # sha256 hex of the wrapped user message
    output_hash: str          # sha256 hex of raw LLM text output
    tokens_in: int
    tokens_out: int
    duration_ms: int


class ExtractionResult(BaseModel):
    job_id: str
    document_id: str
    organization_id: str
    status: Literal["complete", "failed", "partial"]
    claims: list[ExtractedClaim] = Field(default_factory=list)
    adversarial_indicators: AdversarialIndicators = Field(default_factory=AdversarialIndicators)
    page_results: list[PageParseResult] = Field(default_factory=list)
    error: Optional[dict] = None
    metrics: ExtractionMetrics = Field(default_factory=ExtractionMetrics)
    # Layer 8: per-call audit log, written to model_call_log table by Worker on callback
    model_call_logs: list[ModelCallLogEntry] = Field(default_factory=list)


# LLM extraction response schema — enforced via Pydantic (Layer 2)
class LLMClaimItem(BaseModel):
    raw_text: str
    page_num: int
    char_start: int
    char_end: int
    normalized_value: Optional[float] = None
    unit: Optional[str] = None
    category: Optional[str] = None


class LLMExtractionResponse(BaseModel):
    claims: list[LLMClaimItem] = Field(default_factory=list)
