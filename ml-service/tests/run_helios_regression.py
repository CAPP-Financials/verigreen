"""
Adversarial Layer 9 — Helios fixture CI regression runner.

Runs all 8 fixture stages as a single pass/fail gate. Any stage regression
exits with code 1, which blocks CI deploy.

Usage:
    python tests/run_helios_regression.py
    python tests/run_helios_regression.py --stage 6   # single stage

Exit codes:
    0  all stages passed
    1  one or more stages failed

Stage mapping:
    Stage 0: baseline GRI claims (via test_adversarial.py + test_substantiation.py)
    Stage 1: unit conversion + subsidiary (test_taxonomy.py)
    Stage 2+3: substantiation flags (test_substantiation.py)
    Stage 4+5: layout + numerical edge cases (test_stage45.py)
    Stage 6+7: adversarial injection + trust traps (test_stage67.py)
"""
from __future__ import annotations

import argparse
import importlib
import sys
import os
import time
import unittest.mock as mock

# Root must be on path before any api.* import
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Mock anthropic before any test module imports it
if "anthropic" not in sys.modules:
    sys.modules["anthropic"] = mock.MagicMock()

# ---------------------------------------------------------------------------
# Stage registry — maps stage label → (module_name, [test_function_names])
# ---------------------------------------------------------------------------
# "None" in the test list means "run all test_* functions in the module"
STAGE_REGISTRY = [
    {
        "label": "Stage 0 — Baseline extraction guards",
        "module": "tests.test_adversarial",
        "tests": None,  # all
    },
    {
        "label": "Stage 1+2+3 — Taxonomy mapping + substantiation indicators",
        "module": "tests.test_taxonomy",
        "tests": None,
    },
    {
        "label": "Stage 2+3 — Substantiation scoring + verifier whitelist",
        "module": "tests.test_substantiation",
        "tests": None,
    },
    {
        "label": "Stage 4+5 — Layout edge cases + numerical edge cases",
        "module": "tests.test_stage45",
        "tests": None,
    },
    {
        "label": "Stage 6+7 — Adversarial injection + trust traps",
        "module": "tests.test_stage67",
        "tests": None,
    },
    {
        "label": "Stage 8 — Format corruption graceful degradation",
        "module": "tests.test_stage8",
        "tests": None,
    },
    {
        "label": "Layer 8 — Per-call model audit log",
        "module": "tests.test_layer8",
        "tests": None,
    },
]


def _run_module(mod_name: str, test_names: list[str] | None) -> tuple[int, int, list[str]]:
    """
    Import module, discover test_* functions, run each.
    Returns (passed, failed, failed_names).
    """
    mod = importlib.import_module(mod_name)
    if test_names is None:
        test_names = sorted(f for f in dir(mod) if f.startswith("test_"))

    passed = failed = 0
    failed_names: list[str] = []

    for name in test_names:
        fn = getattr(mod, name, None)
        if fn is None:
            continue
        try:
            fn()
            passed += 1
        except AssertionError as e:
            failed += 1
            failed_names.append(f"  FAIL  {name}: {e}")
        except Exception as e:
            failed += 1
            failed_names.append(f"  ERROR {name}: {type(e).__name__}: {e}")

    return passed, failed, failed_names


def run_regression(stage_filter: int | None = None) -> int:
    """
    Run all (or one) stage(s). Returns exit code (0 = all pass, 1 = any fail).
    """
    stages = STAGE_REGISTRY
    if stage_filter is not None:
        # Map CLI --stage to registry index (0-indexed)
        idx = stage_filter
        if idx < 0 or idx >= len(stages):
            print(f"[regression] unknown stage index {idx} (0–{len(stages)-1})")
            return 1
        stages = [STAGE_REGISTRY[idx]]

    total_passed = total_failed = 0
    stage_results: list[tuple[str, int, int, list[str]]] = []

    t0 = time.monotonic()
    for stage in stages:
        p, f, names = _run_module(stage["module"], stage["tests"])
        total_passed += p
        total_failed += f
        stage_results.append((stage["label"], p, f, names))

    elapsed = time.monotonic() - t0

    # ── Print report ────────────────────────────────────────────────────────
    print()
    print("=" * 64)
    print("  HELIOS ADVERSARIAL REGRESSION SUITE")
    print("=" * 64)
    for label, p, f, failures in stage_results:
        status = "PASS" if f == 0 else "FAIL"
        print(f"  {status}  {label}  ({p} passed, {f} failed)")
        for line in failures:
            print(f"    {line}")
    print("-" * 64)
    print(f"  Total: {total_passed} passed, {total_failed} failed  ({elapsed:.2f}s)")
    print("=" * 64)
    print()

    if total_failed:
        print("[regression] DEPLOY BLOCKED — fix failing stages before merging.")
        return 1

    print("[regression] All stages green — deploy cleared.")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Helios adversarial regression runner")
    parser.add_argument(
        "--stage",
        type=int,
        default=None,
        help="Run only this stage index (0=adversarial, 1=taxonomy, 2=substantiation, 3=stage45, 4=stage67)",
    )
    args = parser.parse_args()
    sys.exit(run_regression(args.stage))
