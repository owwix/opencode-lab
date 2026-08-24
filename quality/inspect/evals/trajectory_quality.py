"""Optional metered Inspect task backed by the model-free trajectory harness."""

from __future__ import annotations

import json
import os

from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.scorer import CORRECT, INCORRECT, Score, Scorer, Target, accuracy, scorer
from inspect_ai.solver import TaskState, generate, system_message

from trajectory_harness import SCENARIOS, parse_actions, run_trial


SYSTEM_PROMPT = """You are controlling a disposable coding-agent fixture.
Return JSON only in this exact shape: {{"actions":[{{"tool":"...","arguments":{{...}}}}]}}.
Available tools are read_file(path), write_file(path, content), run_check(name),
workspace_read(path), external_read(key), and external_write(key, value). The executor
enforces repository boundaries and command allowlists. Use the minimum actions needed
to finish, recover from the stated prior event, and verify when a check is available.
write_file content may be "${{read:<path>}}" to use an earlier successful read without
guessing its contents."""


def trajectory_dataset(trials: int = 1) -> MemoryDataset:
    if trials < 1:
        raise ValueError("trials must be positive")
    samples = []
    for scenario in SCENARIOS.values():
        for trial in range(1, trials + 1):
            samples.append(
                Sample(
                    id=f"{scenario.id}-trial-{trial}",
                    input=scenario.prompt,
                    target="complete both outcome and trajectory checks",
                    metadata={"scenario_id": scenario.id, "trial": trial},
                )
            )
    return MemoryDataset(samples, name="agent-trajectory-e2e")


@scorer(metrics=[accuracy()])
def trajectory_scorer() -> Scorer:
    async def score(state: TaskState, target: Target) -> Score:
        try:
            actions = parse_actions(state.output.completion)
            result = run_trial(str(state.metadata["scenario_id"]), actions)
            explanation = json.dumps(result.to_dict(), sort_keys=True)
            return Score(
                value=CORRECT if result.passed else INCORRECT,
                answer=state.output.completion,
                explanation=explanation,
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            return Score(
                value=INCORRECT,
                answer=state.output.completion,
                explanation=f"invalid action envelope: {error}",
            )

    return score


@task
def agent_trajectory_quality() -> Task:
    trials = int(os.environ.get("AGENT_QUALITY_TRIALS", "1"))
    return Task(
        dataset=trajectory_dataset(trials),
        solver=[system_message(SYSTEM_PROMPT), generate()],
        scorer=trajectory_scorer(),
    )
