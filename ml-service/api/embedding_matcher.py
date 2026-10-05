import math, os
from typing import Optional
import httpx

# In-memory store: node_id → list of embedding vectors (anchors)
_node_embeddings: dict[str, list[list[float]]] = {}
_correction_history: list[dict] = []
_feedback_counter = 0

# Routing thresholds (calibrated by /feedback, starting values)
_MATCH_THRESHOLD = 0.65
_REVIEW_THRESHOLD = 0.35

def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    return dot / (norm_a * norm_b) if norm_a and norm_b else 0.0

def match_claim_embedding(
    claim_embedding: list[float],
    raw_text: str,
    unit: Optional[str],
    category: Optional[str],
) -> TaxonomyMapping:
    """Cosine similarity against all anchors, category+unit bonus, threshold routing."""
    if not _node_embeddings:
        # TF-IDF fallback if embeddings not loaded yet
        from .taxonomy import get_mapper
        from .models import ExtractedClaim
        dummy = ExtractedClaim(raw_text=raw_text, page_num=1, char_start=0,
                               char_end=len(raw_text), unit=unit, category=category)
        return get_mapper().map_claim(dummy)

    mapper = get_mapper()
    best_node_id, best_score = None, 0.0

    for node in mapper._nodes:
        nid = node["id"]
        anchors = _node_embeddings.get(nid, [])
        if not anchors:
            continue
        score = max(cosine_similarity(claim_embedding, a) for a in anchors)
        if category and category == node.get("category"):
            score = min(score + 0.08, 1.0)
        if unit:
            from .taxonomy import _normalize_unit
            if _normalize_unit(unit) in {_normalize_unit(u) for u in node.get("units", [])}:
                score = min(score + 0.05, 1.0)
        if score > best_score:
            best_score, best_node_id = score, nid

    score_r = round(best_score, 4)
    if not best_node_id or best_score < _REVIEW_THRESHOLD:
        return TaxonomyMapping(score=score_r, routing="unmapped")

    routing = "matched" if best_score >= _MATCH_THRESHOLD else "requires_manual_review"
    node = mapper._node_map[best_node_id]
    return TaxonomyMapping(
        node_id=best_node_id, framework=node["framework"],
        code=node["code"], label=node["label"],
        score=score_r, routing=routing,
    )

def apply_feedback(
    claim_embedding: list[float],
    correct_node_id: str,
    wrong_node_id: Optional[str] = None,
    system_score: float = 0.0,
    system_correct: bool = True,
) -> int:
    """Add positive anchor. Cap anchors per node at 50 (sliding window)."""
    global _feedback_counter
    if correct_node_id not in _node_embeddings:
        _node_embeddings[correct_node_id] = []
    _node_embeddings[correct_node_id].append(claim_embedding)
    if len(_node_embeddings[correct_node_id]) > 50:
        _node_embeddings[correct_node_id] = _node_embeddings[correct_node_id][-50:]

    _correction_history.append({"score": system_score, "correct": int(system_correct)})
    if len(_correction_history) > 100:
        _correction_history.pop(0)

    _feedback_counter += 1
    if _feedback_counter % 10 == 0:
        _recalibrate_thresholds()

    return len(_node_embeddings[correct_node_id])

def _recalibrate_thresholds():
    global _MATCH_THRESHOLD, _REVIEW_THRESHOLD
    if len(_correction_history) < 10:
        return
    from .evaluate import calibrate_threshold
    scores = [int(c["score"] * 100) for c in _correction_history]
    labels = [c["correct"] for c in _correction_history]
    best_t = calibrate_threshold(scores, labels)
    new_t = best_t / 100.0
    _MATCH_THRESHOLD = max(0.5, min(0.9,
        _MATCH_THRESHOLD + 0.3 * (new_t - _MATCH_THRESHOLD)))

async def rebuild_taxonomy_embeddings() -> dict:
    """Embed all 30 taxonomy nodes via Gemini text-embedding-004."""
    mapper = get_mapper()
    results = {}
    for node in mapper._nodes:
        corpus = f"{node[\"label\"]} {node[\"description\"]} {\" \".join(node.get(\"keywords\", []))}"
        emb = await _call_gemini_embedding(corpus)
        if emb:
            _node_embeddings[node["id"]] = [emb]
            results[node["id"]] = 1
    return results

async def _call_gemini_embedding(text: str) -> Optional[list[float]]:
    api_key = os.getenv("GEMINI_API_KEY", "")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={api_key}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, json={
            "model": "models/text-embedding-004",
            "content": {"parts": [{"text": text}]},
            "taskType": "SEMANTIC_SIMILARITY",
        })
        resp.raise_for_status()
    return resp.json()["embedding"]["values"]
