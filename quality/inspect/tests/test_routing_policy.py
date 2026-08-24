import sys
import unittest
from pathlib import Path


EVALS_DIR = Path(__file__).resolve().parents[1] / "evals"
REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(EVALS_DIR))

from routing_policy import evaluate_review_plan, load_routing_policy  # noqa: E402


class RoutingPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.policy = load_routing_policy(REPO_ROOT / "quality/model-routing.json")

    def test_standard_review_accepts_the_only_evaluated_candidate(self) -> None:
        decision = evaluate_review_plan(
            self.policy,
            risk_level="standard",
            reviewer_models=["cloudflare-ai/@cf/moonshotai/kimi-k2.7-code"],
        )
        self.assertTrue(decision["passed"], decision)

    def test_high_risk_review_fails_closed_without_family_diversity(self) -> None:
        decision = evaluate_review_plan(
            self.policy,
            risk_level="high",
            reviewer_models=["cloudflare-ai/@cf/moonshotai/kimi-k2.7-code"],
        )
        self.assertFalse(decision["passed"])
        self.assertTrue(
            any("distinct model" in reason for reason in decision["reasons"])
        )

    def test_deepseek_candidate_does_not_count_before_evaluation(self) -> None:
        deepseek = "cloudflare-ai/@cf/deepseek-ai/deepseek-v4-pro-0813"
        decision = evaluate_review_plan(
            self.policy,
            risk_level="high",
            reviewer_models=[
                "cloudflare-ai/@cf/moonshotai/kimi-k2.7-code",
                deepseek,
            ],
        )
        self.assertFalse(decision["passed"])
        self.assertIn("eval-required", " ".join(decision["reasons"]))
        self.assertNotIn(deepseek, decision["eligibleReviewerModels"])

    def test_deepseek_would_satisfy_diversity_only_after_promotion(self) -> None:
        policy = {**self.policy, "reviewPolicy": {**self.policy["reviewPolicy"]}}
        policy["reviewPolicy"]["reviewerCandidates"] = [
            {**candidate, "status": "eligible"}
            for candidate in self.policy["reviewPolicy"]["reviewerCandidates"]
        ]
        decision = evaluate_review_plan(
            policy,
            risk_level="high",
            reviewer_models=[
                "cloudflare-ai/@cf/moonshotai/kimi-k2.7-code",
                "cloudflare-ai/@cf/deepseek-ai/deepseek-v4-pro-0813",
            ],
        )
        self.assertTrue(decision["passed"], decision)
        self.assertEqual(len(decision["distinctModelFamilies"]), 2)


if __name__ == "__main__":
    unittest.main()
