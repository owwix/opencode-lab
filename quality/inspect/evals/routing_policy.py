"""Pure enforcement hook for model-routing review requirements."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence


def load_routing_policy(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def evaluate_review_plan(
    policy: Mapping[str, Any], *, risk_level: str, reviewer_models: Sequence[str]
) -> dict[str, Any]:
    """Return a fail-closed decision without starting models or changing routes."""
    review_policy = policy.get("reviewPolicy")
    if not isinstance(review_policy, Mapping):
        return {"passed": False, "reasons": ["reviewPolicy is missing"]}
    levels = review_policy.get("levels")
    if not isinstance(levels, Mapping) or risk_level not in levels:
        return {
            "passed": False,
            "reasons": [f"unknown review risk level: {risk_level}"],
        }
    requirement = levels[risk_level]
    if not isinstance(requirement, Mapping):
        return {"passed": False, "reasons": ["review requirement is invalid"]}

    candidates = {
        candidate.get("model"): candidate
        for candidate in review_policy.get("reviewerCandidates", [])
        if isinstance(candidate, Mapping) and isinstance(candidate.get("model"), str)
    }
    unique_models = list(dict.fromkeys(reviewer_models))
    reasons: list[str] = []
    eligible: list[Mapping[str, Any]] = []
    for model in unique_models:
        candidate = candidates.get(model)
        if candidate is None:
            reasons.append(f"reviewer model is not registered: {model}")
        elif candidate.get("status") != "eligible":
            reasons.append(
                f"reviewer model has not qualified: {model} "
                f"({candidate.get('status', 'unknown')})"
            )
        else:
            eligible.append(candidate)

    minimum_reviewers = int(requirement.get("minimumReviewers", 1))
    minimum_families = int(requirement.get("minimumDistinctModelFamilies", 1))
    families = {
        candidate.get("family")
        for candidate in eligible
        if isinstance(candidate.get("family"), str)
    }
    if len(eligible) < minimum_reviewers:
        reasons.append(
            f"requires {minimum_reviewers} eligible reviewer(s); found {len(eligible)}"
        )
    if len(families) < minimum_families:
        reasons.append(
            f"requires {minimum_families} distinct model family/families; "
            f"found {len(families)}"
        )
    return {
        "passed": not reasons,
        "riskLevel": risk_level,
        "reviewerModels": unique_models,
        "eligibleReviewerModels": [candidate["model"] for candidate in eligible],
        "distinctModelFamilies": sorted(families),
        "reasons": reasons,
    }
