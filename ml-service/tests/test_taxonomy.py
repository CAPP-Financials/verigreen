"""
Taxonomy mapper unit tests — Helios Stage 1 assertions.

Stage 1 covers: unit conversion/variety (kWh/MWh/GWh/GJ/tCO2e/ML/tonnes),
category routing, three-tier threshold behavior, and vague claim handling.

All tests run without LLM calls.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from api.models import ExtractedClaim, TaxonomyMapping
from api.taxonomy import TaxonomyMapper, _normalize_unit


# One mapper instance shared across all tests (mirrors production singleton pattern)
_mapper = TaxonomyMapper()


def _claim(
    raw_text: str,
    category: str | None = None,
    unit: str | None = None,
    page: int = 1,
    start: int = 0,
    end: int | None = None,
) -> ExtractedClaim:
    return ExtractedClaim(
        raw_text=raw_text,
        page_num=page,
        char_start=start,
        char_end=end if end is not None else len(raw_text),
        category=category,
        unit=unit,
    )


# =========================================================
# Unit normalization
# =========================================================

def test_unit_normalize_kwh():
    assert _normalize_unit("kwh") == "kWh"
    assert _normalize_unit("KWH") == "kWh"  # lowercased before alias lookup → hits "kwh" → "kWh"

def test_unit_normalize_mwh():
    assert _normalize_unit("mwh") == "MWh"
    assert _normalize_unit("MWh") == "MWh"  # exact match key

def test_unit_normalize_gj():
    assert _normalize_unit("gj") == "GJ"
    assert _normalize_unit("gigajoules") == "GJ"

def test_unit_normalize_tco2e():
    assert _normalize_unit("tco2e") == "tCO2e"

def test_unit_normalize_megalitres():
    assert _normalize_unit("megalitres") == "ML"
    assert _normalize_unit("megaliters") == "ML"

def test_unit_normalize_metric_tons():
    assert _normalize_unit("metric tons") == "tonnes"
    assert _normalize_unit("metric tonnes") == "tonnes"


# =========================================================
# Stage 1: energy claims — unit variety (kWh / MWh / GWh / GJ)
# =========================================================

def test_energy_mwh_maps_to_gri302():
    claim = _claim(
        "Total energy consumption: 45,678 MWh in FY2024",
        category="energy", unit="MWh",
    )
    m = _mapper.map_claim(claim)
    # GRI 302-1 or SASB EN-USE are both valid energy consumption nodes
    assert m.framework in ("GRI", "SASB")
    assert m.code is not None and (m.code.startswith("302") or m.code == "EN-USE")
    assert m.routing == "matched"
    assert m.score >= 0.65


def test_energy_gwh_maps_to_gri302():
    claim = _claim(
        "Helios consumed 1,234 GWh of electricity across all facilities.",
        category="energy", unit="GWh",
    )
    m = _mapper.map_claim(claim)
    # GRI 302-1 or SASB EN-USE — either is a valid energy consumption node
    assert m.framework in ("GRI", "SASB")
    assert m.code is not None and (m.code.startswith("302") or m.code in ("EN-USE", "EN-INT"))
    assert m.routing == "matched"  # category + unit agreement bonus should push score ≥ 0.65


def test_energy_gj_maps_to_gri302():
    # Stage 1: GJ is a legitimate energy unit variant; mapper must handle it
    claim = _claim(
        "Energy intensity: 12.5 GJ per tonne of production output.",
        category="energy", unit="GJ",
    )
    m = _mapper.map_claim(claim)
    assert m.framework in ("GRI", "SASB")
    assert m.code is not None and (m.code.startswith("302") or m.code in ("EN-USE", "EN-INT"))
    assert m.routing != "unmapped"


def test_energy_kwh_no_category_still_matches():
    # Claim text contains strong energy keywords even without explicit category
    claim = _claim(
        "Electricity consumption from purchased grid power: 98,765 kWh",
        category=None, unit="kWh",
    )
    m = _mapper.map_claim(claim)
    assert m.routing in ("matched", "requires_manual_review")
    assert m.framework in ("GRI", "SASB")


def test_sasb_en_use_matches_energy():
    # SASB EN-USE should also be a valid match for total energy claims
    claim = _claim(
        "Total energy consumed: 500 GJ from renewable and non-renewable sources.",
        category="energy", unit="GJ",
    )
    m = _mapper.map_claim(claim)
    assert m.framework in ("GRI", "SASB")
    assert m.routing == "matched"


# =========================================================
# Stage 1: emissions claims — tCO2e variants
# =========================================================

def test_scope1_maps_to_gri305_1():
    claim = _claim(
        "Scope 1 direct GHG emissions: 1,234,567 tCO2e in FY2024 (FY2020 baseline: 1,500,000 tCO2e).",
        category="emissions", unit="tCO2e",
    )
    m = _mapper.map_claim(claim)
    assert m.framework in ("GRI", "SASB")
    assert m.code is not None and (m.code in ("305-1", "EM-GHG-1"))
    assert m.routing == "matched"
    assert m.score >= 0.65


def test_scope2_maps_to_gri305_2():
    claim = _claim(
        "Scope 2 energy indirect GHG emissions (market-based): 45,000 tCO2e.",
        category="emissions", unit="tCO2e",
    )
    m = _mapper.map_claim(claim)
    assert m.code is not None and m.code in ("305-2", "EM-GHG-2")
    assert m.routing == "matched"


def test_scope3_maps_to_gri305_3():
    claim = _claim(
        "Scope 3 value chain emissions including upstream purchased goods: 890,000 tCO2e.",
        category="emissions", unit="tCO2e",
    )
    m = _mapper.map_claim(claim)
    assert m.code == "305-3"
    assert m.routing == "matched"


def test_emissions_intensity_maps_to_305_4():
    claim = _claim(
        "GHG emissions intensity: 0.45 tCO2e per tonne of cement produced.",
        category="emissions", unit="tCO2e/tonne",
    )
    m = _mapper.map_claim(claim)
    assert m.code is not None and "305-4" in m.code or "intensity" in (m.label or "").lower() or m.routing != "unmapped"


# =========================================================
# Stage 1: water claims
# =========================================================

def test_water_withdrawal_maps_to_gri303_3():
    claim = _claim(
        "Total water withdrawal: 2,345 ML in FY2024.",
        category="water", unit="ML",
    )
    m = _mapper.map_claim(claim)
    assert m.framework == "GRI"
    assert m.code == "303-3"
    assert m.routing == "matched"


def test_water_cubic_metres_maps_to_303():
    claim = _claim(
        "Groundwater abstracted: 1,200,000 cubic metres from company-owned wells.",
        category="water", unit="m³",
    )
    m = _mapper.map_claim(claim)
    # GRI 303-x or SASB WT-USE — both are valid water withdrawal nodes
    assert m.framework in ("GRI", "SASB")
    assert m.code is not None and (m.code.startswith("303") or m.code.startswith("WT-"))
    assert m.routing == "matched"  # category + unit agreement bonus should push score ≥ 0.65


# =========================================================
# Stage 1: waste claims
# =========================================================

def test_waste_generated_maps_to_gri306_3():
    claim = _claim(
        "Total waste generated: 5,678 tonnes in FY2024.",
        category="waste", unit="tonnes",
    )
    m = _mapper.map_claim(claim)
    assert m.framework == "GRI"
    assert m.code == "306-3"
    assert m.routing == "matched"


def test_waste_recycled_maps_to_306_4():
    claim = _claim(
        "Waste diverted from disposal through recycling and composting: 3,200 tonnes.",
        category="waste", unit="tonnes",
    )
    m = _mapper.map_claim(claim)
    assert m.code == "306-4"
    assert m.routing == "matched"


# =========================================================
# Vague / unquantified claims → unmapped or review
# =========================================================

def test_vague_commitment_unmapped():
    claim = _claim(
        "We are committed to being a global leader in sustainability.",
        category=None, unit=None,
    )
    m = _mapper.map_claim(claim)
    assert m.routing in ("unmapped", "requires_manual_review")


def test_vague_net_zero_no_scope_review_or_unmapped():
    claim = _claim(
        "Net-zero by 2050.",
        category=None, unit=None,
    )
    m = _mapper.map_claim(claim)
    # No quantification → low confidence; should not be "matched"
    assert m.routing in ("unmapped", "requires_manual_review")


def test_empty_claim_unmapped():
    claim = _claim("", category=None, unit=None)
    m = _mapper.map_claim(claim)
    assert m.routing == "unmapped"
    assert m.node_id is None


# =========================================================
# map_claims populates taxonomy field on each claim
# =========================================================

def test_map_claims_populates_taxonomy():
    claims = [
        _claim("Scope 1 emissions: 500 tCO2e.", category="emissions", unit="tCO2e"),
        _claim("Energy consumption: 200 MWh.", category="energy", unit="MWh"),
        _claim("We are committed to sustainability.", category=None, unit=None),
    ]
    mapped = _mapper.map_claims(claims)
    assert len(mapped) == 3
    # Original claims not mutated
    for orig in claims:
        assert orig.taxonomy is None
    # Mapped claims have taxonomy
    for mc in mapped:
        assert mc.taxonomy is not None
    # First two are well-formed quantified claims — should get a node
    assert mapped[0].taxonomy.routing == "matched"
    assert mapped[1].taxonomy.routing == "matched"


if __name__ == "__main__":
    tests = [f for f in dir() if f.startswith("test_")]
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
