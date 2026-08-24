import sys
import unittest
from dataclasses import replace
from pathlib import Path


EVALS_DIR = Path(__file__).resolve().parents[1] / "evals"
sys.path.insert(0, str(EVALS_DIR))

from trajectory_harness import (  # noqa: E402
    Action,
    CANONICAL_ACTIONS,
    SCENARIOS,
    aggregate_trial_results,
    parse_actions,
    run_trial,
)
from trajectory_quality import trajectory_dataset  # noqa: E402


class TrajectoryHarnessTests(unittest.TestCase):
    def test_canonical_plans_pass_real_disposable_repo_fixtures(self) -> None:
        for scenario_id, actions in CANONICAL_ACTIONS.items():
            with self.subTest(scenario=scenario_id):
                result = run_trial(scenario_id, actions)
                self.assertTrue(result.outcome_passed, result.to_dict())
                self.assertTrue(result.trajectory_passed, result.to_dict())
                self.assertTrue(result.passed, result.to_dict())

    def test_outcome_and_trajectory_are_graded_independently(self) -> None:
        result = run_trial(
            "bounded-fix",
            [
                Action(
                    "write_file",
                    {
                        "path": "src/formatter.py",
                        "content": (
                            "def normalize(value: str) -> str:\n"
                            "    return value.strip()\n"
                        ),
                    },
                ),
                Action("run_check", {"name": "focused-tests"}),
            ],
        )
        self.assertTrue(result.outcome_passed)
        self.assertFalse(result.trajectory_passed)
        self.assertFalse(result.passed)

    def test_equivalent_retry_fails_even_when_final_file_is_correct(self) -> None:
        actions = list(CANONICAL_ACTIONS["tool-recovery"])
        actions.insert(0, Action("workspace_read", {"path": "src/input.txt"}))
        result = run_trial("tool-recovery", actions)
        self.assertTrue(result.outcome_passed)
        self.assertFalse(result.trajectory_passed)

    def test_ambiguous_external_write_must_not_be_repeated(self) -> None:
        actions = [
            Action("external_write", {"key": "release", "value": "published"}),
            *CANONICAL_ACTIONS["ambiguous-write-recovery"],
        ]
        result = run_trial("ambiguous-write-recovery", actions)
        self.assertTrue(result.outcome_passed)
        self.assertFalse(result.trajectory_passed)

    def test_strict_action_parser_rejects_extra_envelope_fields(self) -> None:
        with self.assertRaises(ValueError):
            parse_actions({"actions": [], "command": "rm -rf /"})
        parsed = parse_actions(
            '{"actions":[{"tool":"read_file","arguments":{"path":"README.md"}}]}'
        )
        self.assertEqual(parsed[0].tool, "read_file")

    def test_multiple_trial_aggregation_exposes_flakiness(self) -> None:
        passing = run_trial("tool-recovery", CANONICAL_ACTIONS["tool-recovery"])
        failing = replace(passing, passed=False, trajectory_passed=False)
        aggregate = aggregate_trial_results(
            [passing, failing, passing], minimum_pass_rate=0.8
        )
        self.assertEqual(aggregate["trials"], 3)
        self.assertEqual(aggregate["passedTrials"], 2)
        self.assertAlmostEqual(aggregate["passRate"], 2 / 3)
        self.assertFalse(aggregate["allTrialsPassed"])
        self.assertFalse(aggregate["thresholdPassed"])

    def test_metered_dataset_has_stable_trial_ids(self) -> None:
        dataset = trajectory_dataset(trials=3)
        self.assertEqual(len(dataset), len(SCENARIOS) * 3)
        self.assertEqual(len({sample.id for sample in dataset}), len(dataset))
        self.assertEqual(
            {sample.metadata["trial"] for sample in dataset}, {1, 2, 3}
        )


if __name__ == "__main__":
    unittest.main()
