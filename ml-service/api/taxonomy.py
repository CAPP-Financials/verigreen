"""
Day-4 GRI/SASB taxonomy mapper.

Hybrid scoring per claim:
  0.4 × TF-IDF cosine similarity (sparse dict vectors, no numpy required)
  0.4 × rule-based (keyword hits + unit match + category match)
  0.2 × unit normalization agreement

Three-tier routing (thresholds are Day-8 calibration placeholders):
  matched              score >= 0.65
  requires_manual_review  0.35 <= score < 0.65
  unmapped             score < 0.35
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import ExtractedClaim, TaxonomyMapping

_DATA_DIR = Path(__file__).parent.parent / "data"

# Canonical unit spellings keyed by lowercase normalized form
_UNIT_ALIASES: dict[str, str] = {
    # energy
    "kwh": "kWh", "mwh": "MWh", "gwh": "GWh", "twh": "TWh",
    "gj": "GJ", "tj": "TJ", "pj": "PJ", "mmbtu": "MMBtu",
    "gigajoule": "GJ", "gigajoules": "GJ",
    "terajoule": "TJ", "terajoules": "TJ",
    "petajoule": "PJ", "petajoules": "PJ",
    # emissions
    "tco2e": "tCO2e", "co2e": "CO2e", "mtco2e": "MtCO2e", "ktco2e": "ktCO2e",
    "tco2": "tCO2", "tonnes co2e": "tCO2e", "metric tons co2e": "tCO2e",
    "metric tonnes co2e": "tCO2e", "t co2e": "tCO2e",
    # water
    "ml": "ML", "m3": "m³", "km3": "km³", "kl": "kL",
    "megalitres": "ML", "megalitre": "ML", "megaliter": "ML", "megaliters": "ML",
    "cubic metres": "m³", "cubic meters": "m³",
    "cubic metre": "m³", "cubic meter": "m³",
    "gl": "GL", "gigalitres": "GL",
    # waste
    "t": "tonnes", "tonnes": "tonnes", "tonne": "tonnes",
    "tons": "tonnes", "ton": "tonnes",
    "metric tons": "tonnes", "metric ton": "tonnes",
    "metric tonnes": "tonnes", "metric tonne": "tonnes",
    "kg": "kg", "kilogram": "kg", "kilograms": "kg",
}


def _normalize_unit(unit: str) -> str:
    """Return a canonical unit string, or the original lowercase if unknown."""
    key = unit.strip().lower()
    return _UNIT_ALIASES.get(key, key)


def _tokenize(text: str) -> list[str]:
    """Lowercase alpha-only tokens of length >= 3."""
    return [t for t in re.split(r"[^a-z]+", text.lower()) if len(t) >= 3]


def _dot(a: dict[str, float], b: dict[str, float]) -> float:
    return sum(a[k] * b[k] for k in a if k in b)


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    norm_a = math.sqrt(_dot(a, a))
    norm_b = math.sqrt(_dot(b, b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return _dot(a, b) / (norm_a * norm_b)


class TaxonomyMapper:
    def __init__(self) -> None:
        self._nodes: list[dict] = []
        self._node_map: dict[str, dict] = {}
        self._idf: dict[str, float] = {}
        self._node_vectors: dict[str, dict[str, float]] = {}
        self._load_nodes()
        self._build_tfidf()

    def _load_nodes(self) -> None:
        for fname in ("gri_nodes.json", "sasb_nodes.json"):
            path = _DATA_DIR / fname
            data = json.loads(path.read_text(encoding="utf-8"))
            for node in data["nodes"]:
                self._nodes.append(node)
                self._node_map[node["id"]] = node

    def _node_corpus_text(self, node: dict) -> str:
        return " ".join([
            node["description"],
            " ".join(node["keywords"]),
            node["label"],
            node["code"],
        ])

    def _build_tfidf(self) -> None:
        n_docs = len(self._nodes)
        doc_tokens: list[list[str]] = [_tokenize(self._node_corpus_text(n)) for n in self._nodes]

        # document frequency
        df: dict[str, int] = {}
        for tokens in doc_tokens:
            for tok in set(tokens):
                df[tok] = df.get(tok, 0) + 1

        # IDF with smoothing
        self._idf = {
            tok: math.log((n_docs + 1) / (count + 1)) + 1.0
            for tok, count in df.items()
        }

        # TF-IDF vectors for each node
        for node, tokens in zip(self._nodes, doc_tokens):
            tf: dict[str, float] = {}
            for tok in tokens:
                tf[tok] = tf.get(tok, 0) + 1
            total = len(tokens) or 1
            vec: dict[str, float] = {
                tok: (count / total) * self._idf.get(tok, 1.0)
                for tok, count in tf.items()
            }
            self._node_vectors[node["id"]] = vec

    def _tfidf_score(self, text: str) -> dict[str, float]:
        tokens = _tokenize(text)
        if not tokens:
            return {n["id"]: 0.0 for n in self._nodes}
        tf: dict[str, float] = {}
        for tok in tokens:
            tf[tok] = tf.get(tok, 0) + 1
        total = len(tokens)
        query_vec: dict[str, float] = {
            tok: (count / total) * self._idf.get(tok, 1.0)
            for tok, count in tf.items()
        }
        return {
            n["id"]: _cosine(query_vec, self._node_vectors[n["id"]])
            for n in self._nodes
        }

    def _rule_score(self, claim: "ExtractedClaim") -> dict[str, float]:
        text_lower = claim.raw_text.lower()
        scores: dict[str, float] = {}
        for node in self._nodes:
            s = 0.0
            # Category match is a strong signal
            if claim.category and claim.category == node["category"]:
                s += 0.5
            # Keyword hits (partial credit per hit, capped)
            kw_hits = sum(1 for kw in node["keywords"] if kw.lower() in text_lower)
            if node["keywords"]:
                s += 0.4 * min(kw_hits / max(len(node["keywords"]) * 0.3, 1), 1.0)
            # Explicit code/id mention
            if node["code"].lower() in text_lower:
                s += 0.3
            # Framework mention
            if node["framework"].lower() in text_lower:
                s += 0.1
            scores[node["id"]] = min(s, 1.0)
        return scores

    def _unit_score(self, claim: "ExtractedClaim") -> dict[str, float]:
        if not claim.unit:
            return {n["id"]: 0.0 for n in self._nodes}
        normalized = _normalize_unit(claim.unit)
        scores: dict[str, float] = {}
        for node in self._nodes:
            node_units = {_normalize_unit(u) for u in node["units"]}
            scores[node["id"]] = 1.0 if normalized in node_units else 0.0
        return scores

    def map_claim(self, claim: "ExtractedClaim") -> "TaxonomyMapping":
        from .models import TaxonomyMapping  # local import avoids circular at module level

        tfidf = self._tfidf_score(claim.raw_text)
        rule = self._rule_score(claim)
        unit = self._unit_score(claim)

        best_id: str | None = None
        best_score = 0.0
        for node in self._nodes:
            nid = node["id"]
            combined = (
                0.4 * tfidf.get(nid, 0.0)
                + 0.4 * rule.get(nid, 0.0)
                + 0.2 * unit.get(nid, 0.0)
            )
            # When the extractor's category AND unit both agree with this node,
            # that's strong independent corroboration — add a reliability bonus.
            if (
                claim.category is not None
                and claim.category == node["category"]
                and unit.get(nid, 0.0) >= 1.0
            ):
                combined = min(combined + 0.18, 1.0)
            if combined > best_score:
                best_score = combined
                best_id = nid

        score = round(best_score, 4)

        if best_id is None or best_score < 0.35:
            return TaxonomyMapping(
                node_id=None,
                framework=None,
                code=None,
                label=None,
                score=score,
                routing="unmapped",
            )

        routing = "matched" if best_score >= 0.65 else "requires_manual_review"
        node = self._node_map[best_id]
        return TaxonomyMapping(
            node_id=best_id,
            framework=node["framework"],
            code=node["code"],
            label=node["label"],
            score=score,
            routing=routing,
        )

    def map_claims(self, claims: list["ExtractedClaim"]) -> list["ExtractedClaim"]:
        """Return claims with taxonomy field populated (non-mutating copy)."""
        from .models import ExtractedClaim  # local import avoids circular

        result = []
        for claim in claims:
            mapping = self.map_claim(claim)
            result.append(claim.model_copy(update={"taxonomy": mapping}))
        return result


# Module-level lazy singleton — loaded once per process on Vercel Fluid Compute
_mapper: TaxonomyMapper | None = None


def get_mapper() -> TaxonomyMapper:
    global _mapper
    if _mapper is None:
        _mapper = TaxonomyMapper()
    return _mapper
