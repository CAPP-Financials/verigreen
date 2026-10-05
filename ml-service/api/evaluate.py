"""
Day-8 evaluation harness — F1 computation and threshold calibration.

Computes precision, recall, and F1 per metric category against a labeled
ground truth CSV. Also calibrates the substantiation score threshold via
a simple sweep (maximise F1 on the labeled set).

Ground truth CSV columns:
    raw_text       — verbatim or near-verbatim claim text from the source document
    page_num       — integer page number (1-indexed)
    category       — emissions | energy | water | waste | other
    gri_code       — e.g. "GRI 305-1" or empty
    sasb_code      — e.g. "EM-MM-110a.1" or empty
    normalized_value — float or empty
    unit           — e.g. "tCO2e" or empty
    is_quantified  — true/false
    notes          — free-text reviewer notes

Usage:
    from api.evaluate import load_ground_truth, evaluate_extraction, calibrate_threshold

    gt = load_ground_truth("data/ground_truth.csv")
    result = evaluate_extraction(extracted_claims, gt)
    print(result.summary())

    best_t = calibrate_threshold(
        scores=[c.substantiation.score for c in extracted_claims if c.substantiation],
        labels=[1, 1, 0, ...],   # 1=correctly extracted, 0=spurious
    )
"""
from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class GroundTruthClaim:
    raw_text: str
    page_num: int
    category: Optional[str] = None       # emissions/energy/water/waste/other
    gri_code: Optional[str] = None
    sasb_code: Optional[str] = None
    normalized_value: Optional[float] = None
    unit: Optional[str] = None
    is_quantified: bool = True
    notes: str = ""


@dataclass
class CategoryMetrics:
    category: str
    tp: int = 0   # true positives
    fp: int = 0   # false positives
    fn: int = 0   # false negatives
    n_gt: int = 0 # total ground truth for this category

    @property
    def precision(self) -> float:
        return self.tp / (self.tp + self.fp) if (self.tp + self.fp) > 0 else 0.0

    @property
    def recall(self) -> float:
        return self.tp / (self.tp + self.fn) if (self.tp + self.fn) > 0 else 0.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) > 0 else 0.0


@dataclass
class EvalResult:
    total_gt: int
    total_extracted: int
    matched: int                              # true positives (any category)
    per_category: dict[str, CategoryMetrics] = field(default_factory=dict)
    macro_f1: float = 0.0
    calibrated_threshold: Optional[int] = None
    n_labeled: int = 0                        # labeled claims used for calibration
    caveat: str = "n={n}, preliminary — not statistically significant"

    @property
    def precision(self) -> float:
        return self.matched / self.total_extracted if self.total_extracted > 0 else 0.0

    @property
    def recall(self) -> float:
        return self.matched / self.total_gt if self.total_gt > 0 else 0.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) > 0 else 0.0

    def summary(self) -> str:
        lines = [
            f"Evaluation Summary (n={self.n_labeled})",
            f"  Overall:   P={self.precision:.3f}  R={self.recall:.3f}  F1={self.f1:.3f}",
            f"  Extracted: {self.total_extracted}  GT: {self.total_gt}  Matched: {self.matched}",
            f"  Macro F1 (per category): {self.macro_f1:.3f}",
        ]
        if self.calibrated_threshold is not None:
            lines.append(f"  Calibrated substantiation threshold: {self.calibrated_threshold}")
        if self.per_category:
            lines.append("  Per-category:")
            for cat, m in sorted(self.per_category.items()):
                lines.append(
                    f"    {cat:<12}  P={m.precision:.3f}  R={m.recall:.3f}  F1={m.f1:.3f}"
                    f"  (GT={m.n_gt})"
                )
        caveat = self.caveat.replace("{n}", str(self.n_labeled))
        lines.append(f"  NOTE: {caveat}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# CSV loader
# ---------------------------------------------------------------------------

def load_ground_truth(path: str | Path) -> list[GroundTruthClaim]:
    """Parse ground truth CSV and return list of GroundTruthClaim."""
    rows: list[GroundTruthClaim] = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            raw = row.get("raw_text", "").strip()
            if not raw:
                continue
            try:
                page_num = int(row.get("page_num") or 0)
            except ValueError:
                page_num = 0
            try:
                norm = float(row["normalized_value"]) if row.get("normalized_value") else None
            except ValueError:
                norm = None
            is_q_str = (row.get("is_quantified") or "true").lower()
            rows.append(GroundTruthClaim(
                raw_text=raw,
                page_num=page_num,
                category=row.get("category") or None,
                gri_code=row.get("gri_code") or None,
                sasb_code=row.get("sasb_code") or None,
                normalized_value=norm,
                unit=row.get("unit") or None,
                is_quantified=is_q_str not in ("false", "0", "no"),
                notes=row.get("notes", ""),
            ))
    return rows


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def _texts_match(extracted_text: str, gt_text: str, fuzzy: bool = True) -> bool:
    """
    Return True if the extracted raw_text corresponds to the GT claim.

    Exact: GT text == extracted text.
    Fuzzy: one is a substring of the other (handles truncation/whitespace),
           or both share >=60% character overlap via token Jaccard.
    """
    e = extracted_text.strip().lower()
    g = gt_text.strip().lower()
    if e == g:
        return True
    if fuzzy:
        if g in e or e in g:
            return True
        # Token Jaccard (simple word overlap)
        e_tokens = set(e.split())
        g_tokens = set(g.split())
        if not g_tokens:
            return False
        jaccard = len(e_tokens & g_tokens) / len(e_tokens | g_tokens)
        if jaccard >= 0.6:
            return True
    return False


def match_claims(
    extracted: list,            # list[ExtractedClaim]
    ground_truth: list[GroundTruthClaim],
    fuzzy: bool = True,
) -> tuple[list[tuple], list[int], list[int]]:
    """
    Match extracted claims to ground truth.

    Returns:
        matches     — list of (extracted_idx, gt_idx) pairs
        unmatched_extracted — extracted indices with no GT match (false positives)
        unmatched_gt        — GT indices with no extracted match (false negatives)
    """
    matched_gt = set()
    matched_ext = set()
    matches: list[tuple[int, int]] = []

    for ei, ec in enumerate(extracted):
        for gi, gc in enumerate(ground_truth):
            if gi in matched_gt:
                continue
            if _texts_match(ec.raw_text, gc.raw_text, fuzzy=fuzzy):
                matches.append((ei, gi))
                matched_gt.add(gi)
                matched_ext.add(ei)
                break

    unmatched_ext = [i for i in range(len(extracted)) if i not in matched_ext]
    unmatched_gt = [i for i in range(len(ground_truth)) if i not in matched_gt]
    return matches, unmatched_ext, unmatched_gt


# ---------------------------------------------------------------------------
# Core evaluation
# ---------------------------------------------------------------------------

def evaluate_extraction(
    extracted: list,                     # list[ExtractedClaim]
    ground_truth: list[GroundTruthClaim],
    fuzzy: bool = True,
) -> EvalResult:
    """
    Compute precision/recall/F1 overall and per category.
    """
    if not ground_truth:
        return EvalResult(
            total_gt=0,
            total_extracted=len(extracted),
            matched=0,
            n_labeled=0,
        )

    matches, unmatched_ext, unmatched_gt = match_claims(extracted, ground_truth, fuzzy)

    # ── per-category metrics ────────────────────────────────────────────────
    categories = {"emissions", "energy", "water", "waste", "other"}
    cat_metrics: dict[str, CategoryMetrics] = {c: CategoryMetrics(c) for c in categories}

    # Count GT per category
    for gc in ground_truth:
        cat = gc.category or "other"
        if cat in cat_metrics:
            cat_metrics[cat].n_gt += 1
            cat_metrics[cat].fn += 1  # start as false negative; correct on match

    # Update TP/FP/FN from matches
    for ei, gi in matches:
        ec = extracted[ei]
        gc = ground_truth[gi]
        cat = gc.category or "other"
        ext_cat = getattr(ec, "category", None) or "other"

        if cat in cat_metrics:
            cat_metrics[cat].tp += 1
            cat_metrics[cat].fn -= 1  # was pre-counted as FN

        # Category mismatch → FP for wrong category, FN for correct category
        if ext_cat != cat and ext_cat in cat_metrics:
            cat_metrics[ext_cat].fp += 1

    # Unmatched extracted = false positives
    for ei in unmatched_ext:
        ec = extracted[ei]
        ext_cat = getattr(ec, "category", None) or "other"
        if ext_cat in cat_metrics:
            cat_metrics[ext_cat].fp += 1

    # Remove categories with no GT and no predictions (don't skew macro F1)
    active_cats = {c: m for c, m in cat_metrics.items() if m.n_gt > 0 or m.fp > 0}
    macro_f1 = sum(m.f1 for m in active_cats.values()) / len(active_cats) if active_cats else 0.0

    return EvalResult(
        total_gt=len(ground_truth),
        total_extracted=len(extracted),
        matched=len(matches),
        per_category=active_cats,
        macro_f1=macro_f1,
        n_labeled=len(ground_truth),
    )


# ---------------------------------------------------------------------------
# Threshold calibration
# ---------------------------------------------------------------------------

def calibrate_threshold(
    scores: list[int],   # substantiation scores 0-100
    labels: list[int],   # 1 = correctly extracted / true positive, 0 = spurious
) -> int:
    """
    Sweep substantiation score thresholds 0–100. Return threshold that maximises
    F1 on the labeled set (claims with score >= threshold are "accepted").

    Falls back to 50 if scores/labels are empty or calibration is not meaningful.
    """
    if len(scores) != len(labels) or not scores:
        return 50

    best_f1 = -1.0
    best_t = 50
    pairs = list(zip(scores, labels))

    for threshold in range(0, 101, 5):
        tp = sum(1 for s, l in pairs if s >= threshold and l == 1)
        fp = sum(1 for s, l in pairs if s >= threshold and l == 0)
        fn = sum(1 for s, l in pairs if s < threshold and l == 1)
        p = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        r = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0.0
        if f1 > best_f1:
            best_f1 = f1
            best_t = threshold

    return best_t


# ---------------------------------------------------------------------------
# Ground truth CSV skeleton writer
# ---------------------------------------------------------------------------

GROUND_TRUTH_COLUMNS = [
    "raw_text", "page_num", "category", "gri_code", "sasb_code",
    "normalized_value", "unit", "is_quantified", "notes",
]


def write_prelabeled_csv(
    claims: list,           # list[ExtractedClaim]
    output_path: str | Path,
) -> None:
    """
    Write a CSV pre-populated with extracted claims for human review.
    Reviewer fills in: category corrections, gri_code, sasb_code, is_quantified, notes.
    """
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=GROUND_TRUTH_COLUMNS)
        writer.writeheader()
        for claim in claims:
            writer.writerow({
                "raw_text": claim.raw_text,
                "page_num": claim.page_num,
                "category": claim.category or "",
                "gri_code": (claim.taxonomy.code if claim.taxonomy else "") or "",
                "sasb_code": "",
                "normalized_value": claim.normalized_value if claim.normalized_value is not None else "",
                "unit": claim.unit or "",
                "is_quantified": "true" if (claim.normalized_value is not None or claim.unit) else "false",
                "notes": "",
            })
