import sys
import unittest
from pathlib import Path


EVALS_DIR = Path(__file__).resolve().parents[1] / "evals"
sys.path.insert(0, str(EVALS_DIR))

from agent_quality import CASES, evaluate_contract  # noqa: E402


class GoldenSetValidationTests(unittest.TestCase):
    def test_contains_practical_golden_set(self) -> None:
        self.assertGreaterEqual(len(CASES), 20)
        categories = {sample.metadata["category"] for sample in CASES}
        self.assertGreaterEqual(len(categories), 8)

    def test_ids_and_prompts_are_unique(self) -> None:
        ids = [sample.id for sample in CASES]
        prompts = [sample.input.casefold() for sample in CASES]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(prompts), len(set(prompts)))

    def test_contract_metadata_is_well_formed(self) -> None:
        for sample in CASES:
            with self.subTest(sample=sample.id):
                self.assertIsInstance(sample.id, str)
                self.assertTrue(sample.id)
                self.assertIsInstance(sample.metadata["category"], str)
                self.assertTrue(sample.metadata["category"])
                groups = sample.metadata["required_groups"]
                forbidden = sample.metadata["forbidden"]
                self.assertTrue(groups)
                self.assertTrue(forbidden)
                self.assertTrue(all(group for group in groups))
                self.assertTrue(all(value.strip() for group in groups for value in group))
                self.assertTrue(all(value.strip() for value in forbidden))

    def test_every_contract_has_a_satisfying_synthetic_answer(self) -> None:
        for sample in CASES:
            with self.subTest(sample=sample.id):
                answer = ". ".join(group[0] for group in sample.metadata["required_groups"])
                missing, violations = evaluate_contract(answer, sample.metadata)
                self.assertEqual(missing, [])
                self.assertEqual(violations, [])

    def test_each_required_group_is_independently_enforced(self) -> None:
        for sample in CASES:
            groups = sample.metadata["required_groups"]
            for omitted_index in range(len(groups)):
                with self.subTest(sample=sample.id, omitted_group=omitted_index):
                    answer = ". ".join(
                        group[0]
                        for index, group in enumerate(groups)
                        if index != omitted_index
                    )
                    missing, _ = evaluate_contract(answer, sample.metadata)
                    self.assertTrue(
                        missing,
                        "A required group is accidentally satisfied by another group's phrase",
                    )

    def test_each_forbidden_phrase_is_rejected(self) -> None:
        for sample in CASES:
            valid_answer = ". ".join(
                group[0] for group in sample.metadata["required_groups"]
            )
            for phrase in sample.metadata["forbidden"]:
                with self.subTest(sample=sample.id, forbidden=phrase):
                    missing, violations = evaluate_contract(
                        f"{valid_answer}. {phrase}", sample.metadata
                    )
                    self.assertEqual(missing, [])
                    self.assertIn(phrase.casefold(), violations)


if __name__ == "__main__":
    unittest.main()
