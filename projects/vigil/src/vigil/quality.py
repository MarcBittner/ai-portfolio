"""Code-quality grading — vigil decides the letter grade, never the caller.

A CI run (or a committed ``quality.json``) POSTs raw numbers — lint errors, tests
passed/failed, optional coverage and complexity — and *vigil* derives a single
letter grade deterministically here. Keeping the grade in code (not the payload)
means the grading rubric is one auditable function, identical for every app and
every push, and a caller can't inflate its own grade.

The rubric is a simple additive penalty model:
- any failing test is the dominant signal (tests are the contract);
- lint errors accrue a smaller penalty;
- low coverage nudges the grade down; high coverage can't *raise* a failing build.
The penalty maps to A–F on fixed thresholds.
"""

from __future__ import annotations

# Penalty weights (points off a notional 100).
_FAIL_TEST_PENALTY = 12      # each failing test hurts a lot
_LINT_PENALTY = 1.5          # each lint error
_LINT_CAP = 40               # but lint alone can't sink you past this
_LOW_COVERAGE_KNEE = 80.0    # coverage below this starts costing points
_COVERAGE_WEIGHT = 0.5       # points off per percent under the knee


def grade_score(*, lint_errors: int, tests_passed: int, tests_failed: int,
                coverage_pct: float | None = None) -> float:
    """A 0–100 quality score from the raw signals (clamped). Deterministic."""
    lint_errors = max(0, int(lint_errors or 0))
    tests_failed = max(0, int(tests_failed or 0))

    penalty = tests_failed * _FAIL_TEST_PENALTY
    penalty += min(lint_errors * _LINT_PENALTY, _LINT_CAP)
    if coverage_pct is not None:
        try:
            cov = float(coverage_pct)
        except (TypeError, ValueError):
            cov = None
        if cov is not None and cov < _LOW_COVERAGE_KNEE:
            penalty += (_LOW_COVERAGE_KNEE - cov) * _COVERAGE_WEIGHT
    return max(0.0, min(100.0, 100.0 - penalty))


def letter(score: float) -> str:
    return ("A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60
            else "D" if score >= 40 else "F")


def derive_grade(*, lint_errors: int, tests_passed: int, tests_failed: int,
                 coverage_pct: float | None = None) -> str:
    """The public entry point the ingest endpoint uses: raw numbers → letter grade.
    Code decides; the caller only supplies measurements."""
    return letter(grade_score(
        lint_errors=lint_errors, tests_passed=tests_passed,
        tests_failed=tests_failed, coverage_pct=coverage_pct))
